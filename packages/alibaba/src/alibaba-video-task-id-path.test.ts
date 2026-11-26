import { createAlibaba, type AlibabaProvider } from './alibaba-provider';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * These tests describe the required behavior for Alibaba video status checks.
 * They fail while `operation.taskId` is concatenated into the task URL.
 * A status check may send the provider credentials only to
 * `{videoBaseURL}/api/v1/tasks/{one segment}` on the configured host, and
 * that segment must be the caller's task id (dot segments "." and ".." have
 * to survive as data, not as path navigation). Refusing the call before any
 * credentialed request is also acceptable.
 */

const PLACEHOLDER_API_KEY = 'placeholder-api-key';
const runningInEdgeRuntime = 'EdgeRuntime' in globalThis;

type ObservedRequest = {
  method: string;
  target: string;
  authorization: string | undefined;
};

type ProbeServer = {
  origin: string;
  requests: ObservedRequest[];
  close: () => Promise<void>;
};

const startOptions = {
  prompt: 'A lake',
  n: 1,
  providerOptions: {},
  image: undefined,
  frameImages: undefined,
  inputReferences: undefined,
  aspectRatio: undefined,
  resolution: undefined,
  duration: undefined,
  fps: undefined,
  generateAudio: undefined,
  seed: undefined,
} as const;

function authorizationHeader(): string {
  return `Bearer ${PLACEHOLDER_API_KEY}`;
}

/**
 * A credentialed GET is confined when the request that left the client is
 * still one task-id segment under `/api/v1/tasks/`, with no query string.
 */
function isConfinedTaskRequest(target: string, taskId: string): boolean {
  const url = new URL(target, 'http://127.0.0.1');
  if (url.search !== '') {
    return false;
  }

  const match = /^\/api\/v1\/tasks\/([^/]+)$/.exec(url.pathname);
  if (match == null) {
    return false;
  }

  const segment = match[1];
  if (/^(?:\.|\.\.|%2e|%2e%2e|\.%2e|%2e\.)$/i.test(segment)) {
    return false;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return false;
  }

  if (taskId === '.' && decoded.toLowerCase() === '%2e') {
    return true;
  }
  if (taskId === '..' && decoded.toLowerCase() === '%2e%2e') {
    return true;
  }

  return decoded === taskId;
}

function credentialedGets(requests: ObservedRequest[]): ObservedRequest[] {
  return requests.filter(
    request =>
      request.method === 'GET' &&
      request.authorization === authorizationHeader(),
  );
}

describe.skipIf(runningInEdgeRuntime)(
  'Alibaba video task id path confinement',
  () => {
    let server: ProbeServer;
    let provider: AlibabaProvider;

    beforeAll(async () => {
      const { createServer } = await import('node:http');
      const requests: ObservedRequest[] = [];
      const httpServer = createServer((request, response) => {
        request.on('data', () => {});
        request.on('end', () => {
          requests.push({
            method: request.method ?? '',
            target: request.url ?? '',
            authorization: request.headers.authorization,
          });

          const body =
            request.method === 'POST'
              ? {
                  output: {
                    task_status: 'PENDING',
                    task_id: 'task-from-provider',
                  },
                  request_id: 'req-start',
                }
              : {
                  output: {
                    task_id: 'ignored',
                    task_status: 'PENDING',
                  },
                  request_id: 'req-status',
                };

          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(body));
        });
      });

      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(0, '127.0.0.1', () => resolve());
      });

      const address = httpServer.address();
      if (address == null || typeof address === 'string') {
        throw new Error('Expected the probe server to listen on a TCP port');
      }

      server = {
        origin: `http://127.0.0.1:${address.port}`,
        requests,
        close: () =>
          new Promise((resolve, reject) => {
            httpServer.close(error => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          }),
      };

      provider = createAlibaba({
        apiKey: PLACEHOLDER_API_KEY,
        videoBaseURL: server.origin,
      });
    });

    afterAll(async () => {
      await server.close();
    });

    async function expectTaskIdStaysInOneSegment(
      taskId: string,
      check: () => Promise<unknown>,
    ) {
      server.requests.length = 0;
      let failure: unknown;
      try {
        await check();
      } catch (error) {
        failure = error;
      }

      const gets = credentialedGets(server.requests);
      const escaped = gets.filter(
        request => !isConfinedTaskRequest(request.target, taskId),
      );

      expect(escaped.map(request => request.target)).toEqual([]);

      if (gets.length === 0) {
        expect(failure).toBeTruthy();
        expect(failure).not.toMatchObject({
          cause: expect.objectContaining({ code: 'ECONNREFUSED' }),
        });
        const message = failure instanceof Error ? failure.message : '';
        expect(message).not.toMatch(/ECONNREFUSED|fetch failed/i);
      }
    }

    it('sends a normal task id as one credentialed segment', async () => {
      server.requests.length = 0;
      const taskId = 'task.abc-123';

      const result = await provider.video('wan2.6-t2v').doStatus!({
        operation: { taskId },
      });

      const gets = credentialedGets(server.requests);
      expect(gets.map(request => request.target)).toEqual([
        `/api/v1/tasks/${taskId}`,
      ]);
      expect(result.status).toBe('pending');
    });

    it.each([
      '../../other-resource',
      '..',
      '.',
      '%2e%2e/%2e%2e/other-resource',
      '%2E%2E/%2E%2E/secret',
      '.%2e/.%2e/other-resource',
      '..\\..\\other-resource',
      'other/resource',
      'other?injected=1',
      'other#frag',
      '..%2f..%2fother-resource',
      'https://evil.example/x',
      '',
    ])(
      'keeps a credentialed status GET on one task segment for %j',
      async taskId => {
        await expectTaskIdStaysInOneSegment(taskId, () =>
          provider.video('wan2.6-t2v').doStatus!({
            operation: { taskId },
          }),
        );
      },
    );

    it('keeps a tampered stored operation inside one task segment', async () => {
      const { experimental_getVideoStatus } =
        await import('../../ai/src/generate-video/get-video-status');
      const model = provider.video('wan2.6-t2v');
      server.requests.length = 0;

      const started = await model.doStart!({ ...startOptions });
      const stored = JSON.parse(JSON.stringify(started.operation)) as {
        taskId: string;
      };
      expect(stored.taskId).toBe('task-from-provider');
      stored.taskId = '../../other-resource';

      await expectTaskIdStaysInOneSegment(stored.taskId, () =>
        experimental_getVideoStatus(model, {
          operation: stored,
          maxRetries: 0,
        }),
      );
    });
  },
);
