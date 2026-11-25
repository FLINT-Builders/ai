import { InvalidArgumentError } from '@ai-sdk/provider';

// Publisher model ids are a single resource-name segment (e.g.
// `veo-3.1-generate-001`, `textembedding-gecko@001`). Every allowed character
// is valid unescaped in a URL path segment, so a matching id cannot add path
// segments, dot segments, a query, or a fragment to the credentialed request.
const MODEL_ID_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

export function getVertexModelPathSegment(modelId: string): string {
  if (typeof modelId !== 'string' || !MODEL_ID_SEGMENT_PATTERN.test(modelId)) {
    throw new InvalidArgumentError({
      argument: 'modelId',
      message: `Invalid Google Vertex model id ${JSON.stringify(modelId)}. Model ids must be a single path segment of letters, digits, '.', '_', '@', or '-'.`,
    });
  }

  return modelId;
}
