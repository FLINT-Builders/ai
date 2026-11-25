import { normalizeHeaders } from '@ai-sdk/provider-utils';
import { describe, expect, it } from 'vitest';
import {
  createAzure,
  type AzureOpenAIProvider,
  type AzureOpenAIProviderSettings,
} from './index';

/**
 * A resource name is a single DNS label in
 * https://{resourceName}.openai.azure.com. These tests fail while a name can
 * choose a different host for the api-key, bearer token, or prompt.
 */

const PROMPT_MARKER = 'customer-prompt-marker';
const API_KEY_PLACEHOLDER = 'placeholder-api-key';
const TOKEN_PLACEHOLDER = 'placeholder-token';
const SAFE_RESOURCE_NAME = 'test-resource';
const AZURE_HOST_SUFFIX = '.openai.azure.com';

const PROMPT = [
  {
    role: 'user' as const,
    content: [{ type: 'text' as const, text: PROMPT_MARKER }],
  },
];

const ATTACKER_RESOURCE_NAMES = [
  'evil.example/collect',
  'evil.example?collect',
  'evil.example#collect',
  'evil.example\\collect',
  '//evil.example/collect',
  'user@evil.example/',
] as const;

type CapturedCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  protocols?: string[];
};

type Capture = {
  calls: CapturedCall[];
  fetch: typeof fetch;
  restore: () => void;
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

async function readBody(body: BodyInit | null | undefined): Promise<string> {
  if (body == null) {
    return '';
  }
  if (typeof body === 'string') {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const parts: string[] = [];
    for (const [key, value] of body.entries()) {
      parts.push(
        `${key}=${typeof value === 'string' ? value : await value.text()}`,
      );
    }
    return parts.join('\n');
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return body.text();
  }
  return '';
}

async function readCallBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<string> {
  if (init?.body != null) {
    return readBody(init.body);
  }
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.clone().text();
  }
  return '';
}

function readCallHeaders(
  input: RequestInfo | URL,
  init?: RequestInit,
): Record<string, string> {
  const headers = normalizeHeaders(init?.headers);
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return { ...normalizeHeaders(input.headers), ...headers };
  }
  return headers;
}

function startCapture(): Capture {
  const calls: CapturedCall[] = [];
  const previousFetch = globalThis.fetch;
  const previousWebSocket = globalThis.WebSocket;

  const record = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<void> => {
    calls.push({
      url: requestUrl(input),
      method: init?.method ?? 'GET',
      headers: readCallHeaders(input, init),
      body: await readCallBody(input, init),
    });
  };

  class RecordingWebSocket {
    readyState = 0;
    bufferedAmount = 0;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onclose: ((event: unknown) => void) | null = null;
    private onopenHandler: ((event: unknown) => void) | null = null;
    private readonly record: CapturedCall;

    constructor(
      url: string | URL,
      protocols?: string | string[],
      options?: { headers?: Record<string, string | undefined> },
    ) {
      this.record = {
        url: requestUrl(url),
        method: 'WEBSOCKET',
        headers: normalizeHeaders(options?.headers),
        body: '',
        protocols:
          protocols == null
            ? []
            : Array.isArray(protocols)
              ? protocols
              : [protocols],
      };
      calls.push(this.record);
    }

    get onopen(): ((event: unknown) => void) | null {
      return this.onopenHandler;
    }

    set onopen(handler: ((event: unknown) => void) | null) {
      this.onopenHandler = handler;
      queueMicrotask(() => {
        this.readyState = 1;
        handler?.({});
      });
    }

    send(data: string | Uint8Array | ArrayBuffer): void {
      const text =
        typeof data === 'string' ? data : new TextDecoder().decode(data);
      let decodedAudio = '';
      try {
        const parsed = JSON.parse(text) as { audio?: unknown };
        if (typeof parsed.audio === 'string') {
          decodedAudio = atob(parsed.audio);
        }
      } catch {
        decodedAudio = '';
      }
      this.record.body += text;
      this.record.body += decodedAudio;
    }

    close(): void {
      this.readyState = 3;
    }
  }

  globalThis.fetch = async (input, init) => {
    await record(input, init);
    throw new Error('global fetch must not run');
  };
  globalThis.WebSocket = RecordingWebSocket as unknown as typeof WebSocket;

  return {
    calls,
    fetch: async (input, init) => {
      await record(input, init);
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    restore() {
      globalThis.fetch = previousFetch;
      globalThis.WebSocket = previousWebSocket;
    },
  };
}

function isSingleLabelAzureHost(hostname: string): boolean {
  if (!hostname.endsWith(AZURE_HOST_SUFFIX)) {
    return false;
  }
  const label = hostname.slice(0, -AZURE_HOST_SUFFIX.length);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label);
}

