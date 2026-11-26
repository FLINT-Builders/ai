import { InvalidArgumentError } from '@ai-sdk/provider';

const resourceIdPattern = /^[A-Za-z0-9._~-]+$/;

function isResourceId(segment: string): boolean {
  return resourceIdPattern.test(segment) && segment !== '.' && segment !== '..';
}

/**
 * Converts a caller-supplied Google resource name (e.g. `operations/123`)
 * into a URL path that stays on that resource.
 *
 * Resource names are persisted and passed back by callers, so they are
 * untrusted. A name is accepted only when it matches one of the `layouts`
 * exactly, where `*` stands for a single resource id. Anything else (dot
 * segments, extra segments, URL delimiters, percent escapes, non-strings) is
 * rejected before a request is made.
 */
export function getGoogleResourcePath({
  name,
  argument,
  layouts,
}: {
  name: unknown;
  argument: string;
  layouts: ReadonlyArray<string>;
}): string {
  if (typeof name === 'string') {
    const segments = name.split('/');

    for (const layout of layouts) {
      const layoutSegments = layout.split('/');

      if (
        layoutSegments.length === segments.length &&
        layoutSegments.every((layoutSegment, index) =>
          layoutSegment === '*'
            ? isResourceId(segments[index])
            : segments[index] === layoutSegment,
        )
      ) {
        return segments.map(segment => encodeURIComponent(segment)).join('/');
      }
    }
  }

  throw new InvalidArgumentError({
    argument,
    message: `Invalid Google resource name. Expected ${layouts
      .map(layout => `"${layout}"`)
      .join(' or ')}.`,
  });
}
