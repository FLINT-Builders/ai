import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createReplicate } from './replicate-provider';

const apiToken = 'placeholder-token';

/**
 * Model ids that are a single owner segment and a single name segment.
 * Dots are allowed inside a segment, but a segment of only dots is not.
 */
const safeModelIdPattern =
  /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

const injectedModelIds = [
  'owner/../../predictions',
  'owner/model?x=.',
  'owner/model#hash',
  '../account',
  'x/../../predictions?',
  'owner\\..\\..\\predictions',
  'owner/%2e%2e/%2e%2e/predictions',
  'owner/model/extra',
] as const;

type CapturedRequest = {
  method: string;
  target: string;
  sentConfiguredToken: boolean;
};

const captured: CapturedRequest[] = [];

let server: Server | undefined;
let baseURL: string | undefined;

describe('Replicate model id path injection', () => {
  beforeAll(async () => {
    const { createServer } = await import('node:http');

    server = createServer((request, response) => {
      captured.push({
        method: request.method ?? '',
        target: request.url ?? '',
        sentConfiguredToken:
          request.headers.authorization === `Bearer ${apiToken}`,
      });

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'prediction',
          status: 'succeeded',
          output: null,
          error: null,
          urls: {
            get: 'https://api.replicate.com/v1/predictions/prediction',
          },
        }),
      );
    });

    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => {
        server!.off('error', reject);
        resolve();
      });
    });

    const address = server.address();
    if (address == null || typeof address === 'string') {
      throw new Error('Expected the local server to listen on a TCP port.');
    }

    baseURL = `http://127.0.0.1:${address.port}/v1`;
  });

  beforeEach(() => {
    captured.length = 0;
  });

  afterAll(async () => {
    if (server == null) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      server!.close(error => {
        if (error == null) {
          resolve();
          return;
        }
        reject(error);
      });
    });
  });

  describe('image doGenerate', () => {
    it.each(injectedModelIds)(
      'does not send the API token for model id %j',
      async modelId => {
        await generateImage(modelId);

        expect(unsafeRequests(modelId)).toEqual([]);
      },
    );

    it('uses the same image model constructor for imageModel()', async () => {
      const provider = providerForTest();
      expect(provider.imageModel).toBe(provider.image);

      await generateImage('owner/../../predictions', 'imageModel');

      expect(unsafeRequests('owner/../../predictions')).toEqual([]);
    });
  });

  describe('video doStart', () => {
    it.each(injectedModelIds)(
      'does not send the API token for model id %j',
      async modelId => {
        await startVideo(modelId);

        expect(unsafeRequests(modelId)).toEqual([]);
      },
    );

    it('uses the same video model constructor for videoModel()', async () => {
      const provider = providerForTest();
      expect(provider.videoModel).toBe(provider.video);

      await startVideo('owner/model?x=.', 'videoModel');

      expect(unsafeRequests('owner/model?x=.')).toEqual([]);
    });
  });
});

function unsafeRequests(modelId: string): CapturedRequest[] {
  return captured.filter(request => !isAllowedPrediction(modelId, request));
}

function isAllowedPrediction(
  modelId: string,
  request: CapturedRequest,
): boolean {
  if (!request.sentConfiguredToken || request.method !== 'POST') {
    return false;
  }

  if (!safeModelIdPattern.test(modelId)) {
    return false;
  }

  const [owner, name] = modelId.split('/');
  if (owner === '.' || owner === '..' || name === '.' || name === '..') {
    return false;
  }

  return request.target === `/v1/models/${owner}/${name}/predictions`;
}

function providerForTest() {
  if (baseURL == null) {
    throw new Error('Local server did not start.');
  }

  return createReplicate({
    apiToken,
    baseURL,
  });
}

async function generateImage(
  modelId: string,
  factory: 'image' | 'imageModel' = 'image',
) {
  const provider = providerForTest();
  const model = provider[factory](modelId);

  try {
    await model.doGenerate({
      prompt: 'a cat',
      n: 1,
      size: undefined,
      aspectRatio: undefined,
      seed: undefined,
      files: undefined,
      mask: undefined,
      providerOptions: {},
    });
  } catch {
    // Generation may reject after the request. The recorded request is the result.
  }
}

async function startVideo(
  modelId: string,
  factory: 'video' | 'videoModel' = 'video',
) {
  const provider = providerForTest();
  const model = provider[factory](modelId);

  try {
    await model.doStart({
      prompt: 'a cat',
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
    });
  } catch {
    // Starting may reject after the request. The recorded request is the result.
  }
}
