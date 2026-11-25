import { createQuiverAI } from '@ai-sdk/quiverai';
import { generateImage } from 'ai';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { presentImages } from './present-image';

const { rendered } = vi.hoisted(() => ({
  rendered: [] as Buffer[],
}));

vi.mock('terminal-image', () => ({
  default: {
    buffer: async (input: Uint8Array) => {
      rendered.push(Buffer.from(input));
      return '';
    },
  },
}));

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const outputDir = path.resolve('output');

afterEach(async () => {
  rendered.length = 0;
  await rm(outputDir, { recursive: true, force: true });
});

/**
 * librsvg releases that include the fix for duplicate entities in nested
 * XInclude documents. Sharp 0.35.5 bundles 2.63.2.
 */
function librsvgIsPatched(version: string | undefined): boolean {
  if (version == null) {
    return false;
  }

  const [major = Number.NaN, minor = Number.NaN, micro = 0] = version
    .split('.')
    .map(part => Number.parseInt(part, 10));
  if (Number.isNaN(major) || Number.isNaN(minor)) {
    return false;
  }

  const atLeast = (maj: number, min: number, mic: number) =>
    major > maj ||
    (major === maj && (minor > min || (minor === min && micro >= mic)));

  if (atLeast(2, 63, 2)) return true;
  if (minor === 62 && micro >= 4) return true;
  if (minor === 61 && micro >= 5) return true;
  if (minor === 60 && micro >= 3) return true;
  if (minor === 57 && micro >= 5) return true;
  if (minor === 56 && micro >= 6) return true;
  if (minor === 52 && micro >= 13) return true;
  return false;
}

function nestedIncludeSvg(): string {
  const included = encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="blue"/></svg>`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xi="http://www.w3.org/2001/XInclude" width="8" height="8"><xi:include href="data:image/svg+xml;charset=utf-8,${included}"/></svg>`;
}

async function presentProviderSvg(svg: string): Promise<Buffer | undefined> {
  let requestedUrl: string | undefined;
  const provider = createQuiverAI({
    apiKey: 'test-api-key',
    fetch: async url => {
      requestedUrl = String(url);
      return new Response(
        JSON.stringify({
          id: 'resp_test',
          created: 1_700_000_000,
          data: [{ svg, mime_type: 'image/svg+xml' }],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    },
  });

  const result = await generateImage({
    model: provider.image('arrow-2'),
    prompt: 'icon',
    maxRetries: 0,
  });

  expect(requestedUrl).toBe('https://api.quiver.ai/v1/svgs/generations');
  expect(result.images).toHaveLength(1);
  expect(Buffer.from(result.images[0].uint8Array).toString('utf8')).toBe(svg);

  try {
    await presentImages(result.images);
  } catch {
    return undefined;
  }

  const preview = rendered[0];
  if (preview == null || !preview.subarray(0, 8).equals(PNG_MAGIC)) {
    return undefined;
  }
  return preview;
}

function expectProviderSvgNotDecodedByVulnerableLibrsvg(decoded: boolean) {
  const rsvg = sharp.versions.rsvg;
  expect(
    decoded && !librsvgIsPatched(rsvg),
    `provider SVG was decoded by sharp ${sharp.versions.sharp} with librsvg ${rsvg ?? 'unknown'}`,
  ).toBe(false);
}

it('does not rasterize a provider SVG with a vulnerable librsvg', async () => {
  const preview = await presentProviderSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>',
  );
  expectProviderSvgNotDecodedByVulnerableLibrsvg(preview != null);
});

it('does not let a provider SVG include a nested data document through a vulnerable librsvg', async () => {
  const preview = await presentProviderSvg(nestedIncludeSvg());
  if (preview == null) {
    expectProviderSvgNotDecodedByVulnerableLibrsvg(false);
    return;
  }

  const { data } = await sharp(preview)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const includedBlue =
    data[0] === 0 && data[1] === 0 && data[2] === 255 && data[3] === 255;
  expectProviderSvgNotDecodedByVulnerableLibrsvg(includedBlue);
});
