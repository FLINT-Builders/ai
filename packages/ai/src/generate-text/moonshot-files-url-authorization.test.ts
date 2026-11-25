import { createMoonshotAI } from '../../../moonshotai/src/moonshotai-provider';
import type { ModelMessage } from '@ai-sdk/provider-utils';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { generateObject } from '../generate-object/generate-object';
import { streamObject } from '../generate-object/stream-object';
import { convertToModelMessages } from '../ui/convert-to-model-messages';
import { generateText } from './generate-text';
import { streamText } from './stream-text';

/**
 * Placeholder for the application's Moonshot credential. The value is not a
 * real key; tests only check that this configured credential is attached to
 * a request that names a caller-supplied Files API id.
 */
const applicationApiKey = 'test-api-key';

const chatCompletion = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 1_785_880_000,
  model: 'kimi-k3',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: '{"value":"ok"}' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const chatStream = [
  'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"{\\"value\\":\\"ok\\"}"},"finish_reason":null}]}',
  '',
  'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '',
  'data: [DONE]',
  '',
].join('\n');

type RecordedRequest = {
  url: string;
  authorizedWithApplicationKey: boolean;
  body: string;
};

/**
 * `ms://` file ids are resolved by Moonshot under the bearer token on the
 * chat request. A caller-supplied id must not be named by any request that
 * carries the application credential, including when the URL string observed
 * at the native-URL check differs from the string copied into the body.
 */
function filesUrl(fileId: string): URL {
  return new URL(`ms://${fileId}`);
}

function rereadFilesUrl(firstFileId: string, laterFileId: string): URL {
  const url = new URL(`ms://${firstFileId}`);
  let reads = 0;
  const read = () => {
    reads += 1;
    return `ms://${reads === 1 ? firstFileId : laterFileId}`;
  };
  Object.defineProperty(url, 'href', {
    configurable: true,
    get: read,
  });
  url.toString = () => url.href;
  return url;
}

