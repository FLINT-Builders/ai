import type { Experimental_VideoModelV4CallOptions } from '@ai-sdk/provider';
import type { FetchFunction } from '@ai-sdk/provider-utils';
import { describe, expect, it } from 'vitest';
import { createBlackForestLabs } from './black-forest-labs-provider';
import type { BlackForestLabsImageModelId } from './black-forest-labs-image-settings';
import type { BlackForestLabsVideoModelId } from './black-forest-labs-video-settings';

/**
 * Obvious placeholder. The tests assert that this provider credential is not
 * attached to a request whose path or query escaped the model id segment.
 */
const PLACEHOLDER_KEY = 'placeholder-bfl-api-key';

const documentedImageModelIds = [
  'flux-kontext-pro',
  'flux-kontext-max',
  'flux-pro-1.1-ultra',
  'flux-pro-1.1',
  'flux-pro-1.0-fill',
] as const satisfies readonly BlackForestLabsImageModelId[];

const documentedVideoModelId =
  'flux-3-video' as const satisfies BlackForestLabsVideoModelId;

/**
 * Ids that must not be able to choose another path or query on the configured
 * host. Includes the attack examples plus the encodings Node's URL parser
 * resolves before the request is sent (`\`, `%2e%2e/`, a fragment, an embedded
 * absolute URL).
 */
const injectedModelIds = [
  'flux-kontext-pro?x=',
  '../other-endpoint',
  '..\\other-endpoint',
  'flux-kontext-pro/extra',
  'flux-kontext-pro#fragment',
  '%2e%2e/other-endpoint',
  '%2e%2e%2fother-endpoint',
  '?x=injected',
  'https://evil.example/steal',
] as const;

type SeenRequest = {
  method: string;
  href: string;
  origin: string;
  pathname: string;
  search: string;
  xKey: string | null;
};

const imageCall = {
  prompt: 'A serene mountain landscape at sunset',
  files: undefined,
  mask: undefined,
  n: 1,
  size: undefined,
  seed: undefined,
  aspectRatio: '1:1' as const,
  providerOptions: {},
};

const videoCall: Experimental_VideoModelV4CallOptions = {
  prompt: 'A white kitten chases a butterfly across a sunlit garden.',
  n: 1,
  aspectRatio: undefined,
  resolution: undefined,
  duration: undefined,
  fps: undefined,
  seed: undefined,
  image: undefined,
  frameImages: undefined,
  inputReferences: undefined,
  generateAudio: undefined,
  providerOptions: {},
};

function seenRequest(
  url: string,
  method: string,
  headers: HeadersInit | undefined,
): SeenRequest {
  const parsed = new URL(url);
  const normalized = new Headers(headers);
  return {
    method,
    href: parsed.href,
    origin: parsed.origin,
    pathname: parsed.pathname,
    search: parsed.search,
    xKey: normalized.get('x-key'),
  };
}

function expectedModelPath(baseURL: string, modelId: string): string {
  const base = new URL(baseURL);
  const basePath = base.pathname.replace(/\/$/, '');
  return `${basePath}/${encodeURIComponent(modelId)}`;
}

/**
 * A credentialed request may only target the configured origin, with the model
 * id as one encoded path segment and an empty query. Sending no credentialed
 * request (the id was rejected first) also satisfies this.
 */
function expectCredentialStaysOnEncodedSegment(
  requests: readonly SeenRequest[],
  baseURL: string,
  modelId: string,
) {
  const base = new URL(baseURL);
  const expectedPath = expectedModelPath(baseURL, modelId);

  for (const request of requests.filter(request => request.xKey != null)) {
    expect({
      href: request.href,
      origin: request.origin,
      pathname: request.pathname,
      search: request.search,
      method: request.method,
      xKey: request.xKey,
    }).toEqual({
      href: request.href,
      origin: base.origin,
      pathname: expectedPath,
      search: '',
      method: 'POST',
      xKey: PLACEHOLDER_KEY,
    });
  }
}

function expectDocumentedModelWasCalled(
  requests: readonly SeenRequest[],
  baseURL: string,
  modelId: string,
) {
  const base = new URL(baseURL);
  const expectedPath = expectedModelPath(baseURL, modelId);
  expect(requests).toContainEqual(
    expect.objectContaining({
      method: 'POST',
      origin: base.origin,
      pathname: expectedPath,
      search: '',
      xKey: PLACEHOLDER_KEY,
    }),
  );
}

async function settle(result: Promise<unknown>) {
  await result.catch(() => undefined);
}

