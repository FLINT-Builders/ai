import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cancelBatch, getBatchStatus } from '../../ai/src/batch/batch';
import { experimental_getVideoStatus } from '../../ai/src/generate-video/get-video-status';
import { createGoogle } from './google-provider';

/**
 * Caller-supplied operation and batch ids are persisted JSON and are passed
 * back into status and cancel calls. These tests require that id to be
 * rejected before any request when it is not one safe resource segment.
 * The local server stands in for the Generative Language API host. The
 * request path is whatever Node's fetch actually sends, including dot-segment
 * normalization.
 */

const PLACEHOLDER_API_KEY = 'placeholder-api-key';
const FOREIGN_BODY = 'stored-generation-bytes';

const TRAVERSAL_NAMES = [
  '../download/v1beta/files/TARGET:download?alt=media',
  'operations/../../download/v1beta/files/TARGET:download?alt=media',
  'operations/%2e%2e/%2e%2e/download/v1beta/files/TARGET:download?alt=media',
  'operations/%2e%2e',
  'operations/..',
  'operations/.',
  'operations/',
  '',
  'operations/legit-id/extra',
  'operations/legit-id?alt=media',
  'operations/legit-id%2fextra',
  'operations/..%2f..%2fdownload/v1beta/files/TARGET',
  String.raw`\..\download\v1beta\files\TARGET`,
  String.raw`operations\legit-id\extra`,
  'https://generativelanguage.googleapis.com/download/v1beta/files/TARGET:download?alt=media',
  'models/../../download/v1beta/files/TARGET:download?alt=media',
] as const;

type SeenRequest = {
  method: string;
  pathname: string;
  search: string;
  sentApiKey: boolean;
};

