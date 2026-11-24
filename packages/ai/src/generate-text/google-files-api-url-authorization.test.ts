import { createGoogle, type GoogleProvider } from '@ai-sdk/google';
import type { ModelMessage } from '@ai-sdk/provider-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { createAgentUIStream, ToolLoopAgent } from '../agent';
import {
  convertToModelMessages,
  validateUIMessages,
  type UIMessage,
} from '../ui';
import { experimental_startBatch } from '../batch';
import { generateObject, streamObject } from '../generate-object';
import { generateText } from './generate-text';
import { streamText } from './stream-text';

/**
 * Client-supplied Gemini Files API references must not be forwarded to the
 * provider. These tests fail while chat, batch, interactions, and agent
 * calls still send those references as fileUri/uri.
 *
 * Tool-result https URLs are serialized as text and are not part of this
 * path. Embedding fileUri values are developer provider options, not chat
 * messages, and are not covered here.
 */

const VICTIM_FILE_ID = 'victim-file-9f3c2a';
const OTHER_FILE_ID = 'checked-file-4b7e';
const API_KEY_HEADER = 'x-goog-api-key';
const PLACEHOLDER_API_KEY = 'test-api-key';

const GEMINI_FILES_ORIGIN = 'https://generativelanguage.googleapis.com';
const VICTIM_FILE_URL = `${GEMINI_FILES_ORIGIN}/v1beta/files/${VICTIM_FILE_ID}`;
const OTHER_FILE_URL = `${GEMINI_FILES_ORIGIN}/v1beta/files/${OTHER_FILE_ID}`;
const CUSTOM_BASE_URL = 'https://files-proxy.example/v1beta';
const CUSTOM_VICTIM_FILE_URL = `${CUSTOM_BASE_URL}/files/${VICTIM_FILE_ID}`;

const FILES_REFERENCE_KEYS = new Set(['fileUri', 'uri', 'file_uri']);

type RecordedRequest = {
  url: string;
  method: string;
  body: string;
  sentProviderCredential: boolean;
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function victimFileUrl(fileId: string = VICTIM_FILE_ID): string {
  return `${GEMINI_FILES_ORIGIN}/v1beta/files/${fileId}`;
}

function isProjectFilesRequest(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.pathname.includes('/v1beta/files/') ||
      parsed.pathname.includes('/upload/v1beta/files')
    );
  } catch {
    return url.includes('/v1beta/files/');
  }
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
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return body.text();
  }
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body);
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const parts: string[] = [];
    for (const [key, value] of body.entries()) {
      parts.push(key);
      parts.push(typeof value === 'string' ? value : await value.text());
    }
    return parts.join('\n');
  }
  return '';
}

function headerHasCredential(headers: HeadersInit | undefined): boolean {
  if (headers == null) {
    return false;
  }
  const parsed = new Headers(headers);
  return (
    parsed.has(API_KEY_HEADER) ||
    parsed.has('authorization') ||
    parsed.has('x-api-key')
  );
}

function collectReferenceValues(value: unknown, found: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectReferenceValues(item, found);
    }
    return;
  }
  if (value == null || typeof value !== 'object') {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FILES_REFERENCE_KEYS.has(key) && typeof child === 'string') {
      found.push(child);
    }
    collectReferenceValues(child, found);
  }
}

function referenceValues(body: string): string[] {
  const found: string[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    try {
      collectReferenceValues(JSON.parse(trimmed), found);
    } catch {
      // Non-JSON bodies are checked by the raw marker scan below.
    }
  }
  return found;
}

