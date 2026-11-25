import { createServer, type ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createAnthropic } from './anthropic-provider';

/**
 * Batch ids are caller-supplied. `getBatchStatus`, `cancelBatch`, and
 * `getBatchResults` forward `batch.id` into these methods after checking only
 * the reference version and provider name. A single `encodeURIComponent` leaves
 * "." and ".." as dot segments, and an empty id selects the collection.
 *
 * These tests fail while a status, cancel, or results call can turn that id
 * into a credentialed request for a different path, or can return another
 * batch's id or results to the caller.
 */

const PLACEHOLDER_API_KEY = 'placeholder-api-key';
const CONTROL_BATCH_ID = 'msgbatch_123';
const VICTIM_BATCH_ID = 'msgbatch_victim_9f3c2a';
const VICTIM_RESULT_MARKER = 'victim-batch-output-9f3c2a';

const BATCH_PREFIX = '/v1/messages/batches/';

type Operation = 'status' | 'cancel' | 'results';

type ObservedRequest = {
  method: string;
  pathname: string;
  credential: 'sent' | 'missing';
};

const cases: Array<{ operation: Operation; id: string; label: string }> = [
  { operation: 'status', id: '.', label: 'dot' },
  { operation: 'status', id: '..', label: 'dot-dot' },
  { operation: 'status', id: '', label: 'empty' },
  { operation: 'cancel', id: '.', label: 'dot' },
  { operation: 'cancel', id: '..', label: 'dot-dot' },
  { operation: 'cancel', id: '', label: 'empty' },
  { operation: 'results', id: '.', label: 'dot' },
  { operation: 'results', id: '..', label: 'dot-dot' },
  { operation: 'results', id: '', label: 'empty' },
];

describe('Anthropic batch id path segments', () => {
  it.each(cases)(
    '$operation keeps batch id $label on one /messages/batches segment',
    async ({ operation, id }) => {
      const seen: ObservedRequest[] = [];
      const server = createServer((request, response) => {
        const pathname = new URL(request.url ?? '/', 'http://127.0.0.1')
          .pathname;
        const host = request.headers.host ?? '127.0.0.1';
        seen.push({
          method: request.method ?? 'GET',
          pathname,
          credential:
            request.headers['x-api-key'] === PLACEHOLDER_API_KEY
              ? 'sent'
              : 'missing',
        });
        respond(response, pathname, `http://${host}`);
      });

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });

      try {
        const address = server.address();
        if (address == null || typeof address === 'string') {
          throw new Error('Test server did not bind a TCP port.');
        }
        const origin = `http://127.0.0.1:${address.port}`;
        const baseURL = `${origin}/v1`;
        const batch = createAnthropic({
          apiKey: PLACEHOLDER_API_KEY,
          baseURL,
        }).experimental_batch();

        seen.length = 0;
        await invoke(batch, operation, CONTROL_BATCH_ID);
        const controlRequests = seen.slice();
        expect(controlRequests).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              pathname: controlPath(operation),
              credential: 'sent',
            }),
          ]),
        );
        if (operation === 'results') {
          expect(controlRequests).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                pathname: `${BATCH_PREFIX}${CONTROL_BATCH_ID}/results`,
                credential: 'sent',
              }),
            ]),
          );
        }

        seen.length = 0;
        const attackText = await invoke(batch, operation, id);
        const attackRequests = seen.slice();
        let followText = '';
        if (attackText.includes(VICTIM_BATCH_ID)) {
          seen.length = 0;
          followText = await invoke(batch, 'results', VICTIM_BATCH_ID);
        }
        const followRequests = attackText.includes(VICTIM_BATCH_ID)
          ? seen.slice()
          : [];

        expect({
          unboundRequests: attackRequests
            .filter(request => !requestBindsBatchId(request, id, operation))
            .map(summarize),
          victimResultsRequested: [...attackRequests, ...followRequests].some(
            request =>
              request.pathname === `${BATCH_PREFIX}${VICTIM_BATCH_ID}/results`,
          ),
          leakedVictimId:
            attackText.includes(VICTIM_BATCH_ID) ||
            followText.includes(VICTIM_BATCH_ID),
          leakedVictimResult:
            attackText.includes(VICTIM_RESULT_MARKER) ||
            followText.includes(VICTIM_RESULT_MARKER),
        }).toEqual({
          unboundRequests: [],
          victimResultsRequested: false,
          leakedVictimId: false,
          leakedVictimResult: false,
        });
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    },
  );
});

function controlPath(operation: Operation): string {
  if (operation === 'cancel') {
    return `${BATCH_PREFIX}${CONTROL_BATCH_ID}/cancel`;
  }
  return `${BATCH_PREFIX}${CONTROL_BATCH_ID}`;
}

function requestBindsBatchId(
  request: ObservedRequest,
  id: string,
  operation: Operation,
): boolean {
  if (!request.pathname.startsWith(BATCH_PREFIX)) {
    return false;
  }

  let rest = request.pathname.slice(BATCH_PREFIX.length);
  if (operation === 'cancel') {
    if (!rest.endsWith('/cancel')) {
      return false;
    }
    rest = rest.slice(0, -'/cancel'.length);
  } else if (rest.endsWith('/results')) {
    rest = rest.slice(0, -'/results'.length);
  }

  if (rest.length === 0 || rest.includes('/')) {
    return false;
  }

  return segmentBindsId(rest, id);
}

