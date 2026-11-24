import { describe, expect, it } from 'vitest';
import { DownloadError } from './download-error';

describe('DownloadError', () => {
  it('should keep URLs without credentials unchanged', () => {
    const error = new DownloadError({
      url: 'https://example.com/video.mp4?alt=media',
      statusCode: 404,
      statusText: 'Not Found',
    });

    expect(error.url).toBe('https://example.com/video.mp4?alt=media');
    expect(error.message).toBe(
      'Failed to download https://example.com/video.mp4?alt=media: 404 Not Found',
    );
  });

  it('should redact credential query parameters from url and message', () => {
    const error = new DownloadError({
      url: 'https://example.com/video.mp4?alt=media&key=test-secret&access_token=test-token',
      statusCode: 404,
      statusText: 'Not Found',
    });

    expect(error.url).toBe(
      'https://example.com/video.mp4?alt=media&key=REDACTED&access_token=REDACTED',
    );
    expect(error.message).toBe(
      'Failed to download https://example.com/video.mp4?alt=media&key=REDACTED&access_token=REDACTED: 404 Not Found',
    );
  });

  it('should redact userinfo from url', () => {
    const error = new DownloadError({
      url: 'https://user:test-password@example.com/video.mp4',
      cause: new Error('network down'),
    });

    expect(error.url).toBe('https://example.com/video.mp4');
    expect(error.message).toBe(
      'Failed to download https://example.com/video.mp4: Error: network down',
    );
  });

  it('should redact credentials from URLs in custom messages', () => {
    const error = new DownloadError({
      url: 'https://example.com/video.mp4?key=test-secret',
      message:
        'Redirect from https://example.com/next?api_key=test-secret could not be validated and was blocked',
    });

    expect(error.url).toBe('https://example.com/video.mp4?key=REDACTED');
    expect(error.message).toBe(
      'Redirect from https://example.com/next?api_key=REDACTED could not be validated and was blocked',
    );
  });
});
