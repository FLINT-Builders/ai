/**
 * Security contract for prompt URL downloads.
 *
 * These tests describe the limits the default prompt download path must
 * enforce. They fail while every file URL is downloaded at once and each body
 * is buffered up to the 2 GiB default.
 *
 * Limits:
 * - at most 8 files downloaded per prompt
 * - at most 2 of those downloads in flight at once
 * - at most 100 MiB for one file (the default already documented on `download`)
 * - at most 100 MiB combined across the files downloaded for one prompt
 * - a download that stalls aborts within 10 seconds when the caller sets no
 *   timeout and no abort signal
 *
 * The file-count and total-byte errors must include the phrases below.
 * A per-file overflow must surface the existing size error that names the
 * 100 MiB limit in bytes. A Content-Length above that limit must be rejected
 * before the body is read. A body without Content-Length must be stopped
 * while it is read, not after the whole body has been buffered.
 *
 * Covered operations, all of which download through
 * `convertToLanguageModelPrompt` when the caller does not pass
 * `experimental_download`:
 * - `streamText` after `convertToModelMessages` (documented chat route)
 * - `generateText`
 * - `generateObject`
 * - `streamObject`
 * - `startBatch`
 * - user file parts, legacy user image parts, tool-result file parts, and
 *   assistant tool-result file parts
 *
 * Not part of this download path, so not asserted here:
 * - assistant `file` parts and `reasoning-file` parts (they stay URLs)
 * - deprecated tool outputs `file-url` and `image-url` (they stay URLs)
 * - `createDownload()` used by transcribe and video (caller-supplied URLs,
 *   separate from prompt conversion)
 */
