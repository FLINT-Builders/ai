import { APICallError } from '@ai-sdk/provider';
import { describe, expect, it, vi } from 'vitest';
import { experimental_getVideoStatus } from '../../ai/src/generate-video/get-video-status';
import { experimental_startVideo } from '../../ai/src/generate-video/start-video';
import { createReplicate } from './replicate-provider';

const API_ORIGIN = 'https://api.replicate.com';
const API_ROOT = `${API_ORIGIN}/v1`;
const MODEL_ID = 'minimax/video-01';
const API_TOKEN = 'test-api-token';
const USER_PREDICTION_ID = 'pred-user';
const USER_VIDEO_URL = 'https://videos.example/user-only.mp4';
const VICTIM_PREDICTION_URL = `${API_ROOT}/predictions/pred-victim`;
const VICTIM_VIDEO_URL = 'https://videos.example/victim-only.mp4';
const ACCOUNT_URL = `${API_ROOT}/account`;
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

function authorizationOf(headers: HeadersInit | undefined): string | null {
  if (headers == null) return null;
  return new Headers(headers).get('authorization');
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function prediction(options: {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: string | null;
  getUrl: string;
}) {
  return {
    id: options.id,
    status: options.status,
    output: options.output ?? null,
    error: null,
    urls: { get: options.getUrl },
    metrics: { predict_time: 1 },
  };
}

function isLockedPredictionUrl(
  requestUrlValue: string,
  predictionId: string,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(requestUrlValue);
  } catch {
    return false;
  }

  if (parsed.origin !== API_ORIGIN) return false;
  if (
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    return false;
  }

  const prefix = '/v1/predictions/';
  if (!parsed.pathname.startsWith(prefix)) return false;
  const segment = parsed.pathname.slice(prefix.length);
  if (segment.length === 0 || segment.includes('/')) return false;

  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return false;
  }

  if (decoded === '.' || decoded === '..') return false;
  if (decoded !== predictionId) return false;
  return new URL(parsed.href).pathname === parsed.pathname;
}

function errorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();

  const visit = (value: unknown) => {
    if (value == null || seen.has(value)) return;
    if (typeof value === 'string') {
      parts.push(value);
      return;
    }
    if (typeof value !== 'object') return;
    seen.add(value);

    if (value instanceof Error) {
      parts.push(value.message);
    }

    const record = value as {
      responseBody?: unknown;
      url?: unknown;
      data?: unknown;
      cause?: unknown;
    };
    if (typeof record.responseBody === 'string')
      parts.push(record.responseBody);
    if (typeof record.url === 'string') parts.push(record.url);
    if (record.data != null) {
      try {
        parts.push(JSON.stringify(record.data));
      } catch {
        // Ignore unserializable provider data.
      }
    }
    visit(record.cause);
  };

  visit(error);
  return parts.join('\n');
}

function videoUrls(result: unknown): string[] {
  if (result == null || typeof result !== 'object') return [];
  const videos = (result as { videos?: Array<{ url?: string }> }).videos;
  if (!Array.isArray(videos)) return [];
  return videos.flatMap(video =>
    typeof video?.url === 'string' ? [video.url] : [],
  );
}

function createHarness(options?: {
  providerGetUrl?: string;
  predictionId?: string;
}) {
  const predictionId = options?.predictionId ?? USER_PREDICTION_ID;
  const providerGetUrl =
    options?.providerGetUrl ?? `${API_ROOT}/predictions/${predictionId}`;
  const requests: CapturedRequest[] = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    const method =
      init?.method ?? (input instanceof Request ? input.method : 'GET');
    const headers =
      init?.headers ?? (input instanceof Request ? input.headers : undefined);
    requests.push({
      url,
      method,
      authorization: authorizationOf(headers),
    });

    if (method === 'POST') {
      return Response.json(
        prediction({
          id: predictionId,
          status: 'starting',
          getUrl: providerGetUrl,
        }),
      );
    }

    if (isLockedPredictionUrl(url, predictionId)) {
      return Response.json(
        prediction({
          id: predictionId,
          status: 'succeeded',
          output: USER_VIDEO_URL,
          getUrl: `${API_ROOT}/predictions/${encodeURIComponent(predictionId)}`,
        }),
      );
    }

    if (
      url === VICTIM_PREDICTION_URL ||
      url.startsWith(`${VICTIM_PREDICTION_URL}?`)
    ) {
      return Response.json(
        prediction({
          id: 'pred-victim',
          status: 'succeeded',
          output: VICTIM_VIDEO_URL,
          getUrl: VICTIM_PREDICTION_URL,
        }),
      );
    }

    return Response.json({
      username: ACCOUNT_MARKER,
      type: 'account',
    });
  };

  const provider = createReplicate({
    apiToken: API_TOKEN,
    fetch: fetchImpl,
  });
  const model = provider.video(MODEL_ID);

  return { requests, model, fetchImpl, predictionId };
}

