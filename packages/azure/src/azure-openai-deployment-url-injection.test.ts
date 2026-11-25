import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import { afterEach, describe, expect, it } from 'vitest';
import { createAzure } from './azure-openai-provider';

/**
 * Deployment names must stay a single path segment on deployment-based URLs.
 * These tests fail while a name can change the path that is requested with
 * the provider credential, and pass once that name is confined or refused
 * before any request is sent.
 */

const RESOURCE_HOST = 'test-resource.openai.azure.com';
const API_KEY = 'placeholder-api-key';
const TOKEN = 'placeholder-token';

const PROMPT: LanguageModelV4Prompt = [
  { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
];

const DEPLOYMENT_PREFIX = '/openai/deployments/';

/**
 * Names that are not one path segment. Each one changes the parsed request
 * path when inserted raw after `/deployments/`.
 */
const ESCAPING_DEPLOYMENT_NAMES = [
  '../../openai/OTHER_PATH?',
  '%2e%2e/%2e%2e/%2e%2e/files',
  '%2e%2e',
  '.%2e',
  '%2e',
  '..\\..\\openai\\files',
  '..',
  '.',
  'foo/bar',
  'OTHER_PATH?',
  'foo#hash',
] as const;

type RecordedHttp = {
  url: string;
  headers: Record<string, string>;
};

class RecordingWebSocket {
  static instances: RecordingWebSocket[] = [];

  readonly url: string;
  readonly protocols: string | string[] | undefined;
  readonly options: { headers?: Record<string, string> } | undefined;
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  constructor(
    url: string | URL,
    protocols?: string | string[],
    options?: { headers?: Record<string, string> },
  ) {
    this.url = url instanceof URL ? url.toString() : String(url);
    this.protocols = protocols;
    this.options = options;
    RecordingWebSocket.instances.push(this);
  }

  send(): void {}

  close(): void {}
}

const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  RecordingWebSocket.instances = [];
});

function headerRecord(
  headers: HeadersInit | Record<string, string | undefined> | undefined,
): Record<string, string> {
  const recorded: Record<string, string> = {};
  if (headers == null) {
    return recorded;
  }

  const normalized = new Headers(headers as HeadersInit);
  normalized.forEach((value, key) => {
    recorded[key.toLowerCase()] = value;
  });
  return recorded;
}

