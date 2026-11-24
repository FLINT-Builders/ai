import type { AIMessageChunk } from '@langchain/core/messages';
import type {
  UIMessage,
  UIMessageChunk,
  ChatTransport,
  ChatRequestOptions,
} from 'ai';
import {
  RemoteGraph,
  type RemoteGraphParams,
} from '@langchain/langgraph/remote';
import { toBaseMessages, toUIMessageStream } from './adapter';

/**
 * Options for configuring a LangSmith deployment transport.
 * Extends RemoteGraphParams but makes graphId optional (defaults to 'agent').
 */
export type LangSmithDeploymentTransportOptions = Omit<
  RemoteGraphParams,
  'graphId'
> & {
  /**
   * The ID of the graph to connect to.
   * @default 'agent'
   */
  graphId?: string;
};

type RemoteGraphConstructorParams = Omit<RemoteGraphParams, 'apiKey'> & {
  /**
   * `null` stops the LangGraph client from reading API keys from environment
   * variables, which bundlers may inline into browser code.
   */
  apiKey?: string | null;
};

const API_KEY_HEADER = 'x-api-key';

function isBrowserEnvironment(): boolean {
  const scope = globalThis as {
    window?: unknown;
    document?: unknown;
    self?: unknown;
    WorkerGlobalScope?: abstract new (...args: never[]) => unknown;
  };
  if (scope.window !== undefined && scope.document !== undefined) {
    return true;
  }
  return (
    typeof scope.WorkerGlobalScope === 'function' &&
    scope.self instanceof scope.WorkerGlobalScope
  );
}

function browserApiKeyError(source: string): Error {
  return new Error(
    `LangSmithDeploymentTransport received a LangSmith API key (${source}) ` +
      'while running in the browser. The LangSmith API key is a server ' +
      'secret: anyone who loads the page can read it and call the ' +
      'deployment directly. Call the deployment from a server route instead, ' +
      'or connect without an API key (for example to a local LangGraph ' +
      'development server).',
  );
}

function headerEntries(headers: unknown): Array<[string, unknown]> {
  if (headers == null) return [];
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const entries: Array<[string, unknown]> = [];
    headers.forEach((value, name) => entries.push([name, value]));
    return entries;
  }
  if (Array.isArray(headers)) {
    return headers.map(entry => [String(entry[0]), entry[1]]);
  }
  return Object.entries(headers as Record<string, unknown>);
}

/**
 * Copies the caller's headers into an object owned by the transport.
 * The LangGraph client keeps a reference to the object it receives and
 * writes the API key into it, so the caller's object must not be shared.
 */
function copyHeaders(
  headers: unknown,
  inBrowser: boolean,
): Record<string, string> | undefined {
  if (headers == null) return undefined;
  const copy: Record<string, string> = {};
  for (const [name, value] of headerEntries(headers)) {
    if (value == null) continue;
    if (inBrowser && name.toLowerCase() === API_KEY_HEADER) {
      throw browserApiKeyError(`"${name}" header`);
    }
    copy[name] = String(value);
  }
  return copy;
}

function clientCarriesApiKey(client: object): boolean {
  return Object.values(client).some(subClient => {
    const defaultHeaders = (subClient as { defaultHeaders?: unknown } | null)
      ?.defaultHeaders;
    return headerEntries(defaultHeaders).some(
      ([name, value]) => value != null && name.toLowerCase() === API_KEY_HEADER,
    );
  });
}

/**
 * A ChatTransport implementation for LangSmith/LangGraph deployments.
 *
 * This transport enables seamless integration between the AI SDK's useChat hook
 * and LangSmith deployed LangGraph agents.
 *
 * The LangSmith API key is a server secret. When the transport runs in the
 * browser it refuses an API key (passed as `apiKey`, as an `x-api-key` header,
 * or stored on a caller-supplied client) and does not read API keys from
 * environment variables. In the browser, use it only with servers that do not
 * need a LangSmith API key, such as a local LangGraph development server.
 * To call a LangSmith deployment that requires an API key, use `RemoteGraph`
 * with `toUIMessageStream` in a server route instead.
 *
 * @example
 * ```ts
 * import { LangSmithDeploymentTransport } from '@ai-sdk/langchain';
 *
 * // Use with useChat against a local LangGraph development server
 * const { messages, sendMessage } = useChat({
 *   transport: new LangSmithDeploymentTransport({
 *     url: 'http://localhost:2024',
 *   }),
 * });
 * ```
 */
export class LangSmithDeploymentTransport<
  UI_MESSAGE extends UIMessage,
> implements ChatTransport<UI_MESSAGE> {
  protected graph: RemoteGraph;

  constructor(options: LangSmithDeploymentTransportOptions) {
    // Each option is read exactly once; only these bound values are used.
    const { apiKey, headers, client, graphId, ...rest } = options;
    const inBrowser = isBrowserEnvironment();

    if (inBrowser && apiKey != null && apiKey !== '') {
      throw browserApiKeyError('"apiKey" option');
    }
    if (inBrowser && client != null && clientCarriesApiKey(client)) {
      throw browserApiKeyError('stored on the supplied client');
    }

    const params: RemoteGraphConstructorParams = {
      ...rest,
      graphId: graphId ?? 'agent',
      client,
      apiKey,
      headers: copyHeaders(headers, inBrowser),
    };
    if (inBrowser) {
      params.apiKey = null;
    }

    this.graph = new RemoteGraph(params as RemoteGraphParams);
  }

  async sendMessages(
    options: {
      trigger: 'submit-message' | 'regenerate-message';
      chatId: string;
      messageId: string | undefined;
      messages: UI_MESSAGE[];
      abortSignal: AbortSignal | undefined;
    } & ChatRequestOptions,
  ): Promise<ReadableStream<UIMessageChunk>> {
    const baseMessages = await toBaseMessages(options.messages);

    const stream = await this.graph.stream(
      { messages: baseMessages },
      { streamMode: ['values', 'messages'] },
    );

    return toUIMessageStream(
      stream as AsyncIterable<AIMessageChunk> | ReadableStream,
    );
  }

  async reconnectToStream(
    _options: {
      chatId: string;
    } & ChatRequestOptions,
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    throw new Error('Method not implemented.');
  }
}
