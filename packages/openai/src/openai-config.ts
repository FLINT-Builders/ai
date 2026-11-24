import type {
  FetchFunction,
  WebSocketConstructor,
} from '@ai-sdk/provider-utils';

type OpenAIHeaders = Record<string, string | undefined>;

type SerializedOpenAIConfig = Omit<Partial<OpenAIConfig>, 'headers'> & {
  headers?: (() => OpenAIHeaders) | OpenAIHeaders;
};

export type OpenAIConfig = {
  provider: string;
  baseURL?: string;
  url: (options: { modelId: string; path: string }) => string;
  headers?: () => OpenAIHeaders;
  fetch?: FetchFunction;
  webSocket?: WebSocketConstructor;
  generateId?: () => string;
  /**
   * Whether Responses API message input items must include an explicit
   * `type: 'message'` discriminator.
   *
   * @see https://github.com/vercel/ai/issues/20180
   */
  explicitMessageItemType?: boolean;
  /**
   * Whether the provider supports the
   * `web_search_call.action.sources` Responses API include value.
   *
   * Defaults to `true`.
   */
  supportsWebSearchSourcesInclude?: boolean;
};

export function prepareOpenAIConfigForWorkflowDeserialize(
  config: SerializedOpenAIConfig,
): OpenAIConfig {
  if (config.provider == null) {
    throw new Error(
      'OpenAI model is missing provider after workflow deserialization.',
    );
  }

  return {
    ...config,
    provider: config.provider,
    url:
      typeof config.url === 'function'
        ? config.url
        : ({ path }) => {
            if (config.baseURL == null) {
              throw new Error(
                'OpenAI model is missing baseURL after workflow deserialization.',
              );
            }

            return `${config.baseURL}${path}`;
          },
    headers:
      typeof config.headers === 'function'
        ? config.headers
        : config.headers == null
          ? undefined
          : () => config.headers as OpenAIHeaders,
  };
}
