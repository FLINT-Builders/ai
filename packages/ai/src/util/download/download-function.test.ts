import { DownloadError } from '@ai-sdk/provider-utils';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultDownloadFunction } from './download-function';

function requests(count: number, isUrlSupportedByModel = false) {
  return Array.from({ length: count }, (_, index) => ({
    url: new URL(`https://example.com/file-${index}.txt`),
    isUrlSupportedByModel,
  }));
}

describe('createDefaultDownloadFunction', () => {
  it('should pass an abort signal that follows the caller signal', async () => {
    const abortController = new AbortController();
    const download = vi.fn().mockResolvedValue({
      data: new Uint8Array([1, 2, 3]),
      mediaType: 'text/plain',
    });

    await createDefaultDownloadFunction(
      download,
      abortController.signal,
    )([
      {
        url: new URL('https://example.com/file.txt'),
        isUrlSupportedByModel: false,
      },
    ]);

    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({
        url: new URL('https://example.com/file.txt'),
        isUrlSupportedByModel: false,
        maxBytes: 100 * 1024 * 1024,
      }),
    );

    const signal: AbortSignal = download.mock.calls[0][0].abortSignal;
    expect(signal.aborted).toBe(false);
    abortController.abort();
    expect(signal.aborted).toBe(true);
  });

  it('should not download URLs that the model supports', async () => {
    const download = vi.fn();

    const result = await createDefaultDownloadFunction(download)(
      requests(20, true),
    );

    expect(download).not.toHaveBeenCalled();
    expect(result).toEqual(Array.from({ length: 20 }, () => null));
  });

  it('should reject before downloading when too many files need a download', async () => {
    const download = vi.fn();

    await expect(
      createDefaultDownloadFunction(download)(requests(9)),
    ).rejects.toThrow('A prompt may download at most 8 files.');
    expect(download).not.toHaveBeenCalled();
  });

  it('should limit the number of concurrent downloads', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const download = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 10));
      inFlight--;
      return { data: new Uint8Array([1]), mediaType: 'text/plain' };
    });

    const result = await createDefaultDownloadFunction(download)(requests(6));

    expect(download).toHaveBeenCalledTimes(6);
    expect(maxInFlight).toBe(2);
    expect(result).toHaveLength(6);
  });

  it('should keep the result order and skip supported URLs', async () => {
    const download = vi.fn(async ({ url }: { url: URL }) => ({
      data: new TextEncoder().encode(url.pathname),
      mediaType: 'text/plain',
    }));

    const result = await createDefaultDownloadFunction(download)([
      { url: new URL('https://example.com/a'), isUrlSupportedByModel: false },
      { url: new URL('https://example.com/b'), isUrlSupportedByModel: true },
      { url: new URL('https://example.com/c'), isUrlSupportedByModel: false },
    ]);

    expect(result).toEqual([
      { data: new TextEncoder().encode('/a'), mediaType: 'text/plain' },
      null,
      { data: new TextEncoder().encode('/c'), mediaType: 'text/plain' },
    ]);
  });

  it('should enforce the total byte budget across streamed chunks', async () => {
    const download = vi.fn(
      async ({ onChunk }: { onChunk?: (chunk: Uint8Array) => void }) => {
        for (let i = 0; i < 4; i++) {
          onChunk?.(new Uint8Array(10));
        }
        return { data: new Uint8Array(40), mediaType: 'text/plain' };
      },
    );

    await expect(
      createDefaultDownloadFunction(download, undefined, {
        maxTotalBytes: 100,
      })(requests(3)),
    ).rejects.toThrow(
      'A prompt download exceeded the total limit of 100 bytes.',
    );
  });

  it('should enforce the total byte budget for downloads that do not report chunks', async () => {
    const download = vi.fn(async () => ({
      data: new Uint8Array(40),
      mediaType: 'text/plain',
    }));

    await expect(
      createDefaultDownloadFunction(download, undefined, {
        maxTotalBytes: 100,
        maxConcurrency: 1,
      })(requests(3)),
    ).rejects.toSatisfy(error => DownloadError.isInstance(error));
  });

  it('should abort the other downloads when one download fails', async () => {
    const signals: AbortSignal[] = [];
    const download = vi.fn(
      async ({ url, abortSignal }: { url: URL; abortSignal?: AbortSignal }) => {
        signals.push(abortSignal!);
        if (url.pathname === '/file-0.txt') {
          throw new DownloadError({ url: url.toString(), message: 'failed' });
        }
        return await new Promise<never>((_resolve, reject) => {
          abortSignal!.addEventListener('abort', () =>
            reject(abortSignal!.reason),
          );
        });
      },
    );

    await expect(
      createDefaultDownloadFunction(download)(requests(4)),
    ).rejects.toThrow('failed');
    expect(download).toHaveBeenCalledTimes(2);
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });

  it('should abort downloads after the timeout', async () => {
    const download = vi.fn(
      ({ abortSignal }: { abortSignal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          abortSignal!.addEventListener('abort', () =>
            reject(abortSignal!.reason),
          );
        }),
    );

    await expect(
      createDefaultDownloadFunction(download, undefined, { timeoutMs: 20 })(
        requests(1),
      ),
    ).rejects.toSatisfy(
      error => error instanceof Error && error.name === 'TimeoutError',
    );
  });
});
