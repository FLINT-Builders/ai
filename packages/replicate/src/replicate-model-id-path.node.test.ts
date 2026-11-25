import { createServer, type IncomingMessage, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createReplicate } from './replicate-provider';

const placeholderToken = 'test-api-token';

type RecordedRequest = {
  method: string;
  path: string;
  search: string;
  host: string;
  authorization: string | undefined;
};

/**
 * Local stand-in for the Replicate API. Node's fetch performs WHATWG URL
 * parsing before the request is written, so the recorded path is the path
 * that left the process, not the string concatenated in the provider.
 */
async function withLocalReplicate(
  run: (args: {
    baseURL: string;
    requests: RecordedRequest[];
  }) => Promise<void>,
) {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on('end', () => {
      recordRequest(request, requests);
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ detail: 'not found' }));
    });
  });

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address == null || typeof address === 'string') {
    server.close();
    throw new Error('Expected a TCP listener');
  }

  const baseURL = `http://127.0.0.1:${address.port}/v1`;

  try {
    await run({ baseURL, requests });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

function recordRequest(request: IncomingMessage, requests: RecordedRequest[]) {
  const hostHeader = request.headers.host;
  const host = Array.isArray(hostHeader) ? hostHeader[0] : (hostHeader ?? '');
  const url = new URL(request.url ?? '/', `http://${host}`);
  const authorization = request.headers.authorization;
  requests.push({
    method: request.method ?? '',
    path: url.pathname,
    search: url.search,
    host,
    authorization: Array.isArray(authorization)
      ? authorization[0]
      : authorization,
  });
}

const videoStartOptions = {
  prompt: 'A rocket launching into space',
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

const imageGenerateOptions = {
  prompt: 'The Loch Ness monster getting a manicure',
  files: undefined,
  mask: undefined,
  n: 1,
  size: '1024x768' as const,
  aspectRatio: '3:4' as const,
  seed: 123,
  providerOptions: {},
};

/**
 * Model ids that are not a single owner segment plus a single name segment.
 * Each one changes the path or query Node's fetch writes on the wire when the
 * raw id is concatenated into `/models/${id}/predictions`.
 */
const unsafeModelIds = [
  'owner/../../account',
  'owner/model?x=.',
  'owner/model#frag',
  'owner\\..\\..\\account',
  'owner/%2e%2e/%2e%2e/account',
  'x/../../../account',
  'owner/model/extra',
] as const;

describe('Replicate model id path', () => {
  describe('video doStart', () => {
    it('posts an unversioned owner/name only to that model predictions path', async () => {
      await withLocalReplicate(async ({ baseURL, requests }) => {
        const model = createReplicate({
          apiToken: placeholderToken,
          baseURL,
        }).video('minimax/video-01');

        await expect(model.doStart({ ...videoStartOptions })).rejects.toThrow();

        expect(requests).toEqual([
          {
            method: 'POST',
            path: '/v1/models/minimax/video-01/predictions',
            search: '',
            host: new URL(baseURL).host,
            authorization: `Bearer ${placeholderToken}`,
          },
        ]);
      });
    });

    it('posts a versioned model id to /predictions without the id in the path', async () => {
      await withLocalReplicate(async ({ baseURL, requests }) => {
        const model = createReplicate({
          apiToken: placeholderToken,
          baseURL,
        }).video('stability-ai/stable-video-diffusion:abc123');

        await expect(model.doStart({ ...videoStartOptions })).rejects.toThrow();

        expect(requests).toEqual([
          {
            method: 'POST',
            path: '/v1/predictions',
            search: '',
            host: new URL(baseURL).host,
            authorization: `Bearer ${placeholderToken}`,
          },
        ]);
      });
    });

    it.each(unsafeModelIds)(
      'rejects %j before sending the bearer token',
      async modelId => {
        await withLocalReplicate(async ({ baseURL, requests }) => {
          const model = createReplicate({
            apiToken: placeholderToken,
            baseURL,
          }).video(modelId);

          await expect(
            model.doStart({ ...videoStartOptions }),
          ).rejects.toThrow();

          expect(
            requests,
            `video model id ${modelId} must be rejected before any request`,
          ).toEqual([]);
        });
      },
    );

    it('rejects a traversing id passed to videoModel before sending the bearer token', async () => {
      await withLocalReplicate(async ({ baseURL, requests }) => {
        const model = createReplicate({
          apiToken: placeholderToken,
          baseURL,
        }).videoModel('owner/../../account');

        await expect(model.doStart({ ...videoStartOptions })).rejects.toThrow();

        expect(requests).toEqual([]);
      });
    });
  });

  describe('image doGenerate', () => {
    it('posts an unversioned owner/name only to that model predictions path', async () => {
      await withLocalReplicate(async ({ baseURL, requests }) => {
        const model = createReplicate({
          apiToken: placeholderToken,
          baseURL,
        }).image('black-forest-labs/flux-1.1-pro');

        await expect(
          model.doGenerate({ ...imageGenerateOptions }),
        ).rejects.toThrow();

        expect(requests).toEqual([
          {
            method: 'POST',
            path: '/v1/models/black-forest-labs/flux-1.1-pro/predictions',
            search: '',
            host: new URL(baseURL).host,
            authorization: `Bearer ${placeholderToken}`,
          },
        ]);
      });
    });

    it.each(unsafeModelIds)(
      'rejects %j before sending the bearer token',
      async modelId => {
        await withLocalReplicate(async ({ baseURL, requests }) => {
          const model = createReplicate({
            apiToken: placeholderToken,
            baseURL,
          }).image(modelId);

          await expect(
            model.doGenerate({ ...imageGenerateOptions }),
          ).rejects.toThrow();

          expect(
            requests,
            `image model id ${modelId} must be rejected before any request`,
          ).toEqual([]);
        });
      },
    );

    it('rejects a query-delimiter id passed to imageModel before sending the bearer token', async () => {
      await withLocalReplicate(async ({ baseURL, requests }) => {
        const model = createReplicate({
          apiToken: placeholderToken,
          baseURL,
        }).imageModel('owner/model?x=.');

        await expect(
          model.doGenerate({ ...imageGenerateOptions }),
        ).rejects.toThrow();

        expect(requests).toEqual([]);
      });
    });
  });
});
