import { createServer, type Server } from 'node:http';
import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { createGoogleVertexAnthropic } from './anthropic/google-vertex-anthropic-provider-node';
import { GoogleVertexGeminiTranscriptionModel } from './gemini-transcription/google-vertex-gemini-transcription-model';
import { createGoogleVertex } from './google-vertex-provider';

/**
 * Spec for credentialed Vertex requests that embed a caller-supplied model id
 * in the URL. These tests fail while that id can change the path or query
 * that receives the credential. A fix should refuse any id that is not one
 * safe path segment before a request is sent, and encode that segment.
 */

const PLACEHOLDER_API_KEY = 'placeholder-google-api-key';
const PLACEHOLDER_AUTHORIZATION = 'Bearer placeholder-token';

const PROMPT: LanguageModelV4Prompt = [
  { role: 'user', content: [{ type: 'text', text: 'hello' }] },
];

// `@` is a published Vertex model-id character (for example
// `textembedding-gecko@001` and `claude-3-5-sonnet@20240620`). It is not a
// URL delimiter. `/`, `\`, `?`, and `#` are.
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

const UNSAFE_MODEL_IDS = [
  '../../other-resource',
  '../../v1/models/gemini-2.0-flash:generateContent?',
  'veo-3.1-generate-preview?injected=1',
  'veo-3.1-generate-preview#fragment',
  '%2e%2e/%2e%2e/other-resource',
  '..\\..\\other-resource',
  'veo-3.1-generate-preview/extra',
] as const;

type ObservedRequest = {
  method: string | undefined;
  origin: string;
  pathname: string;
  search: string;
  apiKey: string | undefined;
  authorization: string | undefined;
};

