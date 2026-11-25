import { describe, expect, it, vi } from 'vitest';
import { experimental_getVideoStatus } from '../../ai/src/generate-video/get-video-status';
import { experimental_startVideo } from '../../ai/src/generate-video/start-video';
import { createFal } from './fal-provider';

const API_TOKEN = 'test-api-token';
const MODEL_ID = 'luma-dream-machine';
const REQUEST_ID = 'req-user';
const USER_VIDEO_URL = 'https://videos.example/user-only.mp4';
const VICTIM_VIDEO_URL = 'https://videos.example/victim-only.mp4';
const VICTIM_RESPONSE_URL =
  'https://queue.fal.run/fal-ai/luma-dream-machine/requests/req-victim';
const ACCOUNT_MARKER = 'other-customer-account-payload';

vi.mock('./version', () => ({
  VERSION: '0.0.0-test',
}));

vi.mock('../../ai/src/version', () => ({
  VERSION: '0.0.0-test',
}));

type CapturedRequest = {
  url: string;
  method: string;
  authorization: string | null;
};

function isLockedStatusUrl(requestUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return false;
  }
  if (parsed.origin !== 'https://queue.fal.run') return false;
  if (parsed.search !== '' || parsed.hash !== '' || parsed.username !== '') {
    return false;
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  return (
    segments.length === 4 &&
    segments[0] === 'fal-ai' &&
    segments[1] === MODEL_ID &&
    segments[2] === 'requests' &&
    decodeURIComponent(segments[3]) === REQUEST_ID &&
    segments[3] !== '.' &&
    segments[3] !== '..'
  );
}

function createHarness(responseUrl: string) {
  const requests: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = init?.method ?? 'GET';
    requests.push({
      url,
      method,
      authorization:
        init?.headers == null
          ? null
          : new Headers(init.headers).get('authorization'),
    });

    if (method === 'POST') {
      return Response.json({
        request_id: REQUEST_ID,
        response_url: responseUrl,
      });
    }

    if (isLockedStatusUrl(url)) {
      return Response.json({
        video: { url: USER_VIDEO_URL, content_type: 'video/mp4' },
      });
    }

    if (url === VICTIM_RESPONSE_URL) {
      return Response.json({
        video: { url: VICTIM_VIDEO_URL, content_type: 'video/mp4' },
      });
    }

    return Response.json({ username: ACCOUNT_MARKER });
  };

  const model = createFal({ apiKey: API_TOKEN, fetch: fetchImpl }).video(
    MODEL_ID,
  );
  return { requests, model };
}

describe('fal video status URL', () => {
  it('does not fetch a replaced response URL with the api token', async () => {
    const harness = createHarness(
      'https://queue.fal.run/fal-ai/luma-dream-machine/requests/req-user',
    );
    const started = await experimental_startVideo({
      model: harness.model,
      prompt: 'a rocket',
      maxRetries: 0,
    });
    const beforeStatus = harness.requests.length;
    const operation = {
      ...(started.operation as Record<string, unknown>),
      responseUrl: VICTIM_RESPONSE_URL,
    };

    const result = await experimental_getVideoStatus(harness.model, {
      operation,
      maxRetries: 0,
    });

    const gets = harness.requests
      .slice(beforeStatus)
      .filter(request => request.method === 'GET');
    expect(gets).toHaveLength(1);
    expect(isLockedStatusUrl(gets[0].url)).toBe(true);
    expect(gets[0].authorization).toBe(`Key ${API_TOKEN}`);
    expect(result.status === 'completed' && result.videos[0]?.url).toBe(
      USER_VIDEO_URL,
    );
  });

  it('does not send the api token to a caller-selected host', async () => {
    const harness = createHarness(
      'https://queue.fal.run/fal-ai/luma-dream-machine/requests/req-user',
    );
    const attacker = 'https://example.invalid/collect';
    let thrown: unknown;
    try {
      await experimental_getVideoStatus(harness.model, {
        operation: {
          responseUrl: attacker,
          submitUrl: 'https://example.invalid',
        },
        maxRetries: 0,
      });
    } catch (error) {
      thrown = error;
    }

    expect(harness.requests.map(request => request.url)).not.toContain(
      attacker,
    );
    expect(
      harness.requests.some(
        request =>
          request.authorization === `Key ${API_TOKEN}` &&
          request.url === attacker,
      ),
    ).toBe(false);
    expect(JSON.stringify(thrown ?? '')).not.toContain(ACCOUNT_MARKER);
  });

  it('does not treat a caller-supplied submit URL as a trusted origin', async () => {
    const harness = createHarness(
      'https://queue.fal.run/fal-ai/luma-dream-machine/requests/req-user',
    );
    const attacker = 'http://127.0.0.1/latest/meta-data';

    await experimental_getVideoStatus(harness.model, {
      operation: { responseUrl: attacker, submitUrl: 'http://127.0.0.1' },
      maxRetries: 0,
    }).catch(() => undefined);

    expect(harness.requests.map(request => request.url)).not.toContain(
      attacker,
    );
    expect(
      harness.requests.some(request => request.url.includes('127.0.0.1')),
    ).toBe(false);
  });

  it('reads the stored response URL once and ignores a later value', async () => {
    const harness = createHarness(
      'https://queue.fal.run/fal-ai/luma-dream-machine/requests/req-user?extra=1',
    );
    const started = await experimental_startVideo({
      model: harness.model,
      prompt: 'a rocket',
      maxRetries: 0,
    });
    const stored = started.operation as Record<string, unknown>;
    const operation: Record<string, unknown> = {};
    for (const key of Object.keys(stored)) {
      let reads = 0;
      const original = stored[key];
      Object.defineProperty(operation, key, {
        enumerable: true,
        get() {
          reads += 1;
          if (key === 'responseUrl' || key === 'submitUrl') {
            return reads === 1
              ? 'https://queue.fal.run/fal-ai/luma-dream-machine/requests/req-user?extra=1'
              : 'https://queue.fal.run/account';
          }
          return reads === 1 ? original : 'https://queue.fal.run/account';
        },
      });
    }

    const beforeStatus = harness.requests.length;
    await experimental_getVideoStatus(harness.model, {
      operation,
      maxRetries: 0,
    }).catch(() => undefined);

    const gets = harness.requests
      .slice(beforeStatus)
      .filter(request => request.method === 'GET');
    expect(gets.every(request => isLockedStatusUrl(request.url))).toBe(true);
    expect(gets.some(request => request.url.includes('/account'))).toBe(false);
    expect(gets.some(request => request.url.includes('extra=1'))).toBe(false);
  });
});
