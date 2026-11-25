import { createServer, type Server } from 'node:http';
import type { Experimental_VideoModelV4CallOptions } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { createBlackForestLabs } from './black-forest-labs-provider';

/**
 * Security spec for model ids interpolated into credentialed Black Forest Labs
 * requests. These tests fail while a model id can move the configured API key
 * onto another path or query, and pass once the id is confined to one path
 * segment under the configured base URL (or rejected before any request).
 */
const placeholderApiKey = 'placeholder-bfl-api-key';

const videoOptions: Experimental_VideoModelV4CallOptions = {
  prompt: 'A white kitten chases a butterfly.',
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

type CapturedRequest = {
  method: string;
  target: string;
  credentialed: boolean;
};

/**
 * The request target Node records is the path and query on the wire, not a
 * WHATWG relative URL. A target of `//other` must stay a path.
 */
function staysOnSingleModelSegment(
  baseURL: string,
  requestTarget: string,
): boolean {
  const hashIndex = requestTarget.indexOf('#');
  if (hashIndex !== -1) {
    return false;
  }

  const queryIndex = requestTarget.indexOf('?');
  const path =
    queryIndex === -1 ? requestTarget : requestTarget.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : requestTarget.slice(queryIndex);
  if (query !== '') {
    return false;
  }

  const basePath = new URL(baseURL).pathname.replace(/\/$/, '');
  const prefix = `${basePath}/`;
  if (!path.startsWith(prefix)) {
    return false;
  }

  const segment = path.slice(prefix.length);
  return (
    segment.length > 0 &&
    !segment.includes('/') &&
    segment !== '.' &&
    segment !== '..'
  );
}

async function captureRequests(
  run: (baseURL: string) => Promise<unknown>,
): Promise<{ baseURL: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((request, response) => {
    requests.push({
      method: request.method ?? '',
      target: request.url ?? '',
      credentialed: request.headers['x-key'] === placeholderApiKey,
    });
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end('{"message":"stop"}');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (address == null || typeof address === 'string') {
    server.close();
    throw new Error('test server did not bind to a TCP port');
  }

  const baseURL = `http://127.0.0.1:${address.port}/v1`;

  try {
    await run(baseURL);
  } catch {
    // Rejection before a request is a valid fix. A 500 from this server also
    // rejects, after the request has been recorded.
  } finally {
    await new Promise<void>(resolve => {
      server.close(() => resolve());
    });
  }

  return { baseURL, requests };
}

function describeRequests(requests: CapturedRequest[]): string {
  return requests
    .map(
      request =>
        `${request.method} ${request.target} credentialed=${request.credentialed}`,
    )
    .join('\n');
}

async function expectCredentialedRequestsStayOnModelSegment(
  run: (baseURL: string) => Promise<unknown>,
) {
  const { baseURL, requests } = await captureRequests(run);
  const escaped = requests.filter(
    request =>
      request.credentialed &&
      !staysOnSingleModelSegment(baseURL, request.target),
  );

  expect(escaped, describeRequests(requests)).toEqual([]);
}

describe('Black Forest Labs model id path', () => {
  it('posts a flux-3-video start to a single segment under the base URL', async () => {
    const { requests } = await captureRequests(baseURL =>
      createBlackForestLabs({
        apiKey: placeholderApiKey,
        baseURL,
      })
        .video('flux-3-video')
        .doStart(videoOptions),
    );

    expect(
      requests
        .filter(request => request.credentialed)
        .map(request => `${request.method} ${request.target}`),
    ).toEqual(['POST /v1/flux-3-video']);
  });

  it('does not send the configured key outside the base path when video doStart is given ../other', async () => {
    await expectCredentialedRequestsStayOnModelSegment(baseURL =>
      createBlackForestLabs({
        apiKey: placeholderApiKey,
        baseURL,
      })
        .video('../other')
        .doStart(videoOptions),
    );
  });

  it('does not send the configured key outside the base path when videoModel doStart is given a traversed id', async () => {
    await expectCredentialedRequestsStayOnModelSegment(baseURL =>
      createBlackForestLabs({
        apiKey: placeholderApiKey,
        baseURL,
      })
        .videoModel('flux-3-video/../../other')
        .doStart(videoOptions),
    );
  });

  it('does not add a query string from the model id on video doStart', async () => {
    await expectCredentialedRequestsStayOnModelSegment(baseURL =>
      createBlackForestLabs({
        apiKey: placeholderApiKey,
        baseURL,
      })
        .video('flux-3-video?injected=1')
        .doStart(videoOptions),
    );
  });

  it('does not treat a backslash in the video model id as an extra path separator', async () => {
    await expectCredentialedRequestsStayOnModelSegment(baseURL =>
      createBlackForestLabs({
        apiKey: placeholderApiKey,
        baseURL,
      })
        .video('..\\other')
        .doStart(videoOptions),
    );
  });

  it('does not send the configured key to an extra path segment on video doStart', async () => {
    await expectCredentialedRequestsStayOnModelSegment(baseURL =>
      createBlackForestLabs({
        apiKey: placeholderApiKey,
        baseURL,
      })
        .video('flux-3-video/extra')
        .doStart(videoOptions),
    );
  });

  it('does not send the configured key outside the base path when video doGenerate is given ../other', async () => {
    await expectCredentialedRequestsStayOnModelSegment(baseURL =>
      createBlackForestLabs({
        apiKey: placeholderApiKey,
        baseURL,
      })
        .video('../other')
        .doGenerate(videoOptions),
    );
  });

  it('does not send the configured key outside the base path when image doGenerate is given ../other', async () => {
    await expectCredentialedRequestsStayOnModelSegment(baseURL =>
      createBlackForestLabs({
        apiKey: placeholderApiKey,
        baseURL,
      })
        .image('../other')
        .doGenerate({
          prompt: 'A cat',
          n: 1,
          files: undefined,
          mask: undefined,
          size: undefined,
          aspectRatio: undefined,
          seed: undefined,
          providerOptions: {},
        }),
    );
  });

  it('does not add a query string from the model id on image doGenerate', async () => {
    await expectCredentialedRequestsStayOnModelSegment(baseURL =>
      createBlackForestLabs({
        apiKey: placeholderApiKey,
        baseURL,
      })
        .image('flux-pro-1.1?injected=1')
        .doGenerate({
          prompt: 'A cat',
          n: 1,
          files: undefined,
          mask: undefined,
          size: undefined,
          aspectRatio: undefined,
          seed: undefined,
          providerOptions: {},
        }),
    );
  });

  it('does not send the configured key to an extra path segment on image doGenerate', async () => {
    await expectCredentialedRequestsStayOnModelSegment(baseURL =>
      createBlackForestLabs({
        apiKey: placeholderApiKey,
        baseURL,
      })
        .imageModel('flux-pro-1.1/extra')
        .doGenerate({
          prompt: 'A cat',
          n: 1,
          files: undefined,
          mask: undefined,
          size: undefined,
          aspectRatio: undefined,
          seed: undefined,
          providerOptions: {},
        }),
    );
  });
});
