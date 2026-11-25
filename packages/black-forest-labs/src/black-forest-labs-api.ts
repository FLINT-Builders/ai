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
 * Builds the submit endpoint URL for a model. The model id must stay a single
 * path segment under the base URL, because the request carries the API key:
 * separators, query and fragment markers, and dot segments are rejected, and
 * everything else is percent-encoded.
 */
export function getModelEndpointUrl({
  baseURL,
  modelId,
}: {
  baseURL: string;
  modelId: string;
}): string {
  if (
    typeof modelId !== 'string' ||
    modelId === '' ||
    modelId === '.' ||
    modelId === '..' ||
    /[/\\?#]/.test(modelId)
  ) {
    throw new InvalidArgumentError({
      argument: 'modelId',
      message: `Invalid Black Forest Labs model id: ${JSON.stringify(modelId)}. Model ids must be a single path segment.`,
    });
  }

  return `${baseURL}/${encodeURIComponent(modelId)}`;
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
