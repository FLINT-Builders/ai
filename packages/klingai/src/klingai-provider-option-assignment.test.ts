import type { Experimental_VideoModelV4CallOptions as VideoModelV4CallOptions } from '@ai-sdk/provider';
import { createTestServer } from '@ai-sdk/test-server/with-vitest';
import { describe, expect, it } from 'vitest';
import { KlingAIVideoModel } from './klingai-video-model';

const baseURL = 'https://klingai.example.test';
const appPrompt = 'A moderated prompt composed by the application';
const appImageUrl = 'https://app.example/start-frame.png';
const appLastFrameUrl = 'https://app.example/last-frame.png';
const appReferenceUrl = 'https://app.example/reference.png';
const appMotionUrl = 'https://app.example/motion.mp4';
const attackerModel = 'attacker-billed-model';
const attackerPrompt = 'Attacker prompt that bypasses the application template';
const attackerImageUrl = 'https://attacker.example/media.png';
const attackerCallbackUrl = 'https://attacker.example/callback';
const appWebhookUrl = 'https://app.example/video-callback';

const taskResponse = {
  type: 'json-value' as const,
  body: {
    code: 0,
    message: 'success',
    data: { task_id: 'task-1' },
  },
};

const callDefaults = {
  n: 1,
  fps: undefined,
  resolution: undefined,
  seed: undefined,
  headers: {},
  abortSignal: undefined,
} as const;

async function submittedBody(
  calls: Array<{
    requestBodyJson: Promise<unknown>;
    requestHeaders: Record<string, string>;
    requestUrl: string;
    requestMethod: string;
  }>,
  run: () => Promise<unknown>,
  expectedUrl: string,
): Promise<Record<string, unknown> | undefined> {
  let refused = false;
  try {
    await run();
  } catch {
    refused = true;
  }

  if (refused) {
    expect(calls).toHaveLength(0);
    return undefined;
  }

  expect(calls).toHaveLength(1);
  expect(calls[0].requestMethod).toBe('POST');
  expect(calls[0].requestUrl).toBe(expectedUrl);
  expect(calls[0].requestHeaders.authorization).toBe('Bearer test-key');

  return (await calls[0].requestBodyJson) as Record<string, unknown>;
}

function createModel(modelId: string) {
  return new KlingAIVideoModel(modelId, {
    provider: 'klingai.video',
    baseURL,
    headers: { Authorization: 'Bearer test-key' },
  });
}

