import { createGoogle } from '@ai-sdk/google';
import { describe, expect, it } from 'vitest';
import { createDownload } from '../util/download/create-download';
import { experimental_generateVideo } from './generate-video';
import { experimental_getVideoStatus } from './get-video-status';
import { experimental_startVideo } from './start-video';

/**
 * Placeholder only. This is not a credential.
 * The tests assert that this exact string never leaves the provider config.
 */
const CONFIGURED_API_KEY = 'TEST_GOOGLE_API_KEY_PLACEHOLDER';

const OPERATION_NAME = 'operations/video-status-op';

const SAME_ORIGIN_URI_WITH_QUERY =
  'https://generativelanguage.googleapis.com/v1beta/files/video-456:download?alt=media';
const SAME_ORIGIN_URI_WITHOUT_QUERY =
  'https://generativelanguage.googleapis.com/files/video-789.mp4';

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function providerFetch(): typeof fetch {
  return async (input, _init) => {
    const url = requestUrl(input);

    if (url.includes(':predictLongRunning')) {
      return new Response(
        JSON.stringify({
          name: OPERATION_NAME,
          done: false,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    if (url.includes(OPERATION_NAME)) {
      return new Response(
        JSON.stringify({
          name: OPERATION_NAME,
          done: true,
          response: {
            generateVideoResponse: {
              generatedSamples: [
                { video: { uri: SAME_ORIGIN_URI_WITH_QUERY } },
                { video: { uri: SAME_ORIGIN_URI_WITHOUT_QUERY } },
              ],
            },
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    return new Response('Not found', { status: 404 });
  };
}

function videoModel() {
  return createGoogle({
    apiKey: CONFIGURED_API_KEY,
    fetch: providerFetch(),
  }).video('veo-3.1-generate-preview');
}

function assertNoConfiguredKey(value: string) {
  expect(value).not.toContain(CONFIGURED_API_KEY);
}

function exposedErrorText(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const withDetails = error as Error & {
    url?: unknown;
    cause?: unknown;
    statusText?: unknown;
  };

  return [
    error.name,
    error.message,
    String(withDetails.url),
    String(withDetails.statusText),
    withDetails.cause instanceof Error
      ? withDetails.cause.message
      : String(withDetails.cause),
  ].join('\n');
}

describe('Google video API key exposure', () => {
  it('does not return the configured API key from experimental_getVideoStatus', async () => {
    const model = videoModel();

    const started = await experimental_startVideo({
      model,
      prompt: 'a paper boat crossing a pond',
      maxRetries: 0,
    });

    const status = await experimental_getVideoStatus(model, {
      operation: started.operation,
      maxRetries: 0,
    });

    expect(status.status).toBe('completed');
    if (status.status !== 'completed') {
      return;
    }

    expect(status.videos).toHaveLength(2);
    assertNoConfiguredKey(JSON.stringify(status));

    for (const video of status.videos) {
      if (video.type !== 'url') {
        continue;
      }

      const parsed = new URL(video.url);
      expect(parsed.searchParams.has('key')).toBe(false);
      expect(parsed.searchParams.has('access_token')).toBe(false);
      expect([
        SAME_ORIGIN_URI_WITH_QUERY,
        SAME_ORIGIN_URI_WITHOUT_QUERY,
      ]).toContain(video.url);
    }
  });

  it.each([
    {
      name: 'HTTP error',
      download: undefined,
      installFetch: (seen: string[]) => async (input: RequestInfo | URL) => {
        seen.push(requestUrl(input));
        return new Response(null, { status: 404, statusText: 'Not Found' });
      },
    },
    {
      name: 'network error',
      download: undefined,
      installFetch: (seen: string[]) => async (input: RequestInfo | URL) => {
        seen.push(requestUrl(input));
        throw new TypeError('network down');
      },
    },
    {
      name: 'size limit',
      download: createDownload({ maxBytes: 1 }),
      installFetch: (seen: string[]) => async (input: RequestInfo | URL) => {
        seen.push(requestUrl(input));
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { 'content-type': 'video/mp4', 'content-length': '4' },
        });
      },
    },
  ])(
    'does not expose the configured API key when experimental_generateVideo download fails ($name)',
    async ({ download, installFetch }) => {
      const seen: string[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = installFetch(seen) as typeof fetch;

      try {
        let thrown: unknown;
        let result: unknown;
        try {
          result = await experimental_generateVideo({
            model: videoModel(),
            prompt: 'a paper boat crossing a pond',
            maxRetries: 0,
            download,
            poll: {
              intervalMs: 0,
              timeoutMs: 10_000,
              delay: async () => {},
            },
          });
        } catch (error) {
          thrown = error;
        }

        const downloadedProviderVideo = seen.some(url =>
          url.startsWith('https://generativelanguage.googleapis.com/'),
        );
        const producedVideo =
          result != null &&
          typeof result === 'object' &&
          'videos' in result &&
          Array.isArray(result.videos) &&
          result.videos.length > 0;
        expect(downloadedProviderVideo || producedVideo).toBe(true);
        assertNoConfiguredKey(
          `${seen.join('\n')}\n${exposedErrorText(thrown)}\n${JSON.stringify(result)}`,
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});
