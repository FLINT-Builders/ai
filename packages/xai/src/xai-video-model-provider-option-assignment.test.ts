import { createTestServer } from '@ai-sdk/test-server/with-vitest';
import { describe, expect, it } from 'vitest';
import { experimental_generateVideo } from '../../ai/src/generate-video/generate-video';
import { experimental_startVideo } from '../../ai/src/generate-video/start-video';
import { XaiVideoModel } from './xai-video-model';

const SERVER_PROMPT = 'server chosen prompt';
const ATTACKER_PROMPT = 'attacker chosen prompt';
const SERVER_MODEL = 'grok-imagine-video';
const ATTACKER_MODEL = 'grok-imagine-video-1.5';
const SERVER_IMAGE_URL = 'https://app.example/start.png';
const ATTACKER_IMAGE_URL = 'https://attacker.example/image.png';
const SERVER_VIDEO_URL = 'https://app.example/source.mp4';
const ATTACKER_VIDEO_URL = 'https://attacker.example/source.mp4';
const SERVER_REFERENCE_URL = 'https://app.example/reference.png';
const ATTACKER_REFERENCE_URL = 'https://attacker.example/reference.png';
const TEST_BASE_URL = 'https://api.example.com';
const PLACEHOLDER_AUTHORIZATION = 'Bearer test-api-key';

const createVideoResponse = {
  request_id: 'req-123',
};

const doneStatusResponse = {
  status: 'done',
  video: {
    url: 'https://vidgen.x.ai/output/video-001.mp4',
    duration: 5,
    respect_moderation: true,
  },
  model: SERVER_MODEL,
  progress: 100,
};

function createModel() {
  return new XaiVideoModel(SERVER_MODEL, {
    provider: 'xai.video',
    baseURL: TEST_BASE_URL,
    headers: () => ({ Authorization: PLACEHOLDER_AUTHORIZATION }),
  });
}

const server = createTestServer({
  [`${TEST_BASE_URL}/videos/generations`]: {
    response: { type: 'json-value', body: createVideoResponse },
  },
  [`${TEST_BASE_URL}/videos/edits`]: {
    response: { type: 'json-value', body: createVideoResponse },
  },
  [`${TEST_BASE_URL}/videos/extensions`]: {
    response: { type: 'json-value', body: createVideoResponse },
  },
  [`${TEST_BASE_URL}/videos/req-123`]: {
    response: { type: 'json-value', body: doneStatusResponse },
  },
});

const baseCall = {
  prompt: SERVER_PROMPT,
  n: 1,
  image: undefined,
  frameImages: undefined,
  inputReferences: undefined,
  aspectRatio: '16:9' as const,
  resolution: '1280x720' as const,
  duration: 5,
  fps: undefined,
  generateAudio: undefined,
  seed: undefined,
  providerOptions: {},
};

/**
 * Extra keys a client can place on xAI provider options next to a setting
 * the application meant to forward, such as resolution.
 */
const injectedGenerationOptions = {
  resolution: '720p' as const,
  user: 'end-user-1',
  prompt: ATTACKER_PROMPT,
  model: ATTACKER_MODEL,
  image: { url: ATTACKER_IMAGE_URL },
  video: { url: ATTACKER_VIDEO_URL },
  duration: 99,
  aspect_ratio: '1:1',
  reference_images: [{ url: ATTACKER_REFERENCE_URL }],
  injected_option: 'present',
};

