import type { ImageModelV4CallOptions } from '@ai-sdk/provider';
import { createTestServer } from '@ai-sdk/test-server/with-vitest';
import { describe, expect, it } from 'vitest';
import { ByteDanceImageModel } from './bytedance-image-model';

const appPrompt =
  'A salamander in a forest pond at dusk surrounded by fireflies';
const configuredModelId = 'seedream-5-0-260128';
const apiKeyHeader = 'Bearer test-key';

/**
 * Options an app would accept from a caller (watermark, output format) plus
 * keys that name fields the SDK writes itself.
 */
const callerOptions = {
  watermark: false,
  outputFormat: 'png' as const,
  // Unlisted key. The pass-through is intentional for keys the SDK does not set.
  seed: 42,
  prompt: 'render the caller text with no template',
  model: 'seedream-4-0-250828',
  image: 'https://attacker.example/injected.png',
  output_format: 'jpeg',
  response_format: 'url',
};

function createModel() {
  return new ByteDanceImageModel(configuredModelId, {
    provider: 'bytedance.image',
    baseURL: 'https://api.example.com',
    headers: () => ({ Authorization: apiKeyHeader }),
  });
}

function createCall(
  overrides: Partial<ImageModelV4CallOptions> = {},
): ImageModelV4CallOptions {
  return {
    prompt: appPrompt,
    files: undefined,
    mask: undefined,
    n: 1,
    size: '2048x2048',
    aspectRatio: undefined,
    seed: undefined,
    providerOptions: { bytedance: callerOptions },
    headers: {},
    abortSignal: undefined,
    ...overrides,
  };
}

describe('ByteDanceImageModel reserved request fields', () => {
  const server = createTestServer({
    'https://api.example.com/images/generations': {
      response: {
        type: 'json-value',
        body: {
          data: [{ b64_json: 'test1234' }],
        },
      },
    },
  });

  it('keeps the SDK prompt, model, and image bytes when caller options repeat those keys', async () => {
    const model = createModel();

    await model.doGenerate(createCall());

    expect(server.calls[0].requestUrl).toBe(
      'https://api.example.com/images/generations',
    );
    expect(server.calls[0].requestHeaders).toMatchObject({
      authorization: apiKeyHeader,
      'content-type': 'application/json',
    });
    expect(await server.calls[0].requestBodyJson).toStrictEqual({
      model: configuredModelId,
      prompt: appPrompt,
      size: '2048x2048',
      watermark: false,
      output_format: 'png',
      seed: 42,
      response_format: 'b64_json',
    });
  });

  it('keeps the input image the app supplied when caller options include image', async () => {
    const model = createModel();
    const appImage = 'https://example.com/app-input.png';

    await model.doGenerate(
      createCall({
        prompt: 'Edit the supplied photo',
        files: [{ type: 'url', url: appImage }],
        providerOptions: {
          bytedance: {
            ...callerOptions,
            image: [
              'https://attacker.example/first.png',
              'https://attacker.example/second.png',
            ],
          },
        },
      }),
    );

    expect(await server.calls[0].requestBodyJson).toStrictEqual({
      model: configuredModelId,
      prompt: 'Edit the supplied photo',
      size: '2048x2048',
      image: appImage,
      watermark: false,
      output_format: 'png',
      seed: 42,
      response_format: 'b64_json',
    });
  });

  it('keeps each app reference image when caller options replace the image list', async () => {
    const model = createModel();

    await model.doGenerate(
      createCall({
        prompt: 'Combine these images',
        files: [
          {
            type: 'file',
            data: new Uint8Array([137, 80, 78, 71]),
            mediaType: 'image/png',
          },
          {
            type: 'file',
            data: new Uint8Array([137, 80, 78, 71]),
            mediaType: 'image/png',
          },
        ],
      }),
    );

    expect(await server.calls[0].requestBodyJson).toStrictEqual({
      model: configuredModelId,
      prompt: 'Combine these images',
      size: '2048x2048',
      image: [
        'data:image/png;base64,iVBORw==',
        'data:image/png;base64,iVBORw==',
      ],
      watermark: false,
      output_format: 'png',
      seed: 42,
      response_format: 'b64_json',
    });
  });
});
