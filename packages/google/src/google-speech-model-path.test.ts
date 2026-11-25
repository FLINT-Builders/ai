import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import { WORKFLOW_DESERIALIZE } from '@ai-sdk/provider-utils';
import { GoogleSpeechModel } from './google-speech-model';
import { createGoogle } from './google-provider';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Model ids are caller input. The provider attaches the API key itself.
 * These tests fail while an unsafe id can change the path, query, or fragment
 * of a credentialed Generative Language API request.
 *
 * A safe speech, embedding, or video id is one path segment:
 * `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` and it does not contain `..`.
 * Language and image ids may also be `models/<segment>` or
 * `tunedModels/<segment>` with that same segment rule.
 * The segment must be encoded when it is placed in the URL.
 */

const PLACEHOLDER_API_KEY = 'test-api-key';
const SPEECH_MODEL_ID = 'gemini-2.5-flash-preview-tts';
const LANGUAGE_MODEL_ID = 'gemini-2.5-flash';
const EMBEDDING_MODEL_ID = 'gemini-embedding-001';
const VIDEO_MODEL_ID = 'veo-3.1-generate-preview';
const IMAGE_MODEL_ID = 'gemini-2.5-flash-image';
const PROMPT: LanguageModelV4Prompt = [
  { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
];

const unsafeModelIds = [
  ['dot-dot slash', '../files/target'],
  ['dot-dot escaping the version prefix', '../../other-resource'],
  ['percent-encoded dot segments', '%2e%2e/%2e%2e/other-resource'],
  ['uppercase percent-encoded dot segments', '%2E%2E/%2E%2E/other-resource'],
  ['backslash separators', '..\\..\\other-resource'],
  ['query delimiter', `${SPEECH_MODEL_ID}?injected=1`],
  ['fragment delimiter', `${SPEECH_MODEL_ID}#frag`],
  ['additional path segment', 'foo/bar'],
  ['prefixed traversal', 'models/../files/abc'],
] as const;

// Image generation rejects ids that do not start with `gemini-` before fetch.
// These still pass that check and are rewritten by the URL parser.
const unsafeGeminiPrefixedModelIds = [
  ['prefixed traversal', `${IMAGE_MODEL_ID}/../files/abc`],
  ['query delimiter', `${IMAGE_MODEL_ID}?injected=1`],
  ['fragment delimiter', `${IMAGE_MODEL_ID}#frag`],
  ['backslash separators', `${IMAGE_MODEL_ID}\\..\\files\\abc`],
  ['percent-encoded dot segments', `gemini-2.5-flash-image/%2e%2e/files/abc`],
] as const;

type RecordedRequest = {
  method: string;
  url: string;
  sentApiKey: boolean;
};

function isNodeRuntime(): boolean {
  const runtimeProcess = globalThis.process as
    | {
        release?: { name?: string };
        title?: string;
        versions?: { bun?: string; deno?: string };
      }
    | undefined;

  return (
    runtimeProcess?.release?.name === 'node' &&
    runtimeProcess.versions?.bun == null &&
    runtimeProcess.versions?.deno == null &&
    runtimeProcess.title !== 'workerd' &&
    !('EdgeRuntime' in globalThis)
  );
}

function encodedPath(modelId: string, suffix: string): string {
  return `/v1beta/models/${encodeURIComponent(modelId)}:${suffix}`;
}

describe.skipIf(!isNodeRuntime())(
  'credentialed Google model ids stay on one encoded path segment',
  () => {
    const recorded: RecordedRequest[] = [];
    let baseURL = '';
    let closeServer: () => Promise<void> = async () => {};

    beforeAll(async () => {
      const { createServer } = await import('node:http');
      const server = createServer((request, response) => {
        const url = request.url ?? '';
        recorded.push({
          method: request.method ?? '',
          url,
          sentApiKey: request.headers['x-goog-api-key'] === PLACEHOLDER_API_KEY,
        });

        if (url.includes(':streamGenerateContent')) {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(
            'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]},"finishReason":"STOP"}]}\n\n',
          );
          return;
        }

        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: 'Hi',
                      inlineData: {
                        mimeType: 'audio/L16;rate=24000',
                        data: 'AQIDBAUGBwg=',
                      },
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            embedding: { values: [0.1] },
            embeddings: [{ values: [0.1] }, { values: [0.2] }],
            name: 'operations/op-1',
          }),
        );
      });

      await new Promise<void>(resolve => {
        server.listen(0, '127.0.0.1', () => resolve());
      });
      const address = server.address();
      if (address == null || typeof address === 'string') {
        throw new Error('Expected the test server to listen on a TCP port');
      }
      baseURL = `http://127.0.0.1:${address.port}/v1beta`;
      closeServer = () =>
        new Promise(resolve => {
          server.close(() => resolve());
        });
    });

    beforeEach(() => {
      recorded.length = 0;
    });

    afterAll(async () => {
      await closeServer();
    });

    function provider() {
      return createGoogle({
        apiKey: PLACEHOLDER_API_KEY,
        baseURL,
      });
    }

    async function expectRefused(run: () => PromiseLike<unknown>) {
      let error: unknown;
      try {
        await run();
      } catch (caught) {
        error = caught;
      }

      expect(recorded).toEqual([]);
      expect(error).toBeInstanceOf(Error);
    }

    function expectCredentialed(url: string) {
      expect(recorded).toEqual([{ method: 'POST', url, sentApiKey: true }]);
    }

    describe('speech doGenerate', () => {
      const entryPoints = {
        speech: (modelId: string) => provider().speech(modelId),
        speechModel: (modelId: string) => provider().speechModel(modelId),
        workflowDeserialize: (modelId: string) =>
          GoogleSpeechModel[WORKFLOW_DESERIALIZE]({
            modelId,
            config: {
              provider: 'google.generative-ai.speech',
              baseURL,
              headers: () => ({ 'x-goog-api-key': PLACEHOLDER_API_KEY }),
            },
          }),
      };

      for (const [entryName, createModel] of Object.entries(entryPoints)) {
        describe(entryName, () => {
          it('encodes one safe model id and sends the API key only on that path', async () => {
            const result = await createModel(SPEECH_MODEL_ID).doGenerate({
              text: 'Hello',
            });

            const audio = result.audio;
            expect(
              typeof audio === 'string' ? audio.length : audio.byteLength,
            ).toBeGreaterThan(0);
            expectCredentialed(encodedPath(SPEECH_MODEL_ID, 'generateContent'));
          });

          for (const [payloadName, modelId] of unsafeModelIds) {
            it(`refuses ${payloadName} before sending the API key`, async () => {
              await expectRefused(() =>
                createModel(modelId).doGenerate({ text: 'Hello' }),
              );
            });
          }
        });
      }
    });

    describe('embedding doEmbed', () => {
      it('encodes one safe model id on embedContent', async () => {
        await provider()
          .embedding(EMBEDDING_MODEL_ID)
          .doEmbed({
            values: ['hello'],
          });

        expectCredentialed(encodedPath(EMBEDDING_MODEL_ID, 'embedContent'));
      });

      it('encodes one safe model id on batchEmbedContents', async () => {
        await provider()
          .embedding(EMBEDDING_MODEL_ID)
          .doEmbed({
            values: ['hello', 'world'],
          });

        expectCredentialed(
          encodedPath(EMBEDDING_MODEL_ID, 'batchEmbedContents'),
        );
      });

      for (const [payloadName, modelId] of unsafeModelIds) {
        it(`refuses ${payloadName} on embedContent before sending the API key`, async () => {
          await expectRefused(() =>
            provider()
              .embedding(modelId)
              .doEmbed({ values: ['hello'] }),
          );
        });

        it(`refuses ${payloadName} on batchEmbedContents before sending the API key`, async () => {
          await expectRefused(() =>
            provider()
              .embedding(modelId)
              .doEmbed({ values: ['hello', 'world'] }),
          );
        });
      }

      for (const createModel of [
        (modelId: string) => provider().embeddingModel(modelId),
        (modelId: string) => provider().textEmbedding(modelId),
        (modelId: string) => provider().textEmbeddingModel(modelId),
      ]) {
        it('refuses dot-dot slash on the embedding alias before sending the API key', async () => {
          await expectRefused(() =>
            createModel('../files/target').doEmbed({ values: ['hello'] }),
          );
        });
      }
    });

    describe('video doStart', () => {
      const videoOptions = {
        prompt: 'A city',
        n: 1,
        aspectRatio: undefined,
        resolution: undefined,
        duration: undefined,
        fps: undefined,
        seed: undefined,
        image: undefined,
        frameImages: undefined,
        inputReferences: undefined,
        generateAudio: undefined,
        providerOptions: {},
      };

      async function startVideo(
        model: ReturnType<ReturnType<typeof provider>['video']>,
      ) {
        if (model.doStart == null) {
          throw new Error('Google video models implement doStart');
        }
        return model.doStart(videoOptions);
      }

      for (const [entryName, createModel] of [
        ['video', (modelId: string) => provider().video(modelId)],
        ['videoModel', (modelId: string) => provider().videoModel(modelId)],
      ] as const) {
        describe(entryName, () => {
          it('encodes one safe model id on predictLongRunning', async () => {
            await startVideo(createModel(VIDEO_MODEL_ID));

            expectCredentialed(
              encodedPath(VIDEO_MODEL_ID, 'predictLongRunning'),
            );
          });

          for (const [payloadName, modelId] of unsafeModelIds) {
            it(`refuses ${payloadName} before sending the API key`, async () => {
              await expectRefused(() => startVideo(createModel(modelId)));
            });
          }
        });
      }
    });

    describe('language model URLs', () => {
      it('encodes a bare model id on generateContent', async () => {
        await provider().languageModel(LANGUAGE_MODEL_ID).doGenerate({
          prompt: PROMPT,
        });

        expectCredentialed(encodedPath(LANGUAGE_MODEL_ID, 'generateContent'));
      });

      it('keeps a models/ id on one encoded segment', async () => {
        await provider()
          .languageModel(`models/${LANGUAGE_MODEL_ID}`)
          .doGenerate({ prompt: PROMPT });

        expectCredentialed(encodedPath(LANGUAGE_MODEL_ID, 'generateContent'));
      });

      it('keeps a tunedModels/ id on one encoded segment', async () => {
        await provider()
          .languageModel('tunedModels/some-model')
          .doGenerate({ prompt: PROMPT });

        expect(recorded).toEqual([
          {
            method: 'POST',
            url: `/v1beta/tunedModels/${encodeURIComponent('some-model')}:generateContent`,
            sentApiKey: true,
          },
        ]);
      });

      it('encodes a bare model id on streamGenerateContent', async () => {
        const result = await provider()
          .languageModel(LANGUAGE_MODEL_ID)
          .doStream({ prompt: PROMPT });
        await result.stream.cancel();

        expectCredentialed(
          `${encodedPath(LANGUAGE_MODEL_ID, 'streamGenerateContent')}?alt=sse`,
        );
      });

      for (const [payloadName, modelId] of [
        ...unsafeModelIds,
        ['tuned model traversal', 'tunedModels/../../other-resource'],
        ['extra segment under models', `models/${LANGUAGE_MODEL_ID}/extra`],
      ] as const) {
        it(`refuses ${payloadName} on generateContent before sending the API key`, async () => {
          await expectRefused(() =>
            provider().languageModel(modelId).doGenerate({ prompt: PROMPT }),
          );
        });

        it(`refuses ${payloadName} on streamGenerateContent before sending the API key`, async () => {
          await expectRefused(() =>
            provider().languageModel(modelId).doStream({ prompt: PROMPT }),
          );
        });
      }

      for (const createModel of [
        (modelId: string) => provider()(modelId),
        (modelId: string) => provider().chat(modelId),
      ]) {
        it('refuses dot-dot slash on the chat alias before sending the API key', async () => {
          await expectRefused(() =>
            createModel('../files/target').doGenerate({ prompt: PROMPT }),
          );
        });
      }
    });

    describe('image doGenerate', () => {
      const imageOptions = {
        prompt: 'A sunset',
        n: 1,
        files: undefined,
        mask: undefined,
        size: undefined,
        aspectRatio: undefined,
        seed: undefined,
        providerOptions: {},
      };

      it('encodes one safe gemini image model id', async () => {
        await provider().image(IMAGE_MODEL_ID).doGenerate(imageOptions);

        expectCredentialed(encodedPath(IMAGE_MODEL_ID, 'generateContent'));
      });

      for (const [payloadName, modelId] of unsafeGeminiPrefixedModelIds) {
        it(`refuses ${payloadName} before sending the API key`, async () => {
          await expectRefused(() =>
            provider().imageModel(modelId).doGenerate(imageOptions),
          );
        });
      }
    });
  },
);
