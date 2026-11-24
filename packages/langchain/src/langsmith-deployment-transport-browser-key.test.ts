import {
  AbstractChat,
  type ChatInit,
  type ChatState,
  type ChatStatus,
  type UIMessage,
} from 'ai';
import { RemoteGraph } from '@langchain/langgraph/remote';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LangSmithDeploymentTransport,
  type LangSmithDeploymentTransportOptions,
} from './transport';

/**
 * Placeholder only. This is not a credential.
 * The LangSmith deployment examples tell a client component to pass this
 * value through from a NEXT_PUBLIC_ environment variable. Next.js inlines
 * that variable into the browser bundle as a string literal, which then
 * arrives here as `apiKey`.
 */
const API_KEY_PLACEHOLDER = 'langsmith-api-key-placeholder';

const DEPLOYMENT_URL = 'http://127.0.0.1:9';
const THREAD_ID = '00000000-0000-4000-8000-000000000001';
const ASSISTANT_ID = 'assistant-under-test';

const SERVER_SECRET_ENV_NAMES = [
  'LANGGRAPH_API_KEY',
  'LANGSMITH_API_KEY',
  'LANGCHAIN_API_KEY',
] as const;

type CapturedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

class RecordingChatState<
  UI_MESSAGE extends UIMessage,
> implements ChatState<UI_MESSAGE> {
  status: ChatStatus = 'ready';
  error: Error | undefined = undefined;
  messages: UI_MESSAGE[];

  constructor(initialMessages: UI_MESSAGE[] = []) {
    this.messages = initialMessages;
  }

  pushMessage = (message: UI_MESSAGE) => {
    this.messages = this.messages.concat(message);
  };

  popMessage = () => {
    this.messages = this.messages.slice(0, -1);
  };

  replaceMessage = (index: number, message: UI_MESSAGE) => {
    this.messages = [
      ...this.messages.slice(0, index),
      message,
      ...this.messages.slice(index + 1),
    ];
  };

  snapshot = <T>(value: T): T => value;
}

class RecordingChat extends AbstractChat<UIMessage> {
  constructor(init: ChatInit<UIMessage>) {
    super({
      ...init,
      state: new RecordingChatState(init.messages ?? []),
    });
  }
}

const savedEnv = new Map<string, string | undefined>();

function installBrowser() {
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('document', {});
}

function installServerSecrets() {
  for (const name of SERVER_SECRET_ENV_NAMES) {
    if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
    process.env[name] = API_KEY_PLACEHOLDER;
  }
}

function restoreEnvironment() {
  vi.unstubAllGlobals();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
}

