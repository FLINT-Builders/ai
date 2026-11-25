import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGoogleVertex } from './google-vertex-provider';

const PLACEHOLDER_TOKEN = 'placeholder-vertex-token';
const PLACEHOLDER_API_KEY = 'placeholder-api-key';

vi.mock('google-auth-library', () => {
  return {
    GoogleAuth: vi.fn(function () {
      return {
        getClient: async () => ({
          getAccessToken: async () => ({ token: 'placeholder-vertex-token' }),
        }),
      };
    }),
  };
});

/**
 * Path the embedding call is allowed to request: the configured project and
 * location, then exactly one model segment. Dot-segment removal has already
 * happened by the time the request is on the wire.
 */
const CONFIGURED_MODEL_PATH =
  /^\/v1beta1\/projects\/configured-project\/locations\/us-central1\/publishers\/google\/models\/[^/]+:(?:predict|embedContent)$/;

type RecordedRequest = {
  url: string;
  authorization: string | undefined;
  apiKey: string | undefined;
};

const TRAVERSAL_TO_OTHER_PROJECT = [
  {
    label: 'slash dot segments',
    modelId:
      '../../../../../../other-project/locations/us-central1/publishers/google/models/text-embedding-004',
  },
  {
    label: 'percent-encoded dot segments',
    modelId:
      '%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/other-project/locations/us-central1/publishers/google/models/text-embedding-004',
  },
  {
    label: 'backslash percent-encoded dot segments',
    modelId:
      '%2e%2e\\%2e%2e\\%2e%2e\\%2e%2e\\%2e%2e\\%2e%2e\\other-project\\locations\\us-central1\\publishers\\google\\models\\text-embedding-004',
  },
] as const;

describe('Vertex embedding model id path', () => {
  let server: Server;
  let baseURL: string;
  let recorded: RecordedRequest[];
  const originalApiKey = process.env.GOOGLE_VERTEX_API_KEY;

  beforeEach(async () => {
    delete process.env.GOOGLE_VERTEX_API_KEY;
    recorded = [];
    server = createServer((request, response) => {
      recorded.push(readRequest(request));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          predictions: [
            {
              embeddings: {
                values: [0.25],
                statistics: { token_count: 1 },
              },
            },
          ],
          embedding: { values: [0.25] },
          usageMetadata: { promptTokenCount: 1 },
        }),
      );
    });
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address == null || typeof address === 'string') {
      throw new Error('test server did not bind to a TCP port');
    }
    baseURL = `http://127.0.0.1:${address.port}/v1beta1/projects/configured-project/locations/us-central1/publishers/google`;
  });

  afterEach(async () => {
    if (originalApiKey === undefined) {
      delete process.env.GOOGLE_VERTEX_API_KEY;
    } else {
      process.env.GOOGLE_VERTEX_API_KEY = originalApiKey;
    }
    await new Promise<void>(resolve => {
      server.close(() => {
        resolve();
      });
    });
  });

  it('sends the bearer token to the configured model path for a single-segment id', async () => {
    const vertex = createGoogleVertex({
      project: 'configured-project',
      location: 'us-central1',
      baseURL,
    });

    const result = await vertex
      .embeddingModel('text-embedding-004')
      .doEmbed({ values: ['hello'] });

    expect(result.embeddings).toEqual([[0.25]]);
    expect(recorded).toEqual([
      {
        url: '/v1beta1/projects/configured-project/locations/us-central1/publishers/google/models/text-embedding-004:predict',
        authorization: `Bearer ${PLACEHOLDER_TOKEN}`,
        apiKey: undefined,
      },
    ]);
  });

  it('sends gemini-embedding-2 to embedContent under the configured project', async () => {
    const vertex = createGoogleVertex({
      project: 'configured-project',
      location: 'us-central1',
      baseURL,
    });

    await vertex.embeddingModel('gemini-embedding-2').doEmbed({
      values: ['hello'],
    });

    expect(recorded).toEqual([
      {
        url: '/v1beta1/projects/configured-project/locations/us-central1/publishers/google/models/gemini-embedding-2:embedContent',
        authorization: `Bearer ${PLACEHOLDER_TOKEN}`,
        apiKey: undefined,
      },
    ]);
  });

  it.each(TRAVERSAL_TO_OTHER_PROJECT)(
    'does not send the bearer token outside the configured project for $label',
    async ({ modelId }) => {
      const vertex = createGoogleVertex({
        project: 'configured-project',
        location: 'us-central1',
        baseURL,
      });

      let thrown: unknown;
      try {
        await vertex.embeddingModel(modelId).doEmbed({ values: ['hello'] });
      } catch (error) {
        thrown = error;
      }

      expect(recorded, recordedMessage(recorded)).toEqual([]);
      expect(thrown).toBeDefined();
      expect(recorded.every(request => staysOnConfiguredModel(request))).toBe(
        true,
      );
    },
  );

  it('does not send the bearer token when textEmbeddingModel receives a dot-segment id', async () => {
    const vertex = createGoogleVertex({
      project: 'configured-project',
      location: 'us-central1',
      baseURL,
    });

    let thrown: unknown;
    try {
      await vertex
        .textEmbeddingModel(TRAVERSAL_TO_OTHER_PROJECT[0].modelId)
        .doEmbed({ values: ['hello'] });
    } catch (error) {
      thrown = error;
    }

    expect(recorded, recordedMessage(recorded)).toEqual([]);
    expect(thrown).toBeDefined();
  });

  it('does not attach the express-mode api key to a model path outside the configured project', async () => {
    const vertex = createGoogleVertex({
      apiKey: PLACEHOLDER_API_KEY,
      baseURL,
    });

    let thrown: unknown;
    try {
      await vertex
        .embeddingModel(TRAVERSAL_TO_OTHER_PROJECT[2].modelId)
        .doEmbed({ values: ['hello'] });
    } catch (error) {
      thrown = error;
    }

    expect(recorded, recordedMessage(recorded)).toEqual([]);
    expect(thrown).toBeDefined();
  });
});

function readRequest(request: IncomingMessage): RecordedRequest {
  return {
    url: request.url ?? '',
    authorization: headerValue(request, 'authorization'),
    apiKey: headerValue(request, 'x-goog-api-key'),
  };
}

function headerValue(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    return value.join(',');
  }
  return value;
}

function staysOnConfiguredModel(request: RecordedRequest): boolean {
  const path = request.url.split('?')[0] ?? '';
  return CONFIGURED_MODEL_PATH.test(path);
}

function recordedMessage(recorded: RecordedRequest[]): string {
  return `credentialed embedding requests left the configured model path: ${JSON.stringify(recorded)}`;
}
