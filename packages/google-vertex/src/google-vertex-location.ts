import { InvalidArgumentError } from '@ai-sdk/provider';

// Locations are interpolated into hostnames (e.g. `{location}-aiplatform.googleapis.com`),
// so they must be a single lowercase DNS label. Anything else (`.`, `:`, `/`, `?`, `#`, `\`, `@`)
// could move the request, together with its credentials, to a different host.
const LOCATION_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

export function validateGoogleVertexLocation({
  location,
  argument = 'location',
}: {
  location: string;
  argument?: string;
}): string {
  if (typeof location !== 'string' || !LOCATION_PATTERN.test(location)) {
    throw new InvalidArgumentError({
      argument,
      message: `Invalid Google Vertex ${argument}: ${JSON.stringify(location)}. Expected a Google Cloud location such as "us-central1", "global", "us", or "eu".`,
    });
  }

  return location;
}

export function getGoogleVertexAIPlatformHost(location: string): string {
  validateGoogleVertexLocation({ location });

  if (location === 'global') {
    return 'aiplatform.googleapis.com';
  }

  if (location === 'eu' || location === 'us') {
    return `aiplatform.${location}.rep.googleapis.com`;
  }

  return `${location}-aiplatform.googleapis.com`;
}