function allowedPaths(
  prefix: string,
  modelId: string,
  method: string,
): string[] | null {
  if (!SAFE_SEGMENT.test(modelId)) {
    return null;
  }

  return [
    ...new Set([
      `${prefix}${modelId}${method}`,
      `${prefix}${encodeURIComponent(modelId)}${method}`,
    ]),
  ];
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

async function listen(): Promise<{
  baseURL: string;
  anthropicBaseURL: string;
  requests: ObservedRequest[];
  close: () => Promise<void>;
}> {
  const requests: ObservedRequest[] = [];
  const server: Server = createServer((request, response) => {
    const host = request.headers.host ?? '127.0.0.1';
    const url = new URL(request.url ?? '/', `http://${host}`);
    const apiKey = request.headers['x-goog-api-key'];
    const authorization = request.headers.authorization;
    requests.push({
      method: request.method,
      origin: `http://${host}`,
      pathname: url.pathname,
      search: url.search,
      apiKey: Array.isArray(apiKey) ? apiKey[0] : apiKey,
      authorization: Array.isArray(authorization)
        ? authorization[0]
        : authorization,
    });
    response.writeHead(200, {
      'content-type': 'application/json',
      connection: 'close',
    });
    response.end(JSON.stringify({ name: 'operations/ok', done: false }));
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

  const origin = `http://127.0.0.1:${address.port}`;
  return {
    baseURL: `${origin}/v1beta`,
    anthropicBaseURL: `${origin}/v1`,
    requests,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

function expectCredential(
  baseURL: string,
  requests: ObservedRequest[],
  pathnames: string[] | null,
  credential: 'api-key' | 'authorization',
): void {
  if (pathnames == null) {
    expect(requests).toEqual([]);
    return;
  }

  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    expect(request.origin).toBe(new URL(baseURL).origin);
    expect(pathnames).toContain(request.pathname);
    expect(request.search).toBe('');
    if (credential === 'api-key') {
      expect(request.apiKey).toBe(PLACEHOLDER_API_KEY);
    } else {
      expect(request.authorization).toBe(PLACEHOLDER_AUTHORIZATION);
    }
  }
}

describe('Vertex credentialed model-id request targets', () => {
  describe('video', () => {
    it('starts a safe model id on predictLongRunning', async () => {
      const modelId = 'veo-3.1-generate-preview';
      const server = await listen();
      try {
        const provider = createGoogleVertex({
          apiKey: PLACEHOLDER_API_KEY,
          baseURL: server.baseURL,
        });
        await attempt(
          provider.video(modelId).doStart({
            prompt: 'a city',
            n: 1,
            providerOptions: {},
          }),
        );
      } finally {
        await server.close();
      }

      expectCredential(
        server.baseURL,
        server.requests,
        allowedPaths('/v1beta/models/', modelId, ':predictLongRunning'),
        'api-key',
      );
      expect(server.requests[0]?.method).toBe('POST');
    });

    it.each(UNSAFE_MODEL_IDS)(
      'does not send the API key for video start model id %j',
      async modelId => {
        const server = await listen();
        try {
          const provider = createGoogleVertex({
            apiKey: PLACEHOLDER_API_KEY,
            baseURL: server.baseURL,
          });
          await attempt(
            provider.video(modelId).doStart({
              prompt: 'a city',
              n: 1,
              providerOptions: {},
            }),
          );
        } finally {
          await server.close();
        }

        expectCredential(
          server.baseURL,
          server.requests,
          allowedPaths('/v1beta/models/', modelId, ':predictLongRunning'),
          'api-key',
        );
      },
    );

    it.each(UNSAFE_MODEL_IDS)(
      'does not send the API key for video status model id %j',
      async modelId => {
        const server = await listen();
        try {
          const provider = createGoogleVertex({
            apiKey: PLACEHOLDER_API_KEY,
            baseURL: server.baseURL,
          });
          await attempt(
            provider.video(modelId).doStatus({
              operation: { operationName: 'operations/job-1' },
            }),
          );
        } finally {
          await server.close();
        }

        expectCredential(
          server.baseURL,
          server.requests,
          allowedPaths('/v1beta/models/', modelId, ':fetchPredictOperation'),
          'api-key',
        );
      },
    );
  });

  describe('embedding doEmbed', () => {
    it('embeds with a published model id that contains @', async () => {
      const modelId = 'textembedding-gecko@001';
      const server = await listen();
      try {
        const provider = createGoogleVertex({
          apiKey: PLACEHOLDER_API_KEY,
          baseURL: server.baseURL,
        });
        await attempt(
          provider.embeddingModel(modelId).doEmbed({ values: ['hello'] }),
        );
      } finally {
        await server.close();
      }

      expectCredential(
        server.baseURL,
        server.requests,
        allowedPaths('/v1beta/models/', modelId, ':predict'),
        'api-key',
      );
    });

    it.each(UNSAFE_MODEL_IDS)(
      'does not send the API key for embedding model id %j',
      async modelId => {
        const server = await listen();
        try {
          const provider = createGoogleVertex({
            apiKey: PLACEHOLDER_API_KEY,
            baseURL: server.baseURL,
          });
          await attempt(
            provider.embeddingModel(modelId).doEmbed({ values: ['hello'] }),
          );
        } finally {
          await server.close();
        }

        expectCredential(
          server.baseURL,
          server.requests,
          allowedPaths('/v1beta/models/', modelId, ':predict'),
          'api-key',
        );
      },
    );
  });

  describe('image doGenerate', () => {
    it.each([
      'gemini-2.5-flash/../../other-resource?',
      'gemini-../../other-resource',
      'gemini-%2e%2e/%2e%2e/other-resource',
    ])('does not send the API key for image model id %j', async modelId => {
      const server = await listen();
      try {
        const provider = createGoogleVertex({
          apiKey: PLACEHOLDER_API_KEY,
          baseURL: server.baseURL,
        });
        await attempt(
          provider.image(modelId).doGenerate({ prompt: 'a red cube' }),
        );
      } finally {
        await server.close();
      }

      expectCredential(
        server.baseURL,
        server.requests,
        allowedPaths('/v1beta/models/', modelId, ':generateContent'),
        'api-key',
      );
    });
  });

  describe('gemini transcription doGenerate', () => {
    it.each(UNSAFE_MODEL_IDS)(
      'does not send the bearer token for transcription model id %j',
      async modelId => {
        const server = await listen();
        try {
          const model = new GoogleVertexGeminiTranscriptionModel(modelId, {
            provider: 'google.vertex.transcription',
            baseURL: server.baseURL,
            headers: async () => ({
              authorization: PLACEHOLDER_AUTHORIZATION,
            }),
            project: 'placeholder-project',
            location: 'us-central1',
          });
          await attempt(
            model.doGenerate({
              audio: new Uint8Array([1, 2, 3]),
              mediaType: 'audio/wav',
            }),
          );
        } finally {
          await server.close();
        }

        expectCredential(
          server.baseURL,
          server.requests,
          allowedPaths('/v1beta/models/', modelId, ':generateContent'),
          'authorization',
        );
      },
    );
  });

  describe('anthropic rawPredict', () => {
    it('calls rawPredict for a published model id that contains @', async () => {
      const modelId = 'claude-3-5-sonnet@20240620';
      const server = await listen();
      try {
        const provider = createGoogleVertexAnthropic({
          baseURL: server.anthropicBaseURL,
          project: 'placeholder-project',
          location: 'us-central1',
          generateAuthToken: async () => 'placeholder-token',
        });
        await attempt(
          provider.languageModel(modelId).doGenerate({ prompt: PROMPT }),
        );
      } finally {
        await server.close();
      }

      expectCredential(
        server.anthropicBaseURL,
        server.requests,
        allowedPaths('/v1/', modelId, ':rawPredict'),
        'authorization',
      );
    });

    it.each(UNSAFE_MODEL_IDS)(
      'does not send the bearer token for anthropic model id %j',
      async modelId => {
        const server = await listen();
        try {
          const provider = createGoogleVertexAnthropic({
            baseURL: server.anthropicBaseURL,
            project: 'placeholder-project',
            location: 'us-central1',
            generateAuthToken: async () => 'placeholder-token',
          });
          await attempt(
            provider.languageModel(modelId).doGenerate({ prompt: PROMPT }),
          );
        } finally {
          await server.close();
        }

        expectCredential(
          server.anthropicBaseURL,
          server.requests,
          allowedPaths('/v1/', modelId, ':rawPredict'),
          'authorization',
        );
      },
    );

    it.each(UNSAFE_MODEL_IDS)(
      'does not send the bearer token for anthropic stream model id %j',
      async modelId => {
        const server = await listen();
        try {
          const provider = createGoogleVertexAnthropic({
            baseURL: server.anthropicBaseURL,
            project: 'placeholder-project',
            location: 'us-central1',
            generateAuthToken: async () => 'placeholder-token',
          });
          await attempt(
            provider.languageModel(modelId).doStream({ prompt: PROMPT }),
          );
        } finally {
          await server.close();
        }

        expectCredential(
          server.anthropicBaseURL,
          server.requests,
          allowedPaths('/v1/', modelId, ':streamRawPredict'),
          'authorization',
        );
      },
    );
  });
});
