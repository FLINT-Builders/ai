import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createGoogleVertex } from './google-vertex-provider';
import { createGoogleVertex as createGoogleVertexBase } from './google-vertex-provider-base';

const isEdgeRuntime =
  (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime !== undefined;

/**
 * Placeholder credential. This is not a real Google API key.
 * Express mode copies it onto the outgoing request as x-goog-api-key.
 */
const PLACEHOLDER_API_KEY = 'test-api-key';

type RecordedRequest = {
  url: string;
  method: string;
  apiKey: string | undefined;
  body: string;
};

const PROMPT = [
  {
    role: 'user' as const,
    content: [{ type: 'text' as const, text: 'Hello' }],
  },
];

async function listen(): Promise<{
  baseURL: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on('end', () => {
      const headers = request.headers as IncomingHttpHeaders;
      const apiKeyHeader = headers['x-goog-api-key'];
      requests.push({
        url: request.url ?? '',
        method: request.method ?? '',
        apiKey: Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 404, message: 'no' } }));
    });
  });

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('Test server did not bind to a TCP port');
  }

  return {
    baseURL: `http://127.0.0.1:${address.port}/v1/publishers/google`,
    requests,
    close: () =>
      new Promise(resolve => {
        server.close(() => resolve());
      }),
  };
}

async function expectRejectedBeforeRequest(
  requests: RecordedRequest[],
  call: () => Promise<unknown>,
): Promise<void> {
  const before = requests.length;
  await expect(call()).rejects.toThrow();
  expect(requests.slice(before)).toEqual([]);
}

