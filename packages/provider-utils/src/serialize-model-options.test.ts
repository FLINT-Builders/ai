import { LoadAPIKeyError } from '@ai-sdk/provider';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadApiKey } from './load-api-key';
import { loadOptionalSetting } from './load-optional-setting';
import {
  deserializeModelConfig,
  serializeModelOptions,
} from './serialize-model-options';
import { SerializationError } from './serialization-error';

type TestConfig = Record<string, unknown> & {
  headers?: () => Record<string, string | undefined>;
};

const ENV_PLACEHOLDER = 'placeholder-env-credential';
const EXPLICIT_PLACEHOLDER = 'placeholder-explicit-credential';

function envHeaders(apiKey?: string) {
  return () => ({
    authorization: `Bearer ${loadApiKey({
      apiKey,
      environmentVariableName: 'TEST_PROVIDER_API_KEY',
      description: 'Test',
    })}`,
    'anthropic-version': '2023-06-01',
    'user-agent': 'ai-sdk/test/0.0.0',
  });
}

describe('serializeModelOptions', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns modelId and serializable config without credential headers', () => {
    const result = serializeModelOptions({
      modelId: 'claude-sonnet-4-20250514',
      config: {
        provider: 'anthropic.messages',
        baseURL: 'https://api.anthropic.com/v1',
        headers: () => ({ 'x-api-key': EXPLICIT_PLACEHOLDER }),
        fetch: undefined,
        generateId: () => 'id',
        supportedUrls: () => ({}),
        supportsNativeStructuredOutput: true,
        supportsStrictTools: false,
      },
    });

    expect(result).toEqual({
      modelId: 'claude-sonnet-4-20250514',
      config: {
        provider: 'anthropic.messages',
        baseURL: 'https://api.anthropic.com/v1',
        supportsNativeStructuredOutput: true,
        supportsStrictTools: false,
      },
    });
  });

  it.each([
    'authorization',
    'Authorization',
    'x-api-key',
    'api-key',
    'xi-api-key',
    'x-goog-api-key',
    'x-key',
    'X-Custom-Proxy-Token',
  ])('does not persist explicit values of the %s header', headerName => {
    const result = serializeModelOptions({
      modelId: 'model',
      config: {
        provider: 'test',
        headers: () => ({ [headerName]: `Bearer ${EXPLICIT_PLACEHOLDER}` }),
      },
    });

    expect(result).toEqual({ modelId: 'model', config: { provider: 'test' } });
    expect(JSON.stringify(result)).not.toContain(EXPLICIT_PLACEHOLDER);
  });

  it('does not persist an explicitly passed API key', () => {
    vi.stubEnv('TEST_PROVIDER_API_KEY', ENV_PLACEHOLDER);

    const result = serializeModelOptions({
      modelId: 'model',
      config: { provider: 'test', headers: envHeaders(EXPLICIT_PLACEHOLDER) },
    });

    expect(JSON.stringify(result)).not.toContain(EXPLICIT_PLACEHOLDER);
    expect(result.config).not.toHaveProperty('environmentHeaders');
    expect(result.config.headers).toEqual({
      'anthropic-version': '2023-06-01',
      'user-agent': 'ai-sdk/test/0.0.0',
    });
  });

  it('stores environment-loaded API keys as environment variable references', () => {
    vi.stubEnv('TEST_PROVIDER_API_KEY', ENV_PLACEHOLDER);

    const result = serializeModelOptions({
      modelId: 'gpt-4',
      config: {
        provider: 'openai',
        headers: envHeaders(),
        url: () => 'https://api.openai.com/v1/chat/completions',
      },
    });

    expect(result).toEqual({
      modelId: 'gpt-4',
      config: {
        provider: 'openai',
        headers: {
          'anthropic-version': '2023-06-01',
          'user-agent': 'ai-sdk/test/0.0.0',
        },
        environmentHeaders: {
          authorization: {
            environmentVariableName: 'TEST_PROVIDER_API_KEY',
            prefix: 'Bearer ',
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(ENV_PLACEHOLDER);
  });

  it('stores environment-loaded optional settings without a scheme as references', () => {
    vi.stubEnv('TEST_PROVIDER_TOKEN', ENV_PLACEHOLDER);

    const result = serializeModelOptions({
      modelId: 'model',
      config: {
        provider: 'test',
        headers: () => ({
          'x-api-key': loadOptionalSetting({
            settingValue: undefined,
            environmentVariableName: 'TEST_PROVIDER_TOKEN',
          }),
        }),
      },
    });

    expect(result.config).toEqual({
      provider: 'test',
      environmentHeaders: {
        'x-api-key': {
          environmentVariableName: 'TEST_PROVIDER_TOKEN',
          prefix: '',
        },
      },
    });
  });

  it('drops headers that embed an environment value in other text', () => {
    vi.stubEnv('TEST_PROVIDER_API_KEY', ENV_PLACEHOLDER);

    const result = serializeModelOptions({
      modelId: 'model',
      config: {
        provider: 'test',
        headers: () => {
          const apiKey = loadApiKey({
            apiKey: undefined,
            environmentVariableName: 'TEST_PROVIDER_API_KEY',
            description: 'Test',
          });
          return {
            authorization: `Bearer ${EXPLICIT_PLACEHOLDER}:${apiKey}`,
            'x-signed': `${apiKey}.suffix`,
          };
        },
      },
    });

    expect(result.config).toEqual({ provider: 'test' });
    expect(JSON.stringify(result)).not.toContain(EXPLICIT_PLACEHOLDER);
    expect(JSON.stringify(result)).not.toContain(ENV_PLACEHOLDER);
  });

  it('ignores a pre-existing environmentHeaders config value', () => {
    const result = serializeModelOptions({
      modelId: 'model',
      config: {
        provider: 'test',
        environmentHeaders: {
          authorization: { environmentVariableName: 'OTHER', prefix: '' },
        },
      } as TestConfig,
    });

    expect(result.config).toEqual({ provider: 'test' });
  });

  it('filters out objects containing functions', () => {
    const config: TestConfig = {
      provider: 'openai-compatible',
      errorStructure: {
        errorSchema: {},
        errorToMessage: () => 'error',
      },
      metadataExtractor: {
        extractMetadata: async () => undefined,
        createStreamExtractor: () => ({}),
      },
    };

    const result = serializeModelOptions({
      modelId: 'model',
      config,
    });

    expect(result).toEqual({
      modelId: 'model',
      config: { provider: 'openai-compatible' },
    });
  });

  it('keeps arrays of primitives', () => {
    const config: TestConfig = {
      provider: 'test',
      tags: ['a', 'b'],
      fn: () => {},
    };

    const result = serializeModelOptions({
      modelId: 'model',
      config,
    });

    expect(result).toEqual({
      modelId: 'model',
      config: { provider: 'test', tags: ['a', 'b'] },
    });
  });

  it('throws when headers resolve asynchronously', () => {
    expect(() =>
      serializeModelOptions({
        modelId: 'model',
        config: {
          provider: 'test',
          headers: async () => ({ 'x-api-key': EXPLICIT_PLACEHOLDER }),
        },
      }),
    ).toThrow(SerializationError);
  });

  it('throws when headers is a function returning a Promise', () => {
    expect(() =>
      serializeModelOptions({
        modelId: 'model',
        config: {
          provider: 'test',
          headers: () => Promise.resolve({ 'x-api-key': EXPLICIT_PLACEHOLDER }),
        },
      }),
    ).toThrow('Cannot serialize asynchronous model options.');
  });

  it('marks serialization errors for cross-realm detection', () => {
    let serializationError: unknown;

    try {
      serializeModelOptions({
        modelId: 'model',
        config: {
          headers: async () => ({}),
        },
      });
    } catch (error) {
      serializationError = error;
    }

    expect(SerializationError.isInstance(serializationError)).toBe(true);
  });

  it('filters out class instances', () => {
    const config: TestConfig = {
      provider: 'test',
      date: new Date(),
      regex: /test/,
    };

    const result = serializeModelOptions({
      modelId: 'model',
      config,
    });

    expect(result).toEqual({
      modelId: 'model',
      config: { provider: 'test' },
    });
  });
});

describe('deserializeModelConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('restores API key headers from the environment of the step', () => {
    vi.stubEnv('TEST_PROVIDER_API_KEY', ENV_PLACEHOLDER);
    const serialized = serializeModelOptions({
      modelId: 'model',
      config: { provider: 'test', headers: envHeaders() },
    });
    vi.stubEnv('TEST_PROVIDER_API_KEY', 'placeholder-step-credential');

    const restored = deserializeModelConfig(
      JSON.parse(JSON.stringify(serialized.config)) as TestConfig,
    );

    expect(restored).not.toHaveProperty('environmentHeaders');
    expect(restored.headers?.()).toEqual({
      'anthropic-version': '2023-06-01',
      'user-agent': 'ai-sdk/test/0.0.0',
      authorization: 'Bearer placeholder-step-credential',
    });
  });

  it('throws a missing API key error when the step environment lacks the key', () => {
    const restored = deserializeModelConfig<TestConfig>({
      provider: 'test.chat',
      environmentHeaders: {
        authorization: {
          environmentVariableName: 'TEST_PROVIDER_API_KEY',
          prefix: 'Bearer ',
        },
      },
    });

    expect(() => restored.headers?.()).toThrow(LoadAPIKeyError);
    expect(() => restored.headers?.()).toThrow('TEST_PROVIDER_API_KEY');
  });

  it('ignores malformed environment header entries', () => {
    const restored = deserializeModelConfig<TestConfig>({
      provider: 'test',
      environmentHeaders: {
        authorization: { environmentVariableName: 'NOT VALID', prefix: '' },
        'x-api-key': {
          environmentVariableName: 'TEST_PROVIDER_API_KEY',
          prefix: 'not an auth scheme ',
        },
        other: 'TEST_PROVIDER_API_KEY',
      },
    });

    expect(restored).toEqual({ provider: 'test' });
  });

  it('turns plain object headers into a headers function', () => {
    const restored = deserializeModelConfig<TestConfig>({
      provider: 'test',
      headers: { 'anthropic-version': '2023-06-01' } as never,
    });

    expect(restored.headers?.()).toEqual({ 'anthropic-version': '2023-06-01' });
  });

  it('leaves configs without headers unchanged', () => {
    const config = { provider: 'test', baseURL: 'https://example.com' };

    expect(deserializeModelConfig(config)).toBe(config);
  });

  it('leaves function headers unchanged', () => {
    const headers = () => ({ 'x-test': 'value' });
    const config = { provider: 'test', headers };

    expect(deserializeModelConfig(config).headers).toBe(headers);
  });
});
