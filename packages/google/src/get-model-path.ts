import { InvalidArgumentError } from '@ai-sdk/provider';

export function getModelPath(modelId: string): string {
  return modelId.includes('/') ? modelId : `models/${modelId}`;
}

// Every allowed character is a literal path character, so the result needs no
// further encoding. Requiring a leading letter or digit excludes `.`/`..`.
const modelIdPathSegmentPattern = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

/**
 * Returns the model id as a single `models/{id}` path segment, or throws if it
 * could address any other resource (e.g. via `/`, `\`, `..`, `%`, `:`, `?` or
 * `#`).
 */
export function getModelIdPathSegment(modelId: string): string {
  if (typeof modelId !== 'string' || !modelIdPathSegmentPattern.test(modelId)) {
    throw new InvalidArgumentError({
      argument: 'modelId',
      message:
        `Invalid Google model id ${JSON.stringify(modelId)}. ` +
        `A model id must be a single path segment containing only letters, ` +
        `digits, '.', '_', '@' and '-'.`,
    });
  }
  return modelId;
}
