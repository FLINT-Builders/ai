import { createTestServer } from '@ai-sdk/test-server/with-vitest';
import { describe, expect, it } from 'vitest';
import { ByteDanceVideoModel } from './bytedance-video-model';

const appPrompt = 'A futuristic city with flying cars';
const configuredModelId = 'seedance-1-0-pro-250528';
const apiKeyHeader = 'Bearer test-key';
const appWebhook = 'https://app.example/video-callback';

const callerOptions = {
  watermark: true,
  // Unlisted key. The pass-through is intentional for keys the SDK does not set.
  negative_prompt: 'blur',
  model: 'seedance-1-0-lite-attacker',
  content: [{ type: 'text', text: 'replace the app prompt' }],
  duration: 99,
  ratio: '1:1',
  resolution: '1080p',
  generate_audio: false,
  callback_url: 'https://attacker.example/callback',
};

function createModel() {
  return new ByteDanceVideoModel(configuredModelId, {
    provider: 'bytedance.video',
    baseURL: 'https://api.example.com/api/v3',
    headers: () => ({ Authorization: apiKeyHeader }),
  });
}

describe('ByteDanceVideoModel reserved request fields', () => {
  const server = createTestServer({
    'https://api.example.com/api/v3/contents/generations/tasks': {
      response: {
        type: 'json-value',
        body: { id: 'test-task-id-123' },
      },
    },
  });

  it('keeps the SDK model, prompt content, and generation settings when caller options repeat those keys', async () => {
    const model = createModel();

    await model.doStart({
      prompt: appPrompt,
      n: 1,
      aspectRatio: '16:9',
      resolution: '1280x720',
      duration: 5,
      fps: undefined,
      seed: undefined,
      generateAudio: true,
      webhookUrl: appWebhook,
      providerOptions: { bytedance: callerOptions },
    });

    expect(server.calls[0].requestUrl).toBe(
      'https://api.example.com/api/v3/contents/generations/tasks',
    );
    expect(server.calls[0].requestHeaders).toMatchObject({
      authorization: apiKeyHeader,
      'content-type': 'application/json',
    });
    expect(await server.calls[0].requestBodyJson).toStrictEqual({
      model: configuredModelId,
      content: [{ type: 'text', text: appPrompt }],
      ratio: '16:9',
      duration: 5,
      resolution: '720p',
      generate_audio: true,
      watermark: true,
      negative_prompt: 'blur',
      callback_url: appWebhook,
    });
  });
});
