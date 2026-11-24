import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
  HumanMessage,
} from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import {
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { RemoteGraph } from '@langchain/langgraph/remote';
import { createUIMessageStreamResponse, type UIMessage } from 'ai';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { toUIMessageStream } from './adapter';
import { LangSmithDeploymentTransport } from './transport';

/**
 * Distinct from the chat user's text. It stands in for a server-side detail
 * such as a provider response body, database host, or file path.
 */
const SERVER_DETAIL = 'server-only-detail-db.internal.example';
const SERVER_PATH = '/srv/app/provider-internal.js';
const ATTACKER_TEXT = 'please run the lookup';
const DEFAULT_CLIENT_ERROR = 'An error occurred.';
const CUSTOM_CLIENT_ERROR = 'safe-client-message';

const attackerMessages: UIMessage[] = [
  {
    id: 'user-1',
    role: 'user',
    parts: [{ type: 'text', text: ATTACKER_TEXT }],
  },
];

type ErrorMask = (error: unknown) => string | Promise<string> | void;

function callbackDetails(calls: unknown[][]): string {
  return calls
    .map(call => {
      const value = call[0];
      if (value instanceof Error) {
        return `${value.name}: ${value.message}`;
      }
      return JSON.stringify(value);
    })
    .join('\n');
}

function errorTexts(body: string): string[] {
  const texts: string[] = [];
  for (const block of body.split('\n\n')) {
    const line = block.split('\n').find(entry => entry.startsWith('data: '));
    if (line == null || line === 'data: [DONE]') continue;
    const payload = JSON.parse(line.slice('data: '.length)) as {
      errorText?: unknown;
    };
    if (typeof payload.errorText === 'string') {
      texts.push(payload.errorText);
    }
  }
  return texts;
}

function expectClientMasked(
  body: string,
  clientError: string,
  ...hidden: string[]
) {
  const texts = errorTexts(body);
  expect(texts.length).toBeGreaterThan(0);
  expect(texts).toEqual(texts.map(() => clientError));
  for (const secret of hidden) {
    expect(body).not.toContain(secret);
  }
}

async function responseBody(
  stream: ReadableStream,
  options?: { onError?: ErrorMask },
): Promise<string> {
  const response = createUIMessageStreamResponse({
    stream: toUIMessageStream(stream, options),
  });
  return response.text();
}

class MidStreamFailingChatModel extends BaseChatModel {
  constructor(private readonly failure: unknown) {
    super({});
  }

  override _llmType(): string {
    return 'mid-stream-failing-chat-model';
  }

  override async _generate(): Promise<ChatResult> {
    throw new Error('invoke is not used by this test');
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
  ): AsyncGenerator<ChatGenerationChunk> {
    const text = messages
      .map(message =>
        typeof message.content === 'string' ? message.content : '',
      )
      .join('');
    if (!text.includes(ATTACKER_TEXT)) {
      throw new Error('attacker text did not reach the model');
    }

    yield new ChatGenerationChunk({
      message: new AIMessageChunk({ content: 'partial', id: 'model-1' }),
      text: 'partial',
    });
    throw this.failure;
  }
}

async function modelStream(failure: unknown) {
  const model = new MidStreamFailingChatModel(failure);
  return model.stream([new HumanMessage(ATTACKER_TEXT)]);
}

function toolSchema() {
  return {
    type: 'object',
    properties: { q: { type: 'string' } },
    additionalProperties: true,
  };
}

let LangGraphClient: new (config: {
  apiUrl: string;
  callerOptions: { fetch: typeof fetch; maxRetries: number };
}) => { runs: { stream: (...args: unknown[]) => AsyncIterable<unknown> } };

beforeAll(async () => {
  const requireFromLangGraph = createRequire(
    import.meta.resolve('@langchain/langgraph/package.json'),
  );
  const sdkPackageJson = requireFromLangGraph.resolve(
    '@langchain/langgraph-sdk/package.json',
  );
  const sdkEntry = pathToFileURL(
    join(dirname(sdkPackageJson), 'dist/index.js'),
  ).href;
  const sdk = (await import(sdkEntry)) as {
    Client: typeof LangGraphClient;
  };
  LangGraphClient = sdk.Client;
});

describe('toUIMessageStream server error disclosure', () => {
  it('masks a provider error thrown after model.stream() has started', async () => {
    const onError = vi.fn();
    const failure = new Error(
      `provider response body included ${SERVER_DETAIL} from ${SERVER_PATH}`,
    );
    const body = await responseBody(await modelStream(failure), { onError });

    expectClientMasked(body, DEFAULT_CLIENT_ERROR, SERVER_DETAIL, SERVER_PATH);
    expect(callbackDetails(onError.mock.calls)).toContain(SERVER_DETAIL);
    expect(body).toContain('partial');
  });

  it('masks a thrown string after model.stream() has started', async () => {
    const onError = vi.fn();
    const body = await responseBody(
      await modelStream(
        `provider response body included ${SERVER_DETAIL} from ${SERVER_PATH}`,
      ),
      { onError },
    );

    expectClientMasked(body, DEFAULT_CLIENT_ERROR, SERVER_DETAIL, SERVER_PATH);
    expect(callbackDetails(onError.mock.calls)).toContain(SERVER_DETAIL);
  });

  it('masks an abort reason instead of sending it to the client', async () => {
    const onAbort = vi.fn();
    const onError = vi.fn();
    const body = await responseBody(
      await modelStream(
        new DOMException(
          `aborted while reading ${SERVER_DETAIL} at ${SERVER_PATH}`,
          'AbortError',
        ),
      ),
      { onAbort, onError },
    );

    expectClientMasked(body, DEFAULT_CLIENT_ERROR, SERVER_DETAIL, SERVER_PATH);
    expect(onAbort).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('uses the string returned by onError as the only client error text', async () => {
    const onError = vi.fn(async () => CUSTOM_CLIENT_ERROR);
    const body = await responseBody(
      await modelStream(
        new Error(`provider response body included ${SERVER_DETAIL}`),
      ),
      { onError: onError as ErrorMask },
    );

    expectClientMasked(body, CUSTOM_CLIENT_ERROR, SERVER_DETAIL);
    expect(callbackDetails(onError.mock.calls)).toContain(SERVER_DETAIL);
    expect(body).not.toContain(DEFAULT_CLIENT_ERROR);
  });

  it('masks an error thrown by model.streamEvents()', async () => {
    const onError = vi.fn();
    const model = new MidStreamFailingChatModel(
      new Error(`stream event failure ${SERVER_DETAIL} at ${SERVER_PATH}`),
    );
    const body = await responseBody(
      await model.streamEvents([new HumanMessage(ATTACKER_TEXT)], {
        version: 'v2',
      }),
      { onError },
    );

    expectClientMasked(body, DEFAULT_CLIENT_ERROR, SERVER_DETAIL, SERVER_PATH);
    expect(callbackDetails(onError.mock.calls)).toContain(SERVER_DETAIL);
  });

  it('masks a LangGraph node error thrown after the stream has started', async () => {
    const onError = vi.fn();
    const graph = new StateGraph(MessagesAnnotation)
      .addNode('ok', async () => ({
        messages: [new AIMessage('partial graph text')],
      }))
      .addNode('fail', async () => {
        throw new Error(
          `checkpointer connection failed for ${SERVER_DETAIL} at ${SERVER_PATH}`,
        );
      })
      .addEdge(START, 'ok')
      .addEdge('ok', 'fail')
      .addEdge('fail', END)
      .compile();

    const body = await responseBody(
      await graph.stream(
        { messages: [new HumanMessage(ATTACKER_TEXT)] },
        { streamMode: ['values', 'messages'] },
      ),
      { onError },
    );

    expectClientMasked(body, DEFAULT_CLIENT_ERROR, SERVER_DETAIL, SERVER_PATH);
    expect(callbackDetails(onError.mock.calls)).toContain(SERVER_DETAIL);
  });

  it('masks tool exception text from the documented values and messages stream', async () => {
    const onError = vi.fn();
    const lookup = tool(
      async () => {
        throw new Error(
          `tool backend failed for ${SERVER_DETAIL} at ${SERVER_PATH}`,
        );
      },
      {
        name: 'lookup',
        description: 'lookup',
        schema: toolSchema(),
      },
    );
    const graph = new StateGraph(MessagesAnnotation)
      .addNode('agent', async () => ({
        messages: [
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'call-1',
                name: 'lookup',
                args: { q: ATTACKER_TEXT },
                type: 'tool_call',
              },
            ],
          }),
        ],
      }))
      .addNode('tools', new ToolNode([lookup]))
      .addEdge(START, 'agent')
      .addEdge('agent', 'tools')
      .addEdge('tools', END)
      .compile();

    const body = await responseBody(
      await graph.stream(
        { messages: [new HumanMessage(ATTACKER_TEXT)] },
        { streamMode: ['values', 'messages'] },
      ),
      { onError },
    );

    expectClientMasked(body, DEFAULT_CLIENT_ERROR, SERVER_DETAIL, SERVER_PATH);
    expect(callbackDetails(onError.mock.calls)).toContain(SERVER_DETAIL);
  });

  it('masks a tool exception that fails the graph when handleToolErrors is off', async () => {
    const onError = vi.fn();
    const lookup = tool(
      async () => {
        throw new Error(`unhandled tool failure ${SERVER_DETAIL}`);
      },
      {
        name: 'lookup',
        description: 'lookup',
        schema: toolSchema(),
      },
    );
    const graph = new StateGraph(MessagesAnnotation)
      .addNode('agent', async () => ({
        messages: [
          new AIMessage({
            content: 'calling',
            tool_calls: [
              {
                id: 'call-9',
                name: 'lookup',
                args: { q: 'x' },
                type: 'tool_call',
              },
            ],
          }),
        ],
      }))
      .addNode('tools', new ToolNode([lookup], { handleToolErrors: false }))
      .addEdge(START, 'agent')
      .addEdge('agent', 'tools')
      .addEdge('tools', END)
      .compile();

    const body = await responseBody(
      await graph.stream(
        { messages: [new HumanMessage(ATTACKER_TEXT)] },
        { streamMode: ['values', 'messages'] },
      ),
      { onError },
    );

    expectClientMasked(body, DEFAULT_CLIENT_ERROR, SERVER_DETAIL);
    expect(callbackDetails(onError.mock.calls)).toContain(SERVER_DETAIL);
  });

  it('masks a non-Error tool payload from the tools stream instead of serializing it', async () => {
    const onError = vi.fn();
    const lookup = tool(
      async () => {
        throw {
          host: SERVER_DETAIL,
          file: SERVER_PATH,
          name: 'ToolFailure',
        };
      },
      {
        name: 'lookup',
        description: 'lookup',
        schema: toolSchema(),
      },
    );
    const graph = new StateGraph(MessagesAnnotation)
      .addNode('agent', async () => ({
        messages: [
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'call-2',
                name: 'lookup',
                args: {},
                type: 'tool_call',
              },
            ],
          }),
        ],
      }))
      .addNode('tools', new ToolNode([lookup]))
      .addEdge(START, 'agent')
      .addEdge('agent', 'tools')
      .addEdge('tools', END)
      .compile();

    const body = await responseBody(
      await graph.stream(
        { messages: [new HumanMessage(ATTACKER_TEXT)] },
        { streamMode: ['tools'] },
      ),
      {
        onError: onError as ErrorMask,
      },
    );

    expectClientMasked(body, DEFAULT_CLIENT_ERROR, SERVER_DETAIL, SERVER_PATH);
    expect(callbackDetails(onError.mock.calls)).toContain(SERVER_DETAIL);
    expect(callbackDetails(onError.mock.calls)).toContain(SERVER_PATH);
  });

  it('uses the onError return value for tool errors', async () => {
    const onError = vi.fn(() => CUSTOM_CLIENT_ERROR);
    const lookup = tool(
      async () => {
        throw new Error(`tool backend failed for ${SERVER_DETAIL}`);
      },
      {
        name: 'lookup',
        description: 'lookup',
        schema: toolSchema(),
      },
    );
    const graph = new StateGraph(MessagesAnnotation)
      .addNode('agent', async () => ({
        messages: [
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'call-3',
                name: 'lookup',
                args: { q: 'x' },
                type: 'tool_call',
              },
            ],
          }),
        ],
      }))
      .addNode('tools', new ToolNode([lookup]))
      .addEdge(START, 'agent')
      .addEdge('agent', 'tools')
      .addEdge('tools', END)
      .compile();

    const body = await responseBody(
      await graph.stream(
        { messages: [new HumanMessage(ATTACKER_TEXT)] },
        { streamMode: ['values', 'messages', 'tools'] },
      ),
      { onError: onError as ErrorMask },
    );

    expectClientMasked(body, CUSTOM_CLIENT_ERROR, SERVER_DETAIL);
    expect(body).not.toContain(DEFAULT_CLIENT_ERROR);
    expect(callbackDetails(onError.mock.calls)).toContain(SERVER_DETAIL);
  });

  it('masks a remote graph error event parsed by the LangGraph SDK', async () => {
    const onError = vi.fn();
    const sse = [
      'event: messages',
      'data: [{"content":"partial","type":"ai"}]',
      '',
      'event: error',
      `data: ${JSON.stringify({
        message: SERVER_DETAIL,
        path: SERVER_PATH,
      })}`,
      '',
    ].join('\n');
    const fetchImpl: typeof fetch = async () =>
      new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    const client = new LangGraphClient({
      apiUrl: 'http://127.0.0.1',
      callerOptions: { fetch: fetchImpl, maxRetries: 0 },
    });
    const remote = new RemoteGraph({
      graphId: 'agent',
      client,
    });
    const body = await responseBody(
      await remote.stream(
        { messages: [new HumanMessage(ATTACKER_TEXT)] },
        {
          streamMode: ['messages', 'values'],
          configurable: { thread_id: 'thread-1' },
        },
      ),
      { onError },
    );

    expectClientMasked(body, DEFAULT_CLIENT_ERROR, SERVER_DETAIL, SERVER_PATH);
    expect(callbackDetails(onError.mock.calls)).toContain(SERVER_DETAIL);
  });

  it('masks remote errors returned by LangSmithDeploymentTransport', async () => {
    const sse = [
      'event: messages',
      'data: [{"content":"partial","type":"ai"}]',
      '',
      'event: error',
      `data: ${JSON.stringify({
        message: `deployment failure ${SERVER_DETAIL}`,
        path: SERVER_PATH,
      })}`,
      '',
    ].join('\n');
    const fetchImpl: typeof fetch = async () =>
      new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    const remote = new RemoteGraph({
      graphId: 'agent',
      client: new LangGraphClient({
        apiUrl: 'http://127.0.0.1',
        callerOptions: { fetch: fetchImpl, maxRetries: 0 },
      }),
    });
    const transport = new LangSmithDeploymentTransport({
      url: 'http://127.0.0.1',
    });
    (
      transport as unknown as {
        graph: RemoteGraph;
      }
    ).graph = remote;

    const uiStream = await transport.sendMessages({
      trigger: 'submit-message',
      chatId: 'chat-1',
      messageId: 'user-1',
      messages: attackerMessages,
      abortSignal: undefined,
    });
    const body = await createUIMessageStreamResponse({
      stream: uiStream,
    }).text();

    expectClientMasked(body, DEFAULT_CLIENT_ERROR, SERVER_DETAIL, SERVER_PATH);
  });
});