function configuredCredentialSent(
  call: CapturedCall,
  mode: 'api-key' | 'bearer',
): boolean {
  if (mode === 'api-key') {
    return call.headers['api-key'] === API_KEY_PLACEHOLDER;
  }
  return (
    call.headers.authorization === `Bearer ${TOKEN_PLACEHOLDER}` ||
    (call.protocols ?? []).includes(
      `openai-insecure-api-key.${TOKEN_PLACEHOLDER}`,
    )
  );
}

async function settle(operation: Promise<unknown>): Promise<void> {
  try {
    const result = await operation;
    // Let a recorded socket open and send queued audio before the assertion.
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
    if (
      result != null &&
      typeof result === 'object' &&
      'stream' in result &&
      result.stream instanceof ReadableStream
    ) {
      await result.stream.cancel();
    }
  } catch {
    // The request is recorded before response parsing finishes.
  }
}

type Leak = {
  resourceName: string;
  url: string;
  hostname: string | null;
  method: string;
  sentConfiguredCredential: boolean;
  bodyContainsPrompt: boolean;
};

function leaksFrom(
  calls: CapturedCall[],
  resourceName: string,
  mode: 'api-key' | 'bearer',
): Leak[] {
  return calls.flatMap(call => {
    let hostname: string | null = null;
    try {
      hostname = new URL(call.url).hostname;
    } catch {
      hostname = null;
    }
    if (hostname != null && isSingleLabelAzureHost(hostname)) {
      return [];
    }
    return [
      {
        resourceName,
        url: call.url,
        hostname,
        method: call.method,
        sentConfiguredCredential: configuredCredentialSent(call, mode),
        bodyContainsPrompt: call.body.includes(PROMPT_MARKER),
      },
    ];
  });
}

type Operation = {
  name: string;
  run: (provider: AzureOpenAIProvider) => Promise<unknown>;
};

const operations: Operation[] = [
  {
    name: 'default language model doGenerate',
    run: provider => provider('deployment').doGenerate({ prompt: PROMPT }),
  },
  {
    name: 'languageModel doGenerate',
    run: provider =>
      provider.languageModel('deployment').doGenerate({ prompt: PROMPT }),
  },
  {
    name: 'responses doGenerate',
    run: provider =>
      provider.responses('deployment').doGenerate({ prompt: PROMPT }),
  },
  {
    name: 'responses doStream',
    run: provider =>
      provider.responses('deployment').doStream({ prompt: PROMPT }),
  },
  {
    name: 'chat doGenerate',
    run: provider => provider.chat('deployment').doGenerate({ prompt: PROMPT }),
  },
  {
    name: 'chat doStream',
    run: provider => provider.chat('deployment').doStream({ prompt: PROMPT }),
  },
  {
    name: 'deepseek doGenerate',
    run: provider =>
      provider.deepseek('deployment').doGenerate({ prompt: PROMPT }),
  },
  {
    name: 'deepseek doStream',
    run: provider =>
      provider.deepseek('deployment').doStream({ prompt: PROMPT }),
  },
  {
    name: 'completion doGenerate',
    run: provider =>
      provider.completion('deployment').doGenerate({ prompt: PROMPT }),
  },
  {
    name: 'completion doStream',
    run: provider =>
      provider.completion('deployment').doStream({ prompt: PROMPT }),
  },
  {
    name: 'embedding doEmbed',
    run: provider =>
      provider.embedding('deployment').doEmbed({ values: [PROMPT_MARKER] }),
  },
  {
    name: 'embeddingModel doEmbed',
    run: provider =>
      provider
        .embeddingModel('deployment')
        .doEmbed({ values: [PROMPT_MARKER] }),
  },
  {
    name: 'textEmbedding doEmbed',
    run: provider =>
      provider.textEmbedding('deployment').doEmbed({ values: [PROMPT_MARKER] }),
  },
  {
    name: 'textEmbeddingModel doEmbed',
    run: provider =>
      provider
        .textEmbeddingModel('deployment')
        .doEmbed({ values: [PROMPT_MARKER] }),
  },
  {
    name: 'image doGenerate',
    run: provider =>
      provider.image('dalle-deployment').doGenerate({
        prompt: PROMPT_MARKER,
        n: 1,
        size: '1024x1024',
      }),
  },
  {
    name: 'imageModel doGenerate',
    run: provider =>
      provider.imageModel('dalle-deployment').doGenerate({
        prompt: PROMPT_MARKER,
        n: 1,
        size: '1024x1024',
      }),
  },
  {
    name: 'image doGenerate edits',
    run: provider =>
      provider.image('dalle-deployment').doGenerate({
        prompt: PROMPT_MARKER,
        files: [
          {
            type: 'file',
            mediaType: 'image/png',
            data: new TextEncoder().encode(PROMPT_MARKER),
          },
        ],
        n: 1,
        size: '1024x1024',
      }),
  },
  {
    name: 'speech doGenerate',
    run: provider =>
      provider.speech('tts-1').doGenerate({ text: PROMPT_MARKER }),
  },
  {
    name: 'transcription doGenerate',
    run: provider =>
      provider.transcription('whisper-1').doGenerate({
        audio: new TextEncoder().encode(PROMPT_MARKER),
        mediaType: 'audio/wav',
        providerOptions: { openai: { prompt: PROMPT_MARKER } },
      }),
  },
  {
    name: 'transcription doStream',
    run: provider =>
      provider.transcription('gpt-realtime-whisper').doStream({
        audio: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(PROMPT_MARKER));
            controller.close();
          },
        }),
        inputAudioFormat: { type: 'audio/pcm', rate: 24000 },
      }),
  },
];

