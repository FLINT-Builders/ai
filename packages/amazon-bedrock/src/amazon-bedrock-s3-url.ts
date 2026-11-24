import { UnsupportedFunctionalityError } from '@ai-sdk/provider';

const S3_BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export function getAmazonBedrockSupportedUrls(
  allowedS3Buckets: readonly string[] | undefined,
): Record<string, RegExp[]> {
  const patterns = (allowedS3Buckets ?? [])
    .filter(bucket => S3_BUCKET_NAME.test(bucket))
    .map(bucket => new RegExp(`^s3://${bucket.replace(/\./g, '\\.')}/.`));

  return patterns.length > 0
    ? { 'image/*': patterns, 'video/*': patterns }
    : {};
}

/**
 * Returns the S3 URI to send to Bedrock for `url`, or throws when the URL does
 * not point to an object in one of the allowed buckets.
 */
export function getAllowedAmazonBedrockS3Uri({
  url,
  allowedS3Buckets,
  functionality,
}: {
  url: URL;
  allowedS3Buckets: readonly string[] | undefined;
  functionality: string;
}): string {
  const bucket = url.hostname;

  if (
    url.protocol !== 's3:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.pathname.length <= 1 ||
    !S3_BUCKET_NAME.test(bucket) ||
    !(allowedS3Buckets ?? []).includes(bucket)
  ) {
    throw new UnsupportedFunctionalityError({
      functionality,
      message:
        `${functionality} is only supported for s3:// URLs of objects in ` +
        'buckets listed in the allowedS3Buckets provider setting.',
    });
  }

  return `s3://${bucket}${url.pathname}`;
}