function createRecorder() {
  const requests: RecordedRequest[] = [];

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method =
      init?.method ?? (input instanceof Request ? input.method : 'GET');
    const body = await readBody(
      init?.body ?? (input instanceof Request ? input.body : undefined),
    );
    const headers =
      init?.headers ?? (input instanceof Request ? input.headers : undefined);
    const sentProviderCredential = headerHasCredential(headers);
    requests.push({
      url,
      method,
      body,
      sentProviderCredential,
    });

    if (isProjectFilesRequest(url)) {
      return new Response('unavailable', {
        status: 403,
        headers: { 'content-type': 'text/plain' },
      });
    }

    if (url.includes(':streamGenerateContent') || url.includes('stream=true')) {
      const payload = {
        candidates: [
          {
            content: { parts: [{ text: 'ok' }], role: 'model' },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 1,
          candidatesTokenCount: 1,
          totalTokenCount: 2,
        },
      };
      return new Response(`data: ${JSON.stringify(payload)}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }

    if (url.includes(':batchGenerateContent')) {
      return Response.json({
        name: 'batches/test-batch',
        done: false,
        metadata: { state: 'BATCH_STATE_PENDING' },
      });
    }

    if (url.includes('/interactions')) {
      return Response.json({
        id: 'interaction-test',
        status: 'completed',
        steps: [
          {
            type: 'model_output',
            content: [{ type: 'text', text: 'ok' }],
          },
        ],
      });
    }

    return Response.json({
      candidates: [
        {
          content: { parts: [{ text: 'ok' }], role: 'model' },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: 1,
        totalTokenCount: 2,
      },
    });
  };

  return { fetch, requests };
}

function assertProjectFilesNotForwarded(
  requests: RecordedRequest[],
  markers: string[],
) {
  for (const request of requests) {
    if (isProjectFilesRequest(request.url)) {
      expect(request.method).toBe('GET');
      expect(request.sentProviderCredential).toBe(false);
    }

    const references = referenceValues(request.body);
    for (const reference of references) {
      for (const marker of markers) {
        expect(reference).not.toContain(marker);
      }
    }

    for (const marker of markers) {
      const forwarded =
        request.body.includes(marker) &&
        (request.body.includes('fileUri') ||
          request.body.includes('"uri"') ||
          request.body.includes('file_uri'));
      expect(forwarded).toBe(false);
    }
  }
}

async function withGoogle(
  run: (google: GoogleProvider) => Promise<void>,
  {
    baseURL,
    markers = [VICTIM_FILE_ID, `${GEMINI_FILES_ORIGIN}/v1beta/files/`],
  }: { baseURL?: string; markers?: string[] } = {},
) {
  const recorder = createRecorder();
  globalThis.fetch = recorder.fetch;
  const google = createGoogle({
    apiKey: PLACEHOLDER_API_KEY,
    fetch: recorder.fetch,
    ...(baseURL != null ? { baseURL } : {}),
  });

  try {
    await run(google);
  } catch {
    // A download failure or an explicit refusal is a safe outcome.
  }

  assertProjectFilesNotForwarded(recorder.requests, markers);
}

function userFileMessage(url: string, mediaType: string): UIMessage {
  return {
    id: 'user-1',
    role: 'user',
    parts: [
      { type: 'text', text: 'Describe the attached file.' },
      { type: 'file', mediaType, url },
    ],
  };
}

async function modelMessagesFromUi(messages: UIMessage[]) {
  const validated = await validateUIMessages({ messages });
  return convertToModelMessages(validated);
}

/**
 * First string conversion is a different Files API object than later reads
 * and from the URL's own href. A check that reads the URL once and sends it
 * again must not forward either object.
 */
class DivergentFileUrl extends URL {
  private reads = 0;

  override toString(): string {
    this.reads += 1;
    return victimFileUrl(this.reads === 1 ? OTHER_FILE_ID : VICTIM_FILE_ID);
  }

  override toJSON(): string {
    return this.toString();
  }
}

describe('client-supplied Gemini Files API references', () => {
  it('does not forward a chat file URL through generateText for a media type outside the external URL list', async () => {
    const messages = await modelMessagesFromUi([
      userFileMessage(VICTIM_FILE_URL, 'application/octet-stream'),
    ]);

    await withGoogle(google =>
      generateText({
        model: google.chat('gemini-2.5-flash'),
        messages,
        maxRetries: 0,
      }),
    );
  });

  it('does not forward a Files API URL whose media type is also natively supported as external https', async () => {
    const messages = await modelMessagesFromUi([
      userFileMessage(VICTIM_FILE_URL, 'application/pdf'),
    ]);

    await withGoogle(google =>
      generateText({
        model: google.chat('gemini-2.5-flash'),
        messages,
        maxRetries: 0,
      }),
    );
  });

  it('does not forward a Files API image URL on a model without external https URL support', async () => {
    const messages = await modelMessagesFromUi([
      userFileMessage(VICTIM_FILE_URL, 'image/png'),
    ]);

    await withGoogle(google =>
      generateText({
        model: google.chat('gemini-2.0-flash'),
        messages,
        maxRetries: 0,
      }),
    );
  });

  it('does not forward a mixed-case Files API host', async () => {
    const mixedCaseUrl = `https://GenerativeLanguage.googleapis.com/v1beta/files/${VICTIM_FILE_ID}`;
    const messages = await modelMessagesFromUi([
      userFileMessage(mixedCaseUrl, 'application/octet-stream'),
    ]);

    await withGoogle(
      google =>
        generateText({
          model: google.chat('gemini-2.5-flash'),
          messages,
          maxRetries: 0,
        }),
      {
        markers: [VICTIM_FILE_ID, mixedCaseUrl, mixedCaseUrl.toLowerCase()],
      },
    );
  });

  it('does not forward every Files API URL when a message contains more than one', async () => {
    const messages = await modelMessagesFromUi([
      {
        id: 'user-1',
        role: 'user',
        parts: [
          { type: 'text', text: 'Compare these files.' },
          {
            type: 'file',
            mediaType: 'application/octet-stream',
            url: OTHER_FILE_URL,
          },
          {
            type: 'file',
            mediaType: 'application/pdf',
            url: VICTIM_FILE_URL,
          },
        ],
      },
    ]);

    await withGoogle(
      google =>
        generateText({
          model: google.chat('gemini-2.5-flash'),
          messages,
          maxRetries: 0,
        }),
      { markers: [VICTIM_FILE_ID, OTHER_FILE_ID] },
    );
  });

  it('does not forward a string file URL that prompt conversion parses into a URL', async () => {
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe the attached file.' },
          {
            type: 'file',
            mediaType: 'application/octet-stream',
            data: VICTIM_FILE_URL,
          },
        ],
      },
    ];

    await withGoogle(google =>
      generateText({
        model: google.chat('gemini-2.5-flash'),
        messages,
        maxRetries: 0,
      }),
    );
  });

  it('does not forward a legacy image part whose URL is a Files API URL', async () => {
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe the attached file.' },
          {
            type: 'image',
            image: new URL(VICTIM_FILE_URL),
            mediaType: 'image/png',
          },
        ],
      },
    ];

    await withGoogle(google =>
      generateText({
        model: google.chat('gemini-2.5-flash'),
        messages,
        maxRetries: 0,
      }),
    );
  });

  it('does not forward a Files API URL read once for the support check and again as the file reference', async () => {
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe the attached file.' },
          {
            type: 'file',
            mediaType: 'application/octet-stream',
            data: new DivergentFileUrl(VICTIM_FILE_URL),
          },
        ],
      },
    ];

    await withGoogle(
      google =>
        generateText({
          model: google.chat('gemini-2.0-flash'),
          messages,
          maxRetries: 0,
        }),
      { markers: [VICTIM_FILE_ID, OTHER_FILE_ID] },
    );
  });

  it('does not forward a client provider reference in place of the file url', async () => {
    const messages = await modelMessagesFromUi([
      {
        id: 'user-1',
        role: 'user',
        parts: [
          { type: 'text', text: 'Describe the attached file.' },
          {
            type: 'file',
            mediaType: 'application/octet-stream',
            url: OTHER_FILE_URL,
            providerReference: { google: VICTIM_FILE_URL },
          },
        ],
      },
    ]);

    await withGoogle(
      google =>
        generateText({
          model: google.chat('gemini-2.5-flash'),
          messages,
          maxRetries: 0,
        }),
      { markers: [VICTIM_FILE_ID, OTHER_FILE_ID] },
    );
  });

  it('does not forward an assistant file provider reference supplied by the client', async () => {
    const messages = await modelMessagesFromUi([
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [
          {
            type: 'file',
            mediaType: 'application/pdf',
            url: 'https://example.com/placeholder.pdf',
            providerReference: { google: VICTIM_FILE_URL },
          },
        ],
      },
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Describe the file from before.' }],
      },
    ]);

    await withGoogle(google =>
      generateText({
        model: google.chat('gemini-2.5-flash'),
        messages,
        maxRetries: 0,
      }),
    );
  });

  it('does not forward a Files API URL through streamText', async () => {
    const messages = await modelMessagesFromUi([
      userFileMessage(VICTIM_FILE_URL, 'text/markdown'),
    ]);

    await withGoogle(async google => {
      const result = streamText({
        model: google.chat('gemini-2.5-flash'),
        messages,
        maxRetries: 0,
      });
      await result.text;
    });
  });

  it('does not forward a Files API URL through generateObject', async () => {
    const messages = await modelMessagesFromUi([
      userFileMessage(VICTIM_FILE_URL, 'application/pdf'),
    ]);

    await withGoogle(google =>
      generateObject({
        model: google.chat('gemini-2.5-flash'),
        schema: z.object({ summary: z.string() }),
        messages,
        maxRetries: 0,
      }),
    );
  });

  it('does not forward a Files API URL through streamObject', async () => {
    const messages = await modelMessagesFromUi([
      userFileMessage(VICTIM_FILE_URL, 'application/octet-stream'),
    ]);

    await withGoogle(async google => {
      const result = streamObject({
        model: google.chat('gemini-2.0-flash'),
        schema: z.object({ summary: z.string() }),
        messages,
        maxRetries: 0,
      });
      for await (const _part of result.partialObjectStream) {
        // Drain the stream so the provider request is issued.
      }
    });
  });

  it('does not forward a Files API URL through batch generation', async () => {
    const messages = await modelMessagesFromUi([
      userFileMessage(VICTIM_FILE_URL, 'application/octet-stream'),
    ]);

    await withGoogle(google =>
      experimental_startBatch({
        provider: google,
        requests: [
          {
            id: 'request-1',
            type: 'text',
            model: 'gemini-2.0-flash',
            messages,
          },
        ],
      }),
    );
  });

  it('does not forward a Files API image URL through the interactions model', async () => {
    const messages = await modelMessagesFromUi([
      userFileMessage(VICTIM_FILE_URL, 'image/png'),
    ]);

    await withGoogle(google =>
      generateText({
        model: google.interactions('gemini-2.5-flash'),
        messages,
        maxRetries: 0,
      }),
    );
  });

  it('does not forward a Files API PDF URL through the interactions model', async () => {
    const messages = await modelMessagesFromUi([
      userFileMessage(VICTIM_FILE_URL, 'application/pdf'),
    ]);

    await withGoogle(async google => {
      const result = streamText({
        model: google.interactions('gemini-2.5-flash'),
        messages,
        maxRetries: 0,
      });
      await result.text;
    });
  });

  it('does not forward a file URL on a configured base URL files path', async () => {
    const messages = await modelMessagesFromUi([
      userFileMessage(CUSTOM_VICTIM_FILE_URL, 'application/octet-stream'),
    ]);

    await withGoogle(
      google =>
        generateText({
          model: google.chat('gemini-2.0-flash'),
          messages,
          maxRetries: 0,
        }),
      {
        baseURL: CUSTOM_BASE_URL,
        markers: [VICTIM_FILE_ID, `${CUSTOM_BASE_URL}/files/`],
      },
    );
  });

  it('does not forward the default Files API host when the provider base URL is custom', async () => {
    const messages = await modelMessagesFromUi([
      userFileMessage(VICTIM_FILE_URL, 'application/octet-stream'),
    ]);

    await withGoogle(
      google =>
        generateText({
          model: google.chat('gemini-2.0-flash'),
          messages,
          maxRetries: 0,
        }),
      { baseURL: CUSTOM_BASE_URL },
    );
  });

  it('does not forward a Files API URL through the agent UI stream', async () => {
    const uiMessages = [
      userFileMessage(VICTIM_FILE_URL, 'application/octet-stream'),
    ];

    await withGoogle(async google => {
      const agent = new ToolLoopAgent({
        model: google.chat('gemini-2.5-flash'),
        tools: {},
        maxRetries: 0,
      });
      const stream = await createAgentUIStream({
        agent,
        uiMessages,
      });
      for await (const _chunk of stream) {
        // Drain the stream so the provider request is issued.
      }
    });
  });
});
