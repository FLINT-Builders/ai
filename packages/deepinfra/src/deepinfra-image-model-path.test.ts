import type { ImageModelV4 } from '@ai-sdk/provider';
import type { FetchFunction } from '@ai-sdk/provider-utils';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDeepInfra, type DeepInfraProvider } from './deepinfra-provider';

const placeholderApiKey = 'placeholder-api-key';
const prompt = 'A cute baby sea otter';

/**
 * Model ids that the URL parser turns into a different request-target, or that
 * the image URL builder must reject before any request. Each one is sent by
 * the current implementation.
 */
const rejectedModelIds = [
  '../openai/chat/completions',
  '../../openai/chat/completions',
  'black-forest-labs/../../../openai/chat/completions',
  'black-forest-labs/FLUX-1-dev/../../openai/models',
  '%2e%2e/%2e%2e/openai/chat/completions',
  '.%2e/openai/chat/completions',
  '%2e./openai/chat/completions',
  '%2E%2E/openai/chat/completions',
  'foo/%2e%2e/bar',
  '..\\..\\openai\\chat\\completions',
  '..\\openai/chat/completions',
  'foo/bar?x=1',
  '../openai/chat/completions?x=1',
  'foo/bar#../openai/chat/completions',
  '#../openai/chat/completions',
  'foo//bar',
  'foo/',
  '/foo',
  '/../openai/chat/completions',
  'https://example.com/steal',
  'foo/./bar',
  '.',
  '..',
  'publisher/model\r\nX-Injected: 1',
] as const;

const acceptedModelIds: Array<[string, string]> = [
  [
    'black-forest-labs/FLUX-1-dev',
    '/v1/inference/black-forest-labs/FLUX-1-dev',
  ],
  ['stabilityai/sd3.5', '/v1/inference/stabilityai/sd3.5'],
  [
    'black-forest-labs/FLUX.1-Kontext-dev',
    '/v1/inference/black-forest-labs/FLUX.1-Kontext-dev',
  ],
  [
    'black-forest-labs/FLUX-1.1-pro',
    '/v1/inference/black-forest-labs/FLUX-1.1-pro',
  ],
  ['Qwen/Qwen-Image-Edit', '/v1/inference/Qwen/Qwen-Image-Edit'],
  ['org/my model', '/v1/inference/org/my%20model'],
  ['org/a+b', `/v1/inference/org/${encodeURIComponent('a+b')}`],
];

type WireRequest = {
  method: string;
  url: string;
  host: string;
  authorization: string | undefined;
  body: string;
};

type FetchCall = {
  url: string;
  authorization: string | null;
};

const generateArgs = {
  prompt,
  n: 1,
  size: undefined,
  aspectRatio: undefined,
  seed: undefined,
  files: undefined,
  mask: undefined,
  providerOptions: {},
} as const;

async function generate(model: ImageModelV4) {
  return model.doGenerate(generateArgs);
}

