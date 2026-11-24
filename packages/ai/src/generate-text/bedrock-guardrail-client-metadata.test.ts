import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import {
  convertBase64ToUint8Array,
  convertToBase64,
} from '@ai-sdk/provider-utils';
import { EventStreamCodec } from '@smithy/eventstream-codec';
import { fromUtf8, toUtf8 } from '@smithy/util-utf8';
import { describe, expect, it } from 'vitest';
import { convertToModelMessages } from '../ui/convert-to-model-messages';
import { validateUIMessages } from '../ui/validate-ui-messages';
import type { UIMessage } from '../ui/ui-messages';
import { generateText } from './generate-text';
import { streamText } from './stream-text';

/**
 * Spec for the Bedrock guardrail bypass where a chat client sets
 * providerMetadata.bedrock.guardContent (or amazonBedrock.guardContent) on
 * one part. These tests fail while that client flag can put the Converse
 * body into selective guardrail scope.
 */

const DECOY_TEXT = 'harmless-decoy';
const ATTACK_TEXT = 'policy-sensitive-user-text';
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const PNG_BYTES = convertBase64ToUint8Array(PNG_BASE64);
const DOCUMENT_BYTES = convertToBase64(ATTACK_TEXT);

const GUARDRAIL_CONFIG = {
  guardrailIdentifier: 'guardrail-id',
  guardrailVersion: '1',
  trace: 'enabled',
};

const codec = new EventStreamCodec(toUtf8, fromUtf8);

type MediaSource = {
  bytes?: string;
  s3Location?: { uri?: string };
};

type MediaBlock = { source?: MediaSource };

type ContentBlock = {
  text?: string;
  guardContent?: {
    text?: { text?: string };
    image?: MediaBlock;
    document?: MediaBlock;
    video?: MediaBlock;
  };
  image?: MediaBlock;
  document?: MediaBlock;
  video?: MediaBlock;
};

type ConverseBody = {
  guardrailConfig?: {
    guardrailIdentifier?: string;
    guardrailVersion?: string;
    trace?: string;
  };
  messages?: Array<{ role?: string; content?: ContentBlock[] }>;
};

type Operation = 'generate' | 'stream';

function createEvent(eventType: string, data: unknown): Uint8Array {
  return codec.encode({
    headers: {
      ':message-type': { type: 'string', value: 'event' },
      ':event-type': { type: 'string', value: eventType },
    },
    body: fromUtf8(JSON.stringify(data)),
  });
}

