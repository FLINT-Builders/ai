import { DownloadError } from '@ai-sdk/provider-utils';
import { mergeAbortSignals } from '../merge-abort-signals';
import { download as originalDownload } from './download';

/**
 * Experimental. Can change in patch versions without warning.
 *
 * Download function. Called with the array of URLs and a boolean indicating
 * whether the URL is supported by the model.
 *
 * The download function can decide for each URL:
 * - to return null (which means that the URL should be passed to the model)
 * - to download the asset and return the data (incl. retries, authentication, etc.)
 *
 * Should throw DownloadError if the download fails.
 *
 * Should return an array of objects sorted by the order of the requested downloads.
 * For each object, the data should be a Uint8Array if the URL was downloaded.
 * For each object, the mediaType should be the media type of the downloaded asset.
 * For each object, the data should be null if the URL should be passed through as is.
 */
export type DownloadFunction = (
  options: Array<{
    url: URL;
    isUrlSupportedByModel: boolean;
  }>,
) => PromiseLike<
  Array<{
    data: Uint8Array;
    mediaType: string | undefined;
  } | null>
>;

/**
 * Limits applied by the default download function to the files of one prompt.
 */
export type DefaultDownloadLimits = {
  /**
   * Maximum number of files that are downloaded for one prompt.
   * Prompts that need more downloads are rejected before any fetch starts.
   * @default 8
   */
  maxFiles?: number;

  /**
   * Maximum size of a single downloaded file in bytes.
   * @default 100 MiB
   */
  maxBytesPerFile?: number;

  /**
   * Maximum combined size in bytes of all files downloaded for one prompt.
   * @default 100 MiB
   */
  maxTotalBytes?: number;

  /**
   * Maximum number of downloads that run at the same time.
   * @default 2
   */
  maxConcurrency?: number;

  /**
   * Time in milliseconds after which all downloads for one prompt are aborted.
   * @default 10000
   */
  timeoutMs?: number;
};

export const DEFAULT_PROMPT_DOWNLOAD_LIMITS: Required<DefaultDownloadLimits> = {
  maxFiles: 8,
  maxBytesPerFile: 100 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxConcurrency: 2,
  timeoutMs: 10_000,
};

/**
 * Default download function.
 * Downloads the file if it is not supported by the model.
 *
 * Prompt URLs can come from untrusted input (e.g. chat messages), so the
 * downloads for one call share a file count, a byte budget, a concurrency
 * limit, and a timeout (see `DefaultDownloadLimits`).
 */
export const createDefaultDownloadFunction =
  (
    download: typeof originalDownload = originalDownload,
    abortSignal?: AbortSignal,
    limits?: DefaultDownloadLimits,
  ): DownloadFunction =>
  async requestedDownloads => {
    const maxFiles =
      limits?.maxFiles ?? DEFAULT_PROMPT_DOWNLOAD_LIMITS.maxFiles;
    const maxBytesPerFile =
      limits?.maxBytesPerFile ?? DEFAULT_PROMPT_DOWNLOAD_LIMITS.maxBytesPerFile;
    const maxTotalBytes =
      limits?.maxTotalBytes ?? DEFAULT_PROMPT_DOWNLOAD_LIMITS.maxTotalBytes;
    const maxConcurrency = Math.max(
      1,
      limits?.maxConcurrency ?? DEFAULT_PROMPT_DOWNLOAD_LIMITS.maxConcurrency,
    );
    const timeoutMs =
      limits?.timeoutMs ?? DEFAULT_PROMPT_DOWNLOAD_LIMITS.timeoutMs;

    const results: Array<{
      data: Uint8Array;
      mediaType: string | undefined;
    } | null> = requestedDownloads.map(() => null);

    const pendingIndices = requestedDownloads.flatMap((requested, index) =>
      requested.isUrlSupportedByModel ? [] : [index],
    );

    if (pendingIndices.length === 0) {
      return results;
    }

    if (pendingIndices.length > maxFiles) {
      throw new DownloadError({
        url: requestedDownloads[pendingIndices[maxFiles]].url.toString(),
        message: `A prompt may download at most ${maxFiles} files.`,
      });
    }

    const failController = new AbortController();
    const downloadSignal = mergeAbortSignals(
      abortSignal,
      failController.signal,
      timeoutMs,
    );

    let totalBytes = 0;
    const consumeBudget = (url: URL, byteLength: number) => {
      totalBytes += byteLength;
      if (totalBytes > maxTotalBytes) {
        throw new DownloadError({
          url: url.toString(),
          message: `A prompt download exceeded the total limit of ${maxTotalBytes} bytes.`,
        });
      }
    };

    let nextIndex = 0;
    let firstError: { error: unknown } | undefined;

    const worker = async () => {
      while (firstError == null && nextIndex < pendingIndices.length) {
        const index = pendingIndices[nextIndex++];
        const requested = requestedDownloads[index];
        try {
          let streamedBytes = 0;
          const result = await download({
            ...requested,
            maxBytes: maxBytesPerFile,
            abortSignal: downloadSignal,
            onChunk: chunk => {
              if (firstError != null) {
                throw firstError.error;
              }
              streamedBytes += chunk.byteLength;
              consumeBudget(requested.url, chunk.byteLength);
            },
          });

          // Backstop for download implementations that do not report chunks.
          if (result.data.byteLength > streamedBytes) {
            consumeBudget(
              requested.url,
              result.data.byteLength - streamedBytes,
            );
          }

          results[index] = result;
        } catch (error) {
          if (firstError == null) {
            firstError = { error };
            failController.abort(error);
          }
          return;
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(maxConcurrency, pendingIndices.length) },
        worker,
      ),
    );

    if (firstError != null) {
      throw firstError.error;
    }

    return results;
  };
