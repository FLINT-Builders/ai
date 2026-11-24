import type { JSONObject } from '@ai-sdk/provider';
import { isJSONSerializable } from './is-json-serializable';
import { loadApiKey } from './load-api-key';
import {
  recordEnvironmentValues,
  type RecordedEnvironmentValue,
} from './record-environment-values';
import type { Resolvable } from './resolve';
import { SerializationError } from './serialization-error';

/**
 * Header names whose values are protocol metadata rather than credentials.
 * Other resolved header values are never written to the serialized config,
 * because the serialized config is persisted by the workflow runtime.
 */
const PERSISTABLE_HEADER_NAMES = new Set([
  'anthropic-beta',
  'anthropic-version',
  'anthropic-workspace-id',
  'cartesia-version',
  'content-type',
  'openai-organization',
  'openai-project',
  'user-agent',
]);

/**
 * Optional authentication scheme (e.g. `Bearer `, `Key `) that may precede
 * an API key in a header value.
 */
const AUTH_SCHEME_PREFIX = /^(?:[A-Za-z][A-Za-z0-9-]{0,19} )?$/;

const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

type EnvironmentHeader = {
  environmentVariableName: string;
  prefix: string;
};

/**
 * Serializes a model instance for workflow step boundaries.
 * Returns the `modelId` plus the JSON-serializable config properties.
 *
 * Non-serializable values are omitted. A function-valued `headers` property
 * is resolved during serialization, but resolved header values are not
 * persisted, since they usually carry API keys:
 *
 * - A header whose value is an API key or setting that was loaded from an
 *   environment variable (optionally preceded by an auth scheme such as
 *   `Bearer `) is stored as a reference to that environment variable in
 *   `environmentHeaders`. {@link deserializeModelConfig} reads the variable
 *   again when the restored model sends a request.
 * - A small set of non-credential protocol headers (e.g. `anthropic-version`)
 *   is kept in `headers`.
 * - All other headers are dropped.
 *
 * Used as the body of `static [WORKFLOW_SERIALIZE]` in provider models.
 *
 * @example
 * ```ts
 * static [WORKFLOW_SERIALIZE](model: MyLanguageModel) {
 *   return serializeModelOptions({
 *     modelId: model.modelId,
 *     config: model.config,
 *   });
 * }
 * ```
 */
export function serializeModelOptions<
  CONFIG extends {
    headers?: Resolvable<Record<string, string | undefined>>;
  },
>(options: {
  modelId: string;
  config: CONFIG;
}): {
  modelId: string;
  config: JSONObject;
} {
  const serializableConfig: JSONObject = {};
  let environmentHeaders: Record<string, EnvironmentHeader> | undefined;

  for (const [key, value] of Object.entries(options.config)) {
    if (key === 'environmentHeaders') {
      continue;
    }

    if (key === 'headers') {
      const { result: resolvedHeaders, environmentValues } =
        recordEnvironmentValues(() => resolveSync(value));
      const persistableHeaders = toPersistableHeaders(
        resolvedHeaders,
        environmentValues,
      );
      if (Object.keys(persistableHeaders.headers).length > 0) {
        serializableConfig[key] = persistableHeaders.headers;
      }
      if (Object.keys(persistableHeaders.environmentHeaders).length > 0) {
        environmentHeaders = persistableHeaders.environmentHeaders;
      }
    } else if (isJSONSerializable(value)) {
      serializableConfig[key] = value;
    }
  }

  if (environmentHeaders != null) {
    serializableConfig.environmentHeaders = environmentHeaders;
  }

  return { modelId: options.modelId, config: serializableConfig };
}

/**
 * Restores a model config that was produced by {@link serializeModelOptions}.
 * Rebuilds `headers` as a function that re-reads the referenced environment
 * variables on every call, so that API keys are taken from the environment of
 * the workflow step rather than from persisted workflow data.
 *
 * Used in `static [WORKFLOW_DESERIALIZE]` in provider models.
 *
 * @example
 * ```ts
 * static [WORKFLOW_DESERIALIZE](options: {
 *   modelId: string;
 *   config: MyLanguageModelConfig;
 * }) {
 *   return new MyLanguageModel(
 *     options.modelId,
 *     deserializeModelConfig(options.config),
 *   );
 * }
 * ```
 */
