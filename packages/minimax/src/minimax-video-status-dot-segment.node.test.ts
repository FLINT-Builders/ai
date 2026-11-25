import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { APICallError } from '@ai-sdk/provider';
import { experimental_getVideoStatus } from '../../ai/src/generate-video/get-video-status';
import { describe, expect, it } from 'vitest';
import { createMiniMax } from './minimax-provider';

/**
 * Obvious placeholder. The test checks that this value is attached to a
 * status request; it is not a credential.
 */
const PLACEHOLDER_KEY = 'placeholder';

const LISTING_MARKER = 'other-user-job';

const COLLAPSED_PATHS = new Set([
  '/v2/query/video_generation',
  '/v2/query/video_generation/',
  '/v2/query',
  '/v2/query/',
]);

type SeenRequest = {
  path: string;
  authorization: string | null;
};

/**
 * Local stand-in for the MiniMax origin. Only the paths a dot or dot-dot
 * task id collapses to return a collection listing. Every other path returns
 * an error body that does not contain that listing.
 */
async function startOrigin(): Promise<{
  baseURL: string;
  requests: SeenRequest[];
  close: () => Promise<void>;
}> {
  const requests: SeenRequest[] = [];
  const server = createServer((request, response) => {
    const path = requestPath(request);
    requests.push({
      path,
      authorization: request.headers.authorization ?? null,
    });

    if (COLLAPSED_PATHS.has(path)) {
      writeJson(response, 200, {
        tasks: [
          {
            id: LISTING_MARKER,
            status: 'succeeded',
            content: { url: 'https://cdn.example/other.mp4' },
          },
        ],
      });
      return;
    }

    writeJson(response, 404, { error: { message: 'unknown task' } });
  });

  await listen(server);
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('test origin did not bind a TCP port');
  }

  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

function requestPath(request: IncomingMessage): string {
  return (request.url ?? '').split('?')[0] ?? '';
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function storedOperation(taskId: string) {
  return JSON.parse(
    JSON.stringify({
      taskId,
      resolvedInputs: { imageCount: 0, referenceVideoIndices: [] },
    }),
  );
}

function callerVisibleText(value: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current = value;

  while (current != null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      parts.push(current.message);
    }
    if (APICallError.isInstance(current)) {
      if (current.responseBody != null) {
        parts.push(current.responseBody);
      }
      if (current.data !== undefined) {
        parts.push(JSON.stringify(current.data));
      }
    }
    current = current instanceof Error ? current.cause : undefined;
  }

  if (value !== undefined) {
    try {
      parts.push(JSON.stringify(value));
    } catch {
      parts.push(String(value));
    }
  }

  return parts.join('\n');
}

function credentialedCollapsedRequests(requests: SeenRequest[]): SeenRequest[] {
  return requests.filter(
    request =>
      COLLAPSED_PATHS.has(request.path) &&
      request.authorization === `Bearer ${PLACEHOLDER_KEY}`,
  );
}

describe('MiniMax video status encoded dot segments', () => {
  async function withOrigin(
    run: (baseURL: string, requests: SeenRequest[]) => Promise<void>,
  ) {
    const origin = await startOrigin();
    try {
      await run(origin.baseURL, origin.requests);
    } finally {
      await origin.close();
    }
  }

  it.each(['.', '..'])(
    'experimental_getVideoStatus does not send task id %j to a collapsed path with the API key',
    async taskId => {
      await withOrigin(async (baseURL, requests) => {
        const model = createMiniMax({
          apiKey: PLACEHOLDER_KEY,
          videoBaseURL: baseURL,
        }).video('MiniMax-H3');

        let result: unknown;
        let caught: unknown;
        try {
          result = await experimental_getVideoStatus(model, {
            operation: storedOperation(taskId),
            maxRetries: 0,
          });
        } catch (error) {
          caught = error;
        }

        expect(credentialedCollapsedRequests(requests)).toEqual([]);
        expect(callerVisibleText(result)).not.toContain(LISTING_MARKER);
        expect(callerVisibleText(caught)).not.toContain(LISTING_MARKER);
      });
    },
  );

  it.each(['.', '..'])(
    'doStatus does not send task id %j to a collapsed path with the API key',
    async taskId => {
      await withOrigin(async (baseURL, requests) => {
        const model = createMiniMax({
          apiKey: PLACEHOLDER_KEY,
          videoBaseURL: baseURL,
        }).video('MiniMax-H3');

        let result: unknown;
        let caught: unknown;
        try {
          result = await model.doStatus({
            operation: storedOperation(taskId),
          });
        } catch (error) {
          caught = error;
        }

        expect(credentialedCollapsedRequests(requests)).toEqual([]);
        expect(callerVisibleText(result)).not.toContain(LISTING_MARKER);
        expect(callerVisibleText(caught)).not.toContain(LISTING_MARKER);
      });
    },
  );
});
