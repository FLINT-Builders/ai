import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderRegistry } from '../../ai/src/registry/provider-registry';
import { createGoogleVertex } from './google-vertex-provider';

vi.mock('google-auth-library', () => {
  const getAccessToken = vi.fn(async () => ({ token: 'placeholder-token' }));
  const getClient = vi.fn(async () => ({ getAccessToken }));
  return {
    GoogleAuth: vi.fn(function GoogleAuth() {
      return { getClient };
    }),
  };
});

const isEdgeRuntime =
  (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime !== undefined;

const BASE_PATH = '/v1beta1/projects/proj/locations/loc/publishers/google';

const SAFE_MODEL_ID = 'veo-2.0-generate-001';

const UNSAFE_MODEL_IDS = [
  '../other-model',
  'veo-2.0-generate-001?injected=1',
  'veo-2.0-generate-001#cut',
  '..\\..\\outside',
  '../../endpoints/123:predict?',
  'nested/model',
] as const;

type VideoOperation = 'predictLongRunning' | 'fetchPredictOperation';
type AuthMode = 'oauth' | 'express';

type CapturedRequest = {
  rawUrl: string;
  method: string;
  host: string | undefined;
  authorization: string | undefined;
  apiKey: string | undefined;
};

const startOptions = {
  prompt: 'A futuristic city with flying cars',
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
} as const;

function expectedRequestTarget(modelId: string, operation: VideoOperation) {
  return `${BASE_PATH}/models/${encodeURIComponent(modelId)}:${operation}`;
}

function headerValue(
  headers: IncomingMessage['headers'],
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

async function listen(): Promise<{
  server: Server;
  port: number;
  requests: CapturedRequest[];
}> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    requests.push({
      rawUrl: request.url ?? '',
      method: request.method ?? '',
      host: headerValue(request.headers, 'host'),
      authorization: headerValue(request.headers, 'authorization'),
      apiKey: headerValue(request.headers, 'x-goog-api-key'),
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        name: 'operations/op-1',
        done: false,
      }),
    );
  });

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('Test server did not bind to a TCP port');
  }

  return { server, port: address.port, requests };
}

async function close(server: Server) {
  await new Promise<void>(resolve => {
    server.close(() => resolve());
  });
}

function createVertex(baseURL: string, mode: AuthMode) {
  if (mode === 'express') {
    return createGoogleVertex({
      apiKey: 'placeholder-api-key',
      baseURL,
    });
  }

  return createGoogleVertex({
    project: 'proj',
    location: 'loc',
    baseURL,
  });
}

async function invoke(
  model: {
    doStart?: (options: typeof startOptions) => Promise<unknown>;
    doStatus?: (options: {
      operation: { operationName: string };
    }) => Promise<unknown>;
  },
  operation: VideoOperation,
) {
  try {
    if (operation === 'predictLongRunning') {
      await model.doStart?.(startOptions);
      return;
    }

    await model.doStatus?.({
      operation: { operationName: 'operations/op-1' },
    });
  } catch {
    // A fix may reject the model id. Requests already sent are still recorded.
  }
}

function assertCredentialedModelRequest({
  requests,
  modelId,
  operation,
  port,
  mode,
}: {
  requests: CapturedRequest[];
  modelId: string;
  operation: VideoOperation;
  port: number;
  mode: AuthMode;
}) {
  if (requests.length === 0) {
    return;
  }

  expect(requests.map(request => request.method)).toEqual(['POST']);
  expect(requests.map(request => request.host)).toEqual([`127.0.0.1:${port}`]);

  if (mode === 'oauth') {
    expect(requests.map(request => request.authorization)).toEqual([
      'Bearer placeholder-token',
    ]);
    expect(requests.map(request => request.apiKey)).toEqual([undefined]);
  } else {
    expect(requests.map(request => request.apiKey)).toEqual([
      'placeholder-api-key',
    ]);
    expect(requests.map(request => request.authorization)).toEqual([undefined]);
  }

  expect(requests.map(request => request.rawUrl)).toEqual([
    expectedRequestTarget(modelId, operation),
  ]);
}

