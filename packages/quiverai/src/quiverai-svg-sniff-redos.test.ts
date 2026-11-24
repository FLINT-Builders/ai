import { InvalidArgumentError } from '@ai-sdk/provider';
import { convertUint8ArrayToBase64 } from '@ai-sdk/provider-utils';
import { describe, expect, it } from 'vitest';
import { prepareQuiverAIImageReference } from './prepare-quiverai-image-reference';
import { createQuiverAI } from './quiverai-provider';

/**
 * Backtracking SVG sniffers must reject these inputs without stalling.
 *
 * On Node 22, `<svg `.repeat(60_000) takes about 10s in the reference-image
 * self-closing search, and the repeated `?><!--` / `--><!DOCTYPE` / `>`
 * prologue takes about 22s at 1_400 repetitions. The animate sniff, which
 * repeats those prologue groups, takes about 22s cold and about 3s warmed
 * up at 21 repetitions. A linear check on these sizes finishes well under
 * the limit. The sizes stay inside the 12_582_912-byte and 16_777_216-character
 * reference limits.
 *
 * `isSvgMarkup` (edit source documents), generate, and vectorize do not run
 * these sniffers. URL references are not decoded.
 */

const MAX_VALIDATION_MS = 500;
const TEST_TIMEOUT_MS = 60_000;

const REFERENCE_REJECTION =
  'QuiverAI reference images must be PNG, JPEG, WebP, GIF, or SVG data.';
const ANIMATE_REJECTION =
  'QuiverAI animate requires the input file to contain SVG data.';

const encoder = new TextEncoder();

const selfClosingBytes = encoder.encode('<svg '.repeat(60_000));
const selfClosingBase64 = convertUint8ArrayToBase64(selfClosingBytes);
const selfClosingBuffer = selfClosingBytes.buffer.slice(
  selfClosingBytes.byteOffset,
  selfClosingBytes.byteOffset + selfClosingBytes.byteLength,
);

const headerBytes = prologueBytes(1_400);
const headerBase64 = convertUint8ArrayToBase64(headerBytes);

const animateBytes = prologueBytes(21);
const animateBase64 = convertUint8ArrayToBase64(animateBytes);

function prologueBytes(repetitions: number): Uint8Array {
  return encoder.encode(
    `<?xml${'?><!--'.repeat(repetitions)}${'--><!DOCTYPE'.repeat(repetitions)}${'>'.repeat(repetitions)}`,
  );
}

function expectSyncRejection(run: () => unknown, message: string): void {
  const started = performance.now();
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(InvalidArgumentError);
  expect((caught as Error).message).toContain(message);
  expect(performance.now() - started).toBeLessThan(MAX_VALIDATION_MS);
}

async function expectAsyncRejection(
  run: () => Promise<unknown>,
  message: string,
  requests: string[],
): Promise<void> {
  const started = performance.now();
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(InvalidArgumentError);
  expect((caught as Error).message).toContain(message);
  expect(performance.now() - started).toBeLessThan(MAX_VALIDATION_MS);
  expect(requests).toEqual([]);
}

function createProvider() {
  const requests: string[] = [];
  const provider = createQuiverAI({
    apiKey: 'test-api-key',
    fetch: async url => {
      requests.push(String(url));
      throw new Error('QuiverAI request must not be sent');
    },
  });
  return { provider, requests };
}

