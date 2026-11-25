import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createFal } from './fal-provider';

/**
 * Spec for model ids passed to the fal provider.
 *
 * A model id is a sequence of path segments, not a raw URL suffix. Each
 * segment may contain only letters, digits, ".", "_", and "-". Empty
 * segments, "." and ".." (including percent-encoded forms the URL parser
 * treats as dot segments), and URL delimiters such as "?", "#", "\", and
 * "%" must be rejected before any request is made.
 *
 * Encoding "." or ".." with encodeURIComponent is not a fix: Node's fetch
 * (undici 6.29.1) parses the URL with `new URL` and then requests
 * `pathname + search`, and that parser removes those dot segments.
 *
 * These tests fail while the raw id is concatenated into the request URL.
 */

const placeholderApiKey = 'placeholder-fal-key';
const authorization = `Key ${placeholderApiKey}`;

const realFetch = globalThis.fetch.bind(globalThis);

type Hit = {
  method: string;
  url: string;
  authorization: string | undefined;
};

const unsafeModelIds = [
  { label: 'query delimiter', modelId: 'other-model?x=' },
  { label: 'query string', modelId: 'owner/model?x=injected' },
  { label: 'dot segment', modelId: 'owner/../other-model' },
  { label: 'percent-encoded dot segment', modelId: 'owner/%2e%2e/other-model' },
  {
    label: 'uppercase percent-encoded dot segment',
    modelId: 'owner/%2E%2E/other-model',
  },
  { label: 'fragment', modelId: 'other-model#fragment' },
  { label: 'single-dot segment', modelId: 'owner/./other-model' },
  { label: 'empty segment', modelId: 'owner//other-model' },
  { label: 'backslash', modelId: 'owner\\../other-model' },
  {
    label: 'dot segment after fal-ai prefix',
    modelId: 'fal-ai/../other-model',
  },
  { label: 'leading slash', modelId: '/other-model' },
  { label: 'leading query', modelId: '?x=injected' },
  { label: 'empty id', modelId: '' },
] as const;

async function readBody(request: IncomingMessage): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function startServer(): Promise<{
  origin: string;
  hits: Hit[];
  close: () => Promise<void>;
}> {
  const hits: Hit[] = [];
  const server = createServer(async (request, response) => {
    await readBody(request);
    const url = request.url ?? '';
    hits.push({
      method: request.method ?? '',
      url,
      authorization: request.headers.authorization,
    });

    const path = url.split('?')[0] ?? url;

    if (
      request.method === 'POST' &&
      (path === '/fal-ai/flux/dev' || path === '/fal-ai/flux-pro/v1.1')
    ) {
      // data: image so the follow-up download does not open another socket.
      sendJson(response, 200, {
        images: [
          {
            url: 'data:image/png;base64,aGk=',
            content_type: 'image/png',
          },
        ],
      });
      return;
    }

    if (request.method === 'POST' && path === '/fal-ai/minimax/speech-02-hd') {
      sendJson(response, 200, {
        audio: { url: 'data:audio/mpeg;base64,aGk=' },
      });
      return;
    }

    if (request.method === 'POST' && path === '/fal-ai/wizper') {
      sendJson(response, 200, { request_id: 'job-1' });
      return;
    }

    if (request.method === 'GET' && path === '/fal-ai/wizper/requests/job-1') {
      sendJson(response, 200, { text: 'hello' });
      return;
    }

    if (request.method === 'POST' && path === '/fal-ai/luma-dream-machine') {
      sendJson(response, 200, {
        request_id: 'job-1',
        response_url:
          'https://queue.fal.run/fal-ai/luma-dream-machine/requests/job-1',
      });
      return;
    }

    sendJson(response, 401, { message: 'unauthorized' });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        hits,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close(error => {
              if (error) {
                closeReject(error);
                return;
              }
              closeResolve();
            });
          }),
      });
    });
  });
}

/**
 * Forwards pathname and search to the local server and leaves the method,
 * headers, and body untouched. Undici 6.29.1 does the same split: it parses
 * with `new URL` and dispatches `pathname + search` to the URL origin.
 * Hosts other than the local server are rewritten so the test never contacts
 * fal.run. data: URLs are fetched as-is.
 */