describe.skipIf(isEdgeRuntime)(
  'Vertex video model id stays a single credentialed path segment',
  () => {
    beforeEach(() => {
      delete process.env.GOOGLE_VERTEX_API_KEY;
    });

    it('records a request target that still contains dot segments', async () => {
      const { server, port, requests } = await listen();

      try {
        const rawTarget = `${BASE_PATH}/models/../other-model:predictLongRunning`;
        await new Promise<void>(resolve => {
          const socket: Socket = connect(port, '127.0.0.1', () => {
            socket.write(
              `POST ${rawTarget} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
            );
          });
          socket.on('data', () => {
            socket.end();
          });
          socket.on('error', () => {
            socket.destroy();
          });
          socket.on('close', () => resolve());
        });

        expect(requests.map(request => request.rawUrl)).toEqual([rawTarget]);
      } finally {
        await close(server);
      }
    });

    it.each(['oauth', 'express'] as const)(
      'calls the configured model operation with %s credentials',
      async mode => {
        const { server, port, requests } = await listen();
        const baseURL = `http://127.0.0.1:${port}${BASE_PATH}`;

        try {
          const provider = createVertex(baseURL, mode);
          const model = provider.video(SAFE_MODEL_ID);

          await invoke(model, 'predictLongRunning');
          assertCredentialedModelRequest({
            requests,
            modelId: SAFE_MODEL_ID,
            operation: 'predictLongRunning',
            port,
            mode,
          });
          expect(requests).toHaveLength(1);

          requests.length = 0;
          await invoke(model, 'fetchPredictOperation');
          assertCredentialedModelRequest({
            requests,
            modelId: SAFE_MODEL_ID,
            operation: 'fetchPredictOperation',
            port,
            mode,
          });
          expect(requests).toHaveLength(1);
        } finally {
          await close(server);
        }
      },
    );

    it.each(
      (['oauth', 'express'] as const).flatMap(mode =>
        (['predictLongRunning', 'fetchPredictOperation'] as const).flatMap(
          operation =>
            UNSAFE_MODEL_IDS.map(
              modelId => [mode, operation, modelId] as const,
            ),
        ),
      ),
    )(
      '%s %s does not send %j outside the encoded model segment',
      async (mode, operation, modelId) => {
        const { server, port, requests } = await listen();
        const baseURL = `http://127.0.0.1:${port}${BASE_PATH}`;

        try {
          const model = createVertex(baseURL, mode).video(modelId);
          await invoke(model, operation);
          assertCredentialedModelRequest({
            requests,
            modelId,
            operation,
            port,
            mode,
          });
        } finally {
          await close(server);
        }
      },
    );

    it.each(['predictLongRunning', 'fetchPredictOperation'] as const)(
      'videoModel(%s) does not let a dot-segment id retarget the bearer call',
      async operation => {
        const { server, port, requests } = await listen();
        const baseURL = `http://127.0.0.1:${port}${BASE_PATH}`;
        const modelId = '../other-model';

        try {
          const model = createVertex(baseURL, 'oauth').videoModel(modelId);
          await invoke(model, operation);
          assertCredentialedModelRequest({
            requests,
            modelId,
            operation,
            port,
            mode: 'oauth',
          });
        } finally {
          await close(server);
        }
      },
    );

    it.each(['predictLongRunning', 'fetchPredictOperation'] as const)(
      'registry videoModel(%s) forwards a query delimiter into the same sink',
      async operation => {
        const { server, port, requests } = await listen();
        const baseURL = `http://127.0.0.1:${port}${BASE_PATH}`;
        const modelId = 'veo-2.0-generate-001?injected=1';

        try {
          const registry = createProviderRegistry({
            vertex: createVertex(baseURL, 'oauth'),
          });
          const model = registry.videoModel(`vertex:${modelId}`);
          await invoke(model, operation);
          assertCredentialedModelRequest({
            requests,
            modelId,
            operation,
            port,
            mode: 'oauth',
          });
        } finally {
          await close(server);
        }
      },
    );
  },
);