describe('QuiverAI reference image SVG sniffing', () => {
  it(
    'rejects a repeated unclosed svg tag passed as bytes',
    () => {
      expectSyncRejection(
        () => prepareQuiverAIImageReference(selfClosingBytes),
        REFERENCE_REJECTION,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects a repeated unclosed svg tag passed as an ArrayBuffer',
    () => {
      expectSyncRejection(
        () => prepareQuiverAIImageReference(selfClosingBuffer),
        REFERENCE_REJECTION,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects a repeated unclosed svg tag passed as base64',
    () => {
      expectSyncRejection(
        () => prepareQuiverAIImageReference(selfClosingBase64),
        REFERENCE_REJECTION,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects a repeated unclosed svg tag passed as a data URL',
    () => {
      expectSyncRejection(
        () =>
          prepareQuiverAIImageReference(
            `data:image/svg+xml;base64,${selfClosingBase64}`,
          ),
        REFERENCE_REJECTION,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects a repeated unclosed svg tag passed as an edit reference image',
    async () => {
      const { provider, requests } = createProvider();
      await expectAsyncRejection(
        () =>
          provider.image('arrow-2').doGenerate({
            prompt: 'Recolor the icon.',
            n: 1,
            size: undefined,
            aspectRatio: undefined,
            seed: undefined,
            mask: undefined,
            files: [{ type: 'url', url: 'https://example.com/source.svg' }],
            providerOptions: {
              quiverai: {
                operation: 'edit',
                referenceImages: [{ base64: selfClosingBase64 }],
              },
            },
          }),
        REFERENCE_REJECTION,
        requests,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects an ambiguous xml prologue passed as bytes',
    () => {
      expectSyncRejection(
        () => prepareQuiverAIImageReference(headerBytes),
        REFERENCE_REJECTION,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects an ambiguous xml prologue passed as an edit reference image',
    async () => {
      const { provider, requests } = createProvider();
      await expectAsyncRejection(
        () =>
          provider.image('arrow-2').doGenerate({
            prompt: 'Recolor the icon.',
            n: 1,
            size: undefined,
            aspectRatio: undefined,
            seed: undefined,
            mask: undefined,
            files: [{ type: 'url', url: 'https://example.com/source.svg' }],
            providerOptions: {
              quiverai: {
                operation: 'edit',
                referenceImages: [{ base64: headerBase64 }],
              },
            },
          }),
        REFERENCE_REJECTION,
        requests,
      );
    },
    TEST_TIMEOUT_MS,
  );
});

describe('QuiverAI animate source SVG sniffing', () => {
  it(
    'rejects an ambiguous xml prologue passed as bytes',
    async () => {
      const { provider, requests } = createProvider();
      await expectAsyncRejection(
        () =>
          provider.image('arrow-2').doGenerate({
            prompt: undefined,
            n: 1,
            size: undefined,
            aspectRatio: undefined,
            seed: undefined,
            mask: undefined,
            files: [
              {
                type: 'file',
                mediaType: 'image/svg+xml',
                data: animateBytes,
              },
            ],
            providerOptions: { quiverai: { operation: 'animate' } },
          }),
        ANIMATE_REJECTION,
        requests,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects an ambiguous xml prologue passed as base64',
    async () => {
      const { provider, requests } = createProvider();
      await expectAsyncRejection(
        () =>
          provider.image('arrow-2').doGenerate({
            prompt: undefined,
            n: 1,
            size: undefined,
            aspectRatio: undefined,
            seed: undefined,
            mask: undefined,
            files: [
              {
                type: 'file',
                mediaType: 'image/svg+xml',
                data: animateBase64,
              },
            ],
            providerOptions: { quiverai: { operation: 'animate' } },
          }),
        ANIMATE_REJECTION,
        requests,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects an ambiguous xml prologue passed as a data URL',
    async () => {
      const { provider, requests } = createProvider();
      await expectAsyncRejection(
        () =>
          provider.image('arrow-2').doGenerate({
            prompt: undefined,
            n: 1,
            size: undefined,
            aspectRatio: undefined,
            seed: undefined,
            mask: undefined,
            files: [
              {
                type: 'file',
                mediaType: 'image/svg+xml',
                data: `data:image/svg+xml;base64,${animateBase64}`,
              },
            ],
            providerOptions: { quiverai: { operation: 'animate' } },
          }),
        ANIMATE_REJECTION,
        requests,
      );
    },
    TEST_TIMEOUT_MS,
  );
});
