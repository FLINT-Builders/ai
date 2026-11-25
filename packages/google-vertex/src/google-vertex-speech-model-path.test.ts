import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { GoogleVertexProvider } from './google-vertex-provider-base';

vi.mock(
  '@ai-sdk/google/internal',
  () => import('../../google/src/internal/index'),
);

/**
 * Vertex Gemini speech uses GoogleSpeechModel. Express mode adds the API key
 * in the fetch wrapper after the model id has already been placed in the URL.
 * These tests fail while that id can retarget the credentialed request.
 *
 * Chirp speech is not covered: its synthesize URL does not include the model id.
 */

const PLACEHOLDER_API_KEY = 'test-api-key';
const SPEECH_MODEL_ID = 'gemini-2.5-flash-tts';

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

describe.skipIf(!isNodeRuntime())(
  'Vertex Gemini speech model ids stay on one encoded path segment',
  () => {
    const recorded: RecordedRequest[] = [];
    let baseURL = '';
    let closeServer: () => Promise<void> = async () => {};
    let createGoogleVertex: (options: {
      apiKey: string;
      baseURL: string;
    }) => GoogleVertexProvider;

    beforeAll(async () => {
      ({ createGoogleVertex } = await import('./google-vertex-provider-base'));
      const { createServer } = await import('node:http');
      const server = createServer((request, response) => {
        recorded.push({
          method: request.method ?? '',
          url: request.url ?? '',
          sentApiKey: request.headers['x-goog-api-key'] === PLACEHOLDER_API_KEY,
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'audio/L16;rate=24000',
                        data: 'AQIDBAUGBwg=',
                      },
                    },
                  ],
                },
              },
            ],
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
      return createGoogleVertex({
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

    for (const [entryName, createModel] of [
      ['speech', (modelId: string) => provider().speech(modelId)],
      ['speechModel', (modelId: string) => provider().speechModel(modelId)],
    ] as const) {
      describe(entryName, () => {
        it('encodes one safe model id and sends the API key only on that path', async () => {
          const result = await createModel(SPEECH_MODEL_ID).doGenerate({
            text: 'Hello',
          });

          const audio = result.audio;
          expect(
            typeof audio === 'string' ? audio.length : audio.byteLength,
          ).toBeGreaterThan(0);
          expect(recorded).toEqual([
            {
              method: 'POST',
              url: `/v1beta/models/${encodeURIComponent(SPEECH_MODEL_ID)}:generateContent`,
              sentApiKey: true,
            },
          ]);
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
  },
);
