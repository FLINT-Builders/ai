import { InvalidArgumentError } from '@ai-sdk/provider';
import { convertUint8ArrayToBase64 } from '@ai-sdk/provider-utils';
import { generateImage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { animateSvgResponseFixture } from './__fixtures__/quiverai-fixtures';
import { createQuiverAI } from './quiverai-provider';

const encoder = new TextEncoder();

/**
 * Empty XML comments, XML declarations, and DOCTYPE tags are each one
 * alternative in the repeated group `isSvg` uses for animate sources.
 * Twenty-eight of any of them, with no `<svg` tag after, is a few
 * hundred bytes. The vulnerable checker takes seconds and roughly doubles
 * with each extra copy. A linear scan of the same bytes finishes in well
 * under this budget, including a real SVG that starts with the same preamble.
 */
const PREAMBLE_COPIES = 28;
const MAX_VALIDATION_MS = 100;

type AnimateModelId = 'arrow-2' | 'arrow-2-telos';

function repeatedPreamble(unit: string): string {
  return unit.repeat(PREAMBLE_COPIES) + 'x';
}

function toBase64(value: string): string {
  return convertUint8ArrayToBase64(encoder.encode(value));
}

async function expectSettlesWithin<T>(
  run: () => Promise<T>,
): Promise<{ elapsedMs: number; value?: T; error?: unknown }> {
  const started = performance.now();
  try {
    const value = await run();
    return { elapsedMs: performance.now() - started, value };
  } catch (error) {
    return { elapsedMs: performance.now() - started, error };
  }
}

function expectSvgRejection(result: {
  elapsedMs: number;
  error?: unknown;
  fetch: ReturnType<typeof vi.fn>;
}) {
  expect(result.error).toBeInstanceOf(InvalidArgumentError);
  expect(result.error).toMatchObject({
    argument: 'files',
    message: 'QuiverAI animate requires the input file to contain SVG data.',
  });
  expect(result.fetch).not.toHaveBeenCalled();
  expect(
    result.elapsedMs,
    `animate source check took ${result.elapsedMs}ms`,
  ).toBeLessThan(MAX_VALIDATION_MS);
}

describe('QuiverAI animate SVG source validation', () => {
  it.each([
    {
      modelId: 'arrow-2' as const,
      label: 'empty comments',
      source: repeatedPreamble('<!---->'),
    },
    {
      modelId: 'arrow-2-telos' as const,
      label: 'empty comments',
      source: repeatedPreamble('<!---->'),
    },
    {
      modelId: 'arrow-2' as const,
      label: 'empty comments after leading whitespace',
      source: ` \n\t${repeatedPreamble('<!---->')}`,
    },
    {
      modelId: 'arrow-2' as const,
      label: 'XML declarations',
      source: repeatedPreamble('<?xml?>'),
    },
    {
      modelId: 'arrow-2' as const,
      label: 'DOCTYPE tags',
      source: repeatedPreamble('<!DOCTYPE>'),
    },
  ])(
    'rejects a $label upload for $modelId before any network call',
    async ({ modelId, source }) => {
      const fetch = vi.fn(async () => {
        throw new Error('animate validation must finish before fetch');
      });
      const provider = createQuiverAI({ apiKey: 'test-api-key', fetch });

      const result = await expectSettlesWithin(() =>
        generateImage({
          model: provider.image(modelId),
          maxRetries: 0,
          prompt: {
            images: [encoder.encode(source)],
          },
          providerOptions: {
            quiverai: { operation: 'animate' },
          },
        }),
      );

      expectSvgRejection({ ...result, fetch });
    },
    60_000,
  );

  it.each([
    {
      label: 'base64 string',
      image: (source: string) => toBase64(source),
    },
    {
      label: 'ArrayBuffer',
      image: (source: string) => {
        const bytes = encoder.encode(source);
        return bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        );
      },
    },
  ])(
    'rejects a comment-only $label passed through prompt.images',
    async ({ image }) => {
      const source = repeatedPreamble('<!---->');
      const fetch = vi.fn(async () => {
        throw new Error('animate validation must finish before fetch');
      });
      const provider = createQuiverAI({ apiKey: 'test-api-key', fetch });

      const result = await expectSettlesWithin(() =>
        generateImage({
          model: provider.image('arrow-2'),
          maxRetries: 0,
          prompt: {
            images: [image(source)],
          },
          providerOptions: {
            quiverai: { operation: 'animate' },
          },
        }),
      );

      expectSvgRejection({ ...result, fetch });
    },
    60_000,
  );

  it.each([
    {
      label: 'raw base64 file data',
      data: (source: string) => toBase64(source),
    },
    {
      label: 'SVG data URL',
      data: (source: string) => `data:image/svg+xml;base64,${toBase64(source)}`,
    },
  ])(
    'rejects $label supplied directly to doGenerate',
    async ({ data }) => {
      const source = repeatedPreamble('<!---->');
      const fetch = vi.fn(async () => {
        throw new Error('animate validation must finish before fetch');
      });
      const provider = createQuiverAI({ apiKey: 'test-api-key', fetch });

      const result = await expectSettlesWithin(() =>
        provider.image('arrow-2').doGenerate({
          prompt: undefined,
          n: 1,
          files: [
            {
              type: 'file',
              mediaType: 'image/svg+xml',
              data: data(source),
            },
          ],
          providerOptions: { quiverai: { operation: 'animate' } },
        }),
      );

      expectSvgRejection({ ...result, fetch });
    },
    60_000,
  );

  it('accepts an SVG whose preamble is the same comment sequence and sends that file', async () => {
    const source = `${'<!---->'.repeat(PREAMBLE_COPIES)}<svg xmlns="http://www.w3.org/2000/svg"/>`;
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(animateSvgResponseFixture), {
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const provider = createQuiverAI({ apiKey: 'test-api-key', fetch });

    const result = await expectSettlesWithin(() =>
      generateImage({
        model: provider.image('arrow-2'),
        maxRetries: 0,
        prompt: { images: [encoder.encode(source)] },
        providerOptions: { quiverai: { operation: 'animate' } },
      }),
    );

    expect(
      result.elapsedMs,
      `valid SVG preamble took ${result.elapsedMs}ms`,
    ).toBeLessThan(MAX_VALIDATION_MS);
    expect(result.error).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('https://api.quiver.ai/v1/svgs/animations');
    expect(JSON.parse(init.body)).toMatchObject({
      model: 'arrow-2',
      svg_source: { base64: toBase64(source) },
      stream: false,
    });
  });

  it.each([
    'arrow-2',
    'arrow-2-telos',
  ] as const satisfies readonly AnimateModelId[])(
    'accepts an SVG with an XML declaration, comment, and DOCTYPE on %s',
    async modelId => {
      const source =
        ' \n<?xml version="1.0"?>\n<!-- icon --><!DOCTYPE svg>\n<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>';
      const fetch = vi.fn(
        async () =>
          new Response(JSON.stringify(animateSvgResponseFixture), {
            headers: { 'Content-Type': 'application/json' },
          }),
      );
      const provider = createQuiverAI({ apiKey: 'test-api-key', fetch });

      const result = await expectSettlesWithin(() =>
        generateImage({
          model: provider.image(modelId),
          maxRetries: 0,
          prompt: { images: [encoder.encode(source)] },
          providerOptions: { quiverai: { operation: 'animate' } },
        }),
      );

      expect(result.elapsedMs).toBeLessThan(MAX_VALIDATION_MS);
      expect(result.error).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
      const [, init] = fetch.mock.calls[0] as [string, { body: string }];
      expect(JSON.parse(init.body).svg_source).toEqual({
        base64: toBase64(source),
      });
    },
  );
});
