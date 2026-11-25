import { InvalidArgumentError } from '@ai-sdk/provider';

// Replicate owner and model names: letters, digits, dashes, underscores and
// periods, starting with a letter or digit (which also rules out `.` and `..`).
const modelIdSegmentRegex = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Resolves the predictions endpoint for a Replicate model id.
 *
 * Versioned ids (`owner/name:version`) use the shared `/predictions` endpoint
 * with the version in the request body. Unversioned ids must be exactly one
 * owner segment and one name segment, which are encoded into
 * `/models/{owner}/{name}/predictions`.
 */
export function getReplicatePredictionUrl({
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

  if (
    segments.length !== 2 ||
    !segments.every(segment => modelIdSegmentRegex.test(segment))
  ) {
    throw new InvalidArgumentError({
      argument: 'modelId',
      message: `Invalid Replicate model id "${modelId}". Expected "owner/name" or "owner/name:version".`,
    });
  }

  const [owner, name] = segments;

  return {
    url: `${baseURL}/models/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/predictions`,
    version: undefined,
  };
}
