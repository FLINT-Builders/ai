import { createServer, type Server } from 'node:http';
import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { createGoogle, type GoogleProvider } from './google-provider';

/**
 * Spec for credentialed Google Generative Language requests that embed a
 * caller-supplied model id or operation id in the URL.
 *
 * These tests fail while an id can change the path or query that receives
 * the API key. A fix should refuse any id that is not one safe path segment
 * (or, where a collection prefix is part of the public id, one safe segment
 * under that collection) before a request is sent, and encode that segment.
 */

const PLACEHOLDER_API_KEY = 'placeholder-google-api-key';

const PROMPT: LanguageModelV4Prompt = [
  { role: 'user', content: [{ type: 'text', text: 'hello' }] },
];

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const UNSAFE_MODEL_IDS = [
  '../../other-resource',
  '../../v1beta/models/gemini-2.0-flash:generateContent?',
  'veo-3.1-generate-preview?injected=1',
  'veo-3.1-generate-preview#fragment',
  '%2e%2e/%2e%2e/other-resource',
  '..\\..\\other-resource',
  'veo-3.1-generate-preview/extra',
] as const;

type Target = { pathname: string; search: string };

type ObservedRequest = {
  method: string | undefined;
  origin: string;
  pathname: string;
  search: string;
  apiKey: string | undefined;
};

function singleSegmentTarget(
  modelId: string,
  method: string,
  search = '',
): Target | null {
  if (!SAFE_SEGMENT.test(modelId)) {
    return null;
  }

  return {
    pathname: `/v1beta/models/${encodeURIComponent(modelId)}${method}`,
    search,
  };
}

function collectionSegmentTarget(
  modelId: string,
  method: string,
  search = '',
): Target | null {
  const direct = singleSegmentTarget(modelId, method, search);
  if (direct != null) {
    return direct;
  }

  const prefixed =
    /^(models|tunedModels)\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(modelId);
  if (prefixed == null) {
    return null;
  }

  return {
    pathname: `/v1beta/${prefixed[1]}/${encodeURIComponent(prefixed[2])}${method}`,
    search,
  };
}

function operationTarget(operationName: string): Target | null {
  const match = /^operations\/([A-Za-z0-9][A-Za-z0-9._-]{0,200})$/.exec(
    operationName,
  );
  if (match == null) {
    return null;
  }

  return {
    pathname: `/v1beta/operations/${encodeURIComponent(match[1])}`,
    search: '',
  };
}

function batchIdTarget(batchId: string, suffix = ''): Target | null {
  const match = /^batches\/([A-Za-z0-9][A-Za-z0-9._-]{0,200})$/.exec(batchId);
  if (match == null) {
    return null;
  }

  return {
    pathname: `/v1beta/batches/${encodeURIComponent(match[1])}${suffix}`,
    search: '',
  };
}

async function attempt(work: Promise<unknown>): Promise<void> {
  try {
    const result = (await work) as {
      stream?: { cancel?: () => Promise<void> };
    };
    await result?.stream?.cancel?.();
  } catch {
    // Parsing the local stand-in response is not the behavior under test.
  }
}

