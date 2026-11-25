import { InvalidArgumentError } from '@ai-sdk/provider';
import { createTestServer } from '@ai-sdk/test-server/with-vitest';
import { describe, expect, it } from 'vitest';
import { createLuma } from './luma-provider';

const applicationModelId = 'photon-flash-1';
const applicationPrompt = 'A moderated landscape';
const applicationAspectRatio = '1:1' as const;
const approvedImageUrl = 'https://cdn.example.com/approved-reference.jpg';
const untrustedImageUrl = 'https://untrusted.example/not-allowed.jpg';

const attackerGenerationFields = {
  model: 'photon-1',
  prompt: 'unreviewed prompt the application rejected',
  aspect_ratio: '16:9',
  image: [{ url: untrustedImageUrl, weight: 1 }],
  style: [{ url: untrustedImageUrl, weight: 1 }],
  character: {
    identity0: { images: [untrustedImageUrl] },
  },
  modify_image: { url: untrustedImageUrl, weight: 1 },
  additional_param: 'kept',
};

function createApplicationModel() {
  return createLuma({
    apiKey: 'application-api-key',
    baseURL: 'https://api.example.com',
  }).image(applicationModelId);
}

/**
 * The generation request must keep the fields the application chose.
 * Rejecting the options before any request is also safe. Sending the
 * attacker's model, prompt, aspect ratio, or image references is not.
 */
async function expectApplicationControlsGeneration({
  run,
  expectedBody,
  server,
}: {
  run: () => Promise<unknown>;
  expectedBody: Record<string, unknown>;
  server: ReturnType<typeof createTestServer>;
}) {
  try {
    await run();
  } catch (error) {
    expect(
      server.calls,
      'provider options must be rejected before a Luma request is sent',
    ).toEqual([]);
    expect(InvalidArgumentError.isInstance(error)).toBe(true);
    return;
  }

  expect(server.calls[0]?.requestMethod).toBe('POST');
  expect(server.calls[0]?.requestUrl).toBe(
    'https://api.example.com/dream-machine/v1/generations/image',
  );
  expect(server.calls[0]?.requestHeaders.authorization).toBe(
    'Bearer application-api-key',
  );
  expect(
    await server.calls[0].requestBodyJson,
    'provider option keys must not replace application-controlled generation fields',
  ).toStrictEqual(expectedBody);
}

describe('Luma image provider option overrides', () => {
  const server = createTestServer({
    'https://api.example.com/dream-machine/v1/generations/image': {
      response: {
        type: 'json-value',
        body: {
          id: 'test-generation-id',
          state: 'queued',
        },
      },
    },
    'https://api.example.com/dream-machine/v1/generations/test-generation-id': {
      response: {
        type: 'json-value',
        body: {
          id: 'test-generation-id',
          state: 'completed',
          assets: {
            image: 'https://api.example.com/image.png',
          },
        },
      },
    },
    'https://api.example.com/image.png': {
      response: {
        type: 'binary',
        body: Buffer.from('test-binary-content'),
      },
    },
  });

  it('does not let extra provider option keys replace the application model, prompt, or aspect ratio, or add image references', async () => {
    const model = createApplicationModel();

    await expectApplicationControlsGeneration({
      server,
      expectedBody: {
        prompt: applicationPrompt,
        aspect_ratio: applicationAspectRatio,
        model: applicationModelId,
        additional_param: 'kept',
      },
      run: () =>
        model.doGenerate({
          prompt: applicationPrompt,
          files: undefined,
          mask: undefined,
          n: 1,
          size: undefined,
          aspectRatio: applicationAspectRatio,
          seed: undefined,
          providerOptions: {
            luma: {
              referenceType: 'image',
              images: [{ weight: 0.4 }],
              ...attackerGenerationFields,
            },
          },
        }),
    });
  });

  it('does not let extra provider option keys replace reference image URLs chosen by the application', async () => {
    const model = createApplicationModel();

    await expectApplicationControlsGeneration({
      server,
      expectedBody: {
        prompt: applicationPrompt,
        aspect_ratio: applicationAspectRatio,
        model: applicationModelId,
        image: [{ url: approvedImageUrl, weight: 0.4 }],
        additional_param: 'kept',
      },
      run: () =>
        model.doGenerate({
          prompt: applicationPrompt,
          files: [{ type: 'url', url: approvedImageUrl }],
          mask: undefined,
          n: 1,
          size: undefined,
          aspectRatio: applicationAspectRatio,
          seed: undefined,
          providerOptions: {
            luma: {
              referenceType: 'image',
              images: [{ weight: 0.4 }],
              ...attackerGenerationFields,
            },
          },
        }),
    });
  });

  it('does not let extra provider option keys replace style reference URLs chosen by the application', async () => {
    const model = createApplicationModel();

    await expectApplicationControlsGeneration({
      server,
      expectedBody: {
        prompt: applicationPrompt,
        model: applicationModelId,
        style: [{ url: approvedImageUrl, weight: 0.3 }],
        additional_param: 'kept',
      },
      run: () =>
        model.doGenerate({
          prompt: applicationPrompt,
          files: [{ type: 'url', url: approvedImageUrl }],
          mask: undefined,
          n: 1,
          size: undefined,
          aspectRatio: undefined,
          seed: undefined,
          providerOptions: {
            luma: {
              referenceType: 'style',
              images: [{ weight: 0.3 }],
              ...attackerGenerationFields,
            },
          },
        }),
    });
  });

  it('does not let extra provider option keys replace character reference URLs chosen by the application', async () => {
    const model = createApplicationModel();

    await expectApplicationControlsGeneration({
      server,
      expectedBody: {
        prompt: applicationPrompt,
        model: applicationModelId,
        character: {
          identity0: { images: [approvedImageUrl] },
        },
        additional_param: 'kept',
      },
      run: () =>
        model.doGenerate({
          prompt: applicationPrompt,
          files: [{ type: 'url', url: approvedImageUrl }],
          mask: undefined,
          n: 1,
          size: undefined,
          aspectRatio: undefined,
          seed: undefined,
          providerOptions: {
            luma: {
              referenceType: 'character',
              images: [{ id: 'identity0' }],
              ...attackerGenerationFields,
            },
          },
        }),
    });
  });

  it('does not let extra provider option keys replace the modify_image source chosen by the application', async () => {
    const model = createApplicationModel();

    await expectApplicationControlsGeneration({
      server,
      expectedBody: {
        prompt: applicationPrompt,
        model: applicationModelId,
        modify_image: { url: approvedImageUrl, weight: 0.25 },
        additional_param: 'kept',
      },
      run: () =>
        model.doGenerate({
          prompt: applicationPrompt,
          files: [{ type: 'url', url: approvedImageUrl }],
          mask: undefined,
          n: 1,
          size: undefined,
          aspectRatio: undefined,
          seed: undefined,
          providerOptions: {
            luma: {
              referenceType: 'modify_image',
              images: [{ weight: 0.25 }],
              ...attackerGenerationFields,
            },
          },
        }),
    });
  });
});
