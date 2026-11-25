import { InvalidArgumentError } from '@ai-sdk/provider';

const MODEL_NAME_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;

function isValidModelNameSegment(segment: string): boolean {
  return (
    MODEL_NAME_SEGMENT_PATTERN.test(segment) &&
    segment !== '.' &&
    segment !== '..'
  );
}

/**
 * Resolves the predictions endpoint for a Replicate model id.
 *
 * Unversioned ids are placed in the request path, so they must be exactly
 * `owner/name` with no characters that a URL parser could treat as path,
 * query, or fragment syntax. Versioned ids (`owner/name:version`) use the
 * fixed `/predictions` endpoint and send the version in the request body.
 */
export function getReplicatePredictionRequest({
  baseURL,
  modelId,
}: {
  baseURL: string;
  modelId: string;
}): { url: string; version: string | undefined } {
  const [model, version] = modelId.split(':');

  if (version != null) {
    return { url: `${baseURL}/predictions`, version };
  }

  const segments = model.split('/');
  if (segments.length !== 2 || !segments.every(isValidModelNameSegment)) {
    throw new InvalidArgumentError({
      argument: 'modelId',
      message:
        `Invalid Replicate model id "${modelId}". ` +
        'Expected "owner/name" or "owner/name:version".',
    });
  }

  const [owner, name] = segments.map(encodeURIComponent);

  return { url: `${baseURL}/models/${owner}/${name}/predictions`, version };
}
