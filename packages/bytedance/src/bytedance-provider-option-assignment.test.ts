import { createTestServer } from '@ai-sdk/test-server/with-vitest';
import { describe, expect, it } from 'vitest';
import { ByteDanceImageModel } from './bytedance-image-model';
import { createByteDance } from './bytedance-provider';
import { ByteDanceVideoModel } from './bytedance-video-model';

const baseURL = 'https://ark.example.test/api/v3';
const appPrompt = 'A moderated prompt composed by the application';
const appImageUrl = 'https://app.example/first-frame.png';
const appLastFrameUrl = 'https://app.example/last-frame.png';
const appSourceImageUrl = 'https://app.example/source.png';
const attackerModel = 'attacker-billed-model';
const attackerPrompt = 'Attacker prompt that bypasses the application template';
const attackerImageUrl = 'https://attacker.example/media.png';
const attackerCallbackUrl = 'https://attacker.example/callback';
const appWebhookUrl = 'https://app.example/video-callback';

const videoCallDefaults = {
  n: 1,
  fps: undefined,
  frameImages: undefined,
  inputReferences: undefined,
  headers: {},
  abortSignal: undefined,
} as const;

/**
 * A refusal before any provider request is a successful fix. A request that
 * still carries the caller's model, prompt media, and call settings is too.
 * A request that already replaced those fields is not, even if it then throws.
 */
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

describe('ByteDance provider option assignment', () => {
  const server = createTestServer({
    [`${baseURL}/contents/generations/tasks`]: {
      response: { type: 'json-value', body: { id: 'task-1' } },
    },
    [`${baseURL}/images/generations`]: {
      response: {
        type: 'json-value',
        body: { data: [{ b64_json: 'aW1hZ2U=' }] },
      },
    },
  });

  function createVideoModel() {
    return new ByteDanceVideoModel('seedance-1-0-pro-250528', {
      provider: 'bytedance.video',
      baseURL,
      headers: () => ({ Authorization: 'Bearer test-key' }),
    });
  }

  it('keeps the application video model, content, and call settings when extra provider option keys are present', async () => {
    const model = createByteDance({
      apiKey: 'test-key',
      baseURL,
    }).video('seedance-1-0-pro-250528');

    const body = await submittedBody(
      server.calls,
      () =>
        model.doStart!({
          ...videoCallDefaults,
          prompt: appPrompt,
          image: { type: 'url', url: appImageUrl },
          aspectRatio: '16:9',
          resolution: '1280x720',
          duration: 5,
          seed: 7,
          generateAudio: false,
          webhookUrl: appWebhookUrl,
          providerOptions: {
            bytedance: {
              cameraFixed: true,
              watermark: false,
              returnLastFrame: true,
              serviceTier: 'flex',
              lastFrameImage: appLastFrameUrl,
              model: attackerModel,
              content: [
                { type: 'text', text: attackerPrompt },
                {
                  type: 'image_url',
                  image_url: { url: attackerImageUrl },
                  role: 'first_frame',
                },
              ],
              callback_url: attackerCallbackUrl,
              ratio: '9:16',
              duration: 12,
              seed: 999,
              resolution: '1080p',
              generate_audio: true,
              camera_fixed: false,
              return_last_frame: false,
              service_tier: 'default',
            },
          },
        }),
      `${baseURL}/contents/generations/tasks`,
    );

    if (body == null) {
      return;
    }

    expect(body).toMatchObject({
      model: 'seedance-1-0-pro-250528',
      content: [
        { type: 'text', text: appPrompt },
        {
          type: 'image_url',
          image_url: { url: appImageUrl },
          role: 'first_frame',
        },
        {
          type: 'image_url',
          image_url: { url: appLastFrameUrl },
          role: 'last_frame',
        },
      ],
      ratio: '16:9',
      duration: 5,
      seed: 7,
      resolution: '720p',
      generate_audio: false,
      camera_fixed: true,
      watermark: false,
      return_last_frame: true,
      service_tier: 'flex',
      callback_url: appWebhookUrl,
    });
    expect(JSON.stringify(body)).not.toContain(attackerPrompt);
    expect(JSON.stringify(body)).not.toContain(attackerImageUrl);
    expect(JSON.stringify(body)).not.toContain(attackerModel);
    expect(JSON.stringify(body)).not.toContain(attackerCallbackUrl);
  });

  it('keeps the application video model and content when generateVideo would omit webhookUrl', async () => {
    const model = createVideoModel();

    const body = await submittedBody(
      server.calls,
      () =>
        model.doStart({
          ...videoCallDefaults,
          prompt: appPrompt,
          image: undefined,
          aspectRatio: undefined,
          resolution: undefined,
          duration: undefined,
          seed: undefined,
          generateAudio: undefined,
          providerOptions: {
            bytedance: {
              cameraFixed: true,
              model: attackerModel,
              content: [{ type: 'text', text: attackerPrompt }],
              callback_url: attackerCallbackUrl,
            },
          },
        }),
      `${baseURL}/contents/generations/tasks`,
    );

    if (body == null) {
      return;
    }

    expect(body).toMatchObject({
      model: 'seedance-1-0-pro-250528',
      content: [{ type: 'text', text: appPrompt }],
      camera_fixed: true,
    });
    expect(body.content).not.toEqual([{ type: 'text', text: attackerPrompt }]);
    expect(body.model).not.toBe(attackerModel);
  });

  it.each([
    {
      name: 'a single source image',
      files: [{ type: 'url' as const, url: appSourceImageUrl }],
      image: appSourceImageUrl,
    },
    {
      name: 'several source images',
      files: [
        { type: 'url' as const, url: appSourceImageUrl },
        { type: 'url' as const, url: 'https://app.example/second.png' },
      ],
      image: [appSourceImageUrl, 'https://app.example/second.png'],
    },
  ])(
    'keeps the application image model, prompt, and $name when extra provider option keys are present',
    async ({ files, image }) => {
      const model = new ByteDanceImageModel('seedream-5-0-260128', {
        provider: 'bytedance.image',
        baseURL,
        headers: () => ({ Authorization: 'Bearer test-key' }),
      });

      const body = await submittedBody(
        server.calls,
        () =>
          model.doGenerate({
            prompt: appPrompt,
            files,
            mask: undefined,
            n: 1,
            size: '2048x2048',
            aspectRatio: undefined,
            seed: undefined,
            headers: {},
            abortSignal: undefined,
            providerOptions: {
              bytedance: {
                watermark: false,
                model: attackerModel,
                prompt: attackerPrompt,
                image: attackerImageUrl,
                response_format: 'url',
              },
            },
          }),
        `${baseURL}/images/generations`,
      );

      if (body == null) {
        return;
      }

      expect(body).toMatchObject({
        model: 'seedream-5-0-260128',
        prompt: appPrompt,
        image,
        watermark: false,
        size: '2048x2048',
        response_format: 'b64_json',
      });
      expect(JSON.stringify(body)).not.toContain(attackerPrompt);
      expect(JSON.stringify(body)).not.toContain(attackerImageUrl);
      expect(JSON.stringify(body)).not.toContain(attackerModel);
    },
  );
});
