import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { LanguageModelV4, LanguageModelV4Prompt } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { createGoogleVertexAnthropic as createEdgeGoogleVertexAnthropic } from './edge/google-vertex-anthropic-provider-edge';
import type { GoogleVertexAnthropicProvider } from './google-vertex-anthropic-provider';
import { createGoogleVertexAnthropic as createNodeGoogleVertexAnthropic } from './google-vertex-anthropic-provider-node';

const PROJECT = 'app-project';
const LOCATION = 'us-central1';
const MODEL_PATH_PREFIX = `/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/anthropic/models/`;
const AUTH_TOKEN = 'placeholder-token';
const SAFE_MODEL_ID = 'claude-3-5-sonnet@20240620';

const TEST_PROMPT: LanguageModelV4Prompt = [
  { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
];

const SUCCESS_BODY = JSON.stringify({
  type: 'message',
  id: 'msg_test',
  model: SAFE_MODEL_ID,
  content: [{ type: 'text', text: 'Hi' }],
  stop_reason: null,
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});

/**
 * Model ids that the URL parser resolves into a different request target
 * than `models/<one segment>:<action>`.
 *
 * `%2e%2e/` is included because the parser decodes those dots before it
 * applies dot-segment removal. A check for the literal characters `../`
 * does not cover that input.
 */
const UNSAFE_MODEL_IDS = {
  'dot segments': `${'../'.repeat(8)}v1/projects/other-project/locations/${LOCATION}/publishers/google/models/gemini-pro`,
  'percent-encoded dot segments': `${'%2e%2e/'.repeat(8)}v1/projects/other-project/locations/${LOCATION}/publishers/google/models/gemini-pro`,
  'fragment strips the predict verb': 'gemini-pro#ignored',
  'query string strips the predict verb': 'gemini-pro?resource=other',
  'extra path segments': 'publishers/google/models/gemini-pro',
} as const;

type PredictAction = 'rawPredict' | 'streamRawPredict';
type ModelEntry = 'call' | 'languageModel' | 'chat' | 'messages';

type RecordedRequest = {
  method: string | undefined;
  target: string;
  authorization: string | undefined;
  body: string;
};

function authorizationHeader(
  headers: IncomingMessage['headers'] | Record<string, unknown> | undefined,
): string | undefined {
  if (headers == null) {
    return undefined;
  }

  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get('authorization') ?? undefined;
  }

  const record = headers as Record<string, unknown>;
  const value = record.authorization ?? record.Authorization;
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return typeof value === 'string' ? value : undefined;
}

function modelFor(
  provider: GoogleVertexAnthropicProvider,
  modelId: string,
  entry: ModelEntry,
): LanguageModelV4 {
  if (entry === 'call') {
    return provider(modelId);
  }
  if (entry === 'languageModel') {
    return provider.languageModel(modelId);
  }

  const aliases = provider as GoogleVertexAnthropicProvider & {
    chat: (id: string) => LanguageModelV4;
    messages: (id: string) => LanguageModelV4;
  };
  return aliases[entry](modelId);
}

/**
 * The request target the HTTP client actually sends: WHATWG URL parsing,
 * then pathname + search. `hash` is not sent.
 */
function clientRequestUrl(target: string, baseOrigin: string): URL {
  const parsed = new URL(target, baseOrigin);
  return new URL(`${parsed.origin}${parsed.pathname}${parsed.search}`);
}

function isSingleModelSegment(segment: string): boolean {
  if (segment.length === 0 || segment.includes('/')) {
    return false;
  }
  if (segment === '.' || segment === '..') {
    return false;
  }
  return true;
}

function isCredentialedModelRequest(
  request: RecordedRequest,
  action: PredictAction,
  origin: string,
): boolean {
  if (request.method !== 'POST') {
    return false;
  }
  if (request.authorization !== `Bearer ${AUTH_TOKEN}`) {
    return false;
  }

  const url = clientRequestUrl(request.target, origin);
  if (url.origin !== origin || url.search !== '') {
    return false;
  }
  if (!url.pathname.startsWith(MODEL_PATH_PREFIX)) {
    return false;
  }

  const rest = url.pathname.slice(MODEL_PATH_PREFIX.length);
  const suffix = `:${action}`;
  if (!rest.endsWith(suffix)) {
    return false;
  }
  return isSingleModelSegment(rest.slice(0, -suffix.length));
}

function expectRequestsStayOnModel(
  requests: RecordedRequest[],
  action: PredictAction,
  origin: string,
) {
  const unsafe = requests.filter(
    request => !isCredentialedModelRequest(request, action, origin),
  );
  expect(unsafe).toEqual([]);
}

async function invoke(
  model: LanguageModelV4,
  action: PredictAction,
): Promise<void> {
  if (action === 'rawPredict') {
    await model.doGenerate({ prompt: TEST_PROMPT });
    return;
  }

  const result = await model.doStream({ prompt: TEST_PROMPT });
  await result.stream.cancel();
}

