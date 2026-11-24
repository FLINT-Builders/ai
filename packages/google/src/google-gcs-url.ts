import {
  InvalidArgumentError,
  UnsupportedFunctionalityError,
} from '@ai-sdk/provider';

// https://cloud.google.com/storage/docs/buckets#naming
const gcsBucketNamePattern = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;

/**
 * Validates the configured Cloud Storage bucket allowlist. Entries must be
 * bare, lowercase bucket names (e.g. `my-bucket`, not `gs://my-bucket`).
 */
export function validateAllowedGcsBuckets(
  allowedGcsBuckets: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  if (allowedGcsBuckets == null) {
    return [];
  }

  for (const bucket of allowedGcsBuckets) {
    if (typeof bucket !== 'string' || !gcsBucketNamePattern.test(bucket)) {
      throw new InvalidArgumentError({
        argument: 'allowedGcsBuckets',
        message: `Invalid Cloud Storage bucket name ${JSON.stringify(bucket)}. Use bare, lowercase bucket names such as "my-bucket".`,
      });
    }
  }

  return [...new Set(allowedGcsBuckets)];
}

/**
 * Supported-URL patterns for `gs://` URLs in the allowed buckets.
 */
export function getAllowedGcsUrlPatterns(
  allowedGcsBuckets: ReadonlyArray<string> | undefined,
): RegExp[] {
  return validateAllowedGcsBuckets(allowedGcsBuckets).map(
    bucket => new RegExp(`^gs://${bucket.replace(/[.]/g, '\\.')}/`),
  );
}

function isAllowedGcsUrl(
  url: URL,
  allowedGcsBuckets: ReadonlyArray<string> | undefined,
): boolean {
  return (
    url.protocol === 'gs:' &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    url.search === '' &&
    url.hash === '' &&
    url.pathname.startsWith('/') &&
    url.pathname.length > 1 &&
    validateAllowedGcsBuckets(allowedGcsBuckets).includes(url.hostname)
  );
}

/**
 * Returns the file URL to send to Google for a URL file part.
 *
 * Google reads `gs://` URLs with the project's own service identity, so a
 * `gs://` URL is only forwarded when its bucket is explicitly allowlisted.
 * The returned string is the serialization of the URL object that was
 * checked, so callers must send it instead of the original input.
 */
export function getForwardableGoogleFileUrl({
  url,
  allowedGcsBuckets,
}: {
  url: URL;
  allowedGcsBuckets: ReadonlyArray<string> | undefined;
}): string {
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return url.href;
  }

  if (url.protocol === 'gs:') {
    if (isAllowedGcsUrl(url, allowedGcsBuckets)) {
      return url.href;
    }

    throw new UnsupportedFunctionalityError({
      functionality:
        'gs:// file URLs for Cloud Storage buckets that are not listed in the provider `allowedGcsBuckets` setting',
    });
  }

  throw new UnsupportedFunctionalityError({
    functionality: `file URLs with the "${url.protocol}" scheme`,
  });
}

/**
 * Parses a `gs://` URL string and returns it if its bucket is allowlisted.
 * Returns `undefined` when the string is not a `gs://` URL and throws when it
 * is one that must not be forwarded.
 */
export function getForwardableGcsUri({
  uri,
  allowedGcsBuckets,
}: {
  uri: string;
  allowedGcsBuckets: ReadonlyArray<string> | undefined;
}): string | undefined {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return undefined;
  }

  if (url.protocol !== 'gs:') {
    return undefined;
  }

  return getForwardableGoogleFileUrl({ url, allowedGcsBuckets });
}

const uriSchemePattern = /^[a-z][a-z0-9+.-]*:/i;

// URL parsers ignore C0 control characters and spaces around and inside the
// scheme, so they must not hide a scheme from the check below.
function hasUriScheme(value: string): boolean {
  const stripped = Array.from(value)
    .filter(char => char.charCodeAt(0) > 0x20)
    .join('');
  return uriSchemePattern.test(stripped);
}

/**
 * Returns the provider reference to send to Google as a file URI. Resource
 * names such as `files/abc` are returned unchanged. Absolute URIs go through
 * the same checks as file URLs, and scheme-prefixed strings that cannot be
 * parsed are rejected.
 */
export function getForwardableGoogleReferenceUri({
  uri,
  allowedGcsBuckets,
}: {
  uri: string;
  allowedGcsBuckets: ReadonlyArray<string> | undefined;
}): string {
  let url: URL | undefined;
  try {
    url = new URL(uri);
  } catch {
    url = undefined;
  }

  if (url != null) {
    return getForwardableGoogleFileUrl({ url, allowedGcsBuckets });
  }

  if (hasUriScheme(uri)) {
    throw new UnsupportedFunctionalityError({
      functionality: 'provider references that are not valid URLs',
    });
  }

  return uri;
}
