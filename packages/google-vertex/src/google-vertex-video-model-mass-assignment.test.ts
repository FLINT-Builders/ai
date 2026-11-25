import { describe, expect, it } from 'vitest';
import { createGoogleVertex } from './google-vertex-provider';

const placeholderApiKey = 'test-api-key';
const modelId = 'veo-3.1-generate-preview';
const prompt = 'A lighthouse in a storm';

const clientVertexOptions = {
  pollIntervalMs: 1000,
  pollTimeoutMs: 2000,
  personGeneration: 'allow_adult' as const,
  negativePrompt: 'blurry',
  gcsOutputDirectory: 'gs://app-bucket/outputs',
  sampleCount: 8,
  durationSeconds: 60,
  resolution: '4k',
  aspectRatio: '9:16',
  seed: 999,
  outputGcsUri: 'gs://attacker/out',
};

const safeParameters = {
  sampleCount: 1,
  durationSeconds: 6,
  resolution: '720p',
  aspectRatio: '16:9',
  seed: 7,
  generateAudio: false,
  personGeneration: 'allow_adult',
  negativePrompt: 'blurry',
  gcsOutputDirectory: 'gs://app-bucket/outputs',
};

type CapturedRequest = {
  url: string;
  body: {
    instances: Array<Record<string, unknown>>;
    parameters: Record<string, unknown>;
  };
  headers: Record<string, string>;
};

function createFetch(captured: CapturedRequest[]) {
  return async (url: string | URL, init?: RequestInit) => {
    const urlString = url.toString();

    if (urlString.includes(':predictLongRunning')) {
      captured.push({
        url: urlString,
        body: JSON.parse(String(init?.body)),
        headers: (init?.headers as Record<string, string>) ?? {},
      });

      return new Response(
        JSON.stringify({ name: 'operations/video-op', done: false }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return new Response('Not found', { status: 404 });
  };
}

async function startVideo(
  providerOptionsKey: 'googleVertex' | 'vertex',
  providerOptionsValue: Record<string, unknown>,
) {
  const captured: CapturedRequest[] = [];
  const vertex = createGoogleVertex({
    apiKey: placeholderApiKey,
    fetch: createFetch(captured),
  });

  await vertex.video(modelId).doStart({
    prompt,
    n: 1,
    duration: 6,
    resolution: '1280x720',
    aspectRatio: '16:9',
    seed: 7,
    generateAudio: false,
    image: undefined,
    frameImages: undefined,
    inputReferences: undefined,
    fps: undefined,
    providerOptions: { [providerOptionsKey]: providerOptionsValue },
  });

  return captured;
}

describe('Google Vertex video provider option mass assignment', () => {
  it.each(['googleVertex', 'vertex'] as const)(
    'posts server-chosen Veo parameters when extra keys arrive under %s',
    async providerOptionsKey => {
      const captured = await startVideo(
        providerOptionsKey,
        clientVertexOptions,
      );

      expect(captured).toHaveLength(1);
      expect(captured[0].url).toBe(
        `https://aiplatform.googleapis.com/v1/publishers/google/models/${modelId}:predictLongRunning`,
      );
      expect(captured[0].headers['x-goog-api-key']).toBe(placeholderApiKey);
      expect(captured[0].body.instances).toStrictEqual([{ prompt }]);
      expect(captured[0].body.parameters).toStrictEqual(safeParameters);
    },
  );

  it('does not let null billing keys from provider options replace the server values', async () => {
    const captured = await startVideo('vertex', {
      personGeneration: 'dont_allow',
      sampleCount: null,
      durationSeconds: null,
      resolution: null,
      aspectRatio: null,
      seed: null,
    });

    expect(captured[0].body.parameters.sampleCount).toBe(1);
    expect(captured[0].body.parameters.durationSeconds).toBe(6);
    expect(captured[0].body.parameters.resolution).toBe('720p');
    expect(captured[0].body.parameters.aspectRatio).toBe('16:9');
    expect(captured[0].body.parameters.seed).toBe(7);
    expect(captured[0].body.parameters.personGeneration).toBe('dont_allow');
  });
});