function concatenate(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function streamResponseBody(): Uint8Array<ArrayBuffer> {
  return concatenate([
    createEvent('messageStart', { role: 'assistant' }),
    createEvent('contentBlockDelta', {
      contentBlockIndex: 0,
      delta: { text: 'ok' },
    }),
    createEvent('contentBlockStop', { contentBlockIndex: 0 }),
    createEvent('messageStop', { stopReason: 'end_turn' }),
    createEvent('metadata', {
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }),
  ]);
}

function createRecordingModel() {
  const requests: Array<{ url: string; body: ConverseBody }> = [];
  const model = createAmazonBedrock({
    apiKey: 'test-api-key',
    region: 'us-east-1',
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (typeof init?.body !== 'string') {
        throw new Error('Bedrock request body was not a JSON string');
      }
      requests.push({ url, body: JSON.parse(init.body) as ConverseBody });

      if (url.endsWith('/converse-stream')) {
        return new Response(streamResponseBody(), {
          status: 200,
          headers: { 'content-type': 'application/vnd.amazon.eventstream' },
        });
      }

      return new Response(
        JSON.stringify({
          output: {
            message: { role: 'assistant', content: [{ text: 'ok' }] },
          },
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    },
  })('anthropic.claude-3-haiku-20240307-v1:0');

  return { model, requests };
}

function textPart(
  text: string,
  provider: 'bedrock' | 'amazonBedrock' | undefined,
  options?: {
    qualifiers?: Array<'grounding_source' | 'query' | 'guard_content'>;
  },
) {
  if (provider == null) {
    return { type: 'text', text };
  }

  return {
    type: 'text',
    text,
    providerMetadata: {
      [provider]: {
        guardContent: true,
        ...(options?.qualifiers != null
          ? { guardContentQualifiers: options.qualifiers }
          : {}),
      },
    },
  };
}

function filePart({
  mediaType,
  url,
  provider,
}: {
  mediaType: string;
  url: string;
  provider?: 'bedrock' | 'amazonBedrock';
}) {
  return {
    type: 'file',
    mediaType,
    url,
    ...(provider != null
      ? { providerMetadata: { [provider]: { guardContent: true } } }
      : {}),
  };
}

function userMessage(id: string, parts: unknown[]) {
  return { id, role: 'user', parts };
}

async function toModelMessages(raw: unknown, validate: boolean) {
  const uiMessages = validate
    ? await validateUIMessages({ messages: raw })
    : (raw as UIMessage[]);
  return convertToModelMessages(uiMessages);
}

function collectScope(body: ConverseBody) {
  const guardedText = new Set<string>();
  const unguardedText = new Set<string>();
  const guardedBytes = new Set<string>();
  const unguardedBytes = new Set<string>();
  let selective = false;

  const recordSource = (block: MediaBlock | undefined, guarded: boolean) => {
    const bytes = block?.source?.bytes;
    const uri = block?.source?.s3Location?.uri;
    const value =
      typeof bytes === 'string'
        ? bytes
        : typeof uri === 'string'
          ? uri
          : undefined;
    if (value == null) {
      return;
    }
    (guarded ? guardedBytes : unguardedBytes).add(value);
  };

  for (const message of body.messages ?? []) {
    for (const block of message.content ?? []) {
      if (block.guardContent != null) {
        selective = true;
        const text = block.guardContent.text?.text;
        if (typeof text === 'string') {
          guardedText.add(text);
        }
        recordSource(block.guardContent.image, true);
        recordSource(block.guardContent.document, true);
        recordSource(block.guardContent.video, true);
      }
      if (typeof block.text === 'string') {
        unguardedText.add(block.text);
      }
      recordSource(block.image, false);
      recordSource(block.document, false);
      recordSource(block.video, false);
    }
  }

  return {
    selective,
    guardedText,
    unguardedText,
    guardedBytes,
    unguardedBytes,
  };
}

function expectClientContentInGuardrailScope(
  body: ConverseBody,
  payload: { texts: string[]; bytes?: string[] },
) {
  expect(body.guardrailConfig).toMatchObject(GUARDRAIL_CONFIG);

  const scope = collectScope(body);

  for (const text of payload.texts) {
    const guarded = scope.guardedText.has(text);
    const unguarded = scope.unguardedText.has(text);
    expect(
      guarded || unguarded,
      `user text ${JSON.stringify(text)} was dropped from the Converse messages`,
    ).toBe(true);
    if (scope.selective) {
      expect(
        guarded,
        `user text ${JSON.stringify(text)} is outside guardContent while another block opted the request into selective guardrail scope`,
      ).toBe(true);
    }
  }

  for (const bytes of payload.bytes ?? []) {
    const guarded = scope.guardedBytes.has(bytes);
    const unguarded = scope.unguardedBytes.has(bytes);
    expect(
      guarded || unguarded,
      'user file bytes were dropped from the Converse messages',
    ).toBe(true);
    if (scope.selective) {
      expect(
        guarded,
        'user file bytes are outside guardContent while another block opted the request into selective guardrail scope',
      ).toBe(true);
    }
  }
}

async function runConversation({
  operation,
  rawMessages,
  validate,
  guardrailKey = 'bedrock',
  download,
}: {
  operation: Operation;
  rawMessages: unknown;
  validate: boolean;
  guardrailKey?: 'bedrock' | 'amazonBedrock';
  download?: (
    requests: Array<{ url: URL; isUrlSupportedByModel: boolean }>,
  ) => Promise<
    Array<{ data: Uint8Array; mediaType: string | undefined } | null>
  >;
}) {
  const messages = await toModelMessages(rawMessages, validate);
  const { model, requests } = createRecordingModel();
  const providerOptions = {
    [guardrailKey]: { guardrailConfig: GUARDRAIL_CONFIG },
  };

  if (operation === 'generate') {
    await generateText({
      model,
      messages,
      providerOptions,
      experimental_download: download,
    });
  } else {
    const result = streamText({
      model,
      messages,
      providerOptions,
      experimental_download: download,
    });
    await result.text;
  }

  expect(requests).toHaveLength(1);
  const request = requests[0];
  expect(request.url).toContain(
    operation === 'generate' ? '/converse' : '/converse-stream',
  );
  if (operation === 'generate') {
    expect(request.url.endsWith('/converse-stream')).toBe(false);
  }
  return request.body;
}

const operations: Operation[] = ['generate', 'stream'];

describe('client providerMetadata cannot narrow Bedrock guardrail scope', () => {
  it.each(operations)(
    '%s keeps an ordinary user message in the default guardrail scope',
    async operation => {
      const body = await runConversation({
        operation,
        validate: true,
        rawMessages: [
          userMessage('user-1', [textPart(ATTACK_TEXT, undefined)]),
        ],
      });

      expectClientContentInGuardrailScope(body, { texts: [ATTACK_TEXT] });
      expect(JSON.stringify(body.messages)).not.toContain('guardContent');
    },
  );

  it.each(operations)(
    '%s does not let a validated client text part mark itself as the only guarded content',
    async operation => {
      const body = await runConversation({
        operation,
        validate: true,
        rawMessages: [
          userMessage('user-1', [
            textPart(DECOY_TEXT, 'bedrock'),
            textPart(ATTACK_TEXT, undefined),
          ]),
        ],
      });

      expectClientContentInGuardrailScope(body, {
        texts: [DECOY_TEXT, ATTACK_TEXT],
      });
    },
  );

  it.each(operations)(
    '%s does not let an unvalidated client text part mark itself as the only guarded content',
    async operation => {
      const body = await runConversation({
        operation,
        validate: false,
        rawMessages: [
          userMessage('user-1', [
            textPart(DECOY_TEXT, 'bedrock'),
            textPart(ATTACK_TEXT, undefined),
          ]),
        ],
      });

      expectClientContentInGuardrailScope(body, {
        texts: [DECOY_TEXT, ATTACK_TEXT],
      });
    },
  );

  it.each(operations)(
    '%s does not let the amazonBedrock providerMetadata key narrow guardrail scope',
    async operation => {
      const body = await runConversation({
        operation,
        validate: true,
        guardrailKey: 'amazonBedrock',
        rawMessages: [
          userMessage('user-1', [
            textPart(DECOY_TEXT, 'amazonBedrock'),
            textPart(ATTACK_TEXT, undefined),
          ]),
        ],
      });

      expectClientContentInGuardrailScope(body, {
        texts: [DECOY_TEXT, ATTACK_TEXT],
      });
    },
  );

  it.each(operations)(
    '%s does not let client guardContentQualifiers select the guarded text',
    async operation => {
      const body = await runConversation({
        operation,
        validate: true,
        rawMessages: [
          userMessage('user-1', [
            textPart(DECOY_TEXT, 'bedrock', { qualifiers: ['query'] }),
            textPart(ATTACK_TEXT, undefined),
          ]),
        ],
      });

      expectClientContentInGuardrailScope(body, {
        texts: [DECOY_TEXT, ATTACK_TEXT],
      });
    },
  );

  it.each(operations)(
    '%s does not let an earlier client message put a later user message outside guardrail scope',
    async operation => {
      const body = await runConversation({
        operation,
        validate: true,
        rawMessages: [
          userMessage('user-1', [textPart(DECOY_TEXT, 'bedrock')]),
          {
            id: 'assistant-1',
            role: 'assistant',
            parts: [{ type: 'text', text: 'Noted.' }],
          },
          userMessage('user-2', [textPart(ATTACK_TEXT, undefined)]),
        ],
      });

      expectClientContentInGuardrailScope(body, {
        texts: [DECOY_TEXT, ATTACK_TEXT],
      });
    },
  );

  it.each(operations)(
    '%s does not let a client image part be the only guarded content',
    async operation => {
      const body = await runConversation({
        operation,
        validate: true,
        rawMessages: [
          userMessage('user-1', [
            filePart({
              mediaType: 'image/png',
              url: `data:image/png;base64,${PNG_BASE64}`,
              provider: 'bedrock',
            }),
            textPart(ATTACK_TEXT, undefined),
          ]),
        ],
      });

      expectClientContentInGuardrailScope(body, {
        texts: [ATTACK_TEXT],
        bytes: [PNG_BASE64],
      });
    },
  );

  it.each(operations)(
    '%s does not let a downloaded client image part be the only guarded content',
    async operation => {
      const downloaded = convertToBase64(PNG_BYTES);
      const body = await runConversation({
        operation,
        validate: true,
        download: async requests => {
          expect(requests).toHaveLength(1);
          expect(requests[0].url.protocol).toBe('https:');
          expect(requests[0].isUrlSupportedByModel).toBe(false);
          return [{ data: PNG_BYTES, mediaType: 'image/png' }];
        },
        rawMessages: [
          userMessage('user-1', [
            filePart({
              mediaType: 'image/png',
              url: 'https://example.com/decoy.png',
              provider: 'amazonBedrock',
            }),
            textPart(ATTACK_TEXT, undefined),
          ]),
        ],
      });

      expectClientContentInGuardrailScope(body, {
        texts: [ATTACK_TEXT],
        bytes: [downloaded],
      });
    },
  );

  it.each(operations)(
    '%s does not let a client text flag hide an image from the guardrail',
    async operation => {
      const body = await runConversation({
        operation,
        validate: true,
        rawMessages: [
          userMessage('user-1', [
            textPart(DECOY_TEXT, 'bedrock'),
            filePart({
              mediaType: 'image/png',
              url: `data:image/png;base64,${PNG_BASE64}`,
            }),
          ]),
        ],
      });

      expectClientContentInGuardrailScope(body, {
        texts: [DECOY_TEXT],
        bytes: [PNG_BASE64],
      });
    },
  );

  it.each(operations)(
    '%s does not let a client text flag hide a document from the guardrail',
    async operation => {
      const body = await runConversation({
        operation,
        validate: true,
        rawMessages: [
          userMessage('user-1', [
            textPart(DECOY_TEXT, 'amazonBedrock', {
              qualifiers: ['grounding_source'],
            }),
            filePart({
              mediaType: 'text/plain',
              url: `data:text/plain;base64,${DOCUMENT_BYTES}`,
            }),
          ]),
        ],
      });

      expectClientContentInGuardrailScope(body, {
        texts: [DECOY_TEXT],
        bytes: [DOCUMENT_BYTES],
      });
    },
  );

  it.each(operations)(
    '%s does not let a client text flag hide an S3 image from the guardrail',
    async operation => {
      const imageUri = 's3://bucket/attack.png';
      const body = await runConversation({
        operation,
        validate: true,
        rawMessages: [
          userMessage('user-1', [
            textPart(DECOY_TEXT, 'bedrock'),
            filePart({ mediaType: 'image/png', url: imageUri }),
          ]),
        ],
      });

      expectClientContentInGuardrailScope(body, {
        texts: [DECOY_TEXT],
        bytes: [imageUri],
      });
    },
  );

  it.each(operations)(
    '%s does not let a client text flag hide an S3 video from the guardrail',
    async operation => {
      const videoUri = 's3://bucket/attack.mp4';
      const body = await runConversation({
        operation,
        validate: true,
        rawMessages: [
          userMessage('user-1', [
            textPart(DECOY_TEXT, 'amazonBedrock'),
            filePart({ mediaType: 'video/mp4', url: videoUri }),
          ]),
        ],
      });

      expectClientContentInGuardrailScope(body, {
        texts: [DECOY_TEXT],
        bytes: [videoUri],
      });
    },
  );
});
