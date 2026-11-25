import { describe, expect, it, vi } from 'vitest';
import { experimental_getVideoStatus } from '../../ai/src/generate-video/get-video-status';
import { experimental_startVideo } from '../../ai/src/generate-video/start-video';
import { createBlackForestLabs } from './black-forest-labs-provider';

const API_TOKEN = 'test-api-token';
const REQUEST_ID = 'req-user';
const USER_VIDEO_URL = 'https://videos.example/user-only.mp4';
const VICTIM_VIDEO_URL = 'https://videos.example/victim-only.mp4';
const ACCOUNT_URL = 'https://api.bfl.ai/v1/account';
const ACCOUNT_MARKER = 'other-customer-account-payload';
const POLL_URL = `https://api.us1.bfl.ai/v1/get_result?id=${REQUEST_ID}`;

vi.mock('./version', () => ({
  VERSION: '0.0.0-test',
}));

vi.mock('../../ai/src/version', () => ({
  VERSION: '0.0.0-test',
}));

type CapturedRequest = {
  url: string;
  method: string;
  apiKey: string | null;
};

function isLockedPollUrl(requestUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return false;
  }
  const hostOk =
    parsed.protocol === 'https:' &&
    (parsed.hostname === 'bfl.ai' || parsed.hostname.endsWith('.bfl.ai'));
  return (
    hostOk &&
    parsed.username === '' &&
    parsed.pathname === '/v1/get_result' &&
    parsed.searchParams.get('id') === REQUEST_ID &&
    [...parsed.searchParams.keys()].every(key => key === 'id')
  );
}

function createHarness() {
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
      apiKey:
        init?.headers == null ? null : new Headers(init.headers).get('x-key'),
    });

    if (method === 'POST') {
      return Response.json({
        id: REQUEST_ID,
        polling_url: POLL_URL,
      });
    }

    if (isLockedPollUrl(url)) {
      return Response.json({
        status: 'Ready',
        result: { sample: USER_VIDEO_URL },
      });
    }

    if (url.startsWith('https://api.us1.bfl.ai/v1/get_result')) {
      return Response.json({
        status: 'Ready',
        result: { sample: VICTIM_VIDEO_URL },
      });
    }

    return Response.json({ username: ACCOUNT_MARKER });
  };

  const model = createBlackForestLabs({
    apiKey: API_TOKEN,
    fetch: fetchImpl,
  }).video('flux-3-video');

  return { requests, model };
}

describe('Black Forest Labs video status URL', () => {
  it('does not fetch a replaced polling URL with the api token', async () => {
    const harness = createHarness();
    const started = await experimental_startVideo({
      model: harness.model,
      prompt: 'a rocket',
      maxRetries: 0,
    });
    const beforeStatus = harness.requests.length;
    const operation = {
      ...(started.operation as Record<string, unknown>),
      pollingUrl: ACCOUNT_URL,
    };

    const result = await experimental_getVideoStatus(harness.model, {
      operation,
      maxRetries: 0,
    }).catch(() => undefined);

    const gets = harness.requests
      .slice(beforeStatus)
      .filter(request => request.method === 'GET');
    expect(gets).toHaveLength(1);
    expect(isLockedPollUrl(gets[0].url)).toBe(true);
    expect(gets[0].apiKey).toBe(API_TOKEN);
    expect(gets.map(request => request.url)).not.toContain(ACCOUNT_URL);
    expect(result.status === 'completed' && result.videos[0]?.url).toBe(
      USER_VIDEO_URL,
    );
  });

  it('does not send the api token to another host under bfl.ai', async () => {
    const harness = createHarness();
    const attacker = 'https://files.bfl.ai/secret';
    let thrown: unknown;
    try {
      await experimental_getVideoStatus(harness.model, {
        operation: { requestId: REQUEST_ID, pollingUrl: attacker },
        maxRetries: 0,
      });
    } catch (error) {
      thrown = error;
    }

    expect(
      harness.requests.some(
        request => new URL(request.url).hostname === 'files.bfl.ai',
      ),
    ).toBe(false);
    expect(JSON.stringify(thrown ?? '')).not.toContain(ACCOUNT_MARKER);
  });

  it('ignores a polling URL that changes between reads', async () => {
    const harness = createHarness();
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
          if (key === 'pollingUrl') return ACCOUNT_URL;
          return reads === 1 ? original : '../../account';
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
    expect(gets.every(request => isLockedPollUrl(request.url))).toBe(true);
    expect(gets.map(request => request.url)).not.toContain(ACCOUNT_URL);
  });
});
