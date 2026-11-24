import { DEFAULT_MAX_DOWNLOAD_SIZE } from '@ai-sdk/provider-utils';
import { createTestServer } from '@ai-sdk/test-server/with-vitest';
import {
  generateText,
  streamText,
  type Experimental_DownloadFunction,
} from '../../ai/dist/index.js';
import { describe, expect, it } from 'vitest';
import { createProdia } from './prodia-provider';

const METADATA_URL = 'http://169.254.169.254/latest/meta-data/';
const LOOPBACK_URL = 'http://127.0.0.1/latest/meta-data/';
const LOCALHOST_ADMIN_URL = 'http://localhost:8080/admin';
const PRIVATE_NETWORK_URL = 'http://10.0.0.1/secret';
const DECIMAL_LOOPBACK_URL = 'http://2130706433/latest/meta-data/';
const PUBLIC_IMAGE_URL = 'https://cdn.example.com/image.png';
const HUGE_IMAGE_URL = 'https://cdn.example.com/huge.png';
const REDIRECT_TARGET = METADATA_URL;

/**
 * Return null for every URL. This is the documented download-hook result that
 * means "pass the URL through to the model".
 */
const passUrlThrough: Experimental_DownloadFunction = async requested =>
  requested.map(() => null);

function createLanguageMultipartResponse(): {
  body: Buffer;
  contentType: string;
} {
  const boundary = 'ssrf-boundary';
  const jobJson = JSON.stringify({
    id: 'job-ssrf',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:03Z',
    state: { current: 'completed' },
    config: { prompt: 'edit' },
    metrics: { elapsed: 1 },
    price: { product: 'nano-banana', dollars: 0.01 },
  });
  const body = Buffer.from(
    [
      `--${boundary}\r\n`,
      'Content-Disposition: form-data; name="job"; filename="job.json"\r\n',
      'Content-Type: application/json\r\n',
      '\r\n',
      jobJson,
      '\r\n',
      `--${boundary}\r\n`,
      'Content-Disposition: form-data; name="output"; filename="message.txt"\r\n',
      'Content-Type: text/plain\r\n',
      '\r\n',
      'ok',
      '\r\n',
      `--${boundary}--\r\n`,
    ].join(''),
  );
  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

const multipart = createLanguageMultipartResponse();

const fetchedImage = {
  type: 'binary' as const,
  body: Buffer.from('internal-bytes'),
  headers: { 'content-type': 'text/plain' },
};

const server = createTestServer({
  'https://api.example.com/v2/job?price=true': {
    response: {
      type: 'binary',
      body: multipart.body,
      headers: { 'content-type': multipart.contentType },
    },
  },
  [METADATA_URL]: { response: fetchedImage },
  [LOOPBACK_URL]: { response: fetchedImage },
  [LOCALHOST_ADMIN_URL]: { response: fetchedImage },
  [PRIVATE_NETWORK_URL]: { response: fetchedImage },
  [PUBLIC_IMAGE_URL]: {
    response: {
      type: 'error',
      status: 302,
      body: 'redirecting',
      headers: { location: REDIRECT_TARGET },
    },
  },
});

function model() {
  return createProdia({
    apiKey: 'test-key',
    baseURL: 'https://api.example.com/v2',
  }).languageModel('inference.nano-banana.img2img.v2');
}

function requestUrls(): string[] {
  return server.calls.map(call => call.requestUrl);
}

function jobWasSubmitted(): boolean {
  return requestUrls().some(url => url.includes('/v2/job'));
}

/**
 * The call must fail closed. When `forbidden` is set, that URL must not have
 * been requested. The provider job must not be submitted either way, so a
 * refusal that happens after the bytes were uploaded still fails.
 */
async function expectBlocked(
  run: () => PromiseLike<unknown>,
  forbidden?: string,
) {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }

  const urls = requestUrls();
  expect(
    thrown,
    `expected rejection, fetched ${urls.join(' | ')}`,
  ).toBeInstanceOf(Error);
  if (forbidden !== undefined) {
    expect(
      urls.some(url => url === forbidden || url.startsWith(forbidden)),
      `forbidden URL was requested: ${urls.join(' | ')}`,
    ).toBe(false);
  }
  expect(
    jobWasSubmitted(),
    `job submitted after fetching ${urls.join(' | ')}`,
  ).toBe(false);
}