async function withLocalServer(
  run: (state: {
    origin: string;
    baseURL: string;
    requests: RecordedRequest[];
  }) => Promise<void>,
): Promise<void> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on('end', () => {
      requests.push({
        method: request.method,
        target: request.url ?? '',
        authorization: authorizationHeader(request.headers),
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.writeHead(200, {
        'content-type': 'application/json',
        connection: 'close',
      });
      response.end(SUCCESS_BODY);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (address == null || typeof address === 'string') {
    server.close();
    throw new Error('local server did not bind a TCP port');
  }

  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await run({
      origin,
      baseURL: `${origin}${MODEL_PATH_PREFIX.slice(0, -1)}`,
      requests,
    });
  } finally {
    await new Promise<void>(resolve => {
      server.close(() => resolve());
    });
  }
}

function providerFor(
  runtime: 'node' | 'edge',
  options: { baseURL?: string },
): GoogleVertexAnthropicProvider {
  const settings = {
    project: PROJECT,
    location: LOCATION,
    baseURL: options.baseURL,
    generateAuthToken: async () => AUTH_TOKEN,
  };
  return runtime === 'node'
    ? createNodeGoogleVertexAnthropic(settings)
    : createEdgeGoogleVertexAnthropic(settings);
}

describe('Vertex Claude model id path', () => {
  it('sends a published model id to that model rawPredict endpoint with the bearer token', async () => {
    await withLocalServer(async ({ origin, baseURL, requests }) => {
      const provider = providerFor('node', { baseURL });
      await invoke(modelFor(provider, SAFE_MODEL_ID, 'call'), 'rawPredict');

      expect(requests).toHaveLength(1);
      expectRequestsStayOnModel(requests, 'rawPredict', origin);
      const url = clientRequestUrl(requests[0]!.target, origin);
      expect(
        decodeURIComponent(url.pathname.slice(MODEL_PATH_PREFIX.length)),
      ).toBe(`${SAFE_MODEL_ID}:rawPredict`);
      expect(requests[0]!.body).toContain('Hello');
    });
  });

  it('sends a published model id to that model streamRawPredict endpoint with the bearer token', async () => {
    await withLocalServer(async ({ origin, baseURL, requests }) => {
      const provider = providerFor('node', { baseURL });
      await invoke(
        modelFor(provider, SAFE_MODEL_ID, 'call'),
        'streamRawPredict',
      );

      expect(requests).toHaveLength(1);
      expectRequestsStayOnModel(requests, 'streamRawPredict', origin);
      const url = clientRequestUrl(requests[0]!.target, origin);
      expect(
        decodeURIComponent(url.pathname.slice(MODEL_PATH_PREFIX.length)),
      ).toBe(`${SAFE_MODEL_ID}:streamRawPredict`);
    });
  });

  describe.each(['node', 'edge'] as const)('%s provider', runtime => {
    describe.each(['rawPredict', 'streamRawPredict'] as const)('%s', action => {
      describe.each(Object.entries(UNSAFE_MODEL_IDS))(
        '%s',
        (_label, modelId) => {
          it.each(['call', 'languageModel', 'chat', 'messages'] as const)(
            'does not send the bearer token outside the model path via %s',
            async entry => {
              await withLocalServer(async ({ origin, baseURL, requests }) => {
                const provider = providerFor(runtime, { baseURL });
                await invoke(modelFor(provider, modelId, entry), action).catch(
                  () => {
                    // Refusing before the request is the safe outcome.
                    // A request recorded above is still asserted.
                  },
                );

                expectRequestsStayOnModel(requests, action, origin);
              });
            },
          );
        },
      );
    });
  });

  it('keeps the default Vertex host and model path when no base URL is configured', async () => {
    const requests: RecordedRequest[] = [];
    const provider = createNodeGoogleVertexAnthropic({
      project: PROJECT,
      location: LOCATION,
      generateAuthToken: async () => AUTH_TOKEN,
      fetch: async (url, init) => {
        const target =
          typeof url === 'string'
            ? url
            : url instanceof URL
              ? url.toString()
              : String(url);
        const headers = new Headers(init?.headers);
        requests.push({
          method: init?.method,
          target,
          authorization: authorizationHeader(headers),
          body: typeof init?.body === 'string' ? init.body : '',
        });
        return new Response(SUCCESS_BODY, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await invoke(modelFor(provider, SAFE_MODEL_ID, 'call'), 'rawPredict');

    const origin = `https://${LOCATION}-aiplatform.googleapis.com`;
    expect(requests).toHaveLength(1);
    expect(clientRequestUrl(requests[0]!.target, origin).origin).toBe(origin);
    expectRequestsStayOnModel(requests, 'rawPredict', origin);
  });

  it('does not retarget the default Vertex host when the model id contains dot segments', async () => {
    const requests: RecordedRequest[] = [];
    const provider = createNodeGoogleVertexAnthropic({
      project: PROJECT,
      location: LOCATION,
      generateAuthToken: async () => AUTH_TOKEN,
      fetch: async (url, init) => {
        const target =
          typeof url === 'string'
            ? url
            : url instanceof URL
              ? url.toString()
              : String(url);
        const headers = new Headers(init?.headers);
        requests.push({
          method: init?.method,
          target,
          authorization: authorizationHeader(headers),
          body: typeof init?.body === 'string' ? init.body : '',
        });
        return new Response(SUCCESS_BODY, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await invoke(
      modelFor(provider, UNSAFE_MODEL_IDS['dot segments'], 'call'),
      'rawPredict',
    ).catch(() => {
      // Refusing before the request is the safe outcome.
    });

    const origin = `https://${LOCATION}-aiplatform.googleapis.com`;
    expectRequestsStayOnModel(requests, 'rawPredict', origin);
    for (const request of requests) {
      expect(clientRequestUrl(request.target, origin).origin).toBe(origin);
    }
  });
});
