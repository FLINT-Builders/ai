import { InvalidArgumentError } from '@ai-sdk/provider';
import {
  createJsonErrorResponseHandler,
  isSameOrigin,
} from '@ai-sdk/provider-utils';
import { z } from 'zod/v4';

/**
 * Transport concerns shared by every Black Forest Labs model
 */

export const bflErrorSchema = z.object({
  message: z.string().optional(),
  detail: z.any().optional(),
});

function bflErrorToMessage(error: unknown): string | undefined {
  const parsed = bflErrorSchema.safeParse(error);
  if (!parsed.success) return undefined;
  const { message, detail } = parsed.data;
  if (typeof detail === 'string') return detail;
  if (detail != null) {
    try {
      return JSON.stringify(detail);
    } catch {
      // ignore
    }
  }
  return message;
}

export const bflFailedResponseHandler = createJsonErrorResponseHandler({
  errorSchema: bflErrorSchema,
  errorToMessage: error =>
    bflErrorToMessage(error) ?? 'Unknown Black Forest Labs error',
});

/**
 * Builds the credentialed endpoint URL for a model. The model id must be a
 * single path segment under the base URL: ids containing any character that
 * `encodeURIComponent` would escape (path, query, and fragment delimiters,
 * backslashes, percent signs, whitespace) or that are dot segments are
 * rejected, so the API key is never sent to another path or query.
 */
export function getModelUrl({
  baseURL,
  modelId,
}: {
  baseURL: string;
  modelId: string;
}): string {
  let encoded: string | undefined;
  try {
    encoded = encodeURIComponent(modelId);
  } catch {
    encoded = undefined;
  }

  if (
    encoded == null ||
    encoded !== modelId ||
    modelId === '' ||
    modelId === '.' ||
    modelId === '..'
  ) {
    throw new InvalidArgumentError({
      argument: 'modelId',
      message: `Invalid Black Forest Labs model id: ${JSON.stringify(modelId)}. Model ids must be a single URL path segment.`,
    });
  }

  return `${baseURL}/${modelId}`;
}

/**
 * Black Forest Labs returns response-supplied URLs (polling and delivery) on
 * sibling cluster hosts of the API origin (e.g. `api.us1.bfl.ai` for a base
 * URL on `api.bfl.ai`), so a strict same-origin check against the configured
 * base URL is not enough. Credentials may also be sent to any https host under
 * the official `bfl.ai` domain.
 */
export function isTrustedUrl(url: string, baseUrl: string): boolean {
  if (isSameOrigin(url, baseUrl)) {
    return true;
  }

  try {
    const { protocol, hostname } = new URL(url);
    return (
      protocol === 'https:' &&
      (hostname === 'bfl.ai' || hostname.endsWith('.bfl.ai'))
    );
  } catch {
    return false;
  }
}