function forwardToLocalServer(
  localOrigin: string,
  attempts: Hit[],
): typeof globalThis.fetch {
  return async (input, init) => {
    const href =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const parsed = new URL(href);
    const headers = new Headers(init?.headers);
    if (parsed.protocol === 'data:' || parsed.origin === localOrigin) {
      attempts.push({
        method: init?.method ?? 'GET',
        url: href,
        authorization: headers.get('authorization') ?? undefined,
      });
      return realFetch(input, init);
    }

    const wireUrl = new URL(parsed.pathname + parsed.search, localOrigin);
    attempts.push({
      method: init?.method ?? 'GET',
      url: `${parsed.origin}${parsed.pathname}${parsed.search}`,
      authorization: headers.get('authorization') ?? undefined,
    });
    return realFetch(wireUrl, init);
  };
}

const imageCall = {
  prompt: 'a cat',
  files: undefined,
  mask: undefined,
  n: 1,
  size: undefined,
  aspectRatio: undefined,
  seed: undefined,
  providerOptions: {},
} as const;

const videoCall = {
  prompt: 'a cat',
  n: 1,
  image: undefined,
  frameImages: undefined,
  inputReferences: undefined,
  aspectRatio: undefined,
  resolution: undefined,
  duration: undefined,
  fps: undefined,
  generateAudio: undefined,
  seed: undefined,
  providerOptions: {},
} as const;

