import { InvalidArgumentError } from '@ai-sdk/provider';

/**
 * Ensures a model id is exactly one URL path segment: no separators, no dot
 * segments, and no percent-encoded sequences that URL parsing would decode.
 * Otherwise a model id could move a credentialed request to another resource.
 */
export function validateModelPathSegment(modelId: string): string {
  if (
    modelId === '' ||
    modelId === '.' ||
    modelId === '..' ||
    /[/\\%?#]/.test(modelId)
  ) {
    throw new InvalidArgumentError({
      argument: 'modelId',
      message: `Invalid model id '${modelId}': model ids must be a single path segment.`,
    });
  }

  return modelId;
}

/**
 * Validates and percent-encodes a model id for use as a URL path segment.
 * `@` is a valid path character and is kept for versioned model ids such as
 * `textembedding-gecko@003`.
 */
export function encodeModelPathSegment(modelId: string): string {
  return encodeURIComponent(validateModelPathSegment(modelId)).replace(
    /%40/g,
    '@',
  );
}
