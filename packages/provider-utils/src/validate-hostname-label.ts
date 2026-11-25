import { InvalidArgumentError } from '@ai-sdk/provider';

const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * Validates that a setting (e.g. a cloud region or resource name) is a single
 * DNS label before it is interpolated into a hostname.
 *
 * Characters such as `.`, `/`, `?`, `#`, `@`, `:` or `\` would otherwise let
 * the setting change which host a credentialed request is sent to.
 *
 * @returns the validated value, which callers must use to build the hostname.
 */
export function validateHostnameLabel({
  value,
  argument,
}: {
  value: string;
  argument: string;
}): string {
  if (!HOSTNAME_LABEL.test(value)) {
    throw new InvalidArgumentError({
      argument,
      message: `${argument} must be a single DNS label containing only letters, digits, and hyphens.`,
    });
  }

  return value;
}
