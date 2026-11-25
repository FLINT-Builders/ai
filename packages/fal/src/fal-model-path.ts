import { InvalidArgumentError } from '@ai-sdk/provider';

const SAFE_SEGMENT = /^(?!\.+$)[A-Za-z0-9._-]+$/;

/**
 * Returns the model id as a URL path that cannot leave the location it is
 * appended to: every `/`-separated segment is non-empty, restricted to
 * `[A-Za-z0-9._-]`, not a dot segment, and not the fal queue `requests`
 * namespace. Throws before any request is made otherwise.
 *
 * With `singleSegment`, the model id must not contain `/` at all.
 */
export function getFalModelPath(
  modelId: string,
  { singleSegment = false }: { singleSegment?: boolean } = {},
): string {
  const segments = typeof modelId === 'string' ? modelId.split('/') : [];

  const isValid =
    segments.length > 0 &&
    (!singleSegment || segments.length === 1) &&
    segments.every(
      segment =>
        SAFE_SEGMENT.test(segment) && segment.toLowerCase() !== 'requests',
    );

  if (!isValid) {
    throw new InvalidArgumentError({
      argument: 'modelId',
      message: `Invalid fal model id: ${JSON.stringify(modelId)}. Model ids may only contain ${singleSegment ? 'a single path segment' : 'path segments'} made of letters, digits, '.', '_', and '-'.`,
    });
  }

  return segments.join('/');
}
