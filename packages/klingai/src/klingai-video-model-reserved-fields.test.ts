import { createTestServer } from '@ai-sdk/test-server/with-vitest';
import { describe, expect, it } from 'vitest';
import { KlingAIVideoModel } from './klingai-video-model';

const appPrompt = 'A character performs a graceful dance';
const apiKeyHeader = 'Bearer test-key';
const baseURL = 'https://api.example.com';

const benignExtra = {
  // Unlisted key. The pass-through is intentional for keys the SDK does not set.
  external_task_id: 'app-task',
};

function createModel(modelId: string) {
  return new KlingAIVideoModel(modelId, {
    provider: 'klingai.video',
    baseURL,
    headers: { Authorization: apiKeyHeader },
  });
}

describe('KlingAIVideoModel reserved request fields', () => {
  const server = createTestServer({
    [`${baseURL}/v1/videos/text2video`]: {
      response: {
        type: 'json-value',
        body: {
          code: 0,
          message: 'success',
          data: { task_id: 'task-abc-123' },
        },
      },
    },
    [`${baseURL}/v1/videos/image2video`]: {
      response: {
        type: 'json-value',
        body: {
          code: 0,
          message: 'success',
          data: { task_id: 'task-abc-123' },
        },
      },
    },
    [`${baseURL}/v1/videos/multi-image2video`]: {
      response: {
        type: 'json-value',
        body: {
          code: 0,
          message: 'success',
          data: { task_id: 'task-abc-123' },
        },
      },
    },
    [`${baseURL}/v1/videos/motion-control`]: {
      response: {
        type: 'json-value',
        body: {
          code: 0,
          message: 'success',
          data: { task_id: 'task-abc-123' },
        },
      },
    },
  });

  it('keeps the text-to-video prompt and model name', async () => {
    await createModel('kling-v2.6-t2v').doStart({
      prompt: appPrompt,
      n: 1,
      aspectRatio: '16:9',
      duration: 5,
      webhookUrl: 'https://app.example/video-callback',
      providerOptions: {
        klingai: {
          mode: 'pro',
          cfgScale: 0.5,
          ...benignExtra,
          model_name: 'kling-attacker',
          prompt: 'replace the app prompt',
          aspect_ratio: '9:16',
          duration: '99',
          cfg_scale: 0,
          callback_url: 'https://attacker.example/callback',
        },
      },
    });

    expect(server.calls[0].requestUrl).toBe(`${baseURL}/v1/videos/text2video`);
    expect(server.calls[0].requestHeaders).toMatchObject({
      authorization: apiKeyHeader,
    });
    expect(await server.calls[0].requestBodyJson).toStrictEqual({
      model_name: 'kling-v2-6',
      prompt: appPrompt,
      mode: 'pro',
      cfg_scale: 0.5,
      aspect_ratio: '16:9',
      duration: '5',
      external_task_id: 'app-task',
      callback_url: 'https://app.example/video-callback',
    });
  });

  it('keeps the image-to-video prompt, model name, and input image', async () => {
    const appImage = 'https://example.com/start-frame.png';
    const appTail = 'https://example.com/end-frame.png';

    await createModel('kling-v2.6-i2v').doStart({
      prompt: appPrompt,
      n: 1,
      image: { type: 'url', url: appImage },
      duration: 5,
      providerOptions: {
        klingai: {
          mode: 'std',
          imageTail: appTail,
          ...benignExtra,
          model_name: 'kling-attacker',
          prompt: 'replace the app prompt',
          image: 'https://attacker.example/image.png',
          image_tail: 'https://attacker.example/tail.png',
          duration: '99',
        },
      },
    });

    expect(server.calls[0].requestUrl).toBe(`${baseURL}/v1/videos/image2video`);
    expect(await server.calls[0].requestBodyJson).toStrictEqual({
      model_name: 'kling-v2-6',
      prompt: appPrompt,
      image: appImage,
      image_tail: appTail,
      mode: 'std',
      duration: '5',
      external_task_id: 'app-task',
    });
  });

  it('keeps the reference-to-video prompt, model name, and image list', async () => {
    await createModel('kling-v1.6-i2v').doStart({
      prompt: appPrompt,
      n: 1,
      aspectRatio: '16:9',
      duration: 5,
      inputReferences: [
        { type: 'url', url: 'https://example.com/character-1.png' },
        { type: 'url', url: 'https://example.com/character-2.png' },
      ],
      providerOptions: {
        klingai: {
          mode: 'std',
          ...benignExtra,
          model_name: 'kling-attacker',
          prompt: 'replace the app prompt',
          image_list: [{ image: 'https://attacker.example/only.png' }],
          aspect_ratio: '9:16',
          duration: '99',
        },
      },
    });

    expect(server.calls[0].requestUrl).toBe(
      `${baseURL}/v1/videos/multi-image2video`,
    );
    expect(await server.calls[0].requestBodyJson).toStrictEqual({
      model_name: 'kling-v1-6',
      prompt: appPrompt,
      image_list: [
        { image: 'https://example.com/character-1.png' },
        { image: 'https://example.com/character-2.png' },
      ],
      mode: 'std',
      aspect_ratio: '16:9',
      duration: '5',
      external_task_id: 'app-task',
    });
  });

  it('keeps the motion-control prompt, model name, and reference media', async () => {
    const appImage = 'https://example.com/character.png';
    const appVideo = 'https://example.com/reference-motion.mp4';

    await createModel('kling-v2.6-motion-control').doStart({
      prompt: appPrompt,
      n: 1,
      image: { type: 'url', url: appImage },
      providerOptions: {
        klingai: {
          mode: 'std',
          videoUrl: appVideo,
          characterOrientation: 'image',
          ...benignExtra,
          model_name: 'kling-attacker',
          prompt: 'replace the app prompt',
          video_url: 'https://attacker.example/motion.mp4',
          image_url: 'https://attacker.example/image.png',
          character_orientation: 'video',
        },
      },
    });

    expect(server.calls[0].requestUrl).toBe(
      `${baseURL}/v1/videos/motion-control`,
    );
    expect(await server.calls[0].requestBodyJson).toStrictEqual({
      model_name: 'kling-v2-6',
      prompt: appPrompt,
      video_url: appVideo,
      character_orientation: 'image',
      image_url: appImage,
      mode: 'std',
      external_task_id: 'app-task',
    });
  });
});
