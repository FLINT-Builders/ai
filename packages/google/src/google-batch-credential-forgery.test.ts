import { describe, expect, it } from 'vitest';
import { createGoogle } from './google-provider';

const isEdgeRuntime =
  (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime !== undefined;

/**
 * Placeholder configured on the provider. The tests assert this same value is
 * the credential attached to batch requests; it is not a real API key.
 */
const placeholderApiKey = 'test-api-key';

/**
 * Bytes served only when a request leaves the batches collection. A caller
 * must not observe them.
 */
const foreignBody = 'foreign-batch-file-bytes';

const batchIds = [
  '../download/v1beta/files/target:download?alt=media',
  'batches/../../download/v1beta/files/target:download?alt=media',
  '%2e%2e/download/v1beta/files/target:download?alt=media',
  '..\\download\\v1beta\\files\\target:download?alt=media',
  'models/gemini-2.5-flash:generateContent?',
  'batches/ok?alt=media',
  'batches/..',
] as const;

type Operation = 'status' | 'results' | 'cancel';
type EntryPoint = 'public' | 'provider';

type ProbeRequest = {
  method: string;
  target: string;
  apiKey: string | undefined;
};

/**
 * A credentialed batch status, results, or cancel request may only address
 * one segment under the batches collection. The path is the one the server
 * received after the runtime resolved the URL.
 */
function isCredentialedBatchResource(method: string, target: string): boolean {
  const url = new URL(target, 'http://127.0.0.1');
  if (url.search !== '') {
    return false;
  }

  const segments = url.pathname.split('/').filter(segment => segment !== '');
  if (
    segments.length !== 3 ||
    segments[0] !== 'v1beta' ||
    segments[1] !== 'batches'
  ) {
    return false;
  }

  let resource = segments[2];
  if (method === 'POST') {
    if (!resource.endsWith(':cancel')) {
      return false;
    }
    resource = resource.slice(0, -':cancel'.length);
  } else if (method !== 'GET') {
    return false;
  }

  return resource !== '' && resource !== '.' && resource !== '..';
}

function observedText(value: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();

  const visit = (current: unknown) => {
    if (current == null || seen.has(current)) {
      return;
    }
    if (typeof current === 'string') {
      parts.push(current);
      return;
    }
    if (typeof current !== 'object') {
      parts.push(String(current));
      return;
    }

    seen.add(current);
    if (current instanceof Error) {
      parts.push(current.message);
    }

    for (const key of ['responseBody', 'url', 'cause', 'data'] as const) {
      if (key in current) {
        visit((current as Record<string, unknown>)[key]);
      }
    }
  };

  visit(value);
  return parts.join('\n');
}

async function startProbe() {
  const { createServer } = await import('node:http');
  const requests: ProbeRequest[] = [];
  const server = createServer(async (request, response) => {
    try {
      for await (const chunk of request) {
        void chunk;
      }

      const method = request.method ?? 'GET';
      const target = request.url ?? '/';
      const apiKeyHeader = request.headers['x-goog-api-key'];
      requests.push({
        method,
        target,
        apiKey: Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader,
      });

      const confined = isCredentialedBatchResource(method, target);
      response.writeHead(200, {
        'content-type': confined ? 'application/json' : 'text/plain',
      });
      response.end(
        confined
          ? JSON.stringify({
              name: 'batches/pending',
              done: false,
              metadata: { state: 'BATCH_STATE_PENDING' },
            })
          : foreignBody,
      );
    } catch {
      response.destroy();
    }
  });

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('Expected the probe server to listen on a TCP port.');
  }

  return {
    baseURL: `http://127.0.0.1:${address.port}/v1beta`,
    requests,
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function callOperation({
  entryPoint,
  operation,
  batchId,
  baseURL,
}: {
  entryPoint: EntryPoint;
  operation: Operation;
  batchId: string;
  baseURL: string;
}) {
  const batchApi = createGoogle({
    apiKey: placeholderApiKey,
    baseURL,
  }).experimental_batch();

  if (entryPoint === 'provider') {
    if (operation === 'status') {
      return batchApi.doGetBatchStatus({ batchId });
    }
    if (operation === 'cancel') {
      return batchApi.doCancelBatch?.({ batchId });
    }

    const stream = await batchApi.doGetBatchResults({ batchId });
    const reader = stream.getReader();
    const items = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        items.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return items;
  }

  const publicBatchModuleUrl = new URL(
    '../../ai/src/batch/batch.ts',
    import.meta.url,
  ).href;
  const { cancelBatch, getBatchResults, getBatchStatus } = await import(
    /* @vite-ignore */ publicBatchModuleUrl
  );
  const batch = {
    version: 2 as const,
    id: batchId,
    provider: batchApi.provider,
  };

  if (operation === 'status') {
    return getBatchStatus({
      provider: batchApi,
      batch,
      maxRetries: 0,
    });
  }
  if (operation === 'cancel') {
    return cancelBatch({ provider: batchApi, batch });
  }

  const items = [];
  for await (const item of getBatchResults({
    provider: batchApi,
    batch,
    maxRetries: 0,
  })) {
    items.push(item);
  }
  return items;
}

describe.skipIf(isEdgeRuntime)(
  'Google batch ids cannot choose another credentialed path',
  () => {
    it.each(
      (['public', 'provider'] as const).flatMap(entryPoint =>
        (['status', 'results', 'cancel'] as const).flatMap(operation =>
          batchIds.map(batchId => [entryPoint, operation, batchId] as const),
        ),
      ),
    )(
      '%s %s keeps the API key on one batches segment for %j',
      async (entryPoint, operation, batchId) => {
        const probe = await startProbe();
        try {
          let outcome: unknown;
          try {
            outcome = await callOperation({
              entryPoint,
              operation,
              batchId,
              baseURL: probe.baseURL,
            });
          } catch (error) {
            outcome = error;
          }

          if (probe.requests.length === 0) {
            expect(outcome).toBeInstanceOf(Error);
            expect((outcome as Error).name.startsWith('AI_')).toBe(true);
          }
          for (const request of probe.requests) {
            expect(request.apiKey).toBe(placeholderApiKey);
            expect(
              isCredentialedBatchResource(request.method, request.target),
              `${request.method} ${request.target}`,
            ).toBe(true);
          }
          expect(observedText(outcome)).not.toContain(foreignBody);
        } finally {
          await probe.stop();
        }
      },
    );
  },
);