describe('Prodia language model URL fetch guard', () => {
  describe('doGenerate', () => {
    it('does not request a cloud metadata image URL', async () => {
      await expectBlocked(
        () =>
          model().doGenerate({
            prompt: [userFile(METADATA_URL)],
            providerOptions: {},
          }),
        METADATA_URL,
      );
    });

    it('does not request a loopback image URL', async () => {
      await expectBlocked(
        () =>
          model().doGenerate({
            prompt: [userFile(LOOPBACK_URL)],
            providerOptions: {},
          }),
        LOOPBACK_URL,
      );
    });

    it('does not request a localhost admin image URL', async () => {
      await expectBlocked(
        () =>
          model().doGenerate({
            prompt: [userFile(LOCALHOST_ADMIN_URL)],
            providerOptions: {},
          }),
        LOCALHOST_ADMIN_URL,
      );
    });

    it('does not request a private-network image URL', async () => {
      await expectBlocked(
        () =>
          model().doGenerate({
            prompt: [userFile(PRIVATE_NETWORK_URL)],
            providerOptions: {},
          }),
        PRIVATE_NETWORK_URL,
      );
    });

    it('does not request a decimal IPv4 image URL that normalizes to loopback', async () => {
      await expectBlocked(
        () =>
          model().doGenerate({
            prompt: [userFile(DECIMAL_LOOPBACK_URL)],
            providerOptions: {},
          }),
        LOOPBACK_URL,
      );
    });

    it('does not follow a public image URL that redirects to a metadata address', async () => {
      await expectBlocked(
        () =>
          model().doGenerate({
            prompt: [userFile(PUBLIC_IMAGE_URL)],
            providerOptions: {},
          }),
        REDIRECT_TARGET,
      );
    });

    it('rejects an image download whose Content-Length exceeds the download cap before submitting the job', async () => {
      // A platform Response keeps the declared Content-Length and a body whose
      // cancel() settles. The guarded reader rejects from that header before
      // buffering. Refusing every URL up front is also acceptable.
      const interceptedFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url === HUGE_IMAGE_URL) {
          return new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 200,
            headers: {
              'content-type': 'image/png',
              'content-length': String(DEFAULT_MAX_DOWNLOAD_SIZE + 1),
            },
          });
        }
        return interceptedFetch(input, init);
      };

      try {
        await expectBlocked(() =>
          model().doGenerate({
            prompt: [userFile(HUGE_IMAGE_URL)],
            providerOptions: {},
          }),
        );
      } finally {
        globalThis.fetch = interceptedFetch;
      }
    });
  });

  describe('doStream', () => {
    it('does not request a cloud metadata image URL', async () => {
      await expectBlocked(
        () =>
          model().doStream({
            prompt: [userFile(METADATA_URL)],
            providerOptions: {},
          }),
        METADATA_URL,
      );
    });

    it('does not follow a public image URL that redirects to a metadata address', async () => {
      await expectBlocked(
        () =>
          model().doStream({
            prompt: [userFile(PUBLIC_IMAGE_URL)],
            providerOptions: {},
          }),
        REDIRECT_TARGET,
      );
    });
  });

  describe('generateText with a download hook that passes URLs through', () => {
    it('does not request a metadata URL supplied as a file part', async () => {
      await expectBlocked(
        () =>
          generateText({
            model: model(),
            maxRetries: 0,
            experimental_download: passUrlThrough,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'edit this image' },
                  {
                    type: 'file',
                    mediaType: 'image/png',
                    data: { type: 'url', url: new URL(METADATA_URL) },
                  },
                ],
              },
            ],
          }),
        METADATA_URL,
      );
    });

    it('does not request a metadata URL supplied as an image string', async () => {
      await expectBlocked(
        () =>
          generateText({
            model: model(),
            maxRetries: 0,
            experimental_download: passUrlThrough,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'image',
                    image: METADATA_URL,
                    mediaType: 'image/png',
                  },
                ],
              },
            ],
          }),
        METADATA_URL,
      );
    });

    it('does not follow a redirect to localhost when the download hook passes the URL through', async () => {
      server.urls[PUBLIC_IMAGE_URL].response = {
        type: 'error',
        status: 302,
        body: 'redirecting',
        headers: { location: LOCALHOST_ADMIN_URL },
      };

      await expectBlocked(
        () =>
          generateText({
            model: model(),
            maxRetries: 0,
            experimental_download: passUrlThrough,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'file',
                    mediaType: 'image/png',
                    data: PUBLIC_IMAGE_URL,
                  },
                ],
              },
            ],
          }),
        LOCALHOST_ADMIN_URL,
      );
    });
  });

  describe('streamText with a download hook that passes URLs through', () => {
    it('does not request a private-network URL supplied as a file part', async () => {
      const result = streamText({
        model: model(),
        maxRetries: 0,
        experimental_download: passUrlThrough,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'edit this image' },
              {
                type: 'file',
                mediaType: 'image/png',
                data: { type: 'url', url: new URL(PRIVATE_NETWORK_URL) },
              },
            ],
          },
        ],
      });

      await expectBlocked(() => result.text, PRIVATE_NETWORK_URL);
    });
  });
});

function userFile(url: string) {
  return {
    role: 'user' as const,
    content: [
      { type: 'text' as const, text: 'edit this image' },
      {
        type: 'file' as const,
        mediaType: 'image/png',
        data: { type: 'url' as const, url: new URL(url) },
      },
    ],
  };
}