describe.skipIf(isEdgeRuntime)(
  'Vertex model ids are a single safe path segment',
  () => {
    it('predicts embeddings for a safe model id under the configured base path', async () => {
      const server = await listen();
      try {
        const provider = createGoogleVertex({
          apiKey: PLACEHOLDER_API_KEY,
          baseURL: server.baseURL,
        });
        await provider
          .embeddingModel('text-embedding-004')
          .doEmbed({ values: ['hello'] })
          .catch(() => undefined);

        expect(server.requests).toHaveLength(1);
        expect(server.requests[0]).toMatchObject({
          method: 'POST',
          url: '/v1/publishers/google/models/text-embedding-004:predict',
          apiKey: PLACEHOLDER_API_KEY,
        });
      } finally {
        await server.close();
      }
    });

    it('uses embedContent for the exact gemini-embedding-2 model id', async () => {
      const server = await listen();
      try {
        const provider = createGoogleVertex({
          apiKey: PLACEHOLDER_API_KEY,
          baseURL: server.baseURL,
        });
        await provider
          .embeddingModel('gemini-embedding-2')
          .doEmbed({ values: ['hello'] })
          .catch(() => undefined);

        expect(server.requests).toHaveLength(1);
        expect(server.requests[0]).toMatchObject({
          url: '/v1/publishers/google/models/gemini-embedding-2:embedContent',
          apiKey: PLACEHOLDER_API_KEY,
        });
      } finally {
        await server.close();
      }
    });

    it.each([
      '../tunedModels/abc:generateContent?',
      'text-embedding-004:predict?',
      '..\\files?',
      '%2e%2e/%2e%2e/files?',
    ])(
      'embedding predict does not request another resource for model id %j',
      async modelId => {
        const server = await listen();
        try {
          const provider = createGoogleVertex({
            apiKey: PLACEHOLDER_API_KEY,
            baseURL: server.baseURL,
          });
          await expectRejectedBeforeRequest(server.requests, () =>
            provider
              .embeddingModel(modelId)
              .doEmbed({ values: ['one', 'two'] }),
          );
        } finally {
          await server.close();
        }
      },
    );

    it('textEmbeddingModel rejects a query-bearing model id', async () => {
      const server = await listen();
      try {
        const provider = createGoogleVertex({
          apiKey: PLACEHOLDER_API_KEY,
          baseURL: server.baseURL,
        });
        await expectRejectedBeforeRequest(server.requests, () =>
          provider
            .textEmbeddingModel('x?alt=json')
            .doEmbed({ values: ['hello'] }),
        );
      } finally {
        await server.close();
      }
    });

    it('chat generateContent rejects a model id that leaves the publishers path', async () => {
      const server = await listen();
      try {
        const provider = createGoogleVertex({
          apiKey: PLACEHOLDER_API_KEY,
          baseURL: server.baseURL,
        });
        await expectRejectedBeforeRequest(server.requests, () =>
          provider('../files?').doGenerate({ prompt: PROMPT }),
        );
      } finally {
        await server.close();
      }
    });

    it('chat streamGenerateContent rejects a percent-encoded model id', async () => {
      const server = await listen();
      try {
        const provider = createGoogleVertex({
          apiKey: PLACEHOLDER_API_KEY,
          baseURL: server.baseURL,
        });
        await expectRejectedBeforeRequest(server.requests, () =>
          provider
            .languageModel('%2e%2e/%2e%2e/files?')
            .doStream({ prompt: PROMPT }),
        );
      } finally {
        await server.close();
      }
    });

    it('image generation rejects a traversing model id', async () => {
      const server = await listen();
      try {
        const provider = createGoogleVertex({
          apiKey: PLACEHOLDER_API_KEY,
          baseURL: server.baseURL,
        });
        await expectRejectedBeforeRequest(server.requests, () =>
          provider.image('gemini-2.5-flash/../../files?').doGenerate({
            prompt: 'A sunset',
            files: undefined,
            mask: undefined,
            n: 1,
            size: undefined,
            aspectRatio: undefined,
            seed: undefined,
            providerOptions: {},
          }),
        );
      } finally {
        await server.close();
      }
    });

    it('speech generateContent rejects a fragment model id', async () => {
      const server = await listen();
      try {
        const provider = createGoogleVertex({
          apiKey: PLACEHOLDER_API_KEY,
          baseURL: server.baseURL,
        });
        await expectRejectedBeforeRequest(server.requests, () =>
          provider
            .speech('gemini-2.5-flash-preview-tts#../../files')
            .doGenerate({
              text: 'Hello',
              voice: 'Puck',
            }),
        );
      } finally {
        await server.close();
      }
    });

    it('video predictLongRunning rejects a backslash model id', async () => {
      const server = await listen();
      try {
        const provider = createGoogleVertex({
          apiKey: PLACEHOLDER_API_KEY,
          baseURL: server.baseURL,
        });
        await expectRejectedBeforeRequest(server.requests, () =>
          provider.video('..\\files?').doStart({
            prompt: 'A city',
            n: 1,
            image: undefined,
            frameImages: undefined,
            inputReferences: undefined,
            aspectRatio: undefined,
            resolution: undefined,
            duration: undefined,
            fps: undefined,
            generateAudio: undefined,
            seed: undefined,
            providerOptions: {},
          }),
        );
      } finally {
        await server.close();
      }
    });

    it('video fetchPredictOperation rejects a query model id', async () => {
      const server = await listen();
      try {
        const provider = createGoogleVertex({
          apiKey: PLACEHOLDER_API_KEY,
          baseURL: server.baseURL,
        });
        await expectRejectedBeforeRequest(server.requests, () =>
          provider.videoModel('veo-3.1:fetchPredictOperation?').doStatus({
            operation: { operationName: 'operations/example' },
            abortSignal: undefined,
          }),
        );
      } finally {
        await server.close();
      }
    });

    it('gemini transcription generateContent rejects a prefixed traversal', async () => {
      const server = await listen();
      try {
        // The public factory adds an Authorization header, then delegates
        // here. Calling the base factory with an explicit header avoids
        // minting a cloud token while still building the request URL.
        const provider = createGoogleVertexBase({
          baseURL: server.baseURL,
          project: 'test-project',
          location: 'us-central1',
          headers: { 'x-goog-api-key': PLACEHOLDER_API_KEY },
        });
        await expectRejectedBeforeRequest(server.requests, () =>
          provider.transcription('gemini/%2e%2e/%2e%2e/files?').doGenerate({
            audio: new Uint8Array([1, 2, 3, 4]),
            mediaType: 'audio/wav',
            providerOptions: {},
          }),
        );
      } finally {
        await server.close();
      }
    });
  },
);
