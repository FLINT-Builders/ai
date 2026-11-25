import { describe, expect, it } from 'vitest';
import { experimental_generateVideo } from '../../ai/src/generate-video/generate-video';
import { createGoogle } from './google-provider';

const placeholderApiKey = 'test-api-key';
const modelId = 'veo-3.1-generate-preview';
const prompt = 'A lighthouse in a storm';

const predictPath = `/models/${modelId}:predictLongRunning`;

/**
 * Client-supplied Google provider options. Named fields such as
 * personGeneration are forwarded by the application. The extra keys are the
 * ones the loose schema must not copy onto the Veo parameters object.
 */
const clientGoogleOptions = {
  pollIntervalMs: 1000,
  pollTimeoutMs: 2000,
  personGeneration: 'allow_adult' as const,
  negativePrompt: 'blurry',
  sampleCount: 8,
  durationSeconds: 60,
  resolution: '4k',
  aspectRatio: '9:16',
  seed: 999,
  outputGcsUri: 'gs://attacker/out',
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
    const headers = (init?.headers as Record<string, string>) ?? {};

    if (urlString.includes(':predictLongRunning')) {
      captured.push({
        url: urlString,
        body: JSON.parse(String(init?.body)),
        headers,
      });

      return new Response(
        JSON.stringify({ name: 'operations/video-op', done: false }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({
        name: 'operations/video-op',
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [
              {
                video: {
                  uri: 'https://generativelanguage.googleapis.com/files/video.mp4',
                },
              },
            ],
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
}

const serverVideoSettings = {
  n: 1,
  duration: 6,
  resolution: '1280x720' as const,
  aspectRatio: '16:9' as const,
  seed: 7,
};

const safeParameters = {
  sampleCount: 1,
  durationSeconds: 6,
  resolution: '720p',
  aspectRatio: '16:9',
  seed: 7,
  personGeneration: 'allow_adult',
  negativePrompt: 'blurry',
};

describe('Google video provider option mass assignment', () => {
  it('posts server-chosen Veo parameters and drops extra provider option keys', async () => {
    const captured: CapturedRequest[] = [];
    const google = createGoogle({
      apiKey: placeholderApiKey,
      fetch: createFetch(captured),
    });

    await google.video(modelId).doStart({
      prompt,
      ...serverVideoSettings,
      image: undefined,
      frameImages: undefined,
      inputReferences: undefined,
      fps: undefined,
      generateAudio: undefined,
      providerOptions: { google: clientGoogleOptions },
      headers: { 'x-request-id': 'server-request' },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(
      `https://generativelanguage.googleapis.com/v1beta${predictPath}`,
    );
    expect(captured[0].headers['x-goog-api-key']).toBe(placeholderApiKey);
    expect(captured[0].body.instances).toStrictEqual([{ prompt }]);
    expect(captured[0].body.parameters).toStrictEqual(safeParameters);
  });

  it('does not let a null sampleCount provider option clear the server count', async () => {
    const captured: CapturedRequest[] = [];
    const google = createGoogle({
      apiKey: placeholderApiKey,
      fetch: createFetch(captured),
    });

    await google.video(modelId).doStart({
      prompt,
      ...serverVideoSettings,
      image: undefined,
      frameImages: undefined,
      inputReferences: undefined,
      fps: undefined,
      generateAudio: undefined,
      providerOptions: {
        google: {
          personGeneration: 'dont_allow',
          sampleCount: null,
          durationSeconds: null,
        },
      },
    });

    expect(captured[0].body.parameters.sampleCount).toBe(1);
    expect(captured[0].body.parameters.durationSeconds).toBe(6);
    expect(captured[0].body.parameters).not.toHaveProperty('sampleCount', null);
    expect(captured[0].body.parameters.personGeneration).toBe('dont_allow');
  });

  it('experimental_generateVideo sends the server sample count on the authenticated predict call', async () => {
    const captured: CapturedRequest[] = [];
    const google = createGoogle({
      apiKey: placeholderApiKey,
      fetch: createFetch(captured),
    });

    await experimental_generateVideo({
      model: google.video(modelId),
      prompt,
      ...serverVideoSettings,
      maxRetries: 0,
      providerOptions: { google: clientGoogleOptions },
      poll: {
        intervalMs: 1,
        timeoutMs: 5_000,
        delay: async () => {},
      },
      download: async () => ({
        data: new Uint8Array([0, 1, 2]),
        mediaType: 'video/mp4',
      }),
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain(':predictLongRunning');
    expect(captured[0].headers['x-goog-api-key']).toBe(placeholderApiKey);
    expect(captured[0].body.parameters).toStrictEqual(safeParameters);
  });

  it('experimental_generateVideo keeps each call at maxVideosPerCall when provider options raise sampleCount', async () => {
    const captured: CapturedRequest[] = [];
    const google = createGoogle({
      apiKey: placeholderApiKey,
      fetch: createFetch(captured),
    });

    await experimental_generateVideo({
      model: google.video(modelId),
      prompt,
      n: 8,
      duration: 6,
      maxRetries: 0,
      providerOptions: {
        google: {
          personGeneration: 'allow_adult',
          sampleCount: 20,
          durationSeconds: 60,
        },
      },
      poll: {
        intervalMs: 1,
        timeoutMs: 5_000,
        delay: async () => {},
      },
      download: async () => ({
        data: new Uint8Array([0, 1, 2]),
        mediaType: 'video/mp4',
      }),
    });

    expect(captured).toHaveLength(2);
    expect(captured.map(request => request.body.parameters)).toStrictEqual([
      {
        sampleCount: 4,
        durationSeconds: 6,
        personGeneration: 'allow_adult',
      },
      {
        sampleCount: 4,
        durationSeconds: 6,
        personGeneration: 'allow_adult',
      },
    ]);
    for (const request of captured) {
      expect(request.headers['x-goog-api-key']).toBe(placeholderApiKey);
    }
  });
});
