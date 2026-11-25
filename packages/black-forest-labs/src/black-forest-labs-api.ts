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
 * The global and regional API hosts (`api.bfl.ai`, `api.eu.bfl.ai`,
 * `api.us.bfl.ai`) and the numbered cluster hosts they route polling to
 * (e.g. `api.us1.bfl.ai`). Other `bfl.ai` hosts, such as `delivery-*` CDNs,
 * serve signed URLs and never need the API key.
 */
const BFL_API_HOST = /^api(?:\.(?:eu|us)\d*)?\.bfl\.ai$/;

/**
 * Black Forest Labs returns polling URLs on sibling cluster hosts of the API
 * origin (e.g. `api.us1.bfl.ai` for a base URL on `api.bfl.ai`), so a strict
 * same-origin check against the configured base URL is not enough.
 * Credentials are sent only to the configured origin or an https BFL API host.
 */
export function isTrustedUrl(url: string, baseUrl: string): boolean {
  if (isSameOrigin(url, baseUrl)) {
    return true;
  }

  try {
    const { protocol, host, username, password } = new URL(url);
    return (
      protocol === 'https:' &&
      username === '' &&
      password === '' &&
      BFL_API_HOST.test(host)
    );
  } catch {
    return false;
  }
}
