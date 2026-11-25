import { APICallError } from '@ai-sdk/provider';
import type { FetchFunction } from '@ai-sdk/provider-utils';
import { describe, expect, it } from 'vitest';
import { experimental_getVideoStatus } from '../../ai/src/generate-video/get-video-status';
import { createBlackForestLabs } from './black-forest-labs-provider';

/**
 * Spec for the video status poll URL.
 *
 * The operation returned by video start is documented as a value the caller
 * persists and submits again. These tests fail while status checks request
 * that caller-supplied polling URL with the API key. They pass when every
 * status request uses only the configured base URL and the operation's own
 * request id, and when a response from any other URL cannot become the video
 * or the body of a thrown error.
 */

const BASE_URL = 'https://api.bfl.ai/v1';
const CONFIGURED_ORIGIN = 'https://api.bfl.ai';
const PLACEHOLDER_API_KEY = 'placeholder-api-key';
const CALLER_REQUEST_ID = 'caller-request';
const OTHER_REQUEST_ID = 'other-generation';
const CALLER_VIDEO_URL = 'https://delivery.example/caller-video.mp4';
const OTHER_VIDEO_URL = 'https://delivery.example/other-generation.mp4';
const FOREIGN_BODY_MARKER = 'foreign-poll-body-marker';

const PROMPT_OPTIONS = {
  prompt: 'A white kitten chases a butterfly across a sunlit garden.',
  n: 1,
  aspectRatio: undefined,
  resolution: undefined,
  duration: undefined,
  fps: undefined,
  seed: undefined,
  image: undefined,
  frameImages: undefined,
  inputReferences: undefined,
  generateAudio: undefined,
  providerOptions: {},
};

type RecordedRequest = {
  url: string;
  credentialHeaderSent: boolean;
};

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Poll URL rebuilt from the configured base URL and the caller's request id.
 * `get_result` is the status path the provider returns under `/v1`.
 */
function canonicalPollUrl(requestId: string): URL {
  const endpoint = new URL('get_result', `${BASE_URL}/`);
  endpoint.searchParams.set('id', requestId);
  return endpoint;
}

function isCanonicalPoll(url: string, requestId: string): boolean {
  let actual: URL;
  try {
    actual = new URL(url);
  } catch {
    return false;
  }

  const expected = canonicalPollUrl(requestId);
  const keys = [...actual.searchParams.keys()];
  return (
    actual.origin === expected.origin &&
    actual.pathname === expected.pathname &&
    actual.username === '' &&
    actual.password === '' &&
    actual.hash === '' &&
    keys.length === 1 &&
    keys[0] === 'id' &&
    actual.searchParams.getAll('id').length === 1 &&
    actual.searchParams.get('id') === requestId
  );
}

function createRecordingFetch(onPoll: (url: string) => Response): {
  fetch: FetchFunction;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetch: FetchFunction = async (input, init) => {
    const url = requestUrl(input);
    const headers = new Headers(init?.headers);
    const recorded = {
      url,
      credentialHeaderSent: headers.get('x-key') === PLACEHOLDER_API_KEY,
    };

    if (url.startsWith(`${BASE_URL}/flux-3-video`)) {
      return jsonResponse({
        id: CALLER_REQUEST_ID,
        polling_url: canonicalPollUrl(CALLER_REQUEST_ID).toString(),
      });
    }

    requests.push(recorded);
    return onPoll(url);
  };

  return { fetch, requests };
}

function ready(sample: string) {
  return jsonResponse({
    status: 'Ready',
    result: { sample },
  });
}

function foreignBody() {
  return jsonResponse({ leaked: FOREIGN_BODY_MARKER });
}

