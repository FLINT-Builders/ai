import { InvalidArgumentError } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { validateHostnameLabel } from './validate-hostname-label';

describe('validateHostnameLabel', () => {
  it.each(['us-east-1', 'global', 'eu', 'us-gov-west-1', 'my-resource-01'])(
    'returns the valid label %s',
    value => {
      expect(validateHostnameLabel({ value, argument: 'region' })).toBe(value);
    },
  );

  it.each([
    '',
    'example.com',
    'example.com?',
    'example.com#',
    'example?',
    'example#',
    'example/path',
    'user@example',
    'example:443',
    'example\\path',
    'example%2e',
    ' us-east-1',
    'us-east-1\n',
    '-us-east-1',
    'us-east-1-',
    'a'.repeat(64),
  ])('throws an InvalidArgumentError for %j', value => {
    expect(() => validateHostnameLabel({ value, argument: 'region' })).toThrow(
      expect.objectContaining({
        name: 'AI_InvalidArgumentError',
        argument: 'region',
      }),
    );

    try {
      validateHostnameLabel({ value, argument: 'region' });
    } catch (error) {
      expect(InvalidArgumentError.isInstance(error)).toBe(true);
    }
  });
});
