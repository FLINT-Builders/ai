import { InvalidArgumentError } from '@ai-sdk/provider';

const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * Locations are interpolated into Google API hostnames, so they must be a
 * single DNS label to keep requests (and credentials) on `googleapis.com`.
 */
export function validateGoogleVertexLocation(
  location: string,
  argument = 'location',
): string {
  if (!DNS_LABEL_PATTERN.test(location)) {
    throw new InvalidArgumentError({
      argument,
      message: `The Google Vertex ${argument} must be a single DNS label (letters, digits, and hyphens).`,
    });
  }

  return location;
}

export function getGoogleVertexAIPlatformHost(location: string): string {
  validateGoogleVertexLocation(location);

  if (location === 'global') {
    return 'aiplatform.googleapis.com';
  }
  if (location === 'eu' || location === 'us') {
    return `aiplatform.${location}.rep.googleapis.com`;
  }
  return `${location}-aiplatform.googleapis.com`;
}