function errorText(error: unknown): string {
  if (error == null || typeof error !== 'object') {
    return error == null ? '' : String(error);
  }

  const record = error as {
    message?: unknown;
    responseBody?: unknown;
    url?: unknown;
    data?: unknown;
    cause?: unknown;
  };
  const parts = [
    typeof record.message === 'string' ? record.message : '',
    typeof record.responseBody === 'string' ? record.responseBody : '',
    typeof record.url === 'string' ? record.url : '',
    record.data != null ? JSON.stringify(record.data) : '',
    errorText(record.cause),
  ];
  return parts.join('\n');
}

function createModel(fetch: FetchFunction) {
  return createBlackForestLabs({
    apiKey: PLACEHOLDER_API_KEY,
    baseURL: BASE_URL,
    fetch,
  }).video('flux-3-video');
}

type StatusRunner = (
  model: ReturnType<typeof createModel>,
  operation: { requestId: string; pollingUrl: string },
) => Promise<unknown>;

const statusRunners: Array<{ name: string; run: StatusRunner }> = [
  {
    name: 'experimental_getVideoStatus',
    run: (model, operation) =>
      experimental_getVideoStatus(model, { operation, maxRetries: 0 }),
  },
  {
    name: 'video.doStatus',
    run: (model, operation) => {
      if (model.doStatus == null) {
        throw new Error('video model does not implement doStatus');
      }
      return model.doStatus({ operation });
    },
  },
];

async function expectStatusIgnoresCallerUrl({
  run,
  pollingUrl,
  requestId = CALLER_REQUEST_ID,
  onPoll,
  forbiddenResponseText,
}: {
  run: StatusRunner;
  pollingUrl: string;
  requestId?: string;
  onPoll: (url: string) => Response;
  forbiddenResponseText: string[];
}) {
  const { fetch, requests } = createRecordingFetch(url => {
    if (isCanonicalPoll(url, requestId)) {
      return ready(CALLER_VIDEO_URL);
    }
    return onPoll(url);
  });
  const model = createModel(fetch);

  let result: unknown;
  let thrown: unknown;
  try {
    result = await run(model, { requestId, pollingUrl });
  } catch (error) {
    thrown = error;
  }

  const observed = [
    result != null ? JSON.stringify(result) : '',
    errorText(thrown),
  ].join('\n');

  const credentialLeaks = requests.filter(request => {
    return (
      new URL(request.url).origin !== CONFIGURED_ORIGIN &&
      request.credentialHeaderSent
    );
  });
  expect(credentialLeaks.map(request => new URL(request.url).origin)).toEqual(
    [],
  );
  expect(
    requests.every(request => isCanonicalPoll(request.url, requestId)),
  ).toBe(true);
  expect(requests.some(request => request.url === pollingUrl)).toBe(false);

  for (const text of forbiddenResponseText) {
    expect(observed).not.toContain(text);
  }

  if (APICallError.isInstance(thrown)) {
    expect(thrown.responseBody ?? '').not.toContain(FOREIGN_BODY_MARKER);
    expect(thrown.responseBody ?? '').not.toContain(OTHER_VIDEO_URL);
  }
}