async function leaksForSettings(
  operation: Operation,
  settings: AzureOpenAIProviderSettings,
  resourceName: string,
  mode: 'api-key' | 'bearer',
): Promise<Leak[]> {
  const capture = startCapture();
  try {
    const provider = createAzure({ ...settings, fetch: capture.fetch });
    await settle(operation.run(provider));
    return leaksFrom(capture.calls, resourceName, mode);
  } finally {
    capture.restore();
  }
}

async function expectResourceNamesStayOnAzure(
  operation: Operation,
  settingsFor: (resourceName: string) => AzureOpenAIProviderSettings,
  resourceNames: readonly string[],
  mode: 'api-key' | 'bearer',
): Promise<void> {
  const leaks: Leak[] = [];
  for (const resourceName of resourceNames) {
    leaks.push(
      ...(await leaksForSettings(
        operation,
        settingsFor(resourceName),
        resourceName,
        mode,
      )),
    );
  }
  expect(leaks).toEqual([]);
}

describe('Azure OpenAI resource name host', () => {
  describe('legitimate resource name', () => {
    it.each(operations)(
      '$name sends the placeholder api key and prompt to that Azure host',
      async operation => {
        const capture = startCapture();
        try {
          const provider = createAzure({
            resourceName: SAFE_RESOURCE_NAME,
            apiKey: API_KEY_PLACEHOLDER,
            fetch: capture.fetch,
          });
          await settle(operation.run(provider));
          expect(capture.calls.length).toBeGreaterThan(0);
          for (const call of capture.calls) {
            expect(new URL(call.url).hostname).toBe(
              `${SAFE_RESOURCE_NAME}${AZURE_HOST_SUFFIX}`,
            );
            expect(call.method === 'POST' || call.method === 'WEBSOCKET').toBe(
              true,
            );
            expect(call.headers['api-key']).toBe(API_KEY_PLACEHOLDER);
            expect(call.body).toContain(PROMPT_MARKER);
          }
        } finally {
          capture.restore();
        }
      },
    );

    it('chat doGenerate with deployment URLs stays on that Azure host', async () => {
      const capture = startCapture();
      try {
        const provider = createAzure({
          resourceName: SAFE_RESOURCE_NAME,
          apiKey: API_KEY_PLACEHOLDER,
          useDeploymentBasedUrls: true,
          fetch: capture.fetch,
        });
        await settle(
          provider.chat('deployment').doGenerate({ prompt: PROMPT }),
        );
        expect(capture.calls).toHaveLength(1);
        expect(capture.calls[0]?.url).toContain(
          `/deployments/deployment/chat/completions`,
        );
        expect(new URL(capture.calls[0]!.url).hostname).toBe(
          `${SAFE_RESOURCE_NAME}${AZURE_HOST_SUFFIX}`,
        );
        expect(capture.calls[0]?.headers['api-key']).toBe(API_KEY_PLACEHOLDER);
        expect(capture.calls[0]?.body).toContain(PROMPT_MARKER);
      } finally {
        capture.restore();
      }
    });
  });

  describe('resource name from provider options', () => {
    it.each(operations)(
      '$name does not send the api key or prompt to a host selected by the resource name',
      async operation => {
        await expectResourceNamesStayOnAzure(
          operation,
          resourceName => ({
            resourceName,
            apiKey: API_KEY_PLACEHOLDER,
          }),
          ATTACKER_RESOURCE_NAMES,
          'api-key',
        );
      },
    );

    it.each(operations)(
      '$name does not send a bearer token or prompt to a host selected by the resource name',
      async operation => {
        await expectResourceNamesStayOnAzure(
          operation,
          resourceName => ({
            resourceName,
            tokenProvider: async () => TOKEN_PLACEHOLDER,
          }),
          ATTACKER_RESOURCE_NAMES,
          'bearer',
        );
      },
    );

    it.each(operations)(
      '$name does not send the api key or prompt when deployment URLs use the resource name',
      async operation => {
        await expectResourceNamesStayOnAzure(
          operation,
          resourceName => ({
            resourceName,
            apiKey: API_KEY_PLACEHOLDER,
            useDeploymentBasedUrls: true,
          }),
          ATTACKER_RESOURCE_NAMES,
          'api-key',
        );
      },
    );
  });

  describe('resource name from AZURE_RESOURCE_NAME', () => {
    async function withResourceName<T>(
      resourceName: string | undefined,
      run: () => Promise<T>,
    ): Promise<T> {
      const previous = process.env.AZURE_RESOURCE_NAME;
      try {
        if (resourceName === undefined) {
          delete process.env.AZURE_RESOURCE_NAME;
        } else {
          process.env.AZURE_RESOURCE_NAME = resourceName;
        }
        return await run();
      } finally {
        if (previous === undefined) {
          delete process.env.AZURE_RESOURCE_NAME;
        } else {
          process.env.AZURE_RESOURCE_NAME = previous;
        }
      }
    }

    it('chat doGenerate sends the placeholder api key to the env resource host', async () => {
      await withResourceName(SAFE_RESOURCE_NAME, async () => {
        const capture = startCapture();
        try {
          const provider = createAzure({
            apiKey: API_KEY_PLACEHOLDER,
            fetch: capture.fetch,
          });
          await settle(
            provider.chat('deployment').doGenerate({ prompt: PROMPT }),
          );
          expect(capture.calls).toHaveLength(1);
          expect(new URL(capture.calls[0]!.url).hostname).toBe(
            `${SAFE_RESOURCE_NAME}${AZURE_HOST_SUFFIX}`,
          );
          expect(capture.calls[0]?.headers['api-key']).toBe(
            API_KEY_PLACEHOLDER,
          );
          expect(capture.calls[0]?.body).toContain(PROMPT_MARKER);
        } finally {
          capture.restore();
        }
      });
    });

    it.each(operations)(
      '$name does not send the api key or prompt to a host selected by AZURE_RESOURCE_NAME',
      async operation => {
        const leaks: Leak[] = [];
        for (const resourceName of ATTACKER_RESOURCE_NAMES) {
          leaks.push(
            ...(await withResourceName(resourceName, () =>
              leaksForSettings(
                operation,
                { apiKey: API_KEY_PLACEHOLDER },
                resourceName,
                'api-key',
              ),
            )),
          );
        }
        expect(leaks).toEqual([]);
      },
    );
  });

  describe('resource name is read once for the request URL', () => {
    it('chat doGenerate uses the first resource name for the host that receives the api key', async () => {
      let reads = 0;
      const capture = startCapture();
      const settings = new Proxy(
        {
          apiKey: API_KEY_PLACEHOLDER,
          fetch: capture.fetch,
        } as AzureOpenAIProviderSettings,
        {
          get(target, prop, receiver) {
            if (prop === 'resourceName') {
              reads += 1;
              return reads === 1 ? SAFE_RESOURCE_NAME : 'evil.example/collect';
            }
            return Reflect.get(target, prop, receiver);
          },
        },
      );

      try {
        const provider = createAzure(settings);
        await settle(
          provider.chat('deployment').doGenerate({ prompt: PROMPT }),
        );
        expect(capture.calls.length).toBeGreaterThan(0);
        expect(
          leaksFrom(capture.calls, 'evil.example/collect', 'api-key'),
        ).toEqual([]);
        for (const call of capture.calls) {
          expect(new URL(call.url).hostname).toBe(
            `${SAFE_RESOURCE_NAME}${AZURE_HOST_SUFFIX}`,
          );
          expect(call.headers['api-key']).toBe(API_KEY_PLACEHOLDER);
          expect(call.body).toContain(PROMPT_MARKER);
        }
      } finally {
        capture.restore();
      }
    });
  });
});