describe('KlingAI provider option assignment', () => {
  const server = createTestServer({
    [`${baseURL}/v1/videos/text2video`]: { response: taskResponse },
    [`${baseURL}/v1/videos/image2video`]: { response: taskResponse },
    [`${baseURL}/v1/videos/multi-image2video`]: { response: taskResponse },
    [`${baseURL}/v1/videos/motion-control`]: { response: taskResponse },
  });

  async function start(
    modelId: string,
    options: VideoModelV4CallOptions & { webhookUrl?: string },
    url: string,
  ) {
    return submittedBody(
      server.calls,
      () => createModel(modelId).doStart(options),
      url,
    );
  }

  it('keeps the text-to-video model, prompt, and call settings when extra provider option keys are present', async () => {
    const body = await start(
      'kling-v2.6-t2v',
      {
        ...callDefaults,
        prompt: appPrompt,
        image: undefined,
        frameImages: undefined,
        inputReferences: undefined,
        aspectRatio: '16:9',
        duration: 5,
        generateAudio: false,
        webhookUrl: appWebhookUrl,
        providerOptions: {
          klingai: {
            mode: 'std',
            model_name: attackerModel,
            prompt: attackerPrompt,
            aspect_ratio: '9:16',
            duration: '99',
            sound: 'on',
            image: attackerImageUrl,
            callback_url: attackerCallbackUrl,
          },
        },
      },
      `${baseURL}/v1/videos/text2video`,
    );

    if (body == null) {
      return;
    }

    expect(body).toMatchObject({
      model_name: 'kling-v2-6',
      prompt: appPrompt,
      aspect_ratio: '16:9',
      duration: '5',
      sound: 'off',
      mode: 'std',
      callback_url: appWebhookUrl,
    });
    expect(JSON.stringify(body)).not.toContain(attackerPrompt);
    expect(JSON.stringify(body)).not.toContain(attackerModel);
    expect(JSON.stringify(body)).not.toContain(attackerCallbackUrl);
  });

  it('keeps the image-to-video model, prompt, and frames when extra provider option keys are present', async () => {
    const body = await start(
      'kling-v2.6-i2v',
      {
        ...callDefaults,
        prompt: appPrompt,
        image: { type: 'url', url: appImageUrl },
        frameImages: [
          {
            frameType: 'last_frame',
            image: { type: 'url', url: appLastFrameUrl },
          },
        ],
        inputReferences: undefined,
        aspectRatio: undefined,
        duration: 5,
        generateAudio: undefined,
        webhookUrl: appWebhookUrl,
        providerOptions: {
          klingai: {
            mode: 'pro',
            model_name: attackerModel,
            prompt: attackerPrompt,
            image: attackerImageUrl,
            image_tail: attackerImageUrl,
            duration: '99',
            callback_url: attackerCallbackUrl,
          },
        },
      },
      `${baseURL}/v1/videos/image2video`,
    );

    if (body == null) {
      return;
    }

    expect(body).toMatchObject({
      model_name: 'kling-v2-6',
      prompt: appPrompt,
      image: appImageUrl,
      image_tail: appLastFrameUrl,
      duration: '5',
      mode: 'pro',
      callback_url: appWebhookUrl,
    });
    expect(JSON.stringify(body)).not.toContain(attackerPrompt);
    expect(JSON.stringify(body)).not.toContain(attackerImageUrl);
    expect(JSON.stringify(body)).not.toContain(attackerModel);
  });

  it('keeps the reference-to-video model, prompt, and image list when extra provider option keys are present', async () => {
    const body = await start(
      'kling-v2.6-i2v',
      {
        ...callDefaults,
        prompt: appPrompt,
        image: undefined,
        frameImages: undefined,
        inputReferences: [{ type: 'url', url: appReferenceUrl }],
        aspectRatio: '1:1',
        duration: 5,
        generateAudio: undefined,
        providerOptions: {
          klingai: {
            model_name: attackerModel,
            prompt: attackerPrompt,
            image_list: [{ image: attackerImageUrl }],
            aspect_ratio: '9:16',
            duration: '99',
            callback_url: attackerCallbackUrl,
          },
        },
      },
      `${baseURL}/v1/videos/multi-image2video`,
    );

    if (body == null) {
      return;
    }

    expect(body).toMatchObject({
      model_name: 'kling-v2-6',
      prompt: appPrompt,
      image_list: [{ image: appReferenceUrl }],
      aspect_ratio: '1:1',
      duration: '5',
    });
    expect(JSON.stringify(body)).not.toContain(attackerPrompt);
    expect(JSON.stringify(body)).not.toContain(attackerImageUrl);
    expect(JSON.stringify(body)).not.toContain(attackerModel);
  });

  it('keeps the motion-control model, prompt, and reference media when extra provider option keys are present', async () => {
    const body = await start(
      'kling-v2.6-motion-control',
      {
        ...callDefaults,
        prompt: appPrompt,
        image: { type: 'url', url: appImageUrl },
        frameImages: undefined,
        inputReferences: undefined,
        aspectRatio: undefined,
        duration: undefined,
        generateAudio: undefined,
        webhookUrl: appWebhookUrl,
        providerOptions: {
          klingai: {
            videoUrl: appMotionUrl,
            characterOrientation: 'image',
            mode: 'std',
            keepOriginalSound: 'yes',
            model_name: attackerModel,
            prompt: attackerPrompt,
            video_url: attackerImageUrl,
            image_url: attackerImageUrl,
            character_orientation: 'video',
            keep_original_sound: 'no',
            callback_url: attackerCallbackUrl,
          },
        },
      },
      `${baseURL}/v1/videos/motion-control`,
    );

    if (body == null) {
      return;
    }

    expect(body).toMatchObject({
      model_name: 'kling-v2-6',
      prompt: appPrompt,
      video_url: appMotionUrl,
      image_url: appImageUrl,
      character_orientation: 'image',
      mode: 'std',
      keep_original_sound: 'yes',
      callback_url: appWebhookUrl,
    });
    expect(JSON.stringify(body)).not.toContain(attackerPrompt);
    expect(JSON.stringify(body)).not.toContain(attackerImageUrl);
    expect(JSON.stringify(body)).not.toContain(attackerModel);
    expect(JSON.stringify(body)).not.toContain(attackerCallbackUrl);
  });
});