function segmentBindsId(segment: string, id: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return false;
  }

  // A single percent-encoding of "." or ".." is still removed by URL parsing.
  if (decoded === '.' || decoded === '..' || decoded === '') {
    return false;
  }

  if (segment === encodeURIComponent(id)) {
    return true;
  }

  // Double-encoding is what keeps a literal dot segment on the wire.
  if (id === '.' && /^%252e$/i.test(segment)) {
    return true;
  }
  if (id === '..' && /^%252e%252e$/i.test(segment)) {
    return true;
  }

  return false;
}

function summarize(request: ObservedRequest) {
  return {
    method: request.method,
    pathname: request.pathname,
    credential: request.credential,
  };
}

async function invoke(
  batch: ReturnType<ReturnType<typeof createAnthropic>['experimental_batch']>,
  operation: Operation,
  id: string,
): Promise<string> {
  try {
    if (operation === 'status') {
      return visible(await batch.doGetBatchStatus({ batchId: id }));
    }
    if (operation === 'cancel') {
      return visible(await batch.doCancelBatch!({ batchId: id }));
    }

    const stream = await batch.doGetBatchResults({ batchId: id });
    const reader = stream.getReader();
    const parts: string[] = [];
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      parts.push(visible(next.value));
    }
    return parts.join('\n');
  } catch (error) {
    return visible(error);
  }
}

function visible(value: unknown, seen = new Set<unknown>()): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value == null || typeof value !== 'object') {
    return value == null ? '' : String(value);
  }
  if (seen.has(value)) {
    return '';
  }
  seen.add(value);

  const parts: string[] = [];
  if (value instanceof Error) {
    parts.push(value.message);
  }

  const record = value as Record<string, unknown>;
  for (const key of new Set([
    ...Object.keys(record),
    'message',
    'cause',
    'responseBody',
    'url',
    'data',
    'errors',
  ])) {
    if (key in record) {
      parts.push(visible(record[key], seen));
    }
  }

  try {
    parts.push(JSON.stringify(value));
  } catch {
    // Ignore values that cannot be serialized.
  }

  return parts.join('\n');
}

function respond(response: ServerResponse, pathname: string, origin: string) {
  const controlBatch = `${BATCH_PREFIX}${CONTROL_BATCH_ID}`;
  const victimBatch = `${BATCH_PREFIX}${VICTIM_BATCH_ID}`;

  if (
    pathname === controlBatch ||
    pathname === `${controlBatch}/cancel` ||
    pathname === victimBatch ||
    pathname === `${victimBatch}/cancel`
  ) {
    const id = pathname.startsWith(victimBatch)
      ? VICTIM_BATCH_ID
      : CONTROL_BATCH_ID;
    const batchPath = id === VICTIM_BATCH_ID ? victimBatch : controlBatch;
    sendJson(response, 200, batchBody(id, `${origin}${batchPath}/results`));
    return;
  }

  if (pathname === `${controlBatch}/results`) {
    sendText(
      response,
      200,
      `${JSON.stringify({
        custom_id: 'control',
        result: { type: 'canceled' },
      })}\n`,
    );
    return;
  }

  if (pathname === `${victimBatch}/results`) {
    sendText(
      response,
      200,
      `${JSON.stringify({
        custom_id: 'other-user',
        result: {
          type: 'succeeded',
          message: {
            id: 'msg_victim',
            type: 'message',
            role: 'assistant',
            model: 'claude-3-haiku-20240307',
            content: [{ type: 'text', text: VICTIM_RESULT_MARKER }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      })}\n`,
    );
    return;
  }

  // The batch list is served only at the collection URL. Parent paths and
  // other collapsed targets get an ordinary not-found body so a leak is
  // reported only when the caller actually reached this collection.
  if (
    pathname === '/v1/messages/batches' ||
    pathname === '/v1/messages/batches/'
  ) {
    sendJson(response, 200, {
      data: [batchBody(VICTIM_BATCH_ID, `${origin}${victimBatch}/results`)],
      has_more: false,
      last_id: VICTIM_BATCH_ID,
    });
    return;
  }

  sendJson(response, 404, {
    type: 'error',
    error: { type: 'not_found_error', message: 'Not found' },
  });
}

function batchBody(id: string, resultsPath: string) {
  return {
    id,
    type: 'message_batch',
    processing_status: 'ended',
    request_counts: {
      processing: 0,
      succeeded: 1,
      errored: 0,
      canceled: 0,
      expired: 0,
    },
    created_at: '2024-09-24T18:37:24.100Z',
    expires_at: '2024-09-25T18:37:24.100Z',
    archived_at: null,
    cancel_initiated_at: null,
    ended_at: '2024-09-24T18:38:24.100Z',
    results_url: resultsPath,
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  sendText(response, status, JSON.stringify(body), 'application/json');
}

function sendText(
  response: ServerResponse,
  status: number,
  body: string,
  contentType = 'text/plain',
) {
  response.writeHead(status, { 'content-type': contentType });
  response.end(body);
}
