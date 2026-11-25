import type { IncomingMessage, Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createGoogle } from './google-provider';

/**
 * Model ids are caller input. These tests require that a credentialed Google
 * request is sent only for a single checked model segment. They fail while
 * path, query, fragment, or backslash characters in the id are copied into
 * the request URL.
 */
const isEdgeRuntime =
  (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime !== undefined;

const apiKey = 'test-api-key';

const prompt = [
  {
    role: 'user' as const,
    content: [{ type: 'text' as const, text: 'Hello' }],
  },
];

const unsafeModelIds = [
  ['parent-segments', '../../other-api/v1/projects/victim'],
  ['encoded-parent-segments', '%2e%2e/%2e%2e/other-api'],
  ['models-prefix-encoded-parent', 'models/%2e%2e/secret'],
  ['tuned-prefix-encoded-parent', 'tunedModels/%2e%2e/secret'],
  ['question-mark', 'gemini-2.5-flash?other=1'],
  ['models-prefix-question-mark', 'models/gemini-2.5-flash?other=1'],
  ['hash', 'gemini-2.5-flash#x'],
  ['backslash', '..\\..\\other-api'],
] as const;

const imageUnsafeModelIds = [
  ['parent-segments', 'gemini-2.5-flash-image/../../../other-api'],
  ['encoded-parent-segments', 'gemini-%2e%2e/%2e%2e/%2e%2e/other-api'],
  ['question-mark', 'gemini-2.5-flash-image?other=1'],
  ['hash', 'gemini-2.5-flash-image#x'],
  ['backslash', 'gemini-..\\..\\other-api'],
] as const;

type Hit = {
  url: string;
  credential: 'api-key' | 'other' | 'none';
};

function credentialOf(request: IncomingMessage): Hit['credential'] {
  const header = request.headers['x-goog-api-key'];
  if (header === apiKey) {
    return 'api-key';
  }
  if (header != null) {
    return 'other';
  }
  return 'none';
}

async function capture(
  run: (origin: string) => Promise<unknown>,
): Promise<Hit[]> {
  const { createServer } = await import('node:http');
  const hits: Hit[] = [];
  const server: Server = createServer((request, response) => {
    hits.push({
      url: request.url ?? '',
      credential: credentialOf(request),
    });
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address == null || typeof address === 'string') {
    server.close();
    throw new Error('Test server did not bind to a TCP port.');
  }

  try {
    const result = await run(`http://127.0.0.1:${address.port}`);
    if (
      result != null &&
      typeof result === 'object' &&
      'stream' in result &&
      result.stream instanceof ReadableStream
    ) {
      await result.stream.cancel();
    }
  } catch {
    // The local server does not speak the provider protocol. The assertion
    // is the request that was sent before parsing failed.
  } finally {
    await new Promise<void>(resolve => {
      server.close(() => resolve());
    });
  }

  return hits;
}

describe.skipIf(isEdgeRuntime)('Google model id request target', () => {
  const chatOperations = [
    {
      name: 'chat generateContent',
      invoke: (modelId: string, baseURL: string) =>
        createGoogle({ apiKey, baseURL })(modelId).doGenerate({ prompt }),
    },
    {
      name: 'chat streamGenerateContent',
      invoke: (modelId: string, baseURL: string) =>
        createGoogle({ apiKey, baseURL })(modelId).doStream({ prompt }),
    },
    {
      name: 'evaluation',
      invoke: (modelId: string, baseURL: string) =>
        createGoogle({ apiKey, baseURL })
          .evaluationModel(modelId)
          .doEvaluate({
            state: { answer: 'Hello' },
            questions: {
              ok: {
                type: 'boolean',
                instructions: 'Is the answer present?',
              },
            },
          }),
    },
    {
      name: 'batch batchGenerateContent',
      invoke: (modelId: string, baseURL: string) =>
        createGoogle({ apiKey, baseURL })
          .experimental_batch()
          .doStartBatch({
            requests: [
              {
                id: 'request-1',
                type: 'text',
                modelId,
                options: { prompt },
              },
            ],
          }),
    },
    {
      name: 'embedding embedContent',
      invoke: (modelId: string, baseURL: string) =>
        createGoogle({ apiKey, baseURL })
          .embeddingModel(modelId)
          .doEmbed({ values: ['Hello'] }),
    },
    {
      name: 'embedding batchEmbedContents',
      invoke: (modelId: string, baseURL: string) =>
        createGoogle({ apiKey, baseURL })
          .embeddingModel(modelId)
          .doEmbed({ values: ['Hello', 'World'] }),
    },
    {
      name: 'speech generateContent',
      invoke: (modelId: string, baseURL: string) =>
        createGoogle({ apiKey, baseURL }).speechModel(modelId).doGenerate({
          text: 'Hello',
          voice: 'Kore',
        }),
    },
    {
      name: 'video predictLongRunning',
      invoke: (modelId: string, baseURL: string) =>
        createGoogle({ apiKey, baseURL }).videoModel(modelId).doStart?.({
          prompt: 'Hello',
          n: 1,
          providerOptions: {},
        }),
    },
  ];

  for (const operation of chatOperations) {
    for (const [label, modelId] of unsafeModelIds) {
      it(`${operation.name} does not send a credentialed request for a ${label} model id`, async () => {
        const hits = await capture(origin =>
          operation.invoke(modelId, `${origin}/v1beta`),
        );

        expect(hits).toEqual([]);
      });
    }
  }

  for (const [label, modelId] of imageUnsafeModelIds) {
    it(`image generateContent does not send a credentialed request for a ${label} model id`, async () => {
      const hits = await capture(origin =>
        createGoogle({ apiKey, baseURL: `${origin}/v1beta` })
          .imageModel(modelId)
          .doGenerate({
            prompt: 'Hello',
            n: 1,
            providerOptions: {},
          }),
      );

      expect(hits).toEqual([]);
    });
  }

  it('sends the API key only to the bare model generateContent method', async () => {
    const hits = await capture(origin =>
      createGoogle({
        apiKey,
        baseURL: `${origin}/v1beta`,
      })('gemini-2.5-flash').doGenerate({ prompt }),
    );

    expect(hits).toEqual([
      {
        url: '/v1beta/models/gemini-2.5-flash:generateContent',
        credential: 'api-key',
      },
    ]);
  });

  it('sends the API key only to an explicit models segment', async () => {
    const hits = await capture(origin =>
      createGoogle({
        apiKey,
        baseURL: `${origin}/v1beta`,
      })('models/gemini-2.5-flash').doGenerate({ prompt }),
    );

    expect(hits).toEqual([
      {
        url: '/v1beta/models/gemini-2.5-flash:generateContent',
        credential: 'api-key',
      },
    ]);
  });

  it('sends the API key only to an explicit tunedModels segment', async () => {
    const hits = await capture(origin =>
      createGoogle({
        apiKey,
        baseURL: `${origin}/v1beta`,
      })('tunedModels/my-tuned-model').doGenerate({ prompt }),
    );

    expect(hits).toEqual([
      {
        url: '/v1beta/tunedModels/my-tuned-model:generateContent',
        credential: 'api-key',
      },
    ]);
  });

  it('keeps the stream method and alt query on a bare model id', async () => {
    const hits = await capture(origin =>
      createGoogle({
        apiKey,
        baseURL: `${origin}/v1beta`,
      })('gemini-2.5-flash').doStream({ prompt }),
    );

    expect(hits).toEqual([
      {
        url: '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
        credential: 'api-key',
      },
    ]);
  });
});