describe('xAI video provider option assignment', () => {
  it('posts the server prompt, model, and image when generation options carry extra keys', async () => {
    const model = createModel();

    await model.doStart({
      ...baseCall,
      image: { type: 'url', url: SERVER_IMAGE_URL },
      providerOptions: { xai: injectedGenerationOptions },
    });

    expect(server.calls[0].requestMethod).toBe('POST');
    expect(server.calls[0].requestUrl).toBe(
      `${TEST_BASE_URL}/videos/generations`,
    );
    expect(server.calls[0].requestHeaders.authorization).toBe(
      PLACEHOLDER_AUTHORIZATION,
    );
    expect(await server.calls[0].requestBodyJson).toStrictEqual({
      model: SERVER_MODEL,
      prompt: SERVER_PROMPT,
      duration: 5,
      aspect_ratio: '16:9',
      resolution: '720p',
      image: { url: SERVER_IMAGE_URL },
      user: 'end-user-1',
    });
  });

  it('does not add a source video when generation options include a video key and no start image', async () => {
    const model = createModel();

    await model.doStart({
      ...baseCall,
      providerOptions: {
        xai: {
          resolution: '480p',
          video: { url: ATTACKER_VIDEO_URL },
          image: { url: ATTACKER_IMAGE_URL },
          prompt: ATTACKER_PROMPT,
          model: ATTACKER_MODEL,
        },
      },
    });

    expect(server.calls[0].requestUrl).toBe(
      `${TEST_BASE_URL}/videos/generations`,
    );
    expect(await server.calls[0].requestBodyJson).toStrictEqual({
      model: SERVER_MODEL,
      prompt: SERVER_PROMPT,
      duration: 5,
      aspect_ratio: '16:9',
      resolution: '480p',
    });
  });

  it('keeps the edit source selected by videoUrl when options also include video and prompt', async () => {
    const model = createModel();

    await model.doStart({
      ...baseCall,
      providerOptions: {
        xai: {
          mode: 'edit-video',
          videoUrl: SERVER_VIDEO_URL,
          video: { url: ATTACKER_VIDEO_URL },
          prompt: ATTACKER_PROMPT,
          model: ATTACKER_MODEL,
          image: { url: ATTACKER_IMAGE_URL },
          user: 'end-user-1',
          injected_option: 'present',
        },
      },
    });

    expect(server.calls[0].requestUrl).toBe(`${TEST_BASE_URL}/videos/edits`);
    expect(server.calls[0].requestHeaders.authorization).toBe(
      PLACEHOLDER_AUTHORIZATION,
    );
    expect(await server.calls[0].requestBodyJson).toStrictEqual({
      model: SERVER_MODEL,
      prompt: SERVER_PROMPT,
      video: { url: SERVER_VIDEO_URL },
      user: 'end-user-1',
    });
  });

  it('keeps the extension source selected by videoUrl when options also include video and prompt', async () => {
    const model = createModel();

    await model.doStart({
      ...baseCall,
      duration: 8,
      providerOptions: {
        xai: {
          mode: 'extend-video',
          videoUrl: SERVER_VIDEO_URL,
          video: { url: ATTACKER_VIDEO_URL },
          prompt: ATTACKER_PROMPT,
          model: ATTACKER_MODEL,
          duration: 99,
          injected_option: 'present',
        },
      },
    });

    expect(server.calls[0].requestUrl).toBe(
      `${TEST_BASE_URL}/videos/extensions`,
    );
    expect(await server.calls[0].requestBodyJson).toStrictEqual({
      model: SERVER_MODEL,
      prompt: SERVER_PROMPT,
      duration: 8,
      video: { url: SERVER_VIDEO_URL },
    });
  });

  it('keeps reference images selected by the server when options include reference_images', async () => {
    const model = createModel();

    await model.doStart({
      ...baseCall,
      inputReferences: [{ type: 'url', url: SERVER_REFERENCE_URL }],
      providerOptions: {
        xai: {
          mode: 'reference-to-video',
          resolution: '1080p',
          reference_images: [{ url: ATTACKER_REFERENCE_URL }],
          reference_audios: [{ voice_id: 'attacker-voice' }],
          prompt: ATTACKER_PROMPT,
          model: ATTACKER_MODEL,
          injected_option: 'present',
        },
      },
    });

    expect(server.calls[0].requestUrl).toBe(
      `${TEST_BASE_URL}/videos/generations`,
    );
    expect(await server.calls[0].requestBodyJson).toStrictEqual({
      model: SERVER_MODEL,
      prompt: SERVER_PROMPT,
      duration: 5,
      aspect_ratio: '16:9',
      // reference-to-video downgrades 1080p to 720p before the body is posted
      resolution: '720p',
      reference_images: [{ url: SERVER_REFERENCE_URL }],
    });
  });

  it('keeps the server job when experimental_generateVideo forwards provider options', async () => {
    const model = createModel();

    await experimental_generateVideo({
      model,
      prompt: SERVER_PROMPT,
      duration: 5,
      aspectRatio: '16:9',
      resolution: '1280x720',
      providerOptions: { xai: injectedGenerationOptions },
      maxRetries: 0,
      poll: { intervalMs: 1, timeoutMs: 5_000 },
      download: async () => ({
        data: new Uint8Array([0]),
        mediaType: 'video/mp4',
      }),
    });

    const startCall = server.calls.find(
      call => call.requestUrl === `${TEST_BASE_URL}/videos/generations`,
    );
    expect(startCall).toBeDefined();
    expect(startCall!.requestHeaders.authorization).toBe(
      PLACEHOLDER_AUTHORIZATION,
    );
    expect(await startCall!.requestBodyJson).toStrictEqual({
      model: SERVER_MODEL,
      prompt: SERVER_PROMPT,
      duration: 5,
      aspect_ratio: '16:9',
      resolution: '720p',
      user: 'end-user-1',
    });
  });

  it('keeps the server job when experimental_startVideo forwards provider options', async () => {
    const model = createModel();

    await experimental_startVideo({
      model,
      prompt: {
        text: SERVER_PROMPT,
        image: SERVER_IMAGE_URL,
      },
      duration: 5,
      aspectRatio: '16:9',
      providerOptions: { xai: injectedGenerationOptions },
      maxRetries: 0,
    });

    expect(server.calls).toHaveLength(1);
    expect(server.calls[0].requestUrl).toBe(
      `${TEST_BASE_URL}/videos/generations`,
    );
    expect(server.calls[0].requestHeaders.authorization).toBe(
      PLACEHOLDER_AUTHORIZATION,
    );
    expect(await server.calls[0].requestBodyJson).toStrictEqual({
      model: SERVER_MODEL,
      prompt: SERVER_PROMPT,
      duration: 5,
      aspect_ratio: '16:9',
      resolution: '720p',
      image: { url: SERVER_IMAGE_URL },
      user: 'end-user-1',
    });
  });
});
