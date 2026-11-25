import { loadSetting, validateHostnameLabel } from '@ai-sdk/provider-utils';

/**
 * Loads the AWS region from the provided setting or the `AWS_REGION`
 * environment variable and ensures it is safe to use in a hostname.
 */
export function loadAmazonBedrockRegion(region: string | undefined): string {
  return validateHostnameLabel({
    value: loadSetting({
      settingValue: region,
      settingName: 'region',
      environmentVariableName: 'AWS_REGION',
      description: 'AWS region',
    }),
    argument: 'region',
  });
}