function requestText(request: CapturedRequest) {
  const headers = Object.entries(request.headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
  return `${request.method} ${request.url}\n${headers}\n${request.body}`;
}

function installFetchRecorder() {
  const requests: CapturedRequest[] = [];
  const fetchImpl = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const headers = new Headers(
      init?.headers ??
        (typeof input !== 'string' && !(input instanceof URL)
          ? input.headers
          : undefined),
    );
    const recordedHeaders: Record<string, string> = {};
    headers.forEach((value, name) => {
      recordedHeaders[name] = value;
    });
    const body =
      typeof init?.body === 'string'
        ? init.body
        : init?.body == null
          ? ''
          : JSON.stringify(init.body);
    requests.push({
      url,
      method: init?.method ?? 'GET',
      headers: recordedHeaders,
      body,
    });
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  vi.stubGlobal('fetch', fetchImpl);
  return requests;
}

function credentialLeaks(requests: CapturedRequest[]) {
  return requests
    .filter(request => requestText(request).includes(API_KEY_PLACEHOLDER))
    .map(request => requestText(request));
}

function remoteClient(transport: LangSmithDeploymentTransport<UIMessage>) {
  const graph = (
    transport as unknown as {
      graph: {
        client: {
          threads: {
            search: (query?: Record<string, unknown>) => Promise<unknown>;
            getState: (threadId: string) => Promise<unknown>;
            updateState: (
              threadId: string,
              options: { values: Record<string, unknown> },
            ) => Promise<unknown>;
          };
          runs: {
            create: (
              threadId: string | null,
              assistantId: string,
              payload?: Record<string, unknown>,
            ) => Promise<unknown>;
            createBatch: (
              payloads: Array<Record<string, unknown>>,
            ) => Promise<unknown>;
          };
          assistants: {
            update: (
              assistantId: string,
              payload: Record<string, unknown>,
            ) => Promise<unknown>;
            search: (query?: Record<string, unknown>) => Promise<unknown>;
          };
          store: {
            putItem: (
              namespace: string[],
              key: string,
              value: Record<string, unknown>,
            ) => Promise<unknown>;
          };
          crons: {
            search: (query?: Record<string, unknown>) => Promise<unknown>;
          };
        };
        getState: (config: {
          configurable: { thread_id: string };
        }) => Promise<unknown>;
        updateState: (
          config: { configurable: { thread_id: string } },
          values: Record<string, unknown>,
        ) => Promise<unknown>;
        getGraphAsync: () => Promise<unknown>;
      };
    }
  ).graph;
  return graph;
}

/**
 * Options whose credential is re-read on every access. A check that
 * inspects `apiKey` and then constructs the remote client from the same
 * object must not observe a different value than the one it refused.
 */
function browserKeyOptions(): LangSmithDeploymentTransportOptions {
  return {
    url: DEPLOYMENT_URL,
    get apiKey() {
      return API_KEY_PLACEHOLDER;
    },
  };
}

function browserHeaderOptions(): LangSmithDeploymentTransportOptions {
  return {
    url: DEPLOYMENT_URL,
    get headers() {
      return { 'X-Api-Key': API_KEY_PLACEHOLDER };
    },
  };
}

async function expectNoBrowserCredential(
  options: LangSmithDeploymentTransportOptions,
  exercise: (
    transport: LangSmithDeploymentTransport<UIMessage>,
  ) => Promise<void>,
  requireRefusal = true,
) {
  installBrowser();
  installServerSecrets();
  const requests = installFetchRecorder();
  let refusal: unknown;
  try {
    const transport = new LangSmithDeploymentTransport(options);
    try {
      await exercise(transport);
    } catch (error) {
      refusal = error;
    }
  } catch (error) {
    refusal = error;
  }

  expect(credentialLeaks(requests)).toEqual([]);
  if (!requireRefusal) return;

  expect(refusal).toBeInstanceOf(Error);
  expect((refusal as Error).message.toLowerCase()).toContain('browser');
  expect((refusal as Error).message.toLowerCase()).toContain('api key');
}

afterEach(() => {
  restoreEnvironment();
});

describe('LangSmithDeploymentTransport browser credential', () => {
  it('does not send the apiKey when useChat submits a message', async () => {
    await expectNoBrowserCredential(browserKeyOptions(), async transport => {
      const chat = new RecordingChat({ transport, id: 'visitor-chat' });
      await chat.sendMessage({ text: 'hello from the browser' });
      if (chat.error) throw chat.error;
    });
  });

  it('does not send an apiKey supplied through request headers', async () => {
    await expectNoBrowserCredential(browserHeaderOptions(), async transport => {
      const chat = new RecordingChat({ transport, id: 'visitor-chat' });
      await chat.sendMessage({ text: 'hello from the browser' });
      if (chat.error) throw chat.error;
    });
  });

  it('does not send a key already stored on a caller-supplied client', async () => {
    const seeded = new RemoteGraph({
      graphId: 'agent',
      url: DEPLOYMENT_URL,
      apiKey: API_KEY_PLACEHOLDER,
    });
    const client = (seeded as unknown as { client: object }).client;
    await expectNoBrowserCredential(
      {
        graphId: 'agent',
        client,
      } as LangSmithDeploymentTransportOptions,
      async transport => {
        const chat = new RecordingChat({ transport, id: 'visitor-chat' });
        await chat.sendMessage({ text: 'hello from the browser' });
        if (chat.error) throw chat.error;
      },
    );
  });

  it('does not attach the key when searching threads', async () => {
    await expectNoBrowserCredential(browserKeyOptions(), async transport => {
      await remoteClient(transport).client.threads.search({});
    });
  });

  it('does not attach the key when reading or updating thread state', async () => {
    await expectNoBrowserCredential(browserKeyOptions(), async transport => {
      const graph = remoteClient(transport);
      const results = await Promise.allSettled([
        graph.client.threads.getState(THREAD_ID),
        graph.client.threads.updateState(THREAD_ID, {
          values: { messages: [] },
        }),
        graph.getState({ configurable: { thread_id: THREAD_ID } }),
        graph.updateState(
          { configurable: { thread_id: THREAD_ID } },
          { messages: [] },
        ),
      ]);
      const rejected = results.find(result => result.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
    });
  });

  it('does not attach the key when creating runs', async () => {
    await expectNoBrowserCredential(browserKeyOptions(), async transport => {
      const client = remoteClient(transport).client;
      await client.runs.create(null, ASSISTANT_ID, {
        input: { messages: [] },
      });
      await client.runs.createBatch([
        { assistantId: ASSISTANT_ID, input: { messages: [] } },
      ]);
    });
  });

  it('does not attach the key when updating or searching assistants', async () => {
    await expectNoBrowserCredential(browserKeyOptions(), async transport => {
      const graph = remoteClient(transport);
      const results = await Promise.allSettled([
        graph.client.assistants.update(ASSISTANT_ID, {
          name: 'renamed-by-visitor',
        }),
        graph.client.assistants.search({}),
        graph.getGraphAsync(),
      ]);
      const rejected = results.find(result => result.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
    });
  });

  it('does not attach the key for store or cron calls on the same client', async () => {
    await expectNoBrowserCredential(browserKeyOptions(), async transport => {
      const client = remoteClient(transport).client;
      await client.store.putItem(['visitor'], 'note', { text: 'hello' });
      await client.crons.search({});
    });
  });

  it('still refuses when the explicit apiKey is absent and the server env vars are set', async () => {
    await expectNoBrowserCredential(
      { url: DEPLOYMENT_URL },
      async transport => {
        const chat = new RecordingChat({ transport, id: 'visitor-chat' });
        await chat.sendMessage({
          text: 'local dev must not pick up the server key',
        });
        if (chat.error) throw chat.error;
      },
      false,
    );
  });
});

describe('LangSmith deployment docs do not put the API key in the browser', () => {
  async function readRepoFile(relativePath: string) {
    try {
      const { readFile } = await import('node:fs/promises');
      const { dirname, resolve } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const here = dirname(fileURLToPath(import.meta.url));
      return await readFile(resolve(here, relativePath), 'utf8');
    } catch {
      return undefined;
    }
  }

  async function requireText(relativePath: string) {
    return readRepoFile(relativePath);
  }

  it('does not tell client code to inline a LangSmith key', async () => {
    const sources = [
      await requireText(
        '../../../content/providers/06-adapters/01-langchain.mdx',
      ),
      await requireText('../README.md'),
      await requireText('./transport.ts'),
      await requireText('../../../examples/next-langchain/README.md'),
      await requireText(
        '../../../examples/next-langchain/app/langsmith/page.tsx',
      ),
      await requireText(
        '../../../examples/next-langchain/components/langsmith-config-panel.tsx',
      ),
    ];
    if (sources.some(source => source === undefined)) {
      expect(process.release?.name).not.toBe('node');
      return;
    }

    for (const source of sources) {
      expect(source).not.toContain('NEXT_PUBLIC_LANGSMITH_API_KEY');
      expect(source).not.toMatch(/apiKey\s*:/);
    }
  });

  it('warns that the LangSmith key is a server secret', async () => {
    const sources = [
      await requireText(
        '../../../content/providers/06-adapters/01-langchain.mdx',
      ),
      await requireText('../README.md'),
      await requireText('./transport.ts'),
    ];
    if (sources.some(source => source === undefined)) {
      expect(process.release?.name).not.toBe('node');
      return;
    }

    for (const source of sources) {
      expect(source?.toLowerCase()).toContain('server secret');
    }
  });
});