function createHttpRecorder() {
  const calls: RecordedHttp[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({ url, headers: headerRecord(init?.headers) });
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

function createProvider(
  fetchImpl: typeof fetch,
  auth: 'api-key' | 'token' = 'api-key',
) {
  if (auth === 'token') {
    return createAzure({
      resourceName: 'test-resource',
      useDeploymentBasedUrls: true,
      tokenProvider: async () => TOKEN,
      fetch: fetchImpl,
    });
  }

  return createAzure({
    resourceName: 'test-resource',
    apiKey: API_KEY,
    useDeploymentBasedUrls: true,
    fetch: fetchImpl,
  });
}

async function invoke(operation: () => Promise<unknown>): Promise<void> {
  try {
    const result = await operation();
    if (
      result != null &&
      typeof result === 'object' &&
      'stream' in result &&
      result.stream instanceof ReadableStream
    ) {
      await result.stream.cancel().catch(() => {});
    }
  } catch {
    // A refused name throws before fetch. A name that is still sent can
    // fail while the response body is parsed. Either way the recorder has
    // every request that left the provider.
  }
}

function decodedSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function assertHttpCallsStayOnDeployment(
  calls: RecordedHttp[],
  operationPath: string,
  credential: 'api-key' | 'authorization',
  credentialValue: string,
): void {
  for (const call of calls) {
    const url = new URL(call.url);
    const pathname = url.pathname;

    expect(url.protocol, call.url).toBe('https:');
    expect(url.hostname, call.url).toBe(RESOURCE_HOST);
    expect(url.hash, call.url).toBe('');
    expect(url.pathname.startsWith(DEPLOYMENT_PREFIX), call.url).toBe(true);
    expect(url.pathname.endsWith(operationPath), call.url).toBe(true);
    expect(url.searchParams.get('api-version'), call.url).toBe('v1');
    expect([...url.searchParams.keys()], call.url).toEqual(['api-version']);
    expect(call.headers[credential], call.url).toBe(credentialValue);

    const segment = pathname.slice(
      DEPLOYMENT_PREFIX.length,
      pathname.length - operationPath.length,
    );
    expect(segment.length, call.url).toBeGreaterThan(0);
    expect(segment.includes('/'), call.url).toBe(false);

    const decoded = decodedSegment(segment);
    expect(decoded, call.url).not.toBe('.');
    expect(decoded, call.url).not.toBe('..');

    const rebuilt = new URL(
      `https://${RESOURCE_HOST}${DEPLOYMENT_PREFIX}${segment}${operationPath}?api-version=v1`,
    );
    expect(rebuilt.pathname, call.url).toBe(pathname);
  }
}

function installRecordingWebSocket(): void {
  RecordingWebSocket.instances = [];
  globalThis.WebSocket =
    RecordingWebSocket as unknown as typeof globalThis.WebSocket;
}

function recordedSocketUrls(): string[] {
  return RecordingWebSocket.instances.map(socket => socket.url);
}

describe('deployment-based Azure URLs keep the deployment name in one segment', () => {
  it('still requests a normal deployment with the api-key header', async () => {
    const { calls, fetchImpl } = createHttpRecorder();
    const provider = createProvider(fetchImpl);

    await invoke(() =>
      provider.chat('my-deployment').doGenerate({ prompt: PROMPT }),
    );

    expect(calls.map(call => call.url)).toEqual([
      `https://${RESOURCE_HOST}/openai/deployments/my-deployment/chat/completions?api-version=v1`,
    ]);
    expect(calls[0]?.headers['api-key']).toBe(API_KEY);
  });

  it('still allows a deployment name that contains a single dot', async () => {
    const { calls, fetchImpl } = createHttpRecorder();
    const provider = createProvider(fetchImpl);

    await invoke(() =>
      provider.chat('my.deployment').doGenerate({ prompt: PROMPT }),
    );

    expect(calls.map(call => call.url)).toEqual([
      `https://${RESOURCE_HOST}/openai/deployments/my.deployment/chat/completions?api-version=v1`,
    ]);
    expect(calls[0]?.headers['api-key']).toBe(API_KEY);
  });

  describe('chat generate', () => {
    it.each(ESCAPING_DEPLOYMENT_NAMES)(
      'does not send %j outside the deployment chat endpoint',
      async deploymentName => {
        const { calls, fetchImpl } = createHttpRecorder();
        const provider = createProvider(fetchImpl);

        await invoke(() =>
          provider.chat(deploymentName).doGenerate({ prompt: PROMPT }),
        );

        assertHttpCallsStayOnDeployment(
          calls,
          '/chat/completions',
          'api-key',
          API_KEY,
        );
      },
    );

    it('does not attach an Entra token to a rewritten chat path', async () => {
      const { calls, fetchImpl } = createHttpRecorder();
      const provider = createProvider(fetchImpl, 'token');

      await invoke(() =>
        provider
          .chat('../../openai/OTHER_PATH?')
          .doGenerate({ prompt: PROMPT }),
      );

      assertHttpCallsStayOnDeployment(
        calls,
        '/chat/completions',
        'authorization',
        `Bearer ${TOKEN}`,
      );
    });
  });

  describe('chat stream', () => {
    it.each([
      '../../openai/OTHER_PATH?',
      '%2e%2e/%2e%2e/%2e%2e/files',
    ] as const)(
      'does not send %j outside the deployment chat endpoint',
      async deploymentName => {
        const { calls, fetchImpl } = createHttpRecorder();
        const provider = createProvider(fetchImpl);

        await invoke(() =>
          provider.chat(deploymentName).doStream({ prompt: PROMPT }),
        );

        assertHttpCallsStayOnDeployment(
          calls,
          '/chat/completions',
          'api-key',
          API_KEY,
        );
      },
    );
  });

  describe('completion generate and stream', () => {
    it.each(['doGenerate', 'doStream'] as const)(
      '%s does not send a traversal deployment outside /completions',
      async method => {
        const { calls, fetchImpl } = createHttpRecorder();
        const provider = createProvider(fetchImpl);

        await invoke(() =>
          provider.completion('%2e%2e/%2e%2e/%2e%2e/files')[method]({
            prompt: PROMPT,
          }),
        );

        assertHttpCallsStayOnDeployment(
          calls,
          '/completions',
          'api-key',
          API_KEY,
        );
      },
    );
  });

  describe('responses generate and stream', () => {
    it.each(['doGenerate', 'doStream'] as const)(
      '%s does not send a traversal deployment outside /responses',
      async method => {
        const { calls, fetchImpl } = createHttpRecorder();
        const provider = createProvider(fetchImpl);

        await invoke(() =>
          provider.responses('../../openai/OTHER_PATH?')[method]({
            prompt: PROMPT,
          }),
        );

        assertHttpCallsStayOnDeployment(
          calls,
          '/responses',
          'api-key',
          API_KEY,
        );
      },
    );

    it('does not send a traversal deployment from the default model factory', async () => {
      const { calls, fetchImpl } = createHttpRecorder();
      const provider = createProvider(fetchImpl);

      await invoke(() =>
        provider('%2e%2e/%2e%2e/%2e%2e/files').doGenerate({ prompt: PROMPT }),
      );

      assertHttpCallsStayOnDeployment(calls, '/responses', 'api-key', API_KEY);
    });
  });

  describe('embedding', () => {
    it.each([
      '../../openai/OTHER_PATH?',
      '%2e%2e/%2e%2e/%2e%2e/files',
    ] as const)(
      'does not send %j outside the deployment embeddings endpoint',
      async deploymentName => {
        const { calls, fetchImpl } = createHttpRecorder();
        const provider = createProvider(fetchImpl);

        await invoke(() =>
          provider.embedding(deploymentName).doEmbed({ values: ['hello'] }),
        );

        assertHttpCallsStayOnDeployment(
          calls,
          '/embeddings',
          'api-key',
          API_KEY,
        );
      },
    );
  });

  describe('image generation and edits', () => {
    const imageOptions = {
      prompt: 'A lighthouse',
      mask: undefined,
      n: 1,
      size: '1024x1024' as const,
      aspectRatio: undefined,
      seed: undefined,
      providerOptions: {},
    };

    it.each([
      '../../openai/OTHER_PATH?',
      '%2e%2e/%2e%2e/%2e%2e/files',
    ] as const)(
      'does not send %j outside the image generation endpoint',
      async deploymentName => {
        const { calls, fetchImpl } = createHttpRecorder();
        const provider = createProvider(fetchImpl);

        await invoke(() =>
          provider.image(deploymentName).doGenerate({
            ...imageOptions,
            files: undefined,
          }),
        );

        assertHttpCallsStayOnDeployment(
          calls,
          '/images/generations',
          'api-key',
          API_KEY,
        );
      },
    );

    it('does not send an edit outside the image edits endpoint', async () => {
      const { calls, fetchImpl } = createHttpRecorder();
      const provider = createProvider(fetchImpl);

      await invoke(() =>
        provider.image('..\\..\\openai\\files').doGenerate({
          ...imageOptions,
          files: [
            {
              type: 'file',
              mediaType: 'image/png',
              data: new Uint8Array([137, 80, 78, 71]),
            },
          ],
        }),
      );

      assertHttpCallsStayOnDeployment(
        calls,
        '/images/edits',
        'api-key',
        API_KEY,
      );
    });
  });

  describe('transcription', () => {
    it.each([
      '../../openai/OTHER_PATH?',
      '%2e%2e/%2e%2e/%2e%2e/files',
    ] as const)(
      'does not send %j outside the transcription endpoint',
      async deploymentName => {
        const { calls, fetchImpl } = createHttpRecorder();
        const provider = createProvider(fetchImpl);

        await invoke(() =>
          provider.transcription(deploymentName).doGenerate({
            audio: new Uint8Array([1, 2, 3]),
            mediaType: 'audio/wav',
          }),
        );

        assertHttpCallsStayOnDeployment(
          calls,
          '/audio/transcriptions',
          'api-key',
          API_KEY,
        );
      },
    );

    it.each([
      'gpt-realtime-whisper-/../../openai/OTHER_PATH?',
      'gpt-realtime-whisper-/%2e%2e/%2e%2e/%2e%2e/files',
    ] as const)(
      'does not open a realtime socket for %j outside the deployment',
      async deploymentName => {
        installRecordingWebSocket();
        const { calls, fetchImpl } = createHttpRecorder();
        const provider = createProvider(fetchImpl);

        await invoke(() =>
          provider.transcription(deploymentName).doStream({
            audio: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3]));
                controller.close();
              },
            }),
            inputAudioFormat: { type: 'audio/pcm', rate: 24000 },
          }),
        );

        expect(calls).toEqual([]);
        const operationPath = '/realtime';
        for (const socketUrl of recordedSocketUrls()) {
          const url = new URL(socketUrl);
          const pathname = url.pathname;

          expect(url.protocol, socketUrl).toBe('wss:');
          expect(url.hostname, socketUrl).toBe(RESOURCE_HOST);
          expect(url.hash, socketUrl).toBe('');
          expect(url.pathname.startsWith(DEPLOYMENT_PREFIX), socketUrl).toBe(
            true,
          );
          expect(url.pathname.endsWith(operationPath), socketUrl).toBe(true);
          expect(url.searchParams.get('intent'), socketUrl).toBe(
            'transcription',
          );
          expect(url.searchParams.get('api-version'), socketUrl).toBe('v1');

          const segment = pathname.slice(
            DEPLOYMENT_PREFIX.length,
            pathname.length - operationPath.length,
          );
          expect(segment.length, socketUrl).toBeGreaterThan(0);
          expect(segment.includes('/'), socketUrl).toBe(false);
          const decoded = decodedSegment(segment);
          expect(decoded, socketUrl).not.toBe('.');
          expect(decoded, socketUrl).not.toBe('..');
        }
      },
    );
  });

  describe('speech', () => {
    it.each([
      '../../openai/OTHER_PATH?',
      '%2e%2e/%2e%2e/%2e%2e/files',
    ] as const)(
      'does not send %j outside the speech endpoint',
      async deploymentName => {
        const { calls, fetchImpl } = createHttpRecorder();
        const provider = createProvider(fetchImpl);

        await invoke(() =>
          provider.speech(deploymentName).doGenerate({ text: 'Hello' }),
        );

        assertHttpCallsStayOnDeployment(
          calls,
          '/audio/speech',
          'api-key',
          API_KEY,
        );
      },
    );
  });

  describe('deepseek generate and stream', () => {
    it.each(['doGenerate', 'doStream'] as const)(
      '%s does not send a traversal deployment outside chat completions',
      async method => {
        const { calls, fetchImpl } = createHttpRecorder();
        const provider = createProvider(fetchImpl);

        await invoke(() =>
          provider.deepseek('foo/bar')[method]({ prompt: PROMPT }),
        );

        assertHttpCallsStayOnDeployment(
          calls,
          '/chat/completions',
          'api-key',
          API_KEY,
        );
      },
    );
  });
});