async function startAndRead(model: ReturnType<typeof createHarness>['model']) {
  return experimental_startVideo({
    model,
    prompt: 'a rocket',
    maxRetries: 0,
  });
}

function statusGets(requests: CapturedRequest[]): CapturedRequest[] {
  return requests.filter(request => request.method === 'GET');
}

function assertCredentialStayedOnLockedPrediction(
  requests: CapturedRequest[],
  predictionId: string,
) {
  const gets = statusGets(requests);
  expect(gets).toEqual([
    {
      url: `${API_ROOT}/predictions/${encodeURIComponent(predictionId)}`,
      method: 'GET',
      authorization: `Bearer ${API_TOKEN}`,
    },
  ]);
  expect(isLockedPredictionUrl(gets[0]?.url ?? '', predictionId)).toBe(true);
}

describe('Replicate video status URL', () => {
  it('checks a stored operation through experimental_getVideoStatus without requesting a replaced prediction', async () => {
    const harness = createHarness();
    const started = await startAndRead(harness.model);
    const beforeStatus = harness.requests.length;
    const operation = {
      ...(started.operation as Record<string, unknown>),
      getUrl: VICTIM_PREDICTION_URL,
    };

    const result = await experimental_getVideoStatus(harness.model, {
      operation,
      maxRetries: 0,
    });

    assertCredentialStayedOnLockedPrediction(
      harness.requests.slice(beforeStatus),
      USER_PREDICTION_ID,
    );
    expect(videoUrls(result)).toEqual([USER_VIDEO_URL]);
    expect(videoUrls(result)).not.toContain(VICTIM_VIDEO_URL);
  });

  it('checks a stored operation through doStatus without requesting a replaced prediction', async () => {
    const harness = createHarness();
    const started = await startAndRead(harness.model);
    const beforeStatus = harness.requests.length;
    const operation = {
      ...(started.operation as Record<string, unknown>),
      getUrl: VICTIM_PREDICTION_URL,
    };

    const result = await harness.model.doStatus!({ operation });

    assertCredentialStayedOnLockedPrediction(
      harness.requests.slice(beforeStatus),
      USER_PREDICTION_ID,
    );
    expect(videoUrls(result)).toEqual([USER_VIDEO_URL]);
  });

  it('does not send the api token to another path on the api host or return that body', async () => {
    const harness = createHarness();
    const started = await startAndRead(harness.model);
    const beforeStatus = harness.requests.length;
    const operation = {
      ...(started.operation as Record<string, unknown>),
      getUrl: ACCOUNT_URL,
    };

    let thrown: unknown;
    let result: unknown;
    try {
      result = await experimental_getVideoStatus(harness.model, {
        operation,
        maxRetries: 0,
      });
    } catch (error) {
      thrown = error;
    }

    const statusRequests = harness.requests.slice(beforeStatus);
    assertCredentialStayedOnLockedPrediction(
      statusRequests,
      USER_PREDICTION_ID,
    );
    expect(errorText(thrown)).not.toContain(ACCOUNT_MARKER);
    expect(errorText(result)).not.toContain(ACCOUNT_MARKER);
    expect(JSON.stringify(result ?? {})).not.toContain(ACCOUNT_MARKER);
    if (thrown != null) {
      expect(
        APICallError.isInstance(thrown) ? thrown.responseBody : '',
      ).not.toContain(ACCOUNT_MARKER);
    }
  });

  it('does not request a same-origin URL that climbs out of the prediction path', async () => {
    const harness = createHarness();
    const started = await startAndRead(harness.model);
    const beforeStatus = harness.requests.length;
    const operation = {
      ...(started.operation as Record<string, unknown>),
      getUrl: `${API_ROOT}/predictions/${USER_PREDICTION_ID}/../../account`,
    };

    await experimental_getVideoStatus(harness.model, {
      operation,
      maxRetries: 0,
    }).catch(() => undefined);

    assertCredentialStayedOnLockedPrediction(
      harness.requests.slice(beforeStatus),
      USER_PREDICTION_ID,
    );
  });

  it('does not request a same-origin URL that carries userinfo or a query', async () => {
    const harness = createHarness();
    const started = await startAndRead(harness.model);
    const beforeStatus = harness.requests.length;
    const operation = {
      ...(started.operation as Record<string, unknown>),
      getUrl: `https://placeholder@api.replicate.com/v1/predictions/${USER_PREDICTION_ID}?extra=1`,
    };

    await experimental_getVideoStatus(harness.model, {
      operation,
      maxRetries: 0,
    }).catch(() => undefined);

    assertCredentialStayedOnLockedPrediction(
      harness.requests.slice(beforeStatus),
      USER_PREDICTION_ID,
    );
  });

  it('rebuilds the status URL from the prediction id when the provider get URL has a query', async () => {
    const harness = createHarness({
      providerGetUrl: `${API_ROOT}/predictions/${USER_PREDICTION_ID}?extra=1`,
    });
    const started = await startAndRead(harness.model);
    const beforeStatus = harness.requests.length;

    const result = await experimental_getVideoStatus(harness.model, {
      operation: started.operation,
      maxRetries: 0,
    }).catch(() => undefined);

    assertCredentialStayedOnLockedPrediction(
      harness.requests.slice(beforeStatus),
      USER_PREDICTION_ID,
    );
    expect(videoUrls(result)).toEqual([USER_VIDEO_URL]);
    expect(
      statusGets(harness.requests.slice(beforeStatus)).some(request =>
        request.url.includes('extra=1'),
      ),
    ).toBe(false);
  });

  it('keeps a prediction id that contains a slash inside one encoded path segment', async () => {
    const predictionId = 'pred/user';
    const harness = createHarness({
      predictionId,
      providerGetUrl: `${API_ROOT}/predictions/pred/user`,
    });
    const started = await startAndRead(harness.model);
    const beforeStatus = harness.requests.length;

    const result = await experimental_getVideoStatus(harness.model, {
      operation: started.operation,
      maxRetries: 0,
    }).catch(() => undefined);

    assertCredentialStayedOnLockedPrediction(
      harness.requests.slice(beforeStatus),
      predictionId,
    );
    expect(videoUrls(result)).toEqual([USER_VIDEO_URL]);
    expect(
      new URL(statusGets(harness.requests.slice(beforeStatus))[0].url).pathname,
    ).toBe('/v1/predictions/pred%2Fuser');
  });

  it('does not let a second read of the operation select a different url', async () => {
    const harness = createHarness();
    const started = await startAndRead(harness.model);
    const beforeStatus = harness.requests.length;
    const stored = started.operation as Record<string, unknown>;
    const operation: Record<string, unknown> = {};

    for (const key of Object.keys(stored)) {
      let reads = 0;
      const original = stored[key];
      const attackerControlled =
        key === 'getUrl' ||
        key === 'url' ||
        (typeof original === 'string' && /^https?:\/\//.test(original));
      Object.defineProperty(operation, key, {
        enumerable: true,
        get() {
          reads += 1;
          if (attackerControlled) return ACCOUNT_URL;
          return reads === 1 ? original : ACCOUNT_URL;
        },
      });
    }

    let thrown: unknown;
    try {
      await experimental_getVideoStatus(harness.model, {
        operation,
        maxRetries: 0,
      });
    } catch (error) {
      thrown = error;
    }

    const statusRequests = harness.requests.slice(beforeStatus);
    expect(statusRequests.map(request => request.url)).not.toContain(
      ACCOUNT_URL,
    );
    for (const request of statusGets(statusRequests)) {
      expect(isLockedPredictionUrl(request.url, USER_PREDICTION_ID)).toBe(true);
      expect(request.authorization).toBe(`Bearer ${API_TOKEN}`);
    }
    expect(errorText(thrown)).not.toContain(ACCOUNT_MARKER);
  });

  it('rejects a dot-segment prediction id without requesting the parent path', async () => {
    const predictionId = '..';
    const harness = createHarness({
      predictionId,
      providerGetUrl: `${API_ROOT}/predictions/..`,
    });
    const started = await startAndRead(harness.model);
    const beforeStatus = harness.requests.length;

    await experimental_getVideoStatus(harness.model, {
      operation: started.operation,
      maxRetries: 0,
    }).catch(() => undefined);

    for (const request of statusGets(harness.requests.slice(beforeStatus))) {
      const parsed = new URL(request.url);
      expect(parsed.pathname === '/v1' || parsed.pathname === '/v1/').toBe(
        false,
      );
      expect(parsed.pathname.startsWith('/v1/predictions/')).toBe(true);
      expect(parsed.pathname.includes('..')).toBe(false);
      const segment = parsed.pathname.slice('/v1/predictions/'.length);
      expect(segment.includes('/')).toBe(false);
      expect(request.authorization).toBe(`Bearer ${API_TOKEN}`);
    }
  });

  it('does not fetch a caller-supplied getUrl when the operation never came from start', async () => {
    const harness = createHarness();
    let thrown: unknown;
    let result: unknown;
    try {
      result = await experimental_getVideoStatus(harness.model, {
        operation: { getUrl: VICTIM_PREDICTION_URL },
        maxRetries: 0,
      });
    } catch (error) {
      thrown = error;
    }

    expect(statusGets(harness.requests)).toEqual([]);
    expect(errorText(thrown)).not.toContain(VICTIM_VIDEO_URL);
    expect(videoUrls(result)).not.toContain(VICTIM_VIDEO_URL);
  });
});