describe('fal model id path injection', () => {
  describe('image doGenerate', () => {
    it('posts a safe model id as slash-separated segments with the provider key', async () => {
      const endpoint = await startServer();
      try {
        const model = createFal({
          apiKey: placeholderApiKey,
          baseURL: endpoint.origin,
          fetch: realFetch,
        }).image('fal-ai/flux/dev');

        await model.doGenerate(imageCall);

        expect(endpoint.hits[0]).toEqual({
          method: 'POST',
          url: '/fal-ai/flux/dev',
          authorization,
        });
      } finally {
        await endpoint.close();
      }
    });

    it('keeps dots that are part of a segment name', async () => {
      const endpoint = await startServer();
      try {
        const model = createFal({
          apiKey: placeholderApiKey,
          baseURL: endpoint.origin,
          fetch: realFetch,
        }).image('fal-ai/flux-pro/v1.1');

        await model.doGenerate(imageCall);

        expect(endpoint.hits[0]).toEqual({
          method: 'POST',
          url: '/fal-ai/flux-pro/v1.1',
          authorization,
        });
      } finally {
        await endpoint.close();
      }
    });

    it('uses the default https://fal.run origin for a safe model id', async () => {
      const endpoint = await startServer();
      const attempts: Hit[] = [];
      try {
        const model = createFal({
          apiKey: placeholderApiKey,
          fetch: forwardToLocalServer(endpoint.origin, attempts),
        }).image('fal-ai/flux/dev');

        await model.doGenerate(imageCall);

        expect(attempts[0]).toEqual({
          method: 'POST',
          url: 'https://fal.run/fal-ai/flux/dev',
          authorization,
        });
        expect(endpoint.hits[0]).toEqual({
          method: 'POST',
          url: '/fal-ai/flux/dev',
          authorization,
        });
      } finally {
        await endpoint.close();
      }
    });

    it.each(unsafeModelIds)(
      'does not send the provider key for a model id with a $label',
      async ({ modelId }) => {
        const endpoint = await startServer();
        try {
          const model = createFal({
            apiKey: placeholderApiKey,
            baseURL: endpoint.origin,
            fetch: realFetch,
          }).image(modelId);

          let thrown: unknown;
          try {
            await model.doGenerate(imageCall);
          } catch (error) {
            thrown = error;
          }

          expect(endpoint.hits).toEqual([]);
          expect(thrown).toBeInstanceOf(Error);
        } finally {
          await endpoint.close();
        }
      },
    );

    it('does not send the provider key to the default fal.run origin for a query model id', async () => {
      const endpoint = await startServer();
      const attempts: Hit[] = [];
      try {
        const model = createFal({
          apiKey: placeholderApiKey,
          fetch: forwardToLocalServer(endpoint.origin, attempts),
        }).image('other-model?x=');

        let thrown: unknown;
        try {
          await model.doGenerate(imageCall);
        } catch (error) {
          thrown = error;
        }

        expect(attempts).toEqual([]);
        expect(endpoint.hits).toEqual([]);
        expect(thrown).toBeInstanceOf(Error);
      } finally {
        await endpoint.close();
      }
    });
  });

  describe('speech doGenerate', () => {
    it('posts a safe model id on https://fal.run with the provider key', async () => {
      const endpoint = await startServer();
      const attempts: Hit[] = [];
      try {
        const model = createFal({
          apiKey: placeholderApiKey,
          fetch: forwardToLocalServer(endpoint.origin, attempts),
        }).speech('fal-ai/minimax/speech-02-hd');

        await model.doGenerate({ text: 'hello' });

        expect(attempts[0]).toEqual({
          method: 'POST',
          url: 'https://fal.run/fal-ai/minimax/speech-02-hd',
          authorization,
        });
        expect(endpoint.hits[0]).toEqual({
          method: 'POST',
          url: '/fal-ai/minimax/speech-02-hd',
          authorization,
        });
      } finally {
        await endpoint.close();
      }
    });

    it.each(unsafeModelIds)(
      'does not send the provider key for a model id with a $label',
      async ({ modelId }) => {
        const endpoint = await startServer();
        const attempts: Hit[] = [];
        try {
          const model = createFal({
            apiKey: placeholderApiKey,
            fetch: forwardToLocalServer(endpoint.origin, attempts),
          }).speech(modelId);

          let thrown: unknown;
          try {
            await model.doGenerate({ text: 'hello' });
          } catch (error) {
            thrown = error;
          }

          expect(attempts).toEqual([]);
          expect(endpoint.hits).toEqual([]);
          expect(thrown).toBeInstanceOf(Error);
        } finally {
          await endpoint.close();
        }
      },
    );
  });

  describe('transcription doGenerate', () => {
    it('posts and polls a safe model id on https://queue.fal.run with the provider key', async () => {
      const endpoint = await startServer();
      const attempts: Hit[] = [];
      try {
        const model = createFal({
          apiKey: placeholderApiKey,
          fetch: forwardToLocalServer(endpoint.origin, attempts),
        }).transcription('wizper');

        await model.doGenerate({
          audio: new Uint8Array([1, 2, 3]),
          mediaType: 'audio/wav',
        });

        expect(
          attempts.map(({ method, url, authorization: key }) => ({
            method,
            url,
            authorization: key,
          })),
        ).toEqual([
          {
            method: 'POST',
            url: 'https://queue.fal.run/fal-ai/wizper',
            authorization,
          },
          {
            method: 'GET',
            url: 'https://queue.fal.run/fal-ai/wizper/requests/job-1',
            authorization,
          },
        ]);
      } finally {
        await endpoint.close();
      }
    });

    it.each(unsafeModelIds)(
      'does not send the provider key for a model id with a $label',
      async ({ modelId }) => {
        const endpoint = await startServer();
        const attempts: Hit[] = [];
        try {
          const model = createFal({
            apiKey: placeholderApiKey,
            fetch: forwardToLocalServer(endpoint.origin, attempts),
          }).transcription(modelId);

          let thrown: unknown;
          try {
            await model.doGenerate({
              audio: new Uint8Array([1, 2, 3]),
              mediaType: 'audio/wav',
            });
          } catch (error) {
            thrown = error;
          }

          expect(attempts).toEqual([]);
          expect(endpoint.hits).toEqual([]);
          expect(thrown).toBeInstanceOf(Error);
        } finally {
          await endpoint.close();
        }
      },
    );
  });

  describe('video doStart', () => {
    it('posts a safe model id on https://queue.fal.run with the provider key', async () => {
      const endpoint = await startServer();
      const attempts: Hit[] = [];
      try {
        const model = createFal({
          apiKey: placeholderApiKey,
          fetch: forwardToLocalServer(endpoint.origin, attempts),
        }).video('luma-dream-machine');

        await model.doStart(videoCall);

        expect(attempts).toEqual([
          {
            method: 'POST',
            url: 'https://queue.fal.run/fal-ai/luma-dream-machine',
            authorization,
          },
        ]);
        expect(endpoint.hits[0]).toEqual({
          method: 'POST',
          url: '/fal-ai/luma-dream-machine',
          authorization,
        });
      } finally {
        await endpoint.close();
      }
    });

    it.each(unsafeModelIds)(
      'does not send the provider key for a model id with a $label',
      async ({ modelId }) => {
        const endpoint = await startServer();
        const attempts: Hit[] = [];
        try {
          const model = createFal({
            apiKey: placeholderApiKey,
            fetch: forwardToLocalServer(endpoint.origin, attempts),
          }).video(modelId);

          let thrown: unknown;
          try {
            await model.doStart(videoCall);
          } catch (error) {
            thrown = error;
          }

          expect(attempts).toEqual([]);
          expect(endpoint.hits).toEqual([]);
          expect(thrown).toBeInstanceOf(Error);
        } finally {
          await endpoint.close();
        }
      },
    );
  });
});