import type {
  Experimental_BatchV4 as BatchV4,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import type { ModelMessage } from '@ai-sdk/provider-utils';
import {
  convertArrayToReadableStream,
  convertAsyncIterableToArray,
} from '@ai-sdk/provider-utils/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBatch } from '../batch/batch';
import { generateObject } from '../generate-object/generate-object';
import { streamObject } from '../generate-object/stream-object';
import { generateText } from '../generate-text/generate-text';
import { streamText } from '../generate-text/stream-text';
import { MockLanguageModelV4 } from '../test/mock-language-model-v4';
import { convertToModelMessages } from '../ui/convert-to-model-messages';

const MIB = 1024 * 1024;

/** Per-file cap. Matches the 100 MiB default documented on `download`. */
const MAX_FILE_BYTES = 100 * MIB;

/** Combined cap for every file downloaded from one prompt. */
const MAX_TOTAL_BYTES = 100 * MIB;

/** How many file URLs one prompt may download. */
const MAX_FILES = 8;

/** How many of those downloads may run at the same time. */
const MAX_CONCURRENCY = 2;

/** A stalled download must reject within this long with no caller timeout. */
const MAX_TIMEOUT_MS = 10_000;

const TIMEOUT_GRACE_MS = 4_000;

const CHUNK_BYTES = MIB;

const FILE_COUNT_MESSAGE = `A prompt may download at most ${MAX_FILES} files.`;

const TOTAL_BYTES_MESSAGE = `A prompt download exceeded the total limit of ${MAX_TOTAL_BYTES} bytes.`;

const FILE_BYTES_MESSAGE = `exceeded maximum size of ${MAX_FILE_BYTES} bytes`;

/**
 * URL patterns the OpenAI responses model reports as natively fetchable.
 * Copied from `openaiResponsesSupportedUrls`.
 */
const OPENAI_RESPONSES_SUPPORTED_URLS: Record<string, RegExp[]> = {
  'image/*': [/^https?:\/\/.*$/],
  'application/pdf': [/^https?:\/\/.*$/],
};

const testUsage: LanguageModelV4Usage = {
  inputTokens: {
    total: 3,
    noCache: 3,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: 10,
    text: 10,
    reasoning: undefined,
  },
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.AI_SDK_LOG_WARNINGS = false;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type ResponseLike = {
  ok: boolean;
  status: number;
  type: string;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
};

type ServedBody = {
  response: ResponseLike;
  bytesEnqueued: () => number;
};

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function collectErrorText(error: unknown, depth = 0): string {
  if (depth > 6 || error == null) {
    return '';
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n${collectErrorText(error.cause, depth + 1)}`;
  }
  return '';
}

function byteStream({
  totalBytes,
  contentLength,
}: {
  totalBytes: number;
  contentLength?: string;
}): ServedBody {
  let bytes = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (bytes >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(CHUNK_BYTES, totalBytes - bytes);
      controller.enqueue(new Uint8Array(size));
      bytes += size;
    },
  });
  const headers = new Headers({ 'content-type': 'text/plain' });
  if (contentLength != null) {
    headers.set('content-length', contentLength);
  }
  return {
    response: {
      ok: true,
      status: 200,
      type: 'basic',
      headers,
      body: stream,
    },
    bytesEnqueued: () => bytes,
  };
}

function smallBody(bytes: Uint8Array, mediaType: string): ResponseLike {
  const headers = new Headers({ 'content-type': mediaType });
  headers.set('content-length', String(bytes.byteLength));
  return {
    ok: true,
    status: 200,
    type: 'basic',
    headers,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

class FetchLog {
  readonly calls: string[] = [];
  private inFlight = 0;
  maxInFlight = 0;
  readonly bodies = new Map<string, ServedBody>();

  install(options?: { holdMs?: number }): void {
    const holdMs = options?.holdMs ?? 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      this.calls.push(url);
      this.inFlight += 1;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      if (holdMs > 0) {
        await delay(holdMs);
      }
      this.inFlight -= 1;
      const served = this.bodies.get(url);
      if (served == null) {
        throw new Error(`Unexpected download: ${url}`);
      }
      return served.response as unknown as Response;
    }) as typeof fetch;
  }

  serve(url: string, body: ServedBody): void {
    this.bodies.set(url, body);
  }

  totalBytes(): number {
    let total = 0;
    for (const body of this.bodies.values()) {
      total += body.bytesEnqueued();
    }
    return total;
  }
}

function createModel(supportedUrls: Record<string, RegExp[]> = {}) {
  return new MockLanguageModelV4({
    supportedUrls,
    doGenerate: async () => ({
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: testUsage,
      warnings: [],
      content: [{ type: 'text', text: '{"ok":true}' }],
    }),
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: '{"ok":true}' },
        { type: 'text-end', id: 'text-1' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: testUsage,
        },
      ]),
    }),
  });
}

type Attempt = {
  errors: unknown[];
  modelCalls: number;
};

async function chatAttempt(
  messages: ModelMessage[],
  supportedUrls: Record<string, RegExp[]>,
): Promise<Attempt> {
  const model = createModel(supportedUrls);
  const errors: unknown[] = [];
  const result = streamText({
    model,
    messages,
    maxRetries: 0,
    onError: ({ error }) => {
      errors.push(error);
    },
  });
  try {
    await result.text;
  } catch (error) {
    errors.push(error);
  }
  return { errors, modelCalls: model.doStreamCalls.length };
}

async function generateTextAttempt(
  messages: ModelMessage[],
  supportedUrls: Record<string, RegExp[]> = {},
): Promise<Attempt> {
  const model = createModel(supportedUrls);
  const errors: unknown[] = [];
  try {
    await generateText({ model, messages, maxRetries: 0 });
  } catch (error) {
    errors.push(error);
  }
  return { errors, modelCalls: model.doGenerateCalls.length };
}

async function generateObjectAttempt(
  messages: ModelMessage[],
): Promise<Attempt> {
  const model = createModel();
  const errors: unknown[] = [];
  try {
    await generateObject({
      model,
      output: 'no-schema',
      messages,
      maxRetries: 0,
    });
  } catch (error) {
    errors.push(error);
  }
  return { errors, modelCalls: model.doGenerateCalls.length };
}

async function streamObjectAttempt(messages: ModelMessage[]): Promise<Attempt> {
  const model = createModel();
  const errors: unknown[] = [];
  const result = streamObject({
    model,
    output: 'no-schema',
    messages,
    maxRetries: 0,
    onError: ({ error }) => {
      errors.push(error);
    },
  });
  try {
    // The object promise resolves while the partial stream is read.
    await Promise.all([
      result.object,
      convertAsyncIterableToArray(result.partialObjectStream),
    ]);
  } catch (error) {
    errors.push(error);
  }
  return { errors, modelCalls: model.doStreamCalls.length };
}

function createBatchApi() {
  const doStartBatch = vi.fn<BatchV4['doStartBatch']>(async () => ({
    batchId: 'batch-1',
    status: 'pending' as const,
    warnings: [],
  }));
  const batchApi = {
    specificationVersion: 'v4' as const,
    provider: 'mock-provider',
    supportedUrls: {} as Record<string, RegExp[]>,
    doStartBatch,
    doGetBatchStatus: async () => ({ status: 'pending' as const }),
    doGetBatchResults: async () => convertArrayToReadableStream([]),
  };
  return { batchApi, doStartBatch };
}

async function startBatchAttempt(messages: ModelMessage[]): Promise<Attempt> {
  const { batchApi, doStartBatch } = createBatchApi();
  const errors: unknown[] = [];
  try {
    await startBatch({
      provider: batchApi as unknown as BatchV4,
      requests: [
        {
          id: 'request-1',
          type: 'text',
          model: 'mock-model',
          messages,
        },
      ],
    });
  } catch (error) {
    errors.push(error);
  }
  return { errors, modelCalls: doStartBatch.mock.calls.length };
}

function joinedErrors(attempt: Attempt): string {
  return attempt.errors.map(error => collectErrorText(error)).join('\n');
}

function collectBytes(value: unknown, found: Uint8Array[]): void {
  if (value instanceof Uint8Array) {
    found.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectBytes(item, found);
    }
    return;
  }
  if (value != null && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collectBytes(nested, found);
    }
  }
}

function promptContainsBytes(prompt: unknown, payload: Uint8Array): boolean {
  const found: Uint8Array[] = [];
  collectBytes(prompt, found);
  return found.some(
    bytes =>
      bytes.byteLength === payload.byteLength &&
      bytes.every((byte, index) => byte === payload[index]),
  );
}

function urlFile(url: string, mediaType = 'text/plain') {
  return {
    type: 'file' as const,
    mediaType,
    data: { type: 'url' as const, url: new URL(url) },
  };
}

function userFileMessage(urls: string[]): ModelMessage {
  return {
    role: 'user',
    content: urls.map(url => urlFile(url)),
  };
}

function toolFileMessages(urls: string[]): ModelMessage[] {
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'load',
          input: {},
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'load',
          output: {
            type: 'content',
            value: urls.map(url => urlFile(url)),
          },
        },
      ],
    },
  ];
}

function assistantToolFileMessages(urls: string[]): ModelMessage[] {
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'load',
          input: {},
          providerExecuted: true,
        },
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'load',
          output: {
            type: 'content',
            value: urls.map(url => urlFile(url)),
          },
        },
      ],
    },
  ];
}

function numberedUrls(prefix: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_value, index) => `https://attacker.example/${prefix}-${index}.txt`,
  );
}

function serveEach(log: FetchLog, urls: string[], totalBytes: number): void {
  for (const url of urls) {
    log.serve(new URL(url).toString(), byteStream({ totalBytes }));
  }
}

describe.sequential('prompt download limits', { timeout: 30_000 }, () => {
  it('downloads a small text/plain file from a chat message and gives the bytes to the model', async () => {
    const payload = new TextEncoder().encode('hello-from-attacker');
    const url = 'https://attacker.example/note.txt';
    const log = new FetchLog();
    log.serve(url, {
      response: smallBody(payload, 'text/plain'),
      bytesEnqueued: () => payload.byteLength,
    });
    log.install();

    const model = createModel(OPENAI_RESPONSES_SUPPORTED_URLS);
    const messages = await convertToModelMessages([
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'read this' },
          { type: 'file', mediaType: 'text/plain', url },
        ],
      },
    ]);
    const result = streamText({
      model,
      messages,
      maxRetries: 0,
      onError: () => {},
    });

    await expect(result.text).resolves.toBe('{"ok":true}');
    expect(log.calls).toEqual([url]);
    expect(promptContainsBytes(model.doStreamCalls[0]?.prompt, payload)).toBe(
      true,
    );
  });

  it('does not download image or pdf URLs the OpenAI responses model fetches natively', async () => {
    const log = new FetchLog();
    log.install();
    const model = createModel(OPENAI_RESPONSES_SUPPORTED_URLS);
    const messages = await convertToModelMessages([
      {
        role: 'user',
        parts: [
          {
            type: 'file',
            mediaType: 'image/png',
            url: 'https://attacker.example/photo.png',
          },
          {
            type: 'file',
            mediaType: 'application/pdf',
            url: 'https://attacker.example/paper.pdf',
          },
          { type: 'text', text: 'what is this?' },
        ],
      },
    ]);

    const result = streamText({
      model,
      messages,
      maxRetries: 0,
      onError: () => {},
    });
    await expect(result.text).resolves.toBe('{"ok":true}');
    expect(log.calls).toEqual([]);
    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt);
    expect(prompt).toContain('https://attacker.example/photo.png');
    expect(prompt).toContain('https://attacker.example/paper.pdf');
  });

  it('stops reading a chat file streamed without Content-Length once it passes 100 MiB', async () => {
    const url = 'https://attacker.example/large.txt';
    const log = new FetchLog();
    log.serve(
      url,
      byteStream({ totalBytes: MAX_FILE_BYTES + 2 * CHUNK_BYTES }),
    );
    log.install();
    const messages = await convertToModelMessages([
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'read this' },
          { type: 'file', mediaType: 'text/plain', url },
        ],
      },
    ]);

    const attempt = await chatAttempt(
      messages,
      OPENAI_RESPONSES_SUPPORTED_URLS,
    );

    expect(log.calls).toEqual([url]);
    expect(log.totalBytes()).toBeGreaterThan(MAX_FILE_BYTES);
    expect(log.totalBytes()).toBeLessThanOrEqual(MAX_FILE_BYTES + CHUNK_BYTES);
    expect(attempt.modelCalls).toBe(0);
    expect(joinedErrors(attempt)).toContain(FILE_BYTES_MESSAGE);
  });

  it('rejects a chat file from Content-Length before reading the body when it is over 100 MiB', async () => {
    const url = 'https://attacker.example/declared-large.txt';
    const log = new FetchLog();
    log.serve(
      url,
      byteStream({
        totalBytes: 1,
        contentLength: String(MAX_FILE_BYTES + 1),
      }),
    );
    log.install();
    const messages = await convertToModelMessages([
      {
        role: 'user',
        parts: [{ type: 'file', mediaType: 'text/plain', url }],
      },
    ]);

    const attempt = await chatAttempt(
      messages,
      OPENAI_RESPONSES_SUPPORTED_URLS,
    );

    expect(log.calls).toEqual([url]);
    expect(log.totalBytes()).toBe(0);
    expect(attempt.modelCalls).toBe(0);
    const text = joinedErrors(attempt);
    expect(text).toContain(FILE_BYTES_MESSAGE);
    expect(text).toContain('Content-Length');
  });

  it.each([
    ['generateText', generateTextAttempt],
    ['generateObject', generateObjectAttempt],
    ['streamObject', streamObjectAttempt],
    ['startBatch', startBatchAttempt],
  ] as const)(
    'rejects an oversized Content-Length through %s before reading the body',
    async (_name, run) => {
      const url = 'https://attacker.example/declared-large.txt';
      const log = new FetchLog();
      log.serve(
        url,
        byteStream({
          totalBytes: 1,
          contentLength: String(MAX_FILE_BYTES + 1),
        }),
      );
      log.install();

      const attempt = await run([userFileMessage([url])]);

      expect(log.calls).toEqual([url]);
      expect(log.totalBytes()).toBe(0);
      expect(attempt.modelCalls).toBe(0);
      const text = joinedErrors(attempt);
      expect(text).toContain(FILE_BYTES_MESSAGE);
      expect(text).toContain('Content-Length');
    },
  );

  it('rejects a legacy user image URL and a user file URL through the same per-file cap', async () => {
    const imageUrl = 'https://attacker.example/legacy-image.bin';
    const log = new FetchLog();
    log.serve(
      imageUrl,
      byteStream({
        totalBytes: 1,
        contentLength: String(MAX_FILE_BYTES + 1),
      }),
    );
    log.install();

    const attempt = await generateTextAttempt([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            image: new URL(imageUrl),
            mediaType: 'text/plain',
          },
        ],
      },
    ]);

    expect(log.calls).toEqual([imageUrl]);
    expect(log.totalBytes()).toBe(0);
    expect(attempt.modelCalls).toBe(0);
    expect(joinedErrors(attempt)).toContain(FILE_BYTES_MESSAGE);
  });

  it('rejects an oversized tool-result file URL before reading the body', async () => {
    const url = 'https://attacker.example/tool-result.txt';
    const log = new FetchLog();
    log.serve(
      url,
      byteStream({
        totalBytes: 1,
        contentLength: String(MAX_FILE_BYTES + 1),
      }),
    );
    log.install();

    const attempt = await generateTextAttempt(toolFileMessages([url]));

    expect(log.calls).toEqual([url]);
    expect(log.totalBytes()).toBe(0);
    expect(attempt.modelCalls).toBe(0);
    expect(joinedErrors(attempt)).toContain(FILE_BYTES_MESSAGE);
  });

  it('rejects an oversized assistant tool-result file URL before reading the body', async () => {
    const url = 'https://attacker.example/assistant-tool.txt';
    const log = new FetchLog();
    log.serve(
      url,
      byteStream({
        totalBytes: 1,
        contentLength: String(MAX_FILE_BYTES + 1),
      }),
    );
    log.install();

    const attempt = await generateTextAttempt(assistantToolFileMessages([url]));

    expect(log.calls).toEqual([url]);
    expect(log.totalBytes()).toBe(0);
    expect(attempt.modelCalls).toBe(0);
    expect(joinedErrors(attempt)).toContain(FILE_BYTES_MESSAGE);
  });

  it('stops a chat prompt whose files together pass 100 MiB without Content-Length', async () => {
    const urls = numberedUrls('chat-budget', 3);
    const log = new FetchLog();
    serveEach(log, urls, 40 * MIB);
    log.install();
    const messages = await convertToModelMessages([
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'read these' },
          ...urls.map(url => ({
            type: 'file' as const,
            mediaType: 'text/plain',
            url,
          })),
        ],
      },
    ]);

    const attempt = await chatAttempt(
      messages,
      OPENAI_RESPONSES_SUPPORTED_URLS,
    );

    expect(log.calls).toHaveLength(3);
    expect(log.totalBytes()).toBeGreaterThan(MAX_TOTAL_BYTES);
    expect(log.totalBytes()).toBeLessThanOrEqual(
      MAX_TOTAL_BYTES + MAX_CONCURRENCY * CHUNK_BYTES,
    );
    expect(attempt.modelCalls).toBe(0);
    expect(joinedErrors(attempt)).toContain(TOTAL_BYTES_MESSAGE);
  });

  it('applies one byte budget across user files, image URLs, tool results, and assistant tool results', async () => {
    const userFileUrl = 'https://attacker.example/budget-user.txt';
    const imageUrl = 'https://attacker.example/budget-image.bin';
    const toolUrl = 'https://attacker.example/budget-tool.txt';
    const assistantUrl = 'https://attacker.example/budget-assistant.txt';
    const log = new FetchLog();
    serveEach(log, [userFileUrl, imageUrl, toolUrl, assistantUrl], 30 * MIB);
    log.install();

    const attempt = await generateTextAttempt([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            image: new URL(imageUrl),
            mediaType: 'text/plain',
          },
          urlFile(userFileUrl),
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-assistant',
            toolName: 'load',
            input: {},
            providerExecuted: true,
          },
          {
            type: 'tool-result',
            toolCallId: 'call-assistant',
            toolName: 'load',
            output: {
              type: 'content',
              value: [urlFile(assistantUrl)],
            },
          },
          {
            type: 'tool-call',
            toolCallId: 'call-tool',
            toolName: 'load',
            input: {},
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-tool',
            toolName: 'load',
            output: {
              type: 'content',
              value: [urlFile(toolUrl)],
            },
          },
        ],
      },
    ]);

    expect(log.calls).toHaveLength(4);
    expect(log.totalBytes()).toBeGreaterThan(MAX_TOTAL_BYTES);
    expect(log.totalBytes()).toBeLessThanOrEqual(
      MAX_TOTAL_BYTES + MAX_CONCURRENCY * CHUNK_BYTES,
    );
    expect(attempt.modelCalls).toBe(0);
    expect(joinedErrors(attempt)).toContain(TOTAL_BYTES_MESSAGE);
  });

  it('still downloads several files when each of them fits in the total budget', async () => {
    const urls = numberedUrls('small-set', 3);
    const payload = new TextEncoder().encode('abc');
    const log = new FetchLog();
    for (const url of urls) {
      log.serve(new URL(url).toString(), {
        response: smallBody(payload, 'text/plain'),
        bytesEnqueued: () => payload.byteLength,
      });
    }
    log.install();

    const attempt = await generateTextAttempt([userFileMessage(urls)]);

    expect(log.calls).toHaveLength(3);
    expect(attempt.modelCalls).toBe(1);
    expect(attempt.errors).toEqual([]);
  });

  it('does not fetch when a chat message has more file URLs than the per-prompt cap', async () => {
    const urls = numberedUrls('chat-count', MAX_FILES + 1);
    const log = new FetchLog();
    serveEach(log, urls, 1);
    log.install();
    const messages = await convertToModelMessages(
      urls.map(url => ({
        role: 'user' as const,
        parts: [{ type: 'file' as const, mediaType: 'text/plain', url }],
      })),
    );

    const attempt = await chatAttempt(
      messages,
      OPENAI_RESPONSES_SUPPORTED_URLS,
    );

    expect(log.calls).toEqual([]);
    expect(attempt.modelCalls).toBe(0);
    expect(joinedErrors(attempt)).toContain(FILE_COUNT_MESSAGE);
  });

  it.each([
    ['generateText user files', generateTextAttempt, userFileMessage],
    ['generateObject user files', generateObjectAttempt, userFileMessage],
    ['streamObject user files', streamObjectAttempt, userFileMessage],
    ['startBatch user files', startBatchAttempt, userFileMessage],
  ] as const)(
    'does not fetch when %s exceed the file cap',
    async (_name, run, build) => {
      const urls = numberedUrls('count', MAX_FILES + 1);
      const log = new FetchLog();
      serveEach(log, urls, 1);
      log.install();

      const attempt = await run([build(urls)]);

      expect(log.calls).toEqual([]);
      expect(attempt.modelCalls).toBe(0);
      expect(joinedErrors(attempt)).toContain(FILE_COUNT_MESSAGE);
    },
  );

  it('does not fetch when tool-result file URLs exceed the file cap', async () => {
    const urls = numberedUrls('tool-count', MAX_FILES + 1);
    const log = new FetchLog();
    serveEach(log, urls, 1);
    log.install();

    const attempt = await generateTextAttempt(toolFileMessages(urls));

    expect(log.calls).toEqual([]);
    expect(attempt.modelCalls).toBe(0);
    expect(joinedErrors(attempt)).toContain(FILE_COUNT_MESSAGE);
  });

  it('does not fetch when assistant tool-result file URLs exceed the file cap', async () => {
    const urls = numberedUrls('assistant-count', MAX_FILES + 1);
    const log = new FetchLog();
    serveEach(log, urls, 1);
    log.install();

    const attempt = await generateTextAttempt(assistantToolFileMessages(urls));

    expect(log.calls).toEqual([]);
    expect(attempt.modelCalls).toBe(0);
    expect(joinedErrors(attempt)).toContain(FILE_COUNT_MESSAGE);
  });

  it('does not fetch when legacy image URLs exceed the file cap', async () => {
    const urls = numberedUrls('image-count', MAX_FILES + 1);
    const log = new FetchLog();
    serveEach(log, urls, 1);
    log.install();

    const attempt = await generateTextAttempt([
      {
        role: 'user',
        content: urls.map(url => ({
          type: 'image' as const,
          image: new URL(url),
          mediaType: 'text/plain',
        })),
      },
    ]);

    expect(log.calls).toEqual([]);
    expect(attempt.modelCalls).toBe(0);
    expect(joinedErrors(attempt)).toContain(FILE_COUNT_MESSAGE);
  });

  it('does not count image and pdf URLs the model fetches itself toward the file cap', async () => {
    const downloaded = numberedUrls('counted', MAX_FILES);
    const native = Array.from(
      { length: 20 },
      (_value, index) => `https://attacker.example/native-${index}.png`,
    );
    const payload = new TextEncoder().encode('x');
    const log = new FetchLog();
    for (const url of downloaded) {
      log.serve(new URL(url).toString(), {
        response: smallBody(payload, 'text/plain'),
        bytesEnqueued: () => payload.byteLength,
      });
    }
    log.install();
    const messages = await convertToModelMessages([
      {
        role: 'user',
        parts: [
          ...downloaded.map(url => ({
            type: 'file' as const,
            mediaType: 'text/plain',
            url,
          })),
          ...native.map(url => ({
            type: 'file' as const,
            mediaType: 'image/png',
            url,
          })),
        ],
      },
    ]);

    const attempt = await chatAttempt(
      messages,
      OPENAI_RESPONSES_SUPPORTED_URLS,
    );

    expect(log.calls).toHaveLength(MAX_FILES);
    expect(log.calls.every(url => url.endsWith('.txt'))).toBe(true);
    expect(attempt.modelCalls).toBe(1);
    expect(attempt.errors).toEqual([]);
  });

  it('downloads the allowed files with a bounded number in flight', async () => {
    const urls = numberedUrls('parallel', MAX_FILES);
    const payload = new TextEncoder().encode('x');
    const log = new FetchLog();
    for (const url of urls) {
      log.serve(new URL(url).toString(), {
        response: smallBody(payload, 'text/plain'),
        bytesEnqueued: () => payload.byteLength,
      });
    }
    log.install({ holdMs: 50 });
    const messages = await convertToModelMessages([
      {
        role: 'user',
        parts: urls.map(url => ({
          type: 'file' as const,
          mediaType: 'text/plain',
          url,
        })),
      },
    ]);

    const attempt = await chatAttempt(
      messages,
      OPENAI_RESPONSES_SUPPORTED_URLS,
    );

    expect(log.calls).toHaveLength(MAX_FILES);
    expect(log.maxInFlight).toBeGreaterThan(0);
    expect(log.maxInFlight).toBeLessThanOrEqual(MAX_CONCURRENCY);
    expect(attempt.modelCalls).toBe(1);
    expect(attempt.errors).toEqual([]);
  });

  it('uses a caller-supplied download function instead of the default fetcher', async () => {
    const payload = new TextEncoder().encode('from-custom-downloader');
    const log = new FetchLog();
    log.install();
    const model = createModel();
    const download = vi.fn(async () => [
      { data: payload, mediaType: 'text/plain' as const },
    ]);

    const result = await generateText({
      model,
      maxRetries: 0,
      experimental_download: download,
      messages: [userFileMessage(['https://attacker.example/custom.txt'])],
    });

    expect(result.text).toBe('{"ok":true}');
    expect(download).toHaveBeenCalledOnce();
    expect(log.calls).toEqual([]);
    expect(promptContainsBytes(model.doGenerateCalls[0]?.prompt, payload)).toBe(
      true,
    );
  });

  describe('default timeout', () => {
    async function stalledFetch(): Promise<{
      calls: () => number;
      aborted: () => boolean;
      stop: () => void;
    }> {
      let calls = 0;
      let aborted = false;
      let stop = () => {};
      globalThis.fetch = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) => {
          calls += 1;
          const signal = init?.signal;
          return new Promise<Response>((_resolve, reject) => {
            const fail = (reason: unknown) => {
              reject(
                reason instanceof Error
                  ? reason
                  : new DOMException(
                      'The operation was aborted.',
                      'AbortError',
                    ),
              );
            };
            const onAbort = () => {
              aborted = true;
              fail(signal?.reason);
            };
            stop = () => fail(new DOMException('stopped', 'AbortError'));
            if (signal?.aborted) {
              onAbort();
              return;
            }
            signal?.addEventListener('abort', onAbort, { once: true });
          });
        },
      ) as typeof fetch;
      return {
        calls: () => calls,
        aborted: () => aborted,
        stop: () => {
          stop();
        },
      };
    }

    async function expectStallAborts(
      run: () => Promise<unknown>,
    ): Promise<void> {
      const fetchLog = await stalledFetch();
      const started = Date.now();
      let outcome: 'fulfilled' | 'rejected' | 'pending' = 'pending';
      const operation = Promise.resolve()
        .then(run)
        .then(
          () => {
            outcome = 'fulfilled';
          },
          () => {
            outcome = 'rejected';
          },
        );
      const winner = await Promise.race([
        operation.then(() => 'settled' as const),
        delay(MAX_TIMEOUT_MS + TIMEOUT_GRACE_MS).then(() => 'timeout' as const),
      ]);
      fetchLog.stop();
      await Promise.race([operation, delay(1_000)]);

      expect(fetchLog.calls()).toBeGreaterThan(0);
      expect(fetchLog.aborted()).toBe(true);
      expect(winner).toBe('settled');
      expect(outcome).toBe('rejected');
      expect(Date.now() - started).toBeLessThanOrEqual(
        MAX_TIMEOUT_MS + TIMEOUT_GRACE_MS,
      );
    }

    it(
      'aborts a stalled chat download when the caller sets no timeout',
      async () => {
        const messages = await convertToModelMessages([
          {
            role: 'user',
            parts: [
              {
                type: 'file',
                mediaType: 'text/plain',
                url: 'https://attacker.example/stall.txt',
              },
            ],
          },
        ]);
        const model = createModel(OPENAI_RESPONSES_SUPPORTED_URLS);
        await expectStallAborts(async () => {
          const result = streamText({
            model,
            messages,
            maxRetries: 0,
            onError: () => {},
          });
          await result.text;
        });
        expect(model.doStreamCalls).toHaveLength(0);
      },
      MAX_TIMEOUT_MS + TIMEOUT_GRACE_MS + 5_000,
    );

    it(
      'aborts a stalled generateText download when the caller sets no timeout',
      async () => {
        const model = createModel();
        await expectStallAborts(() =>
          generateText({
            model,
            maxRetries: 0,
            messages: [
              userFileMessage(['https://attacker.example/stall-generate.txt']),
            ],
          }),
        );
        expect(model.doGenerateCalls).toHaveLength(0);
      },
      MAX_TIMEOUT_MS + TIMEOUT_GRACE_MS + 5_000,
    );

    it(
      'aborts a stalled generateObject download when the caller sets no timeout',
      async () => {
        const model = createModel();
        await expectStallAborts(() =>
          generateObject({
            model,
            output: 'no-schema',
            maxRetries: 0,
            messages: [
              userFileMessage(['https://attacker.example/stall-object.txt']),
            ],
          }),
        );
        expect(model.doGenerateCalls).toHaveLength(0);
      },
      MAX_TIMEOUT_MS + TIMEOUT_GRACE_MS + 5_000,
    );

    it(
      'aborts a stalled streamObject download when the caller sets no timeout',
      async () => {
        const model = createModel();
        await expectStallAborts(async () => {
          const result = streamObject({
            model,
            output: 'no-schema',
            maxRetries: 0,
            onError: () => {},
            messages: [
              userFileMessage([
                'https://attacker.example/stall-stream-object.txt',
              ]),
            ],
          });
          await result.object;
        });
        expect(model.doStreamCalls).toHaveLength(0);
      },
      MAX_TIMEOUT_MS + TIMEOUT_GRACE_MS + 5_000,
    );

    it(
      'aborts a stalled startBatch download when the caller sets no timeout',
      async () => {
        const { batchApi, doStartBatch } = createBatchApi();
        await expectStallAborts(() =>
          startBatch({
            provider: batchApi as unknown as BatchV4,
            requests: [
              {
                id: 'request-1',
                type: 'text',
                model: 'mock-model',
                messages: [
                  userFileMessage(['https://attacker.example/stall-batch.txt']),
                ],
              },
            ],
          }),
        );
        expect(doStartBatch).not.toHaveBeenCalled();
      },
      MAX_TIMEOUT_MS + TIMEOUT_GRACE_MS + 5_000,
    );
  });
});
