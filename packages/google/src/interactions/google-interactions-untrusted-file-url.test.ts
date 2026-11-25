import type { ModelMessage } from '@ai-sdk/provider-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convertToLanguageModelPrompt } from '../../../ai/src/prompt/convert-to-language-model-prompt';
import { standardizePrompt } from '../../../ai/src/prompt/standardize-prompt';
import { createGoogle } from '../google-provider';
import { GoogleInteractionsLanguageModel } from './google-interactions-language-model';

/**
 * Spec for untrusted file URLs on Gemini interactions.
 *
 * These tests fail while a prompt can put a Gemini Files API URL or a gs
 * video URL into an interactions request that carries the application's
 * credentials. They pass once those URLs are no longer sent with credentials
 * unless this process uploaded that exact file URI. YouTube URLs stay native.
 */

const placeholderApiKey = 'test-api-key';
const placeholderBearer = 'Bearer placeholder-token';

const ownedFileUrl =
  'https://generativelanguage.googleapis.com/v1beta/files/owned-file';
const otherUserImageUrl =
  'https://generativelanguage.googleapis.com/v1beta/files/other-user-image';
const otherUserPdfUrl =
  'https://generativelanguage.googleapis.com/v1beta/files/other-user-pdf';
const otherUserAudioUrl =
  'https://generativelanguage.googleapis.com/v1beta/files/other-user-audio';
const otherUserHttpUrl =
  'http://generativelanguage.googleapis.com/v1beta/files/other-user-http';
const otherUserCaseUrl =
  'https://generativelanguage.googleapis.com/v1beta/files/Other-User-Case';
const ownedFilePrefixUrl =
  'https://generativelanguage.googleapis.com/v1beta/files/owned-file-extra';
const ownedFileQueryUrl = `${ownedFileUrl}?alt=media`;
const otherUserReferenceUrl =
  'https://generativelanguage.googleapis.com/v1beta/files/other-user-reference';
const otherUserGsUrl = 'gs://other-user-bucket/private-video.mp4';
const youtubeWatchUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const youtubeShortUrl = 'https://youtu.be/dQw4w9WgXcQ';

const uploadStartUrl =
  'https://generativelanguage.googleapis.com/upload/v1beta/files';
const uploadSessionUrl = `${uploadStartUrl}?upload_id=owned-session`;

type RecordedRequest = {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
};

type InteractionsModel = {
  provider: string;
  supportedUrls: Record<string, RegExp[]> | Promise<Record<string, RegExp[]>>;
  doGenerate: (options: Record<string, unknown>) => Promise<unknown>;
  doStream: (options: Record<string, unknown>) => Promise<{
    stream: ReadableStream<unknown>;
  }>;
};

const requests: RecordedRequest[] = [];

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function bodyText(body: BodyInit | null | undefined): string | undefined {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return undefined;
}

function completedInteraction() {
  return {
    id: 'v1_test',
    status: 'completed',
    model: 'gemini-2.5-flash',
    steps: [
      {
        type: 'model_output',
        content: [{ type: 'text', text: 'ok' }],
      },
    ],
  };
}

function streamBody(): string {
  const events = [
    {
      event_type: 'interaction.created',
      interaction: {
        id: 'v1_test',
        status: 'in_progress',
        model: 'gemini-2.5-flash',
      },
    },
    {
      event_type: 'step.start',
      index: 0,
      step: { type: 'model_output' },
    },
    {
      event_type: 'step.delta',
      index: 0,
      delta: { type: 'text', text: 'ok' },
    },
    { event_type: 'step.stop', index: 0 },
    {
      event_type: 'interaction.completed',
      interaction: {
        id: 'v1_test',
        status: 'completed',
        model: 'gemini-2.5-flash',
      },
    },
  ];
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
}

