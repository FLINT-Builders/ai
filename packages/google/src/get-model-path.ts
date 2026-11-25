import { InvalidArgumentError } from '@ai-sdk/provider';

// Model ids are interpolated into request URLs that carry the API key or
// OAuth token. A segment must not be able to add path segments, dot segments,
// percent-encoded characters, a query, or a fragment.
const MODEL_ID_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

// `endpoints/` addresses tuned models deployed to a Vertex endpoint.
const MODEL_COLLECTIONS = ['models', 'tunedModels', 'endpoints'] as const;

/**
 * Validates that a model id is a single URL path segment and returns it.
 */
export function getModelPathSegment(modelId: string): string {
  if (!MODEL_ID_SEGMENT_PATTERN.test(modelId)) {
    throw new InvalidArgumentError({
      argument: 'modelId',
      message: `Invalid model id: ${JSON.stringify(modelId)}. Model ids may only contain letters, digits, '.', '_', '@', and '-'.`,
    });
  }

  return modelId;
}

/**
 * Returns the `{collection}/{id}` resource path for a model id. Bare ids are
 * placed in the `models` collection.
 */
export function getModelPath(modelId: string): string {
  const separatorIndex = modelId.indexOf('/');

  if (separatorIndex === -1) {
    return `models/${getModelPathSegment(modelId)}`;
  }

  const collection = modelId.slice(0, separatorIndex);
  if (!(MODEL_COLLECTIONS as readonly string[]).includes(collection)) {
    throw new InvalidArgumentError({
      argument: 'modelId',
      message: `Invalid model id: ${JSON.stringify(modelId)}. Model paths must start with ${MODEL_COLLECTIONS.map(c => `'${c}/'`).join(', ')}.`,
    });
  }

  return `${collection}/${getModelPathSegment(modelId.slice(separatorIndex + 1))}`;
}