function recordingFetch(requests: SeenRequest[]): FetchFunction {
  return async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    requests.push(seenRequest(url, init?.method ?? 'GET', init?.headers));
    return new Response(JSON.stringify({ message: 'stopped by test' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('Black Forest Labs model id path', () => {
  const baseURL = 'https://api.bfl.ai/v1';

  describe('image doGenerate', () => {
    it.each(documentedImageModelIds)(
      'posts a documented id %s as one path segment with the provider key',
      async modelId => {
        const requests: SeenRequest[] = [];
        const provider = createBlackForestLabs({
          apiKey: PLACEHOLDER_KEY,
          baseURL,
          fetch: recordingFetch(requests),
        });

        await settle(provider.image(modelId).doGenerate(imageCall));

        expectDocumentedModelWasCalled(requests, baseURL, modelId);
        expectCredentialStaysOnEncodedSegment(requests, baseURL, modelId);
      },
    );

    it.each(injectedModelIds)(
      'rejects or encodes image model id %j before the provider key is attached',
      async modelId => {
        const requests: SeenRequest[] = [];
        const provider = createBlackForestLabs({
          apiKey: PLACEHOLDER_KEY,
          baseURL,
          fetch: recordingFetch(requests),
        });

        await settle(
          provider
            .image(modelId as BlackForestLabsImageModelId)
            .doGenerate(imageCall),
        );

        expectCredentialStaysOnEncodedSegment(requests, baseURL, modelId);
      },
    );

    it('uses the same image factory for imageModel()', async () => {
      const requests: SeenRequest[] = [];
      const provider = createBlackForestLabs({
        apiKey: PLACEHOLDER_KEY,
        baseURL,
        fetch: recordingFetch(requests),
      });
      const modelId = '../other-endpoint' as BlackForestLabsImageModelId;

      await settle(provider.imageModel(modelId).doGenerate(imageCall));

      expectCredentialStaysOnEncodedSegment(requests, baseURL, modelId);
    });
  });

  describe('video doStart and doGenerate', () => {
    it('posts the documented video id as one path segment with the provider key', async () => {
      const requests: SeenRequest[] = [];
      const provider = createBlackForestLabs({
        apiKey: PLACEHOLDER_KEY,
        baseURL,
        fetch: recordingFetch(requests),
      });
      const model = provider.video(documentedVideoModelId);

      await settle(model.doStart!(videoCall));

      expectDocumentedModelWasCalled(requests, baseURL, documentedVideoModelId);
      expectCredentialStaysOnEncodedSegment(
        requests,
        baseURL,
        documentedVideoModelId,
      );
    });

    it.each(injectedModelIds)(
      'rejects or encodes video model id %j before doStart attaches the provider key',
      async modelId => {
        const requests: SeenRequest[] = [];
        const provider = createBlackForestLabs({
          apiKey: PLACEHOLDER_KEY,
          baseURL,
          fetch: recordingFetch(requests),
        });
        const model = provider.video(modelId as BlackForestLabsVideoModelId);

        await settle(model.doStart!(videoCall));

        expectCredentialStaysOnEncodedSegment(requests, baseURL, modelId);
      },
    );

    it.each(['../other-endpoint', 'flux-kontext-pro?x='] as const)(
      'rejects or encodes video model id %j before doGenerate attaches the provider key',
      async modelId => {
        const requests: SeenRequest[] = [];
        const provider = createBlackForestLabs({
          apiKey: PLACEHOLDER_KEY,
          baseURL,
          fetch: recordingFetch(requests),
        });
        const model = provider.videoModel(
          modelId as BlackForestLabsVideoModelId,
        );

        await settle(model.doGenerate!(videoCall));

        expectCredentialStaysOnEncodedSegment(requests, baseURL, modelId);
      },
    );
  });

  describe('runtime fetch request target', () => {
    const nodeRuntime =
      typeof process !== 'undefined' && process.versions?.node != null;

    it.each(['../other-endpoint', 'flux-kontext-pro?x=', '..\\other-endpoint'])(
      'global fetch keeps image model id %j from moving the provider key off the encoded segment',
      async modelId => {
        if (!nodeRuntime) {
          return;
        }

        const { createServer } = await import('node:http');
        const requests: SeenRequest[] = [];
        const server = createServer((request, response) => {
          const host = request.headers.host ?? '127.0.0.1';
          const parsed = new URL(request.url ?? '/', `http://${host}`);
          const header = request.headers['x-key'];
          requests.push({
            method: request.method ?? '',
            href: parsed.href,
            origin: parsed.origin,
            pathname: parsed.pathname,
            search: parsed.search,
            xKey: Array.isArray(header)
              ? (header[0] ?? null)
              : (header ?? null),
          });
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ message: 'stopped by test' }));
        });

        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => resolve());
        });

        const address = server.address();
        if (address == null || typeof address === 'string') {
          throw new Error('Test server did not bind to a port.');
        }

        const localBaseURL = `http://127.0.0.1:${address.port}/v1`;
        try {
          const provider = createBlackForestLabs({
            apiKey: PLACEHOLDER_KEY,
            baseURL: localBaseURL,
          });

          await settle(
            provider
              .image(modelId as BlackForestLabsImageModelId)
              .doGenerate(imageCall),
          );

          expectCredentialStaysOnEncodedSegment(
            requests,
            localBaseURL,
            modelId,
          );
        } finally {
          await new Promise<void>(resolve => {
            server.close(() => resolve());
          });
        }
      },
    );
  });
});
