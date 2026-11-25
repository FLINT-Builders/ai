import { InvalidArgumentError } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import {
  getBatchResourcePath,
  getModelResourcePath,
  getOperationResourcePath,
  getSafePathSegment,
} from './google-resource-path';

const UNSAFE_SEGMENTS = [
  '',
  '.',
  '..',
  '../other',
  'a/b',
  'a\\b',
  'a?b',
  'a#b',
  'a%2fb',
  '%2e%2e',
  'a:b',
  'a b',
  'a\n',
  '\uff0e\uff0e',
];

describe('getSafePathSegment', () => {
  it.each(['gemini-2.5-flash', 'veo-3.1-generate-preview', 'a.b_c@001'])(
    'accepts %j',
    value => {
      expect(getSafePathSegment({ argument: 'modelId', value })).toBe(value);
    },
  );

  it.each(UNSAFE_SEGMENTS)('rejects %j', value => {
    expect(() => getSafePathSegment({ argument: 'modelId', value })).toThrow(
      InvalidArgumentError,
    );
  });

  it('rejects non-string values', () => {
    expect(() =>
      getSafePathSegment({
        argument: 'modelId',
        value: { toString: () => 'x' } as unknown as string,
      }),
    ).toThrow(InvalidArgumentError);
  });
});

describe('getModelResourcePath', () => {
  it.each([
    ['gemini-2.5-flash', 'models/gemini-2.5-flash'],
    ['models/gemini-2.5-flash', 'models/gemini-2.5-flash'],
    ['tunedModels/my-model', 'tunedModels/my-model'],
    ['endpoints/123', 'endpoints/123'],
  ])('maps %j to %j', (modelId, path) => {
    expect(getModelResourcePath(modelId)).toBe(path);
  });

  it.each([
    ...UNSAFE_SEGMENTS,
    'models/..',
    'models/a/b',
    'tunedModels/%2e%2e',
    'other/a',
    '/models/a',
  ])('rejects %j', modelId => {
    expect(() => getModelResourcePath(modelId)).toThrow(InvalidArgumentError);
  });
});

describe('getOperationResourcePath', () => {
  it.each(['operations/abc', 'models/veo-3.1-generate-preview/operations/abc'])(
    'accepts %j',
    name => {
      expect(getOperationResourcePath(name)).toBe(name);
    },
  );

  it.each([
    '../other',
    'operations/..',
    'operations/a/b',
    'operations/a?b',
    'models/../operations/a',
    'models/a/operations/..',
    'tunedModels/a/operations/b',
  ])('rejects %j', name => {
    expect(() => getOperationResourcePath(name)).toThrow(InvalidArgumentError);
  });
});

describe('getBatchResourcePath', () => {
  it('accepts a batch name', () => {
    expect(getBatchResourcePath('batches/batch-123')).toBe('batches/batch-123');
  });

  it.each(['../other', 'batches/..', 'batches/a/b', 'batches/a:cancel', 'a'])(
    'rejects %j',
    batchId => {
      expect(() => getBatchResourcePath(batchId)).toThrow(InvalidArgumentError);
    },
  );
});