describe('credentialed Google operation paths', () => {
  let server: Server;
  let baseURL: string;
  const requests: SeenRequest[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      requests.push({
        method: request.method ?? '',
        pathname: url.pathname,
        search: url.search,
        sentApiKey: request.headers['x-goog-api-key'] != null,
      });
      request.resume();

      if (
        request.method === 'GET' &&
        url.pathname === '/v1beta/operations/legit-id' &&
        url.search === ''
      ) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ name: 'operations/legit-id', done: false }),
        );
        return;
      }

      if (
        request.method === 'GET' &&
        url.pathname === '/v1beta/batches/legit-id' &&
        url.search === ''
      ) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ name: 'batches/legit-id', done: false }));
        return;
      }

      if (
        request.method === 'POST' &&
        url.pathname === '/v1beta/batches/legit-id:cancel' &&
        url.search === ''
      ) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }

      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(FOREIGN_BODY);
    });

    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address == null || typeof address === 'string') {
      throw new Error('expected the local server to listen on a TCP port');
    }
    baseURL = `http://127.0.0.1:${address.port}/v1beta`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  function provider() {
    return createGoogle({
      apiKey: PLACEHOLDER_API_KEY,
      baseURL,
    });
  }

  function requestLog(): string {
    return requests
      .map(
        request =>
          `${request.method} ${request.pathname}${request.search} apiKeySent=${request.sentApiKey}`,
      )
      .join('; ');
  }

  async function expectRejectedBeforeRequest(
    run: () => PromiseLike<unknown>,
  ): Promise<void> {
    requests.length = 0;
    let outcome: unknown;
    let resolved = false;
    try {
      outcome = await run();
      resolved = true;
    } catch (error) {
      outcome = error;
    }

    if (resolved) {
      expect.fail(
        `call resolved instead of rejecting. requests: ${requestLog()}`,
      );
    }
    expect(requests, requestLog()).toEqual([]);
    expect(containsForeignBody(outcome)).toBe(false);
  }

  describe('video status', () => {
    it('keeps a single operation segment on that operation', async () => {
      requests.length = 0;
      const model = provider().video('veo-3.1-generate-preview');
      const result = await experimental_getVideoStatus(model, {
        operation: { operationName: 'operations/legit-id' },
        maxRetries: 0,
      });

      expect(result.status).toBe('pending');
      expect(requests).toEqual([
        {
          method: 'GET',
          pathname: '/v1beta/operations/legit-id',
          search: '',
          sentApiKey: true,
        },
      ]);
      expect(containsForeignBody(result)).toBe(false);
    });

    it.each(TRAVERSAL_NAMES)(
      'experimental_getVideoStatus rejects %j before requesting it',
      async operationName => {
        const model = provider().video('veo-3.1-generate-preview');
        await expectRejectedBeforeRequest(() =>
          experimental_getVideoStatus(model, {
            operation: { operationName },
            maxRetries: 0,
          }),
        );
      },
    );

    it.each(TRAVERSAL_NAMES)(
      'doStatus rejects %j before requesting it',
      async operationName => {
        const model = provider().video('veo-3.1-generate-preview');
        await expectRejectedBeforeRequest(() =>
          model.doStatus!({
            operation: { operationName },
          }),
        );
      },
    );

    it('rejects a non-string operation name without coercing it into the path', async () => {
      const model = provider().video('veo-3.1-generate-preview');
      await expectRejectedBeforeRequest(() =>
        experimental_getVideoStatus(model, {
          operation: {
            operationName: {
              toString: () =>
                '../download/v1beta/files/TARGET:download?alt=media',
            },
          },
          maxRetries: 0,
        }),
      );
    });

    it('does not request a different name than the one it checked', async () => {
      let reads = 0;
      const operation = {
        get operationName() {
          reads += 1;
          return reads === 1
            ? 'operations/legit-id'
            : '../download/v1beta/files/TARGET:download?alt=media';
        },
      };
      requests.length = 0;
      const model = provider().video('veo-3.1-generate-preview');
      let outcome: unknown;
      try {
        outcome = await experimental_getVideoStatus(model, {
          operation,
          maxRetries: 0,
        });
      } catch (error) {
        outcome = error;
      }

      expect(requests.every(isAllowedVideoStatusRequest), requestLog()).toBe(
        true,
      );
      expect(containsForeignBody(outcome)).toBe(false);
      expect(reads).toBeGreaterThan(0);
    });
  });

  describe('batch status, results, and cancel', () => {
    const batchTraversalNames = TRAVERSAL_NAMES.map(name =>
      name === 'operations/legit-id/extra' ? 'batches/legit-id/extra' : name,
    );

    it('keeps a single batch segment on that batch', async () => {
      requests.length = 0;
      const google = provider();
      const result = await getBatchStatus({
        provider: google,
        batch: {
          version: 2,
          id: 'batches/legit-id',
          provider: 'google.batch',
        },
        maxRetries: 0,
      });

      expect(result.status).toBe('pending');
      expect(requests).toEqual([
        {
          method: 'GET',
          pathname: '/v1beta/batches/legit-id',
          search: '',
          sentApiKey: true,
        },
      ]);
    });

    it('cancels only that batch segment', async () => {
      requests.length = 0;
      const google = provider();
      await cancelBatch({
        provider: google,
        batch: {
          version: 2,
          id: 'batches/legit-id',
          provider: 'google.batch',
        },
      });

      expect(requests).toEqual([
        {
          method: 'POST',
          pathname: '/v1beta/batches/legit-id:cancel',
          search: '',
          sentApiKey: true,
        },
      ]);
    });

    it.each(batchTraversalNames)(
      'getBatchStatus rejects %j before requesting it',
      async batchId => {
        const google = provider();
        await expectRejectedBeforeRequest(() =>
          getBatchStatus({
            provider: google,
            batch: { version: 2, id: batchId, provider: 'google.batch' },
            maxRetries: 0,
          }),
        );
      },
    );

    it.each(batchTraversalNames)(
      'doGetBatchStatus rejects %j before requesting it',
      async batchId => {
        const batch = provider().experimental_batch();
        await expectRejectedBeforeRequest(() =>
          batch.doGetBatchStatus({ batchId }),
        );
      },
    );

    it.each(batchTraversalNames)(
      'doGetBatchResults rejects %j before requesting it',
      async batchId => {
        const batch = provider().experimental_batch();
        await expectRejectedBeforeRequest(() =>
          batch.doGetBatchResults({ batchId }),
        );
      },
    );

    it.each(batchTraversalNames)(
      'cancelBatch rejects %j before requesting it',
      async batchId => {
        const google = provider();
        await expectRejectedBeforeRequest(() =>
          cancelBatch({
            provider: google,
            batch: { version: 2, id: batchId, provider: 'google.batch' },
          }),
        );
      },
    );

    it.each(batchTraversalNames)(
      'doCancelBatch rejects %j before requesting it',
      async batchId => {
        const batch = provider().experimental_batch();
        await expectRejectedBeforeRequest(() =>
          batch.doCancelBatch!({ batchId }),
        );
      },
    );
  });
});

function isAllowedVideoStatusRequest(request: SeenRequest): boolean {
  if (request.method !== 'GET' || request.search !== '') {
    return false;
  }
  const match = /^\/v1beta\/operations\/([^/]+)$/.exec(request.pathname);
  if (match == null) {
    return false;
  }
  let segment: string;
  try {
    segment = decodeURIComponent(match[1]);
  } catch {
    return false;
  }
  return (
    segment !== '.' && segment !== '..' && /^[A-Za-z0-9._~-]+$/.test(segment)
  );
}

function containsForeignBody(value: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (current: unknown): boolean => {
    if (typeof current === 'string') {
      return current.includes(FOREIGN_BODY);
    }
    if (current == null || typeof current !== 'object') {
      return false;
    }
    if (seen.has(current)) {
      return false;
    }
    seen.add(current);
    if (
      current instanceof Error &&
      visit((current as { cause?: unknown }).cause)
    ) {
      return true;
    }
    for (const entry of Object.values(current)) {
      if (visit(entry)) {
        return true;
      }
    }
    return false;
  };
  return visit(value);
}
