import { InvalidArgumentError } from '@ai-sdk/provider';

const segmentPattern = /^[A-Za-z0-9._-]+$/;

/**
 * Converts a fal model id (e.g. `fal-ai/flux/dev`) into a URL path.
 *
 * The id is appended to an authenticated fal endpoint, so it must not be able
 * to change the target path or add a query or fragment. Every slash-separated
 * segment may only contain letters, digits, `.`, `_`, and `-`, and must not be
 * empty, `.`, or `..`. Because `%` is rejected, percent-encoded dot segments
 * cannot reach the URL parser either.
 */
export function falModelIdToPath(modelId: string): string {
  const segments = typeof modelId === 'string' ? modelId.split('/') : [];

  if (
    segments.length === 0 ||
    segments.some(
      segment =>
        !segmentPattern.test(segment) || segment === '.' || segment === '..',
    )
  ) {
    throw new InvalidArgumentError({
      argument: 'modelId',
      message: `Invalid fal model id: ${JSON.stringify(modelId)}. Model ids must consist of slash-separated segments containing only letters, digits, ".", "_", and "-".`,
    });
  }

  return segments.join('/');
}