describe('DeepInfra image model id path injection', () => {
  let server: Server;
  let port: number;
  let wire: WireRequest[];
  let calls: FetchCall[];
  const nativeFetch = globalThis.fetch;

  const recordingFetch: FetchFunction = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push({
      url,
      authorization: new Headers(init?.headers).get('authorization'),
    });

    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1' || parsed.port !== String(port)) {
      throw new Error(
        `test blocked a request that left the local inference server: ${parsed.origin}`,
      );
    }

    return nativeFetch(input, init);
  };

  beforeAll(async () => {
    wire = [];
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', chunk => {
        chunks.push(Buffer.from(chunk));
      });
      request.on('end', () => {
        const url = request.url ?? '';
        wire.push({
          method: request.method ?? '',
          url,
          host: request.headers.host ?? '',
          authorization:
            typeof request.headers.authorization === 'string'
              ? request.headers.authorization
              : undefined,
          body: Buffer.concat(chunks).toString('utf8'),
        });

        const edit = url.startsWith('/v1/openai/images/edits');
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify(
            edit
              ? { data: [{ b64_json: 'bbbb' }] }
              : { images: ['data:image/png;base64,aaaa'] },
          ),
        );
      });
    });

    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  function provider() {
    calls = [];
    wire = [];
    return createDeepInfra({
      apiKey: placeholderApiKey,
      baseURL: `http://127.0.0.1:${port}/v1`,
      fetch: recordingFetch,
    });
  }

  function modelFor(
    deepinfra: DeepInfraProvider,
    factory: 'image' | 'imageModel',
    modelId: string,
  ) {
    return factory === 'image'
      ? deepinfra.image(modelId)
      : deepinfra.imageModel(modelId);
  }

  async function expectNoRequest(
    modelId: string,
    factory: 'image' | 'imageModel',
  ) {
    const model = modelFor(provider(), factory, modelId);
    let error: unknown;
    try {
      await generate(model);
    } catch (caught) {
      error = caught;
    }

    expect({ calls, wire }).toEqual({ calls: [], wire: [] });
    expect(error).toBeInstanceOf(Error);
  }

  it.each(rejectedModelIds)(
    'image() refuses %j before posting the api key',
    async modelId => {
      await expectNoRequest(modelId, 'image');
    },
  );

  it.each(rejectedModelIds)(
    'imageModel() refuses %j before posting the api key',
    async modelId => {
      await expectNoRequest(modelId, 'imageModel');
    },
  );

  it.each(acceptedModelIds)(
    'image() posts %j only as encoded inference segments',
    async (modelId, path) => {
      const result = await generate(provider().image(modelId));
      const requested = new URL(calls[0].url);

      expect(result.images).toEqual(['aaaa']);
      expect(calls.map(call => call.authorization)).toEqual([
        `Bearer ${placeholderApiKey}`,
      ]);
      expect(requested.origin).toBe(`http://127.0.0.1:${port}`);
      expect(requested.pathname).toBe(path);
      expect(requested.search).toBe('');
      expect(requested.hash).toBe('');
      expect(wire).toEqual([
        {
          method: 'POST',
          url: path,
          host: `127.0.0.1:${port}`,
          authorization: `Bearer ${placeholderApiKey}`,
          body: JSON.stringify({ prompt, num_images: 1 }),
        },
      ]);
    },
  );

  it('keeps a traversal model id out of the image edit URL', async () => {
    const model = provider().image('../openai/chat/completions');
    let error: unknown;
    try {
      await model.doGenerate({
        prompt: 'Edit this image',
        n: 1,
        size: undefined,
        aspectRatio: undefined,
        seed: undefined,
        files: [
          {
            type: 'file',
            data: new Uint8Array([137, 80, 78, 71]),
            mediaType: 'image/png',
          },
        ],
        mask: undefined,
        providerOptions: {},
      });
    } catch (caught) {
      error = caught;
    }

    const urls = wire.map(request => request.url);
    expect(urls.every(url => url === '/v1/openai/images/edits')).toBe(true);
    expect(urls.some(url => url.includes('/chat/completions'))).toBe(false);
    if (urls.length === 0) {
      expect(error).toBeInstanceOf(Error);
    }
  });

  describe('default DeepInfra inference host', () => {
    function defaultProvider() {
      calls = [];
      return createDeepInfra({
        apiKey: placeholderApiKey,
        fetch: async (input, init) => {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          calls.push({
            url,
            authorization: new Headers(init?.headers).get('authorization'),
          });
          return new Response(
            JSON.stringify({ images: ['data:image/png;base64,aaaa'] }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          );
        },
      });
    }

    it('posts a documented model id under the default inference prefix', async () => {
      const result = await generate(
        defaultProvider().image('black-forest-labs/FLUX-1-dev'),
      );

      expect(result.images).toEqual(['aaaa']);
      expect(calls).toEqual([
        {
          url: 'https://api.deepinfra.com/v1/inference/black-forest-labs/FLUX-1-dev',
          authorization: `Bearer ${placeholderApiKey}`,
        },
      ]);
    });

    it.each([
      '../openai/chat/completions',
      '%2e%2e/%2e%2e/openai/chat/completions',
      '..\\..\\openai\\chat\\completions',
      'foo/bar?x=1',
      'foo/bar#fragment',
    ])('does not request the default host for %j', async modelId => {
      let error: unknown;
      try {
        await generate(defaultProvider().image(modelId));
      } catch (caught) {
        error = caught;
      }

      expect(calls).toEqual([]);
      expect(error).toBeInstanceOf(Error);
    });
  });
});