function createRecordingModel() {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const headers = new Headers(init?.headers);
    const body =
      typeof init?.body === 'string'
        ? init.body
        : init?.body instanceof Uint8Array
          ? new TextDecoder().decode(init.body)
          : '';
    requests.push({
      url,
      authorizedWithApplicationKey:
        headers.get('authorization') === `Bearer ${applicationApiKey}`,
      body,
    });

    if (body.includes('"stream":true')) {
      return new Response(chatStream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }

    return new Response(JSON.stringify(chatCompletion), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const provider = createMoonshotAI({
    apiKey: applicationApiKey,
    fetch: fetchImpl,
  });

  return {
    model: provider.chatModel('kimi-k3'),
    requests,
  };
}

function credentialedFileReferences(
  requests: RecordedRequest[],
  fileIds: readonly string[],
): Array<{ url: string; mediaUrls: string[] }> {
  return requests
    .filter(request => request.authorizedWithApplicationKey)
    .filter(request => {
      const haystack = `${request.url}\n${request.body}`.toLowerCase();
      return fileIds.some(fileId => haystack.includes(fileId.toLowerCase()));
    })
    .map(request => ({
      url: request.url,
      mediaUrls: mediaUrls(request.body),
    }));
}

function mediaUrls(body: string): string[] {
  try {
    const found: string[] = [];
    const visit = (value: unknown) => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (value == null || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      for (const key of ['image_url', 'video_url'] as const) {
        const media = record[key];
        if (
          media != null &&
          typeof media === 'object' &&
          'url' in media &&
          typeof media.url === 'string'
        ) {
          found.push(media.url);
        }
      }
      for (const nested of Object.values(record)) visit(nested);
    };
    visit(JSON.parse(body));
    return found;
  } catch {
    return [];
  }
}

async function expectCallerFileStaysOffCredentialedRequests({
  fileIds,
  messages,
  operation,
}: {
  fileIds: readonly string[];
  messages: ModelMessage[];
  operation: 'generateText' | 'streamText' | 'generateObject' | 'streamObject';
}) {
  const { model, requests } = createRecordingModel();
  const schema = z.object({ value: z.string() });

  try {
    switch (operation) {
      case 'generateText': {
        await generateText({ model, messages, maxRetries: 0 });
        break;
      }
      case 'streamText': {
        const result = streamText({ model, messages, maxRetries: 0 });
        await result.consumeStream();
        await result.text.catch(() => undefined);
        break;
      }
      case 'generateObject': {
        await generateObject({ model, messages, schema, maxRetries: 0 });
        break;
      }
      case 'streamObject': {
        const result = streamObject({
          model,
          messages,
          schema,
          maxRetries: 0,
        });
        const reader = result.partialObjectStream.getReader();
        try {
          while (!(await reader.read()).done) {
            // Drain so the chat request is actually sent.
          }
        } finally {
          reader.releaseLock();
        }
        await result.object.catch(() => undefined);
        break;
      }
    }
  } catch {
    // Refusing the prompt before the provider call satisfies the spec.
  }

  expect(credentialedFileReferences(requests, fileIds)).toEqual([]);
}

describe('caller-supplied Moonshot Files API URLs', () => {
  it('does not attach an image URL object to the application credential from generateText', async () => {
    const fileId = 'file-victim-image-url';
    await expectCallerFileStaysOffCredentialedRequests({
      operation: 'generateText',
      fileIds: [fileId],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image' },
            {
              type: 'image',
              image: filesUrl(fileId),
              mediaType: 'image/png',
            },
          ],
        },
      ],
    });
  });

  it('does not attach an image URL string to the application credential from generateText', async () => {
    const fileId = 'file-victim-image-string';
    await expectCallerFileStaysOffCredentialedRequests({
      operation: 'generateText',
      fileIds: [fileId],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              image: `ms://${fileId}`,
              mediaType: 'image/jpeg',
            },
          ],
        },
      ],
    });
  });

  it('does not attach a tagged image file URL to the application credential from generateText', async () => {
    const fileId = 'file-victim-image-png';
    await expectCallerFileStaysOffCredentialedRequests({
      operation: 'generateText',
      fileIds: [fileId],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'file',
              mediaType: 'image/png',
              data: { type: 'url', url: filesUrl(fileId) },
            },
          ],
        },
      ],
    });
  });

  it('does not attach a string file URL that parses as ms to the application credential', async () => {
    const fileId = 'file-victim-image-data-string';
    await expectCallerFileStaysOffCredentialedRequests({
      operation: 'generateText',
      fileIds: [fileId],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'file',
              mediaType: 'image/webp',
              data: `ms://${fileId}`,
            },
          ],
        },
      ],
    });
  });

  it('does not attach a video file URL to the application credential from generateText', async () => {
    const fileId = 'file-victim-video-mp4';
    await expectCallerFileStaysOffCredentialedRequests({
      operation: 'generateText',
      fileIds: [fileId],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'file',
              mediaType: 'video/mp4',
              data: filesUrl(fileId),
            },
          ],
        },
      ],
    });
  });

  it.each(['image', 'image/*'] as const)(
    'does not attach an image URL with media type %s',
    async mediaType => {
      const fileId = `file-victim-${mediaType.replace('/', '-')}`;
      await expectCallerFileStaysOffCredentialedRequests({
        operation: 'generateText',
        fileIds: [fileId],
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'file',
                mediaType,
                data: filesUrl(fileId),
              },
            ],
          },
        ],
      });
    },
  );

  it.each(['video', 'video/*'] as const)(
    'does not attach a video URL with media type %s',
    async mediaType => {
      const fileId = `file-victim-${mediaType.replace('/', '-')}`;
      await expectCallerFileStaysOffCredentialedRequests({
        operation: 'generateText',
        fileIds: [fileId],
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'file',
                mediaType,
                data: filesUrl(fileId),
              },
            ],
          },
        ],
      });
    },
  );

  it('does not attach a case-variant Files API URL', async () => {
    const fileId = 'File-Victim-Case';
    await expectCallerFileStaysOffCredentialedRequests({
      operation: 'generateText',
      fileIds: [fileId],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'file',
              mediaType: 'image/png',
              data: new URL(`MS://${fileId}`),
            },
          ],
        },
      ],
    });
  });

  it('does not attach a path-form Files API URL', async () => {
    const fileId = 'file-victim-path';
    await expectCallerFileStaysOffCredentialedRequests({
      operation: 'generateText',
      fileIds: [fileId],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'file',
              mediaType: 'video/webm',
              data: new URL(`ms://files/${fileId}`),
            },
          ],
        },
      ],
    });
  });

  it('does not send a file id read again after the native URL check', async () => {
    const checkedFileId = 'file-victim-checked';
    const usedFileId = 'file-victim-reread';
    await expectCallerFileStaysOffCredentialedRequests({
      operation: 'generateText',
      fileIds: [checkedFileId, usedFileId],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              image: rereadFilesUrl(checkedFileId, usedFileId),
              mediaType: 'image/png',
            },
          ],
        },
      ],
    });
  });

  it('does not attach an image URL from streamText', async () => {
    const fileId = 'file-victim-stream-image';
    await expectCallerFileStaysOffCredentialedRequests({
      operation: 'streamText',
      fileIds: [fileId],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              image: filesUrl(fileId),
              mediaType: 'image/gif',
            },
          ],
        },
      ],
    });
  });

  it('does not attach a video URL from streamText', async () => {
    const fileId = 'file-victim-stream-video';
    await expectCallerFileStaysOffCredentialedRequests({
      operation: 'streamText',
      fileIds: [fileId],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'file',
              mediaType: 'video/mp4',
              data: { type: 'url', url: filesUrl(fileId) },
            },
          ],
        },
      ],
    });
  });

  it('does not attach an image URL from generateObject', async () => {
    const fileId = 'file-victim-object-image';
    await expectCallerFileStaysOffCredentialedRequests({
      operation: 'generateObject',
      fileIds: [fileId],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Return JSON describing the image' },
            {
              type: 'file',
              mediaType: 'image/png',
              data: filesUrl(fileId),
            },
          ],
        },
      ],
    });
  });

  it('does not attach a video URL from streamObject', async () => {
    const fileId = 'file-victim-stream-object-video';
    await expectCallerFileStaysOffCredentialedRequests({
      operation: 'streamObject',
      fileIds: [fileId],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'file',
              mediaType: 'video/mpeg',
              data: filesUrl(fileId),
            },
          ],
        },
      ],
    });
  });

  it('does not attach a UI file URL forwarded through convertToModelMessages', async () => {
    const imageId = 'file-victim-ui-image';
    const videoId = 'file-victim-ui-video';
    const messages = await convertToModelMessages([
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'Describe these files' },
          {
            type: 'file',
            mediaType: 'image/png',
            url: `ms://${imageId}`,
          },
          {
            type: 'file',
            mediaType: 'video/mp4',
            url: `ms://${videoId}`,
          },
        ],
      },
    ]);

    await expectCallerFileStaysOffCredentialedRequests({
      operation: 'generateText',
      fileIds: [imageId, videoId],
      messages,
    });
  });

  it('does not attach a UI file URL from streamText after convertToModelMessages', async () => {
    const fileId = 'file-victim-ui-stream';
    const messages = await convertToModelMessages([
      {
        role: 'user',
        parts: [
          {
            type: 'file',
            mediaType: 'image/heic',
            url: `ms://${fileId}`,
          },
        ],
      },
    ]);

    await expectCallerFileStaysOffCredentialedRequests({
      operation: 'streamText',
      fileIds: [fileId],
      messages,
    });
  });
});