describe('caller-supplied Black Forest Labs video polling URL', () => {
  describe.each(statusRunners)('$name', ({ run }) => {
    it('does not fetch another generation when the polling URL names its id', async () => {
      await expectStatusIgnoresCallerUrl({
        run,
        pollingUrl: `${BASE_URL}/get_result?id=${OTHER_REQUEST_ID}`,
        onPoll: () => ready(OTHER_VIDEO_URL),
        forbiddenResponseText: [OTHER_VIDEO_URL],
      });
    });

    it('does not return a Ready video from a caller-named bfl.ai host', async () => {
      const pollingUrl = 'https://attacker.bfl.ai/collect';
      await expectStatusIgnoresCallerUrl({
        run,
        pollingUrl,
        onPoll: () => ready(OTHER_VIDEO_URL),
        forbiddenResponseText: [OTHER_VIDEO_URL],
      });
    });

    it('does not attach the API key to the apex bfl.ai host named by the caller', async () => {
      await expectStatusIgnoresCallerUrl({
        run,
        pollingUrl: 'https://bfl.ai/collect',
        onPoll: () => ready(OTHER_VIDEO_URL),
        forbiddenResponseText: [OTHER_VIDEO_URL],
      });
    });

    it('does not treat a nested host that merely ends with .bfl.ai as the API host', async () => {
      await expectStatusIgnoresCallerUrl({
        run,
        pollingUrl: 'https://api.bfl.ai.attacker.bfl.ai/collect',
        onPoll: () => ready(OTHER_VIDEO_URL),
        forbiddenResponseText: [OTHER_VIDEO_URL],
      });
    });

    it('does not follow a sibling cluster URL to another generation', async () => {
      await expectStatusIgnoresCallerUrl({
        run,
        pollingUrl: `https://api.us1.bfl.ai/v1/get_result?id=${OTHER_REQUEST_ID}`,
        onPoll: () => ready(OTHER_VIDEO_URL),
        forbiddenResponseText: [OTHER_VIDEO_URL],
      });
    });

    it('does not surface the raw body of a non-poll response from the caller URL', async () => {
      await expectStatusIgnoresCallerUrl({
        run,
        pollingUrl: `${BASE_URL}/get_result?id=${OTHER_REQUEST_ID}`,
        onPoll: () => foreignBody(),
        forbiddenResponseText: [FOREIGN_BODY_MARKER],
      });
    });

    it('does not request a different path on the API host named by the caller', async () => {
      await expectStatusIgnoresCallerUrl({
        run,
        pollingUrl: `${BASE_URL}/other-endpoint`,
        onPoll: () => foreignBody(),
        forbiddenResponseText: [FOREIGN_BODY_MARKER],
      });
    });

    it('does not send the API key to a host hidden behind userinfo', async () => {
      await expectStatusIgnoresCallerUrl({
        run,
        pollingUrl: 'https://api.bfl.ai@attacker.bfl.ai/collect',
        onPoll: () => ready(OTHER_VIDEO_URL),
        forbiddenResponseText: [OTHER_VIDEO_URL],
      });
    });

    it('encodes the caller request id into the rebuilt poll URL', async () => {
      const requestId = 'caller/request';
      await expectStatusIgnoresCallerUrl({
        run,
        requestId,
        pollingUrl: `${BASE_URL}/get_result?id=${OTHER_REQUEST_ID}`,
        onPoll: () => ready(OTHER_VIDEO_URL),
        forbiddenResponseText: [OTHER_VIDEO_URL],
      });
    });
  });

  it('keeps a polling URL substituted after start from being requested', async () => {
    const pollingUrl = `${BASE_URL}/get_result?id=${OTHER_REQUEST_ID}`;
    const { fetch, requests } = createRecordingFetch(() =>
      ready(OTHER_VIDEO_URL),
    );
    const model = createModel(fetch);

    const started = await model.doStart!(PROMPT_OPTIONS);
    const operation = started.operation as {
      requestId: string;
      pollingUrl: string;
    };
    operation.pollingUrl = pollingUrl;

    let result: unknown;
    let thrown: unknown;
    try {
      result = await experimental_getVideoStatus(model, {
        operation,
        maxRetries: 0,
      });
    } catch (error) {
      thrown = error;
    }

    const observed = [
      result != null ? JSON.stringify(result) : '',
      errorText(thrown),
    ].join('\n');

    expect(
      requests.every(request =>
        isCanonicalPoll(request.url, CALLER_REQUEST_ID),
      ),
    ).toBe(true);
    expect(requests.some(request => request.url === pollingUrl)).toBe(false);
    expect(
      requests.some(
        request =>
          new URL(request.url).host !== 'api.bfl.ai' &&
          request.credentialHeaderSent,
      ),
    ).toBe(false);
    expect(observed).not.toContain(OTHER_VIDEO_URL);
  });
});
