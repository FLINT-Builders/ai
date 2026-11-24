import type { FetchFunction } from '@ai-sdk/provider-utils';
import { describe, expect, it } from 'vitest';
import { createKlingAI } from './klingai-provider';

/**
 * Placeholder only. The assertion is that this value is not attached to a
 * request whose origin is not the configured KlingAI base URL.
 */
const PLACEHOLDER_API_KEY = 'test-api-key';

const DEFAULT_BASE_URL = 'https://api-singapore.klingai.com';

/**
 * Paths `doStart` stores on the operation. `doStatus` must not request any
 * other path, and must not treat a caller-supplied path as a URL suffix.
 */
const KNOWN_ENDPOINT_PATHS = [
  '/v1/videos/text2video',
  '/v1/videos/image2video',
  '/v1/videos/multi-image2video',
  '/v1/videos/motion-control',
] as const;

type CapturedRequest = {
  url: string;
  authorization: string | null;
};

function capturingFetch(calls: CapturedRequest[]): FetchFunction {
  return async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      authorization: headers.get('authorization'),
    });
    return new Response(
      JSON.stringify({
        code: 0,
        message: 'success',
        data: {
          task_id: 'task-1',
          task_status: 'submitted',
        },
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  };
}

function createModel({
  baseURL,
  calls,
}: {
  baseURL?: string;
  calls: CapturedRequest[];
}) {
  return createKlingAI({
    apiKey: PLACEHOLDER_API_KEY,
    baseURL,
    fetch: capturingFetch(calls),
  }).video('kling-v2.6-t2v');
}

/**
 * Runs the status check the way `experimental_getVideoStatus` does: the
 * operation object is forwarded unchanged to `doStatus`. Rejection is an
 * acceptable outcome. A request to any other origin is not.
 */
async function checkStatus(
  model: ReturnType<typeof createModel>,
  operation: { taskId: string; endpointPath: string },
): Promise<void> {
  if (model.doStatus == null) {
    throw new Error('KlingAI video model does not implement doStatus');
  }

  try {
    await model.doStatus({ operation });
  } catch {
    // A fix may reject a tampered operation. The request must not have left
    // the configured origin before that rejection.
  }
}

function expectRequestsStayOnConfiguredOrigin(
  calls: CapturedRequest[],
  baseURL: string,
): void {
  const configuredOrigin = new URL(baseURL).origin;
  const offOrigin = calls.filter(call => {
    try {
      return new URL(call.url).origin !== configuredOrigin;
    } catch {
      return true;
    }
  });

  expect(offOrigin).toEqual([]);

  for (const call of calls) {
    const url = new URL(call.url);
    expect(url.origin).toBe(configuredOrigin);
    expect(
      KNOWN_ENDPOINT_PATHS.some(path => url.pathname.startsWith(`${path}/`)),
    ).toBe(true);
    expect(call.authorization).toBe(`Bearer ${PLACEHOLDER_API_KEY}`);
  }
}

describe('KlingAI video status operation URL', () => {
  describe('caller-supplied endpointPath', () => {
    it.each([
      {
        label: 'dot suffix on the default base URL',
        baseURL: undefined,
        resolvedBaseURL: DEFAULT_BASE_URL,
        endpointPath: '.attacker.example',
        taskId: 'x',
      },
      {
        label: 'dot suffix after a trailing slash is stripped',
        baseURL: `${DEFAULT_BASE_URL}/`,
        resolvedBaseURL: DEFAULT_BASE_URL,
        endpointPath: '.attacker.example',
        taskId: 'x',
      },
      {
        label: 'userinfo separator',
        baseURL: undefined,
        resolvedBaseURL: DEFAULT_BASE_URL,
        endpointPath: '@attacker.example',
        taskId: 'x',
      },
      {
        label: 'percent-encoded dot decoded by the URL parser',
        baseURL: undefined,
        resolvedBaseURL: DEFAULT_BASE_URL,
        endpointPath: '%2eattacker.example',
        taskId: 'x',
      },
      {
        label: 'leading newline stripped by the URL parser',
        baseURL: undefined,
        resolvedBaseURL: DEFAULT_BASE_URL,
        endpointPath: '\n.attacker.example',
        taskId: 'x',
      },
      {
        label: 'dot suffix on a custom origin-only base URL',
        baseURL: 'https://custom.klingai.example',
        resolvedBaseURL: 'https://custom.klingai.example',
        endpointPath: '.attacker.example',
        taskId: 'x',
      },
    ])(
      'does not request an origin chosen by endpointPath ($label)',
      async ({ baseURL, resolvedBaseURL, endpointPath, taskId }) => {
        const calls: CapturedRequest[] = [];
        const model = createModel({ baseURL, calls });

        await checkStatus(model, { taskId, endpointPath });

        expectRequestsStayOnConfiguredOrigin(calls, resolvedBaseURL);
      },
    );
  });

  it('percent-encodes taskId on a known endpoint path', async () => {
    const calls: CapturedRequest[] = [];
    const model = createModel({ calls });
    const taskId = 'a/b c?d#e';

    await checkStatus(model, {
      taskId,
      endpointPath: '/v1/videos/text2video',
    });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.origin).toBe(new URL(DEFAULT_BASE_URL).origin);
    expect(url.pathname).toBe(
      `/v1/videos/text2video/${encodeURIComponent(taskId)}`,
    );
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
    expect(calls[0].authorization).toBe(`Bearer ${PLACEHOLDER_API_KEY}`);
  });
});