function installFetch() {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const body = bodyText(init?.body);
    requests.push({
      url,
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      headers,
      body,
    });

    if (url === uploadStartUrl) {
      return new Response('{}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-goog-upload-url': uploadSessionUrl,
        },
      });
    }

    if (url === uploadSessionUrl) {
      return new Response(
        JSON.stringify({
          file: {
            name: 'files/owned-file',
            mimeType: 'image/png',
            uri: ownedFileUrl,
            state: 'ACTIVE',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    if (url.includes('/interactions')) {
      if (body?.includes('"stream":true')) {
        return new Response(streamBody(), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response(JSON.stringify(completedInteraction()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(Uint8Array.from([1, 2, 3, 4]), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
  };

  vi.stubGlobal('fetch', fetchImpl);
  return fetchImpl;
}

function credentialedTranscript(): string {
  return requests
    .filter(request => {
      const apiKey = request.headers.get('x-goog-api-key');
      const authorization = request.headers.get('authorization');
      return (
        (apiKey != null && apiKey.length > 0) ||
        (authorization != null && authorization.length > 0)
      );
    })
    .map(request => `${request.method} ${request.url}\n${request.body ?? ''}`)
    .join('\n');
}

function interactionBodies(): string {
  return requests
    .filter(request => request.url.includes('/interactions'))
    .map(request => request.body ?? '')
    .join('\n');
}

function userFile(
  mediaType: string,
  data: ModelMessage extends never ? never : unknown,
): ModelMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text: 'Read the attached file.' },
      { type: 'file', mediaType, data },
    ],
  } as ModelMessage;
}

let fetchImpl: typeof fetch;
let developerModel: InteractionsModel;

beforeEach(() => {
  requests.length = 0;
  fetchImpl = installFetch();
  developerModel = createGoogle({
    apiKey: placeholderApiKey,
    fetch: fetchImpl,
    generateId: () => 'test-id',
  }).interactions('gemini-2.5-flash') as InteractionsModel;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function send({
  messages,
  model = developerModel,
  mode = 'generate',
}: {
  messages: ModelMessage[];
  model?: InteractionsModel;
  mode?: 'generate' | 'stream' | 'background' | 'json-generate' | 'json-stream';
}) {
  // Same prompt preparation generateText and streamText run before doGenerate
  // or doStream: validate the caller messages, then download only URLs the
  // model does not report as native.
  const prompt = await standardizePrompt({ messages });
  const promptMessages = await convertToLanguageModelPrompt({
    prompt,
    supportedUrls: await model.supportedUrls,
    download: undefined,
    provider: model.provider.split('.')[0],
  });

  const callOptions: Record<string, unknown> = {
    prompt: promptMessages,
  };
  if (mode === 'background') {
    callOptions.providerOptions = { google: { background: true } };
  }
  if (mode === 'json-generate' || mode === 'json-stream') {
    callOptions.responseFormat = {
      type: 'json',
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
      },
    };
  }

  if (mode === 'generate' || mode === 'json-generate') {
    await model.doGenerate(callOptions);
    return;
  }

  const result = await model.doStream(callOptions);
  const reader = result.stream.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

async function expectUrlNotSentWithCredentials({
  messages,
  url,
  model,
  mode,
}: {
  messages: ModelMessage[];
  url: string;
  model?: InteractionsModel;
  mode?: 'generate' | 'stream' | 'background' | 'json-generate' | 'json-stream';
}) {
  try {
    await send({ messages, model, mode });
  } catch {
    // Refusing the prompt before the credentialed request is a valid fix.
  }

  expect(credentialedTranscript()).not.toContain(url);
}

describe('Google interactions untrusted file URLs', () => {
  it('still sends a YouTube watch URL with the application API key', async () => {
    await send({ messages: [userFile('video/mp4', youtubeWatchUrl)] });

    expect(interactionBodies()).toContain(
      `"uri":${JSON.stringify(youtubeWatchUrl)}`,
    );
    expect(
      requests.some(
        request =>
          request.url.includes('/interactions') &&
          request.headers.get('x-goog-api-key') === placeholderApiKey,
      ),
    ).toBe(true);
  });

  it('still sends a youtu.be URL with the application API key', async () => {
    await send({ messages: [userFile('video/mp4', youtubeShortUrl)] });

    expect(interactionBodies()).toContain(
      `"uri":${JSON.stringify(youtubeShortUrl)}`,
    );
  });

  it.each([
    ['image file', 'image/png', otherUserImageUrl],
    ['top-level image', 'image', otherUserImageUrl],
    ['pdf', 'application/pdf', otherUserPdfUrl],
    ['audio', 'audio/wav', otherUserAudioUrl],
    ['http files URL', 'image/jpeg', otherUserHttpUrl],
    ['mixed-case files id', 'image/png', otherUserCaseUrl],
  ])(
    'does not send an untrusted %s URL with the API key',
    async (_label, mediaType, url) => {
      await expectUrlNotSentWithCredentials({
        messages: [userFile(mediaType, url)],
        url,
      });
    },
  );

  it('does not send an untrusted gs video URL with the API key', async () => {
    await expectUrlNotSentWithCredentials({
      messages: [userFile('video/mp4', otherUserGsUrl)],
      url: otherUserGsUrl,
    });
  });

  it('does not let a YouTube URL authorize a files URL or a gs URL in the same prompt', async () => {
    await expectUrlNotSentWithCredentials({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Compare these videos and this image.' },
            { type: 'file', mediaType: 'video/mp4', data: youtubeWatchUrl },
            { type: 'file', mediaType: 'image/png', data: otherUserImageUrl },
            { type: 'file', mediaType: 'video/mp4', data: otherUserGsUrl },
          ],
        },
      ],
      url: otherUserImageUrl,
    });
    expect(credentialedTranscript()).not.toContain(otherUserGsUrl);
    const posted = interactionBodies();
    if (posted.includes('/interactions') || posted.includes('youtube.com')) {
      expect(posted).not.toContain(otherUserImageUrl);
      expect(posted).not.toContain(otherUserGsUrl);
    }
  });

  it('does not send a legacy image part whose URL is another user files URI', async () => {
    await expectUrlNotSentWithCredentials({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              image: otherUserImageUrl,
              mediaType: 'image/png',
            },
          ],
        },
      ],
      url: otherUserImageUrl,
    });
  });

  it('does not send an assistant-history files URL with the API key', async () => {
    await expectUrlNotSentWithCredentials({
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'file',
              mediaType: 'image/png',
              data: otherUserImageUrl,
            },
          ],
        },
        { role: 'user', content: 'What was in the previous image?' },
      ],
      url: otherUserImageUrl,
    });
  });

  it('does not send a forged provider reference with the API key', async () => {
    await expectUrlNotSentWithCredentials({
      messages: [userFile('image/png', { google: otherUserReferenceUrl })],
      url: otherUserReferenceUrl,
    });
  });

  it('forwards only the file URI this process uploaded', async () => {
    const provider = createGoogle({
      apiKey: placeholderApiKey,
      fetch: fetchImpl,
      generateId: () => 'test-id',
    });
    const uploaded = await provider.files().uploadFile({
      data: { type: 'data', data: new Uint8Array([9, 8, 7]) },
      mediaType: 'image/png',
      providerOptions: {},
    });
    expect(uploaded.providerReference).toEqual({ google: ownedFileUrl });

    requests.length = 0;
    await send({
      model: provider.interactions('gemini-2.5-flash') as InteractionsModel,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe the owned image only.' },
            {
              type: 'file',
              mediaType: 'image/png',
              data: uploaded.providerReference,
            },
            { type: 'file', mediaType: 'image/png', data: otherUserImageUrl },
            {
              type: 'file',
              mediaType: 'image/png',
              data: { google: ownedFilePrefixUrl },
            },
            { type: 'file', mediaType: 'image/png', data: ownedFileQueryUrl },
            {
              type: 'file',
              mediaType: 'image/png',
              data: { google: otherUserReferenceUrl },
            },
          ],
        },
      ],
    });

    const posted = interactionBodies();
    expect(posted).toContain(`"uri":${JSON.stringify(ownedFileUrl)}`);
    expect(posted).not.toContain(otherUserImageUrl);
    expect(posted).not.toContain(ownedFilePrefixUrl);
    expect(posted).not.toContain(ownedFileQueryUrl);
    expect(posted).not.toContain(otherUserReferenceUrl);
    expect(
      requests.some(
        request =>
          request.url.includes('/interactions') &&
          request.headers.get('x-goog-api-key') === placeholderApiKey,
      ),
    ).toBe(true);
  });

  it.each([
    ['stream', 'stream'],
    ['background stream', 'background'],
    ['json generate', 'json-generate'],
    ['json stream', 'json-stream'],
  ] as const)(
    'does not send an untrusted files URL from %s',
    async (_label, mode) => {
      await expectUrlNotSentWithCredentials({
        messages: [userFile('image/png', otherUserImageUrl)],
        url: otherUserImageUrl,
        mode,
      });
    },
  );

  it('does not send an untrusted files URL from an agent preset', async () => {
    const provider = createGoogle({
      apiKey: placeholderApiKey,
      fetch: fetchImpl,
      generateId: () => 'test-id',
    });
    await expectUrlNotSentWithCredentials({
      model: provider.interactions({
        agent: 'deep-research-pro-preview-12-2025',
      }) as InteractionsModel,
      messages: [userFile('image/png', otherUserImageUrl)],
      url: otherUserImageUrl,
    });
  });

  it('does not send an untrusted files URL from a managed agent', async () => {
    const provider = createGoogle({
      apiKey: placeholderApiKey,
      fetch: fetchImpl,
      generateId: () => 'test-id',
    });
    await expectUrlNotSentWithCredentials({
      model: provider.interactions({
        managedAgent: 'customer-agent',
      }) as InteractionsModel,
      messages: [userFile('image/png', otherUserImageUrl)],
      url: otherUserImageUrl,
    });
  });

  it('does not send a tool-result image URL with the API key', async () => {
    await expectUrlNotSentWithCredentials({
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'loadImage',
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
              toolName: 'loadImage',
              output: {
                type: 'content',
                value: [
                  {
                    type: 'file',
                    mediaType: 'image/png',
                    data: { type: 'url', url: new URL(otherUserImageUrl) },
                  },
                ],
              },
            },
          ],
        },
      ],
      url: otherUserImageUrl,
    });
  });

  it('does not send a tool-result image reference with the API key', async () => {
    await expectUrlNotSentWithCredentials({
      messages: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              toolName: 'loadImage',
              output: {
                type: 'content',
                value: [
                  {
                    type: 'file',
                    mediaType: 'image/png',
                    data: {
                      type: 'reference',
                      reference: { google: otherUserReferenceUrl },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
      url: otherUserReferenceUrl,
    });
  });

  it.each([
    [
      'file-url',
      otherUserImageUrl,
      {
        type: 'file-url',
        url: otherUserImageUrl,
        mediaType: 'image/png',
      },
    ],
    [
      'image-url',
      otherUserImageUrl,
      {
        type: 'image-url',
        url: otherUserImageUrl,
      },
    ],
    [
      'image-file-id',
      otherUserReferenceUrl,
      {
        type: 'image-file-id',
        fileId: otherUserReferenceUrl,
      },
    ],
    [
      'image-file-reference',
      otherUserReferenceUrl,
      {
        type: 'image-file-reference',
        providerReference: { google: otherUserReferenceUrl },
      },
    ],
  ] as const)(
    'does not send a deprecated tool-result %s with the API key',
    async (_label, url, outputPart) => {
      await expectUrlNotSentWithCredentials({
        messages: [
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'call-1',
                toolName: 'loadImage',
                output: {
                  type: 'content',
                  value: [outputPart],
                },
              },
            ],
          } as ModelMessage,
        ],
        url,
      });
    },
  );

  describe('Vertex interactions configuration', () => {
    function vertexModel(): InteractionsModel {
      // createGoogleVertex().interactions() does not pass supportedUrls, so
      // the class default is what production uses. The node provider attaches
      // a bearer token; this supplies that header without contacting Google.
      return new GoogleInteractionsLanguageModel('gemini-2.5-flash', {
        provider: 'google.vertex.interactions',
        baseURL:
          'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/test-project/locations/us-central1',
        headers: async () => ({ Authorization: placeholderBearer }),
        fetch: fetchImpl,
        generateId: () => 'test-id',
      }) as InteractionsModel;
    }

    it('does not send an untrusted files URL with the bearer token', async () => {
      await expectUrlNotSentWithCredentials({
        model: vertexModel(),
        messages: [userFile('image/png', otherUserImageUrl)],
        url: otherUserImageUrl,
      });
    });

    it('does not send an untrusted gs video URL with the bearer token', async () => {
      await expectUrlNotSentWithCredentials({
        model: vertexModel(),
        messages: [userFile('video/mp4', otherUserGsUrl)],
        url: otherUserGsUrl,
      });
    });
  });
});
