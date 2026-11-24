import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { tool, type FetchFunction } from '@ai-sdk/provider-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { generateObject } from '../generate-object/generate-object';
import { streamObject } from '../generate-object/stream-object';
import type { ModelMessage } from '../prompt';
import { convertToModelMessages } from '../ui/convert-to-model-messages';
import { validateUIMessages } from '../ui/validate-ui-messages';
import type { UIMessage } from '../ui/ui-messages';
import { generateText } from './generate-text';
import { streamText } from './stream-text';

const VICTIM_BUCKET = 'victim-bucket';
const NOVA_MODEL_ID = 'us.amazon.nova-pro-v1:0';
const CLAUDE_MODEL_ID = 'anthropic.claude-3-haiku-20240307-v1:0';
const PLACEHOLDER_API_KEY = 'placeholder-not-a-real-key';

const downloadAttempts: string[] = [];
const providerRequests: Array<{ url: string; body: string }> = [];
let originalFetch: typeof globalThis.fetch;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function bodyText(body: BodyInit | null | undefined): string {
  return typeof body === 'string' ? body : '';
}

const recordingProviderFetch: FetchFunction = async (input, init) => {
  const url = requestUrl(input);
  const body = bodyText(init?.body);
  providerRequests.push({ url, body });

  if (url.toLowerCase().startsWith('s3:')) {
    throw new Error('provider fetch was called with an s3 url');
  }

  if (url.includes('/converse-stream')) {
    return new Response('not-an-event-stream', {
      status: 200,
      headers: { 'content-type': 'application/vnd.amazon.eventstream' },
    });
  }

  return new Response(
    JSON.stringify({
      output: {
        message: {
          role: 'assistant',
          content: [{ text: '{"description":"ok"}' }],
        },
      },
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
};

function forwardedS3References(): string[] {
  const found: string[] = [];

  for (const url of downloadAttempts) {
    if (url.toLowerCase().startsWith('s3:')) {
      found.push(url);
    }
  }

  for (const request of providerRequests) {
    if (request.url.toLowerCase().startsWith('s3:')) {
      found.push(request.url);
    }

    const body = request.body.toLowerCase();
    if (body.includes('s3:') || body.includes(VICTIM_BUCKET)) {
      found.push(request.body);
    }
  }

  return found;
}

async function clientMessages(
  parts: UIMessage['parts'],
  extra: UIMessage[] = [],
): Promise<ModelMessage[]> {
  const messages = await validateUIMessages({
    messages: [
      ...extra,
      {
        id: 'attacker-message',
        role: 'user',
        parts,
      },
    ],
  });

  return convertToModelMessages(messages);
}

const attachmentTool = {
  attachment: tool({
    description: 'Reads an attachment.',
    inputSchema: z.object({}),
  }),
};

function bedrock(modelId: typeof NOVA_MODEL_ID | typeof CLAUDE_MODEL_ID) {
  return createAmazonBedrock({
    apiKey: PLACEHOLDER_API_KEY,
    baseURL: 'https://bedrock-runtime.test.example',
    fetch: recordingProviderFetch,
  })(modelId);
}

async function run(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch {
    // A refusal, or a mock response the stream decoder cannot parse, is
    // acceptable. Forwarding the attacker URL is not.
  }
}

beforeEach(() => {
  downloadAttempts.length = 0;
  providerRequests.length = 0;
  originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = requestUrl(input);
    downloadAttempts.push(url);
    throw new Error('download attempted');
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('client-supplied Bedrock s3 file URLs', () => {
  it('does not let a chat user message send an s3 image to Nova through generateText', async () => {
    const messages = await clientMessages([
      { type: 'text', text: 'Describe this image exactly.' },
      {
        type: 'file',
        mediaType: 'image/png',
        url: `s3://${VICTIM_BUCKET}/private/scan.png`,
      },
    ]);

    await run(() =>
      generateText({
        model: bedrock(NOVA_MODEL_ID),
        messages,
        maxRetries: 0,
      }),
    );

    expect(forwardedS3References()).toEqual([]);
  });

  it('uses the normalized s3 object, so a dot-segment path still must not be forwarded', async () => {
    const supplied = `s3://${VICTIM_BUCKET}/public/../private/normalized.png`;
    const messages = await clientMessages([
      { type: 'text', text: 'Describe this image exactly.' },
      { type: 'file', mediaType: 'image/jpeg', url: supplied },
    ]);

    await run(() =>
      generateText({
        model: bedrock(NOVA_MODEL_ID),
        messages,
        maxRetries: 0,
      }),
    );

    expect(forwardedS3References()).toEqual([]);
    expect(new URL(supplied).href).toBe(
      `s3://${VICTIM_BUCKET}/private/normalized.png`,
    );
  });

  it('does not forward a mixed-case s3 image URL on a non-Nova Bedrock chat model', async () => {
    const messages = await clientMessages([
      { type: 'text', text: 'Describe this image exactly.' },
      {
        type: 'file',
        mediaType: 'image/gif',
        url: `S3://Victim-Bucket/private/Scan.gif`,
      },
    ]);

    await run(() =>
      generateText({
        model: bedrock(CLAUDE_MODEL_ID),
        messages,
        maxRetries: 0,
      }),
    );

    expect(forwardedS3References()).toEqual([]);
  });

  it('does not let a chat user message send an s3 video to Nova through streamText', async () => {
    const messages = await clientMessages(
      [
        { type: 'text', text: 'Transcribe this recording.' },
        {
          type: 'file',
          mediaType: 'video/mp4',
          url: `s3://${VICTIM_BUCKET}/private/clip.mp4`,
        },
      ],
      [
        {
          id: 'assistant-history',
          role: 'assistant',
          parts: [
            { type: 'text', text: 'Previous turn.' },
            {
              type: 'file',
              mediaType: 'video/webm',
              url: `s3://${VICTIM_BUCKET}/private/history.webm`,
            },
          ],
        },
      ],
    );

    await run(async () => {
      const result = streamText({
        model: bedrock(NOVA_MODEL_ID),
        messages,
        maxRetries: 0,
      });
      await result.consumeStream();
    });

    expect(forwardedS3References()).toEqual([]);
  });

  it('does not forward an s3 image with userinfo through generateObject', async () => {
    const messages = await clientMessages([
      { type: 'text', text: 'Describe this image exactly.' },
      {
        type: 'file',
        mediaType: 'image/webp',
        url: `s3://user@${VICTIM_BUCKET}/private/scan.webp`,
      },
    ]);

    await run(() =>
      generateObject({
        model: bedrock(NOVA_MODEL_ID),
        schema: z.object({ description: z.string() }),
        messages,
        maxRetries: 0,
      }),
    );

    expect(forwardedS3References()).toEqual([]);
  });

  it('does not forward an s3 video through streamObject', async () => {
    const messages = await clientMessages([
      { type: 'text', text: 'Transcribe this recording.' },
      {
        type: 'file',
        mediaType: 'video/quicktime',
        url: `s3://${VICTIM_BUCKET}/private/clip.mov`,
      },
    ]);

    await run(async () => {
      const result = streamObject({
        model: bedrock(NOVA_MODEL_ID),
        schema: z.object({ description: z.string() }),
        messages,
        maxRetries: 0,
      });
      await result.object;
    });

    expect(forwardedS3References()).toEqual([]);
  });

  it('does not forward an s3 image supplied as a legacy image part', async () => {
    await run(() =>
      generateText({
        model: bedrock(NOVA_MODEL_ID),
        maxRetries: 0,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this image exactly.' },
              {
                type: 'image',
                image: new URL(`s3://${VICTIM_BUCKET}/private/legacy.png`),
                mediaType: 'image/png',
              },
            ],
          },
        ],
      }),
    );

    expect(forwardedS3References()).toEqual([]);
  });

  it('does not forward an s3 file inside a tool result', async () => {
    await run(() =>
      generateText({
        model: bedrock(NOVA_MODEL_ID),
        tools: attachmentTool,
        maxRetries: 0,
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName: 'attachment',
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
                toolName: 'attachment',
                output: {
                  type: 'content',
                  value: [
                    {
                      type: 'file',
                      mediaType: 'image/png',
                      data: {
                        type: 'url',
                        url: new URL(
                          `s3://${VICTIM_BUCKET}/private/from-tool.png`,
                        ),
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );

    expect(forwardedS3References()).toEqual([]);
  });

  it('does not forward a deprecated tool-result file-url that skips the download check', async () => {
    await run(() =>
      generateText({
        model: bedrock(NOVA_MODEL_ID),
        tools: attachmentTool,
        maxRetries: 0,
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'call-2',
                toolName: 'attachment',
                input: {},
              },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'call-2',
                toolName: 'attachment',
                output: {
                  type: 'content',
                  value: [
                    {
                      type: 'file-url',
                      url: `s3://${VICTIM_BUCKET}/private/from-file-url.mp4`,
                      mediaType: 'video/mp4',
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );

    expect(forwardedS3References()).toEqual([]);
  });

  it('does not forward a client document or audio s3 URL', async () => {
    for (const mediaType of ['application/pdf', 'audio/mpeg']) {
      providerRequests.length = 0;
      downloadAttempts.length = 0;
      const messages = await clientMessages([
        { type: 'text', text: 'Read this file.' },
        {
          type: 'file',
          mediaType,
          url: `s3://${VICTIM_BUCKET}/private/notes`,
        },
      ]);

      await run(() =>
        generateText({
          model: bedrock(NOVA_MODEL_ID),
          messages,
          maxRetries: 0,
        }),
      );

      expect(forwardedS3References()).toEqual([]);
    }
  });

  it.each([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'video/mp4',
    'video/quicktime',
    'video/webm',
    'video/x-matroska',
    'video/mpeg',
    'video/mpg',
    'video/wmv',
    'video/x-ms-wmv',
    'video/x-flv',
    'video/3gpp',
  ])('does not forward a client %s file URL', async mediaType => {
    const messages = await clientMessages([
      { type: 'text', text: 'Describe this file exactly.' },
      {
        type: 'file',
        mediaType,
        url: `s3://${VICTIM_BUCKET}/private/object`,
      },
    ]);

    await run(() =>
      generateText({
        model: bedrock(NOVA_MODEL_ID),
        messages,
        maxRetries: 0,
      }),
    );

    expect(forwardedS3References()).toEqual([]);
  });
});
