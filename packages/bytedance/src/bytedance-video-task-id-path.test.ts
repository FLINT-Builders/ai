import type { Experimental_VideoModelV4 as VideoModelV4 } from '@ai-sdk/provider';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createByteDance } from './bytedance-provider';

type GetVideoStatus = (
  model: VideoModelV4,
  options: {
    operation: { taskId: string };
    maxRetries?: number;
  },
) => PromiseLike<{ status: string }>;

// Vite loads the public status function for this test. A static import would
// pull the `ai` sources into this package's TypeScript project.
// @ts-expect-error `import.meta.glob` is provided by the test runner.
const getVideoStatusModules = import.meta.glob(
  '../../ai/src/generate-video/get-video-status.ts',
) as Record<
  string,
  () => Promise<{ experimental_getVideoStatus: GetVideoStatus }>
>;

async function loadGetVideoStatus(): Promise<GetVideoStatus> {
  const load = Object.values(getVideoStatusModules)[0];
  if (load == null) {
    throw new Error('experimental_getVideoStatus could not be loaded.');
  }
  const imported = await load();
  return imported.experimental_getVideoStatus;
}

/**
 * Placeholder only. The provider turns this into the Authorization header.
 * It is not a real credential.
 */
const PLACEHOLDER_API_KEY = 'test-api-key';

const SAFE_TASK_ID = 'test-task-id-123';

/**
 * Task ids the status check must refuse before any request. Each one is
 * applied by the URL parser as more than a single path segment under
 * `/contents/generations/tasks/`, or it adds a query or fragment.
 */
const UNSAFE_TASK_IDS = [
  '../../other-route',
  '..\\..\\other-route',
  '..',
  '.',
  '%2e%2e',
  '%2e%2e/%2e%2e/other-route',
  `${SAFE_TASK_ID}/extra`,
  `${SAFE_TASK_ID}?injected=1`,
  `${SAFE_TASK_ID}#fragment`,
  `${SAFE_TASK_ID}\\extra`,
  '....//....//other-route',
] as const;

type RecordedRequest = {
  method: string;
  path: string;
  hasAuthorization: boolean;
};

type Probe = {
  baseURL: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
};

async function openProbe(): Promise<Probe | null> {
  const http = await import('node:http').catch(() => null);
  if (http == null) {
    return null;
  }

  const requests: RecordedRequest[] = [];
  const server = http.createServer((request, response) => {
    const authorization = request.headers.authorization;
    requests.push({
      method: request.method ?? '',
      path: request.url ?? '',
      hasAuthorization:
        typeof authorization === 'string' &&
        authorization.startsWith('Bearer '),
    });

    const body = JSON.stringify({
      id: SAFE_TASK_ID,
      status: 'queued',
    });
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    response.end(body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('Expected the probe server to listen on a TCP port.');
  }

  return {
    baseURL: `http://127.0.0.1:${address.port}/api/v3`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

function videoModel(baseURL: string) {
  return createByteDance({
    apiKey: PLACEHOLDER_API_KEY,
    baseURL,
  }).video('seedance-1-0-pro-250528');
}

async function expectRefusedWithoutRequest(
  server: Probe,
  status: PromiseLike<unknown>,
) {
  const outcome = await status.then(
    () => ({ rejected: false }),
    () => ({ rejected: true }),
  );

  expect({
    rejected: outcome.rejected,
    requests: server.requests,
  }).toEqual({
    rejected: true,
    requests: [],
  });
}

describe('ByteDance video status task id', () => {
  let probe: Probe | null = null;
  let getVideoStatus: GetVideoStatus = () => {
    throw new Error('experimental_getVideoStatus was not loaded.');
  };

  beforeAll(async () => {
    probe = await openProbe();
    getVideoStatus = await loadGetVideoStatus();
  });

  afterAll(async () => {
    await probe?.close();
  });

  function requireProbe(): Probe {
    if (probe == null) {
      throw new Error(
        'A local HTTP server is required to observe the status request.',
      );
    }
    return probe;
  }

  it('requests only the configured task path for a single safe task id', async () => {
    const server = requireProbe();
    server.requests.length = 0;
    const model = videoModel(server.baseURL);

    const result = await getVideoStatus(model, {
      operation: { taskId: SAFE_TASK_ID },
      maxRetries: 0,
    });

    expect(result.status).toBe('pending');
    expect(server.requests).toEqual([
      {
        method: 'GET',
        path: `/api/v3/contents/generations/tasks/${SAFE_TASK_ID}`,
        hasAuthorization: true,
      },
    ]);
  });

  it('refuses a tampered task id from a started operation before any status request', async () => {
    const server = requireProbe();
    server.requests.length = 0;
    const model = videoModel(server.baseURL);

    const started = await model.doStart!({
      prompt: 'A futuristic city with flying cars',
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
    });

    expect(started.operation).toEqual({ taskId: SAFE_TASK_ID });
    expect(server.requests).toEqual([
      {
        method: 'POST',
        path: '/api/v3/contents/generations/tasks',
        hasAuthorization: true,
      },
    ]);

    server.requests.length = 0;
    const tampered = {
      ...(started.operation as { taskId: string }),
      taskId: '../../other-route',
    };

    await expectRefusedWithoutRequest(
      server,
      getVideoStatus(model, {
        operation: tampered,
        maxRetries: 0,
      }),
    );
  });

  describe.each(['doStatus', 'experimental_getVideoStatus'] as const)(
    '%s',
    entry => {
      it.each(UNSAFE_TASK_IDS)(
        'does not send a credentialed request for task id %j',
        async taskId => {
          const server = requireProbe();
          server.requests.length = 0;
          const model = videoModel(server.baseURL);
          const operation = { taskId };

          const status =
            entry === 'doStatus'
              ? model.doStatus!({ operation })
              : getVideoStatus(model, {
                  operation,
                  maxRetries: 0,
                });

          await expectRefusedWithoutRequest(server, status);
        },
      );
    },
  );
});
