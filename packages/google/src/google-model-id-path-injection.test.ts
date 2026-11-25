import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createGoogle, type GoogleProvider } from './google-provider';

const isEdgeRuntime =
  (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime !== undefined;

/**
 * Placeholder credential. This is not a real Google API key.
 * The provider reads it from the `apiKey` option in createGoogle.
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

/**
 * Model ids that the URL parser (the same one global fetch uses) turns into
 * a different request target when they are concatenated into a path.
 * Each one avoids a different single-character filter.
 */
const UNSAFE_MODEL_IDS = [
  '../tunedModels/abc:generateContent?',
  'gemini-2.0-flash:generateContent?',
  'gemini-2.0-flash:generateContent#',
  '..\\files?',
  '%2e%2e/%2e%2e/files?',
] as const;

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

      if (request.url === '/v1beta/models/gemini-embedding-001:embedContent') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ embedding: { values: [0.1, 0.2] } }));
        return;
      }

      if (
        request.url === '/v1beta/models/gemini-embedding-001:batchEmbedContents'
      ) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            embeddings: [{ values: [0.1] }, { values: [0.2] }],
          }),
        );
        return;
      }

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
    baseURL: `http://127.0.0.1:${address.port}/v1beta`,
    requests,
    close: () =>
      new Promise(resolve => {
        server.close(() => resolve());
      }),
  };
}

function providerFor(baseURL: string): GoogleProvider {
  return createGoogle({
    apiKey: PLACEHOLDER_API_KEY,
    baseURL,
  });
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
  'Google model ids are a single safe path segment',
  () => {
    it('embeds a safe model id as one path segment and sends the configured API key', async () => {
      const server = await listen();
      try {
        const provider = providerFor(server.baseURL);
        const result = await provider
          .embedding('gemini-embedding-001')
          .doEmbed({ values: ['hello'] });

        expect(result.embeddings).toEqual([[0.1, 0.2]]);
        expect(server.requests).toHaveLength(1);
        expect(server.requests[0]).toMatchObject({
          method: 'POST',
          url: '/v1beta/models/gemini-embedding-001:embedContent',
          apiKey: PLACEHOLDER_API_KEY,
        });
        expect(JSON.parse(server.requests[0].body)).toMatchObject({
          model: 'models/gemini-embedding-001',
        });
      } finally {
        await server.close();
      }
    });

    it('batch-embeds a safe model id as one path segment', async () => {
      const server = await listen();
      try {
        const provider = providerFor(server.baseURL);
        const result = await provider
          .embeddingModel('gemini-embedding-001')
          .doEmbed({ values: ['one', 'two'] });

        expect(result.embeddings).toEqual([[0.1], [0.2]]);
        expect(server.requests).toHaveLength(1);
        expect(server.requests[0]).toMatchObject({
          method: 'POST',
          url: '/v1beta/models/gemini-embedding-001:batchEmbedContents',
          apiKey: PLACEHOLDER_API_KEY,
        });
        expect(JSON.parse(server.requests[0].body).requests).toEqual([
          expect.objectContaining({ model: 'models/gemini-embedding-001' }),
          expect.objectContaining({ model: 'models/gemini-embedding-001' }),
        ]);
      } finally {
        await server.close();
      }
    });

    it.each(UNSAFE_MODEL_IDS)(
      'embedding() does not request another resource for model id %j',
      async modelId => {
        const server = await listen();
        try {
          const provider = providerFor(server.baseURL);
          await expectRejectedBeforeRequest(server.requests, () =>
            provider.embedding(modelId).doEmbed({ values: ['hello'] }),
          );
        } finally {
          await server.close();
        }
      },
    );

    it.each([
      [
        'embeddingModel',
        (provider: GoogleProvider, modelId: string) =>
          provider.embeddingModel(modelId),
      ],
      [
        'textEmbedding',
        (provider: GoogleProvider, modelId: string) =>
          provider.textEmbedding(modelId),
      ],
      [
        'textEmbeddingModel',
        (provider: GoogleProvider, modelId: string) =>
          provider.textEmbeddingModel(modelId),
      ],
    ] as const)(
      '%s rejects a model id that escapes the embedding method',
      async (_name, createModel) => {
        const server = await listen();
        try {
          const provider = providerFor(server.baseURL);
          await expectRejectedBeforeRequest(server.requests, () =>
            createModel(
              provider,
              '%2e%2e/%2e%2e/tunedModels/abc:generateContent?',
            ).doEmbed({ values: ['hello'] }),
          );
        } finally {
          await server.close();
        }
      },
    );

    it('batch embed rejects a model id before batchEmbedContents is requested', async () => {
      const server = await listen();
      try {
        const provider = providerFor(server.baseURL);
        await expectRejectedBeforeRequest(server.requests, () =>
          provider.embedding('..\\files?').doEmbed({ values: ['one', 'two'] }),
        );
      } finally {
        await server.close();
      }
    });

    it('keeps a safe chat model on generateContent', async () => {
      const server = await listen();
      try {
        const provider = providerFor(server.baseURL);
        await provider
          .chat('gemini-2.0-flash')
          .doGenerate({ prompt: PROMPT })
          .catch(() => undefined);

        expect(server.requests).toHaveLength(1);
        expect(server.requests[0]).toMatchObject({
          url: '/v1beta/models/gemini-2.0-flash:generateContent',
          apiKey: PLACEHOLDER_API_KEY,
        });
      } finally {
        await server.close();
      }
    });

    it('chat generateContent rejects a model id that leaves /models', async () => {
      const server = await listen();
      try {
        const provider = providerFor(server.baseURL);
        await expectRejectedBeforeRequest(server.requests, () =>
          provider.chat('../files?').doGenerate({ prompt: PROMPT }),
        );
      } finally {
        await server.close();
      }
    });

    it('chat streamGenerateContent rejects a percent-encoded model id', async () => {
      const server = await listen();
      try {
        const provider = providerFor(server.baseURL);
        await expectRejectedBeforeRequest(server.requests, () =>
          provider
            .languageModel('%2e%2e/%2e%2e/files?')
            .doStream({ prompt: PROMPT }),
        );
      } finally {
        await server.close();
      }
    });

    it('speech generateContent rejects a backslash model id', async () => {
      const server = await listen();
      try {
        const provider = providerFor(server.baseURL);
        await expectRejectedBeforeRequest(server.requests, () =>
          provider.speech('..\\files?').doGenerate({
            text: 'Hello',
            voice: 'Puck',
          }),
        );
      } finally {
        await server.close();
      }
    });

    it('video predictLongRunning rejects a fragment model id', async () => {
      const server = await listen();
      try {
        const provider = providerFor(server.baseURL);
        await expectRejectedBeforeRequest(server.requests, () =>
          provider.video('veo-3.1#../../files').doStart({
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

    it('image generation rejects a gemini-prefixed model id that still traverses', async () => {
      const server = await listen();
      try {
        const provider = providerFor(server.baseURL);
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
  },
);
