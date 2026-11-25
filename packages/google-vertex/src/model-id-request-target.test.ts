import type { IncomingMessage, Server } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGoogleVertexAnthropic } from './anthropic/google-vertex-anthropic-provider-node';
import { createGoogleVertex } from './google-vertex-provider';

/**
 * Model ids are caller input. These tests require that a credentialed Vertex
 * request is sent only for a single checked model segment. They fail while
 * path, query, fragment, or backslash characters in the id are copied into
 * the request URL.
 */
vi.mock('google-auth-library', () => {
  class GoogleAuth {
    async getClient() {
      return {
        async getAccessToken() {
          return { token: 'test-bearer-token' };
        },
      };
    }
  }

  return { GoogleAuth };
});

const isEdgeRuntime =
  (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime !== undefined;

const apiKey = 'test-api-key';
const bearer = 'test-bearer-token';

const prompt = [
  {
    role: 'user' as const,
    content: [{ type: 'text' as const, text: 'Hello' }],
  },
];

const unsafeModelIds = [
  [
    'parent-segments',
    `../../../../../OTHER/locations/us/publishers/google/models/gemini-2.5-flash`,
  ],
  [
    'encoded-parent-segments',
    `%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/OTHER/locations/us/publishers/google/models/gemini-2.5-flash`,
  ],
  ['models-prefix-encoded-parent', 'models/%2e%2e/secret'],
  ['question-mark', 'gemini-2.5-flash?other=1'],
  ['hash', 'gemini-2.5-flash#x'],
  ['backslash', '..\\..\\other-api'],
] as const;

const projectBasePath =
  '/v1beta1/projects/PROJ/locations/us-central1/publishers/google';

type Hit = {
  url: string;
  credential: 'api-key' | 'bearer' | 'other' | 'none';
};

function credentialOf(request: IncomingMessage): Hit['credential'] {
  if (request.headers['x-goog-api-key'] === apiKey) {
    return 'api-key';
  }
  if (request.headers.authorization === `Bearer ${bearer}`) {
    return 'bearer';
  }
  if (
    request.headers['x-goog-api-key'] != null ||
    request.headers.authorization != null
  ) {
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

describe.skipIf(isEdgeRuntime)('Vertex model id request target', () => {
  beforeEach(() => {
    delete process.env.GOOGLE_VERTEX_API_KEY;
    delete process.env.GOOGLE_VERTEX_PROJECT;
    delete process.env.GOOGLE_VERTEX_LOCATION;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  });

  const expressOperations = [
    {
      name: 'express chat generateContent',
      invoke: (modelId: string, baseURL: string) =>
        createGoogleVertex({ apiKey, baseURL })(modelId).doGenerate({
          prompt,
        }),
    },
    {
      name: 'express chat streamGenerateContent',
      invoke: (modelId: string, baseURL: string) =>
        createGoogleVertex({ apiKey, baseURL })(modelId).doStream({ prompt }),
    },
  ];

  for (const operation of expressOperations) {
    for (const [label, modelId] of unsafeModelIds) {
      it(`${operation.name} does not send a credentialed request for a ${label} model id`, async () => {
        const hits = await capture(origin =>
          operation.invoke(modelId, `${origin}/v1/publishers/google`),
        );

        expect(hits).toEqual([]);
      });
    }
  }

  const projectOperations = [
    {
      name: 'oauth chat generateContent',
      invoke: (modelId: string, baseURL: string) =>
        createGoogleVertex({
          project: 'PROJ',
          location: 'us-central1',
          baseURL,
        })(modelId).doGenerate({ prompt }),
    },
    {
      name: 'oauth chat streamGenerateContent',
      invoke: (modelId: string, baseURL: string) =>
        createGoogleVertex({
          project: 'PROJ',
          location: 'us-central1',
          baseURL,
        })(modelId).doStream({ prompt }),
    },
    {
      name: 'embedding predict',
      invoke: (modelId: string, baseURL: string) =>
        createGoogleVertex({
          project: 'PROJ',
          location: 'us-central1',
          baseURL,
        })
          .embeddingModel(modelId)
          .doEmbed({ values: ['Hello'] }),
    },
    {
      name: 'video predictLongRunning',
      invoke: (modelId: string, baseURL: string) =>
        createGoogleVertex({
          project: 'PROJ',
          location: 'us-central1',
          baseURL,
        })
          .videoModel(modelId)
          .doStart?.({
            prompt: 'Hello',
            n: 1,
            providerOptions: {},
          }),
    },
    {
      name: 'video fetchPredictOperation',
      invoke: (modelId: string, baseURL: string) =>
        createGoogleVertex({
          project: 'PROJ',
          location: 'us-central1',
          baseURL,
        })
          .videoModel(modelId)
          .doStatus?.({
            operation: { operationName: 'operations/example' },
          }),
    },
    {
      name: 'speech generateContent',
      invoke: (modelId: string, baseURL: string) =>
        createGoogleVertex({
          project: 'PROJ',
          location: 'us-central1',
          baseURL,
        })
          .speechModel(modelId)
          .doGenerate({
            text: 'Hello',
            voice: 'Kore',
          }),
    },
    {
      name: 'gemini transcription generateContent',
      invoke: (modelId: string, baseURL: string) =>
        createGoogleVertex({
          project: 'PROJ',
          location: 'us-central1',
          baseURL,
        })
          .transcriptionModel(
            modelId.startsWith('gemini') ? modelId : `gemini-${modelId}`,
          )
          .doGenerate({
            audio: new Uint8Array([1, 2, 3, 4]),
            mediaType: 'audio/wav',
          }),
    },
  ];

  for (const operation of projectOperations) {
    for (const [label, modelId] of unsafeModelIds) {
      it(`${operation.name} does not send a credentialed request for a ${label} model id`, async () => {
        const hits = await capture(origin =>
          operation.invoke(modelId, `${origin}${projectBasePath}`),
        );

        expect(hits).toEqual([]);
      });
    }
  }

  const imageUnsafeModelIds = [
    [
      'parent-segments',
      `gemini-2.5-flash-image/${'../'.repeat(7)}OTHER/locations/us/publishers/google/models/gemini-2.5-flash-image`,
    ],
    [
      'encoded-parent-segments',
      `gemini-${'%2e%2e/'.repeat(7)}OTHER/locations/us/publishers/google/models/gemini-2.5-flash-image`,
    ],
    ['question-mark', 'gemini-2.5-flash-image?other=1'],
    ['hash', 'gemini-2.5-flash-image#x'],
    ['backslash', 'gemini-..\\..\\other-api'],
  ] as const;

  for (const [label, modelId] of imageUnsafeModelIds) {
    it(`image generateContent does not send a credentialed request for a ${label} model id`, async () => {
      const hits = await capture(origin =>
        createGoogleVertex({
          project: 'PROJ',
          location: 'us-central1',
          baseURL: `${origin}${projectBasePath}`,
        })
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

  const anthropicUnsafeModelIds = [
    [
      'parent-segments',
      `${'../'.repeat(6)}OTHER/locations/us/publishers/anthropic/models/claude-3-5-sonnet`,
    ],
    [
      'encoded-parent-segments',
      `${'%2e%2e/'.repeat(6)}OTHER/locations/us/publishers/anthropic/models/claude-3-5-sonnet`,
    ],
    ['question-mark', 'claude-3-5-sonnet?other=1'],
    ['hash', 'claude-3-5-sonnet#x'],
    ['backslash', '..\\..\\other-api'],
  ] as const;

  for (const mode of ['generate', 'stream'] as const) {
    for (const [label, modelId] of anthropicUnsafeModelIds) {
      it(`anthropic ${mode} does not send a credentialed request for a ${label} model id`, async () => {
        const hits = await capture(origin => {
          const model = createGoogleVertexAnthropic({
            project: 'PROJ',
            location: 'us-central1',
            baseURL: `${origin}/v1/projects/PROJ/locations/us-central1/publishers/anthropic/models`,
            generateAuthToken: async () => bearer,
          })(modelId);
          const options = { prompt, maxOutputTokens: 16 };
          return mode === 'generate'
            ? model.doGenerate(options)
            : model.doStream(options);
        });

        expect(hits).toEqual([]);
      });
    }
  }

  it('express chat sends the API key only to the configured model method', async () => {
    const hits = await capture(origin =>
      createGoogleVertex({
        apiKey,
        baseURL: `${origin}/v1/publishers/google`,
      })('gemini-2.5-flash').doGenerate({ prompt }),
    );

    expect(hits).toEqual([
      {
        url: '/v1/publishers/google/models/gemini-2.5-flash:generateContent',
        credential: 'api-key',
      },
    ]);
  });

  it('oauth chat sends the bearer token only to the configured model method', async () => {
    const hits = await capture(origin =>
      createGoogleVertex({
        project: 'PROJ',
        location: 'us-central1',
        baseURL: `${origin}${projectBasePath}`,
      })('gemini-2.5-flash').doGenerate({ prompt }),
    );

    expect(hits).toEqual([
      {
        url: `${projectBasePath}/models/gemini-2.5-flash:generateContent`,
        credential: 'bearer',
      },
    ]);
  });

  it('oauth chat sends the bearer token only to one endpoint segment', async () => {
    const hits = await capture(origin =>
      createGoogleVertex({
        project: 'PROJ',
        location: 'us-central1',
        baseURL: `${origin}/v1beta1/projects/PROJ/locations/us-central1`,
      })('endpoints/123456').doGenerate({ prompt }),
    );

    expect(hits).toEqual([
      {
        url: '/v1beta1/projects/PROJ/locations/us-central1/endpoints/123456:generateContent',
        credential: 'bearer',
      },
    ]);
  });

  it('endpoint ids cannot escape the configured project', async () => {
    const hits = await capture(origin =>
      createGoogleVertex({
        project: 'PROJ',
        location: 'us-central1',
        baseURL: `${origin}/v1beta1/projects/PROJ/locations/us-central1`,
      })(
        `endpoints/${'../'.repeat(4)}OTHER/locations/us/publishers/google/models/gemini-2.5-flash`,
      ).doGenerate({ prompt }),
    );

    expect(hits).toEqual([]);
  });

  it('encoded endpoint ids cannot escape the configured project', async () => {
    const hits = await capture(origin =>
      createGoogleVertex({
        project: 'PROJ',
        location: 'us-central1',
        baseURL: `${origin}/v1beta1/projects/PROJ/locations/us-central1`,
      })(
        `endpoints/${'%2e%2e/'.repeat(4)}OTHER/locations/us/publishers/google/models/gemini-2.5-flash`,
      ).doGenerate({ prompt }),
    );

    expect(hits).toEqual([]);
  });

  it('embedding keeps an @ model id in one segment', async () => {
    const hits = await capture(origin =>
      createGoogleVertex({
        project: 'PROJ',
        location: 'us-central1',
        baseURL: `${origin}${projectBasePath}`,
      })
        .embeddingModel('textembedding-gecko@001')
        .doEmbed({ values: ['Hello'] }),
    );

    expect(hits).toEqual([
      {
        url: `${projectBasePath}/models/textembedding-gecko@001:predict`,
        credential: 'bearer',
      },
    ]);
  });

  it('anthropic sends the bearer token only to one model segment', async () => {
    const hits = await capture(origin =>
      createGoogleVertexAnthropic({
        project: 'PROJ',
        location: 'us-central1',
        baseURL: `${origin}/v1/projects/PROJ/locations/us-central1/publishers/anthropic/models`,
        generateAuthToken: async () => bearer,
      })('claude-3-5-sonnet@20240620').doGenerate({
        prompt,
        maxOutputTokens: 16,
      }),
    );

    expect(hits).toEqual([
      {
        url: '/v1/projects/PROJ/locations/us-central1/publishers/anthropic/models/claude-3-5-sonnet@20240620:rawPredict',
        credential: 'bearer',
      },
    ]);
  });
});
