import { InvalidArgumentError } from '@ai-sdk/provider';

// Model ids are placed into credentialed request URLs, so they must stay a
// single path segment: no separators, dot segments, percent escapes, or
// `:`/`?`/`#` delimiters. `@` is allowed for versioned Vertex ids such as
// `textembedding-gecko@003`.
const MODEL_ID_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

const MODEL_PATH_COLLECTIONS = ['models', 'tunedModels', 'endpoints'];

/**
 * Validates that a model id is a single safe path segment and returns it
 * URL-encoded. Throws an `InvalidArgumentError` otherwise.
 */
export function getModelIdPathSegment(modelId: string): string {
  if (
    typeof modelId !== 'string' ||
    !MODEL_ID_SEGMENT_PATTERN.test(modelId) ||
    modelId.includes('..')
  ) {
    throw new InvalidArgumentError({
      argument: 'modelId',
      message: `Invalid model id ${JSON.stringify(modelId)}. Model ids must be a single path segment of letters, digits, '.', '_', '-', or '@'.`,
    });
  }

  return encodeURIComponent(modelId).replace(/%40/g, '@');
}

/**
 * Returns the `{collection}/{id}` resource path for a model id. Bare ids are
 * placed under `models/`; ids may also name the `models/`, `tunedModels/`, or
 * `endpoints/` collection explicitly.
 */
export function getModelPath(modelId: string): string {
  const separatorIndex =
    typeof modelId === 'string' ? modelId.indexOf('/') : -1;

  if (separatorIndex === -1) {
    return `models/${getModelIdPathSegment(modelId)}`;
  }

  const collection = modelId.slice(0, separatorIndex);
  if (!MODEL_PATH_COLLECTIONS.includes(collection)) {
    throw new InvalidArgumentError({
      argument: 'modelId',
      message: `Invalid model id ${JSON.stringify(modelId)}. Model paths must start with one of: ${MODEL_PATH_COLLECTIONS.map(name => `${name}/`).join(', ')}.`,
    });
  }

  return `${collection}/${getModelIdPathSegment(
    modelId.slice(separatorIndex + 1),
  )}`;
}
