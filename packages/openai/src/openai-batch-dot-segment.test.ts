import type { AddressInfo } from 'node:net';
import type { IncomingMessage, Server } from 'node:http';
import { APICallError } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { createOpenAI } from './openai-provider';

const isEdgeRuntime =
  (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime !== undefined;

const otherBatchId = 'batch_other_user';
const otherOutputFileId = 'file_other_user_output';
const otherOutputText = 'other-user-batch-output';

type RecordedRequest = {
  method: string;
  path: string;
  authorization: boolean;
};

/**
 * List document from the published OpenAI OpenAPI `listBatches` example.
 * Returned for the collection spellings `GET /v1/batches` and `GET /v1/batches/`.
 */
function listDocument() {
  return {
    object: 'list',
    data: [
      {
        id: otherBatchId,
        object: 'batch',
        endpoint: '/v1/responses',
        errors: null,
        input_file_id: 'file_other_user_input',
        completion_window: '24h',
        status: 'completed',
        output_file_id: otherOutputFileId,
        error_file_id: null,
        created_at: 1_711_471_533,
        request_counts: { total: 1, completed: 1, failed: 0 },
      },
    ],
    first_id: otherBatchId,
    last_id: otherBatchId,
    has_more: false,
  };
}

function singleBatchDocument() {
  return listDocument().data[0];
}

function resultLine() {
  return JSON.stringify({
    custom_id: 'request-other',
    response: {
      status_code: 200,
      request_id: 'req_other',
      body: {
        id: 'resp_other',
        created_at: 1_711_471_533,
        model: 'gpt-5.6',
        output: [
          {
            type: 'message',
            role: 'assistant',
            id: 'msg_other',
            content: [
              {
                type: 'output_text',
                text: otherOutputText,
                annotations: [],
              },
            ],
          },
        ],
      },
    },
    error: null,
  });
}

function pathnameOf(url: string | undefined): string {
  return (url ?? '').split('?')[0] ?? '';
}

/**
 * A request that still names one batch after the client has normalized the
 * URL. Dot and dot-dot segments are already removed by the time the server
 * sees the path, so a collapsed id never matches.
 */
function isSingleBatchRequest(request: RecordedRequest): boolean {
  const pathname = pathnameOf(request.path);

  if (request.method === 'GET') {
    const match = pathname.match(/^\/v1\/batches\/([^/]+)$/);
    if (match?.[1] == null) {
      return false;
    }
    const segment = decodeURIComponent(match[1]);
    return segment !== '' && segment !== '.' && segment !== '..';
  }

  if (request.method === 'POST') {
    const match = pathname.match(/^\/v1\/batches\/([^/]+)\/cancel$/);
    if (match?.[1] == null) {
      return false;
    }
    const segment = decodeURIComponent(match[1]);
    return segment !== '' && segment !== '.' && segment !== '..';
  }

  return false;
}

async function discardBody(request: IncomingMessage): Promise<void> {
  for await (const _chunk of request) {
    // The SDK posts an empty JSON body on cancel. Drain it so the socket ends.
  }
}

async function loadBatchApi() {
  return import('../../ai/src/batch/batch');
}

async function withBatchServer<T>(
  run: (baseURL: string, requests: RecordedRequest[]) => Promise<T>,
): Promise<T> {
  const { createServer } = await import('node:http');
  const requests: RecordedRequest[] = [];
  const server: Server = createServer(async (request, response) => {
    await discardBody(request);
    const path = pathnameOf(request.url);
    const method = request.method ?? 'GET';
    const authorization = request.headers.authorization;
    requests.push({
      method,
      path,
      authorization:
        typeof authorization === 'string' &&
        authorization.startsWith('Bearer '),
    });

    const fileContentPath = `/v1/files/${otherOutputFileId}/content`;
    if (method === 'GET' && path === fileContentPath) {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`${resultLine()}\n`);
      return;
    }

    if (method === 'GET' && path === `/v1/batches/${otherBatchId}`) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(singleBatchDocument()));
      return;
    }

    if (
      method === 'GET' &&
      (path === '/v1/batches' || path === '/v1/batches/')
    ) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(listDocument()));
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        error: {
          message: 'No batch was found with the specified ID.',
          type: 'invalid_request_error',
          code: null,
        },
      }),
    );
  });

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  try {
    const { port } = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${port}/v1`, requests);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error == null) {
          resolve();
          return;
        }
        reject(error);
      });
    });
  }
}

function exposedText(error: unknown): string {
  const parts: unknown[] = [];
  const seen = new Set<unknown>();

  function visit(value: unknown): void {
    if (value == null || seen.has(value)) {
      return;
    }
    if (typeof value !== 'object') {
      parts.push(value);
      return;
    }
    seen.add(value);
    if (value instanceof Error) {
      parts.push(value.name, value.message);
    }
    if (APICallError.isInstance(value)) {
      parts.push(value.url, value.responseBody, value.data, value.statusCode);
    }
    const record = value as Record<string, unknown>;
    for (const key of ['cause', 'reason', 'responseBody', 'data', 'url']) {
      if (key in record) {
        visit(record[key]);
      }
    }
  }

  visit(error);
  return JSON.stringify(parts);
}

function providerFor(baseURL: string) {
  return createOpenAI({
    apiKey: 'placeholder',
    baseURL,
  });
}

function reference(id: string) {
  return {
    version: 2 as const,
    id,
    provider: 'openai.batch',
  };
}

async function expectNoCrossBatchAccess({
  requests,
  error,
}: {
  requests: RecordedRequest[];
  error: unknown;
}): Promise<void> {
  const exposed = exposedText(error);
  const outside = requests.filter(request => !isSingleBatchRequest(request));
  expect({
    outside,
    authorizationOnEveryRequest: requests.every(
      request => request.authorization,
    ),
    exposedOtherBatchId: exposed.includes(otherBatchId),
    exposedOutputFileId: exposed.includes(otherOutputFileId),
    exposedOutputText: exposed.includes(otherOutputText),
    downloadedOtherOutput: requests.some(request =>
      request.path.includes(otherOutputFileId),
    ),
  }).toEqual({
    outside: [],
    authorizationOnEveryRequest: true,
    exposedOtherBatchId: false,
    exposedOutputFileId: false,
    exposedOutputText: false,
    downloadedOtherOutput: false,
  });
}

describe.skipIf(isEdgeRuntime)(
  'OpenAI batch ids that normalize outside one batch',
  () => {
    const dotIds = ['.', '..'] as const;

    describe('getBatchStatus', () => {
      it.each(dotIds)(
        'does not turn batch id %j into another user batch',
        async id => {
          await withBatchServer(async (baseURL, requests) => {
            const { getBatchStatus } = await loadBatchApi();
            const provider = providerFor(baseURL);
            let error: unknown;
            try {
              await getBatchStatus({
                provider,
                batch: reference(id),
                maxRetries: 0,
              });
            } catch (caught) {
              error = caught;
            }

            expect(error).toBeDefined();
            await expectNoCrossBatchAccess({ requests, error });
          });
        },
      );
    });

    describe('cancelBatch', () => {
      it.each(dotIds)(
        'does not send a cancel for batch id %j outside that batch',
        async id => {
          await withBatchServer(async (baseURL, requests) => {
            const { cancelBatch } = await loadBatchApi();
            const provider = providerFor(baseURL);
            let error: unknown;
            try {
              await cancelBatch({
                provider,
                batch: reference(id),
              });
            } catch (caught) {
              error = caught;
            }

            expect(error).toBeDefined();
            await expectNoCrossBatchAccess({ requests, error });
          });
        },
      );
    });

    describe('getBatchResults', () => {
      it.each(dotIds)(
        'does not download another batch for batch id %j',
        async id => {
          await withBatchServer(async (baseURL, requests) => {
            const { getBatchResults } = await loadBatchApi();
            const provider = providerFor(baseURL);
            let error: unknown;
            try {
              const stream = getBatchResults({
                provider,
                batch: reference(id),
                maxRetries: 0,
              });
              for await (const _item of stream) {
                // A fixed provider rejects before yielding another batch's rows.
              }
            } catch (caught) {
              error = caught;
            }

            expect(error).toBeDefined();
            await expectNoCrossBatchAccess({ requests, error });
          });
        },
      );
    });

    describe('provider batch methods', () => {
      it.each(dotIds)(
        'doGetBatchStatus keeps batch id %j on one batch',
        async id => {
          await withBatchServer(async (baseURL, requests) => {
            const batch = providerFor(baseURL).experimental_batch();
            let error: unknown;
            try {
              await batch.doGetBatchStatus({ batchId: id });
            } catch (caught) {
              error = caught;
            }

            expect(error).toBeDefined();
            await expectNoCrossBatchAccess({ requests, error });
          });
        },
      );

      it.each(dotIds)(
        'doCancelBatch keeps batch id %j on one batch',
        async id => {
          await withBatchServer(async (baseURL, requests) => {
            const batch = providerFor(baseURL).experimental_batch();
            let error: unknown;
            try {
              await batch.doCancelBatch?.({ batchId: id });
            } catch (caught) {
              error = caught;
            }

            expect(error).toBeDefined();
            await expectNoCrossBatchAccess({ requests, error });
          });
        },
      );

      it.each(dotIds)(
        'doGetBatchResults keeps batch id %j on one batch',
        async id => {
          await withBatchServer(async (baseURL, requests) => {
            const batch = providerFor(baseURL).experimental_batch();
            let error: unknown;
            try {
              const stream = await batch.doGetBatchResults({ batchId: id });
              const reader = stream.getReader();
              try {
                while (true) {
                  const next = await reader.read();
                  if (next.done) {
                    break;
                  }
                }
              } finally {
                reader.releaseLock();
              }
            } catch (caught) {
              error = caught;
            }

            expect(error).toBeDefined();
            await expectNoCrossBatchAccess({ requests, error });
          });
        },
      );
    });
  },
);