async function observe(
  run: (baseURL: string, provider: GoogleProvider) => Promise<void>,
): Promise<{ baseURL: string; requests: ObservedRequest[] }> {
  const requests: ObservedRequest[] = [];
  const server: Server = createServer((request, response) => {
    const host = request.headers.host ?? '127.0.0.1';
    const url = new URL(request.url ?? '/', `http://${host}`);
    const apiKey = request.headers['x-goog-api-key'];
    requests.push({
      method: request.method,
      origin: `http://${host}`,
      pathname: url.pathname,
      search: url.search,
      apiKey: Array.isArray(apiKey) ? apiKey[0] : apiKey,
    });
    response.writeHead(200, {
      'content-type': 'application/json',
      connection: 'close',
    });
    response.end(
      JSON.stringify({
        name: 'operations/ok',
        done: false,
        candidates: [],
        embedding: { values: [0] },
        embeddings: [{ values: [0] }],
      }),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (address == null || typeof address === 'string') {
    server.close();
    throw new Error('Test server did not bind to a TCP port.');
  }

  const baseURL = `http://127.0.0.1:${address.port}/v1beta`;
  const provider = createGoogle({
    apiKey: PLACEHOLDER_API_KEY,
    baseURL,
  });

  try {
    await run(baseURL, provider);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  return { baseURL, requests };
}

function expectPinned(
  baseURL: string,
  requests: ObservedRequest[],
  target: Target | null,
): void {
  if (target == null) {
    expect(requests).toEqual([]);
    return;
  }

  const origin = new URL(baseURL).origin;
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    expect(request.origin).toBe(origin);
    expect(request.pathname).toBe(target.pathname);
    expect(request.search).toBe(target.search);
    expect(request.apiKey).toBe(PLACEHOLDER_API_KEY);
  }
}

describe('Google credentialed model-id request targets', () => {
  describe('video doStart', () => {
    it('posts a safe model id only to its predictLongRunning method', async () => {
      const modelId = 'veo-3.1-generate-preview';
      const { baseURL, requests } = await observe(
        async (_baseURL, provider) => {
          await attempt(
            provider.video(modelId).doStart({
              prompt: 'a city',
              n: 1,
              providerOptions: {},
            }),
          );
        },
      );

      expectPinned(
        baseURL,
        requests,
        singleSegmentTarget(modelId, ':predictLongRunning'),
      );
      expect(requests[0]?.method).toBe('POST');
    });

    it.each(UNSAFE_MODEL_IDS)(
      'does not send the API key for video model id %j',
      async modelId => {
        const { baseURL, requests } = await observe(
          async (_baseURL, provider) => {
            await attempt(
              provider.video(modelId).doStart({
                prompt: 'a city',
                n: 1,
                providerOptions: {},
              }),
            );
          },
        );

        expectPinned(
          baseURL,
          requests,
          singleSegmentTarget(modelId, ':predictLongRunning'),
        );
      },
    );
  });

  describe('video doStatus', () => {
    it('polls a safe operation name under /v1beta/operations', async () => {
      const operationName = 'operations/job-1';
      const { baseURL, requests } = await observe(
        async (_baseURL, provider) => {
          await attempt(
            provider.video('veo-3.1-generate-preview').doStatus({
              operation: { operationName },
            }),
          );
        },
      );

      expectPinned(baseURL, requests, operationTarget(operationName));
      expect(requests[0]?.method).toBe('GET');
    });

    it.each([
      '../../other-resource',
      'operations/job-1?injected=1',
      'operations/job-1#fragment',
      '%2e%2e/%2e%2e/other-resource',
      '..\\..\\other-resource',
      'models/veo-3.1-generate-preview/operations/../../other-resource?',
    ])(
      'does not send the API key for operation name %j',
      async operationName => {
        const { baseURL, requests } = await observe(
          async (_baseURL, provider) => {
            await attempt(
              provider.video('veo-3.1-generate-preview').doStatus({
                operation: { operationName },
              }),
            );
          },
        );

        expectPinned(baseURL, requests, operationTarget(operationName));
      },
    );
  });

  describe('embedding doEmbed', () => {
    it('embeds one value with a safe model id', async () => {
      const modelId = 'gemini-embedding-001';
      const { baseURL, requests } = await observe(
        async (_baseURL, provider) => {
          await attempt(
            provider.embedding(modelId).doEmbed({ values: ['hello'] }),
          );
        },
      );

      expectPinned(
        baseURL,
        requests,
        singleSegmentTarget(modelId, ':embedContent'),
      );
    });

    it.each(UNSAFE_MODEL_IDS)(
      'does not send the API key for single embed model id %j',
      async modelId => {
        const { baseURL, requests } = await observe(
          async (_baseURL, provider) => {
            await attempt(
              provider.embedding(modelId).doEmbed({ values: ['hello'] }),
            );
          },
        );

        expectPinned(
          baseURL,
          requests,
          singleSegmentTarget(modelId, ':embedContent'),
        );
      },
    );

    it('embeds many values with a safe model id', async () => {
      const modelId = 'gemini-embedding-001';
      const { baseURL, requests } = await observe(
        async (_baseURL, provider) => {
          await attempt(
            provider.embedding(modelId).doEmbed({ values: ['one', 'two'] }),
          );
        },
      );

      expectPinned(
        baseURL,
        requests,
        singleSegmentTarget(modelId, ':batchEmbedContents'),
      );
    });

    it.each(UNSAFE_MODEL_IDS)(
      'does not send the API key for batch embed model id %j',
      async modelId => {
        const { baseURL, requests } = await observe(
          async (_baseURL, provider) => {
            await attempt(
              provider.embedding(modelId).doEmbed({ values: ['one', 'two'] }),
            );
          },
        );

        expectPinned(
          baseURL,
          requests,
          singleSegmentTarget(modelId, ':batchEmbedContents'),
        );
      },
    );
  });

  describe('speech doGenerate', () => {
    it('synthesizes with a safe model id', async () => {
      const modelId = 'gemini-2.5-flash-preview-tts';
      const { baseURL, requests } = await observe(
        async (_baseURL, provider) => {
          await attempt(provider.speech(modelId).doGenerate({ text: 'hello' }));
        },
      );

      expectPinned(
        baseURL,
        requests,
        singleSegmentTarget(modelId, ':generateContent'),
      );
    });

    it.each(UNSAFE_MODEL_IDS)(
      'does not send the API key for speech model id %j',
      async modelId => {
        const { baseURL, requests } = await observe(
          async (_baseURL, provider) => {
            await attempt(
              provider.speech(modelId).doGenerate({ text: 'hello' }),
            );
          },
        );

        expectPinned(
          baseURL,
          requests,
          singleSegmentTarget(modelId, ':generateContent'),
        );
      },
    );
  });

  describe('language model', () => {
    it.each([
      'gemini-2.5-flash',
      'models/gemini-2.5-flash',
      'tunedModels/my-tuned-model',
    ])('generates with model id %j on its own method', async modelId => {
      const { baseURL, requests } = await observe(
        async (_baseURL, provider) => {
          await attempt(
            provider.languageModel(modelId).doGenerate({ prompt: PROMPT }),
          );
        },
      );

      expectPinned(
        baseURL,
        requests,
        collectionSegmentTarget(modelId, ':generateContent'),
      );
    });

    it.each(UNSAFE_MODEL_IDS)(
      'does not send the API key for generateContent model id %j',
      async modelId => {
        const { baseURL, requests } = await observe(
          async (_baseURL, provider) => {
            await attempt(
              provider.languageModel(modelId).doGenerate({ prompt: PROMPT }),
            );
          },
        );

        expectPinned(
          baseURL,
          requests,
          collectionSegmentTarget(modelId, ':generateContent'),
        );
      },
    );

    it.each([
      'tunedModels/../../other:generateContent?',
      'models/%2e%2e/%2e%2e/other-resource',
    ])(
      'does not let a collection prefix escape for model id %j',
      async modelId => {
        const { baseURL, requests } = await observe(
          async (_baseURL, provider) => {
            await attempt(
              provider.languageModel(modelId).doGenerate({ prompt: PROMPT }),
            );
          },
        );

        expectPinned(
          baseURL,
          requests,
          collectionSegmentTarget(modelId, ':generateContent'),
        );
      },
    );

    it('streams a safe model id with only the alt=sse query', async () => {
      const modelId = 'gemini-2.5-flash';
      const { baseURL, requests } = await observe(
        async (_baseURL, provider) => {
          await attempt(
            provider.languageModel(modelId).doStream({ prompt: PROMPT }),
          );
        },
      );

      expectPinned(
        baseURL,
        requests,
        collectionSegmentTarget(modelId, ':streamGenerateContent', '?alt=sse'),
      );
    });

    it.each(UNSAFE_MODEL_IDS)(
      'does not send the API key for streamGenerateContent model id %j',
      async modelId => {
        const { baseURL, requests } = await observe(
          async (_baseURL, provider) => {
            await attempt(
              provider.languageModel(modelId).doStream({ prompt: PROMPT }),
            );
          },
        );

        expectPinned(
          baseURL,
          requests,
          collectionSegmentTarget(
            modelId,
            ':streamGenerateContent',
            '?alt=sse',
          ),
        );
      },
    );
  });

  describe('image doGenerate', () => {
    it('generates with a safe gemini image model id', async () => {
      const modelId = 'gemini-2.5-flash-image';
      const { baseURL, requests } = await observe(
        async (_baseURL, provider) => {
          await attempt(
            provider.image(modelId).doGenerate({ prompt: 'a red cube' }),
          );
        },
      );

      expectPinned(
        baseURL,
        requests,
        collectionSegmentTarget(modelId, ':generateContent'),
      );
    });

    it.each([
      'gemini-2.5-flash/../../other-resource?',
      'gemini-../../other-resource',
      'gemini-%2e%2e/%2e%2e/other-resource',
      'gemini-2.5-flash-image?injected=1',
      'gemini-2.5-flash-image#fragment',
    ])('does not send the API key for image model id %j', async modelId => {
      const { baseURL, requests } = await observe(
        async (_baseURL, provider) => {
          await attempt(
            provider.image(modelId).doGenerate({ prompt: 'a red cube' }),
          );
        },
      );

      expectPinned(
        baseURL,
        requests,
        collectionSegmentTarget(modelId, ':generateContent'),
      );
    });
  });

  describe('batch', () => {
    it('starts a batch for a safe model id', async () => {
      const modelId = 'gemini-2.5-flash';
      const { baseURL, requests } = await observe(
        async (_baseURL, provider) => {
          await attempt(
            provider.experimental_batch().doStartBatch({
              requests: [
                {
                  id: 'one',
                  type: 'text',
                  modelId,
                  options: { prompt: PROMPT },
                },
              ],
            }),
          );
        },
      );

      expectPinned(
        baseURL,
        requests,
        collectionSegmentTarget(modelId, ':batchGenerateContent'),
      );
    });

    it.each(UNSAFE_MODEL_IDS)(
      'does not send the API key for batch model id %j',
      async modelId => {
        const { baseURL, requests } = await observe(
          async (_baseURL, provider) => {
            await attempt(
              provider.experimental_batch().doStartBatch({
                requests: [
                  {
                    id: 'one',
                    type: 'text',
                    modelId,
                    options: { prompt: PROMPT },
                  },
                ],
              }),
            );
          },
        );

        expectPinned(
          baseURL,
          requests,
          collectionSegmentTarget(modelId, ':batchGenerateContent'),
        );
      },
    );

    it('reads a safe batch id', async () => {
      const batchId = 'batches/batch-123';
      const { baseURL, requests } = await observe(
        async (_baseURL, provider) => {
          await attempt(
            provider.experimental_batch().doGetBatchStatus({ batchId }),
          );
        },
      );

      expectPinned(baseURL, requests, batchIdTarget(batchId));
    });

    it.each([
      '../../other-resource',
      'batches/batch-123?injected=1',
      'batches/%2e%2e/%2e%2e/other-resource',
      '..\\..\\other-resource',
    ])('does not send the API key for batch id %j', async batchId => {
      const { baseURL, requests } = await observe(
        async (_baseURL, provider) => {
          await attempt(
            provider.experimental_batch().doGetBatchStatus({ batchId }),
          );
        },
      );

      expectPinned(baseURL, requests, batchIdTarget(batchId));
    });

    it.each([
      '../../other-resource',
      'batches/batch-123?injected=1',
      'batches/%2e%2e/%2e%2e/other-resource',
    ])('does not cancel a retargeted batch id %j', async batchId => {
      const { baseURL, requests } = await observe(
        async (_baseURL, provider) => {
          await attempt(
            provider.experimental_batch().doCancelBatch({ batchId }),
          );
        },
      );

      expectPinned(baseURL, requests, batchIdTarget(batchId, ':cancel'));
    });
  });
});
