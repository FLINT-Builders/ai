import { InvalidArgumentError } from '@ai-sdk/provider';

// A region is interpolated into the request hostname, so it must be a single
// DNS label. Anything else (dots, `?`, `#`, `/`, `@`, `:`, whitespace) could
// move the request and its credentials to a host outside AWS.
const AWS_REGION_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateAwsRegion(region: string): string {
  if (region.length > 63 || !AWS_REGION_PATTERN.test(region)) {
    throw new InvalidArgumentError({
      argument: 'region',
      message:
        `Invalid AWS region ${JSON.stringify(region)}. ` +
        'A region must contain only lowercase letters, digits, and single hyphens (for example "us-east-1"). ' +
        'Use the baseURL setting to target a custom endpoint.',
    });
  }

  return region;
}