export function deserializeModelConfig<CONFIG>(config: CONFIG): CONFIG {
  if (config == null || typeof config !== 'object') {
    return config;
  }

  const {
    environmentHeaders: serializedEnvironmentHeaders,
    headers,
    ...rest
  } = config as Record<string, unknown>;

  if (typeof headers === 'function') {
    return config;
  }

  const staticHeaders = isStringRecord(headers) ? headers : {};
  const environmentHeaders = parseEnvironmentHeaders(
    serializedEnvironmentHeaders,
  );

  if (headers == null && environmentHeaders.length === 0) {
    return (
      serializedEnvironmentHeaders === undefined ? config : rest
    ) as CONFIG;
  }

  const description =
    typeof rest.provider === 'string' ? rest.provider : 'Provider';

  return {
    ...rest,
    headers: () => {
      const restoredHeaders: Record<string, string | undefined> = {
        ...staticHeaders,
      };
      for (const {
        name,
        environmentVariableName,
        prefix,
      } of environmentHeaders) {
        restoredHeaders[name] = `${prefix}${loadApiKey({
          apiKey: undefined,
          environmentVariableName,
          description,
        })}`;
      }
      return restoredHeaders;
    },
  } as CONFIG;
}

function toPersistableHeaders(
  resolvedHeaders: unknown,
  environmentValues: RecordedEnvironmentValue[],
): {
  headers: Record<string, string>;
  environmentHeaders: Record<string, EnvironmentHeader>;
} {
  const headers: Record<string, string> = {};
  const environmentHeaders: Record<string, EnvironmentHeader> = {};

  if (resolvedHeaders == null || typeof resolvedHeaders !== 'object') {
    return { headers, environmentHeaders };
  }

  for (const [name, value] of Object.entries(resolvedHeaders)) {
    if (typeof value !== 'string') {
      continue;
    }

    const environmentHeader = findEnvironmentHeader(value, environmentValues);
    if (environmentHeader != null) {
      environmentHeaders[name] = environmentHeader;
    } else if (PERSISTABLE_HEADER_NAMES.has(name.toLowerCase())) {
      headers[name] = value;
    }
  }

  return { headers, environmentHeaders };
}

function findEnvironmentHeader(
  headerValue: string,
  environmentValues: RecordedEnvironmentValue[],
): EnvironmentHeader | undefined {
  let match: (EnvironmentHeader & { length: number }) | undefined;

  for (const { environmentVariableName, value } of environmentValues) {
    if (
      value.length === 0 ||
      !headerValue.endsWith(value) ||
      !ENVIRONMENT_VARIABLE_NAME.test(environmentVariableName)
    ) {
      continue;
    }

    const prefix = headerValue.slice(0, headerValue.length - value.length);
    if (!AUTH_SCHEME_PREFIX.test(prefix)) {
      continue;
    }

    if (match == null || value.length > match.length) {
      match = { environmentVariableName, prefix, length: value.length };
    }
  }

  return match == null
    ? undefined
    : {
        environmentVariableName: match.environmentVariableName,
        prefix: match.prefix,
      };
}

function parseEnvironmentHeaders(
  value: unknown,
): Array<EnvironmentHeader & { name: string }> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }

  const environmentHeaders: Array<EnvironmentHeader & { name: string }> = [];
  for (const [name, entry] of Object.entries(value)) {
    if (entry == null || typeof entry !== 'object') {
      continue;
    }
    const { environmentVariableName, prefix } = entry as Record<
      string,
      unknown
    >;
    if (
      typeof environmentVariableName === 'string' &&
      ENVIRONMENT_VARIABLE_NAME.test(environmentVariableName) &&
      typeof prefix === 'string' &&
      AUTH_SCHEME_PREFIX.test(prefix)
    ) {
      environmentHeaders.push({ name, environmentVariableName, prefix });
    }
  }
  return environmentHeaders;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    value != null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every(entry => typeof entry === 'string')
  );
}

function resolveSync<T>(value: Resolvable<T>): T {
  let next: unknown = value;
  if (typeof value === 'function') {
    next = (value as () => unknown)();
  }

  if (next instanceof Promise) {
    throw new SerializationError({
      message: 'Cannot serialize asynchronous model options.',
    });
  }

  return next as T;
}
