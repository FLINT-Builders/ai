import { AISDKError } from '@ai-sdk/provider';

const name = 'AI_DownloadError';
const marker = `vercel.ai.error.${name}`;
const symbol = Symbol.for(marker);

const CREDENTIAL_QUERY_PARAMETERS = new Set([
  'key',
  'api_key',
  'apikey',
  'access_token',
  'token',
]);

const REDACTED = 'REDACTED';

/**
 * Removes credentials (userinfo and credential query parameters such as `key`
 * or `access_token`) from a URL so it can be safely included in error output.
 */
function redactUrlCredentials(url: string): string {
  if (!url.includes('?') && !url.includes('@')) {
    return url;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  let redacted = false;

  if (parsed.username !== '' || parsed.password !== '') {
    parsed.username = '';
    parsed.password = '';
    redacted = true;
  }

  for (const parameter of new Set(parsed.searchParams.keys())) {
    if (CREDENTIAL_QUERY_PARAMETERS.has(parameter.toLowerCase())) {
      parsed.searchParams.set(parameter, REDACTED);
      redacted = true;
    }
  }

  return redacted ? parsed.toString() : url;
}

function redactMessageCredentials(message: string): string {
  return message.replace(
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s]*[^\s.,:;!?'")\]}]/gi,
    redactUrlCredentials,
  );
}

export class DownloadError extends AISDKError {
  private readonly [symbol] = true; // used in isInstance

  readonly url: string;
  readonly statusCode?: number;
  readonly statusText?: string;

  constructor({
    url,
    statusCode,
    statusText,
    cause,
    message,
  }: {
    url: string;
    statusCode?: number;
    statusText?: string;
    message?: string;
    cause?: unknown;
  }) {
    const redactedUrl = redactUrlCredentials(url);

    super({
      name,
      message: redactMessageCredentials(
        message ??
          (cause == null
            ? `Failed to download ${redactedUrl}: ${statusCode} ${statusText}`
            : `Failed to download ${redactedUrl}: ${cause}`),
      ),
      cause,
    });

    this.url = redactedUrl;
    this.statusCode = statusCode;
    this.statusText = statusText;
  }

  static isInstance(error: unknown): error is DownloadError {
    return AISDKError.hasMarker(error, marker);
  }
}
