import { InvalidArgumentError } from '@ai-sdk/provider';

// Model ids are placed into request paths (`.../models/{id}:method`) and into
// resource names, so each part must be a single path segment that cannot
// traverse (`..`), start a query or fragment, select another method (`:`), or
// be decoded into any of those (`%`, `\`). Every allowed character is a literal
// RFC 3986 path character, so a matching id needs no further encoding.
const MODEL_ID_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

/**
 * Validates that the model id is a single safe path segment and returns it for
 * use in a URL path or resource name.
 */
export function getModelIdPathSegment(modelId: string): string {
  if (typeof modelId !== 'string' || !MODEL_ID_SEGMENT_PATTERN.test(modelId)) {
    throw new InvalidArgumentError({
      argument: 'modelId',
      message: `Invalid model id ${JSON.stringify(modelId)}. Model ids may only contain letters, digits, '.', '_', '-' and '@', and must start with a letter or digit.`,
    });
  }

  return modelId;
}

// `models/*` and `tunedModels/*` are Gemini API model resources; `endpoints/*`
// addresses Vertex AI tuned models served from a deployed endpoint.
const MODEL_COLLECTIONS = new Set(['models', 'tunedModels', 'endpoints']);

/**
 * Returns the resource path for a model id: `models/{id}` for a bare id, or
 * `{collection}/{id}` (e.g. `tunedModels/{id}`, `endpoints/{id}`) unchanged.
 */
export function getModelPath(modelId: string): string {
  if (typeof modelId === 'string' && modelId.includes('/')) {
    const segments = modelId.split('/');

    if (segments.length !== 2 || !MODEL_COLLECTIONS.has(segments[0])) {
      throw new InvalidArgumentError({
        argument: 'modelId',
        message: `Invalid model id ${JSON.stringify(modelId)}. Expected a model id or a 'models/{id}', 'tunedModels/{id}' or 'endpoints/{id}' resource name.`,
      });
    }

    return `${segments[0]}/${getModelIdPathSegment(segments[1])}`;
  }

  return `models/${getModelIdPathSegment(modelId)}`;
}
