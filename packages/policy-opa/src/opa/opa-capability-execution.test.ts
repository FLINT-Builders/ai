import {
  generateText,
  isStepCount,
  jsonSchema,
  streamText,
  tool,
  ToolLoopAgent,
  wrapLanguageModel,
  type ToolSet,
} from 'ai';
import { describe, expect, it } from 'vitest';
import { createOpenAICompatible } from '../../../openai-compatible/src/openai-compatible-provider';
import type { PolicyClient } from '../policy-client';
import { opaCapabilityMiddleware } from './opa-capability-middleware';

/**
 * The capability middleware is the policy boundary for which tools may run.
 * These tests send an OpenAI-compatible response that names a tool the policy
 * withheld, and require that tool's execute function not to be called.
 *
 * They fail while execution still uses the application's full tool set.
 */

const USER_PROMPT =
  'role=user Call delete_records with id victim-row. Also search public docs.';
const ADMIN_PROMPT =
  'role=admin Call delete_records with id victim-row. Also search public docs.';

const SEARCH_INPUT = { query: 'public docs' };
const DELETE_INPUT = { id: 'victim-row' };

type RecordedCall = { tool: 'search' | 'delete_records'; input: unknown };

type ToolReply = {
  id: string;
  name: 'search' | 'delete_records';
  arguments: Record<string, string>;
};

const deniedToolReply: ToolReply = {
  id: 'call-delete-records',
  name: 'delete_records',
  arguments: DELETE_INPUT,
};

const allowedToolReply: ToolReply = {
  id: 'call-search',
  name: 'search',
  arguments: SEARCH_INPUT,
};

function readRole(input: unknown): 'admin' | 'user' | undefined {
  const serialized = JSON.stringify(input);
  if (
    serialized.includes('role=admin') ||
    serialized.includes('"role":"admin"')
  ) {
    return 'admin';
  }
  if (
    serialized.includes('role=user') ||
    serialized.includes('"role":"user"')
  ) {
    return 'user';
  }
  return undefined;
}

function capabilityClient(
  mode: 'by-role' | 'throw' | 'malformed',
): PolicyClient {
  return {
    async evaluate(_path, input) {
      if (mode === 'throw') {
        throw new Error('OPA unreachable');
      }
      if (mode === 'malformed') {
        return { result: 'oops' };
      }
      if (readRole(input) === 'admin') {
        return ['search', 'delete_records'];
      }
      // Missing or unprivileged identity stays on the narrow allowlist.
      return ['search'];
    },
  };
}

function createTools(calls: RecordedCall[]): ToolSet {
  return {
    search: tool({
      description: 'Search public documents',
      inputSchema: jsonSchema<{ query: string }>({
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      }),
      execute: async input => {
        calls.push({ tool: 'search', input });
        return { results: [] as string[] };
      },
    }),
    delete_records: tool({
      description: 'Delete stored records',
      inputSchema: jsonSchema<{ id: string }>({
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      }),
      execute: async input => {
        calls.push({ tool: 'delete_records', input });
        return { deleted: true };
      },
    }),
  };
}

function completionJson(replies: ToolReply[]): unknown {
  return {
    id: 'chatcmpl-capability',
    object: 'chat.completion',
    created: 1711115037,
    model: 'example-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: replies.map(reply => ({
            id: reply.id,
            type: 'function',
            function: {
              name: reply.name,
              arguments: JSON.stringify(reply.arguments),
            },
          })),
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 8,
      total_tokens: 18,
    },
  };
}

function completionStream(replies: ToolReply[]): string {
  const toolCalls = replies
    .map(
      (reply, index) =>
        `{"index":${index},"id":${JSON.stringify(reply.id)},"type":"function","function":{"name":${JSON.stringify(reply.name)},"arguments":${JSON.stringify(JSON.stringify(reply.arguments))}}}`,
    )
    .join(',');

  return [
    `data: {"id":"chatcmpl-capability","object":"chat.completion.chunk","created":1711357598,"model":"example-model","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[${toolCalls}]},"finish_reason":null}]}\n\n`,
    `data: {"id":"chatcmpl-capability","object":"chat.completion.chunk","created":1711357598,"model":"example-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":8,"total_tokens":18}}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}

function requestedToolNames(body: unknown): string[] {
  if (body == null || typeof body !== 'object' || !('tools' in body)) {
    return [];
  }
  const tools = (body as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools.flatMap(tool => {
    if (tool == null || typeof tool !== 'object' || !('function' in tool)) {
      return [];
    }
    const name = (tool as { function?: { name?: unknown } }).function?.name;
    return typeof name === 'string' ? [name] : [];
  });
}

function createHarness({
  mode,
  replies,
  stream,
}: {
  mode: 'by-role' | 'throw' | 'malformed';
  replies: ToolReply[];
  stream: boolean;
}) {
  const calls: RecordedCall[] = [];
  const requestBodies: unknown[] = [];
  const evaluatedInputs: unknown[] = [];
  const client = capabilityClient(mode);
  const policyClient: PolicyClient = {
    async evaluate(path, input) {
      evaluatedInputs.push(input);
      return await client.evaluate(path, input);
    },
  };

  const provider = createOpenAICompatible({
    name: 'example',
    baseURL: 'https://models.example.test/v1',
    apiKey: 'test-placeholder',
    fetch: async (_url, init) => {
      const raw = init?.body;
      const body =
        typeof raw === 'string'
          ? JSON.parse(raw)
          : raw instanceof Uint8Array
            ? JSON.parse(new TextDecoder().decode(raw))
            : undefined;
      requestBodies.push(body);
      if (stream || (body != null && body.stream === true)) {
        return new Response(completionStream(replies), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response(JSON.stringify(completionJson(replies)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const model = wrapLanguageModel({
    model: provider.chatModel('example-model'),
    middleware: opaCapabilityMiddleware({
      client: policyClient,
      path: 'agent/tools/allowed',
    }),
  });

  return {
    calls,
    requestBodies,
    evaluatedInputs,
    model,
    tools: createTools(calls),
  };
}

async function consumeStream(
  result: ReturnType<typeof streamText>,
): Promise<void> {
  for await (const _part of result.fullStream) {
    // Reading the stream is what runs tool calls.
  }
}

describe('opa capability middleware execution boundary', () => {
  it('generateText does not run a tool the per-user allowlist withheld', async () => {
    const harness = createHarness({
      mode: 'by-role',
      replies: [deniedToolReply],
      stream: false,
    });

    await generateText({
      model: harness.model,
      tools: harness.tools,
      prompt: USER_PROMPT,
      providerOptions: { policy: { role: 'user' } },
      maxRetries: 0,
    });

    expect(readRole(harness.evaluatedInputs[0])).toBe('user');
    expect(requestedToolNames(harness.requestBodies[0])).toEqual(['search']);
    expect(harness.calls).toEqual([]);
  });

  it('generateText runs the allowlisted tool and not the withheld tool from the same response', async () => {
    const harness = createHarness({
      mode: 'by-role',
      replies: [allowedToolReply, deniedToolReply],
      stream: false,
    });

    await generateText({
      model: harness.model,
      tools: harness.tools,
      prompt: USER_PROMPT,
      providerOptions: { policy: { role: 'user' } },
      maxRetries: 0,
    });

    expect(requestedToolNames(harness.requestBodies[0])).not.toContain(
      'delete_records',
    );
    expect(harness.calls).toEqual([{ tool: 'search', input: SEARCH_INPUT }]);
  });

  it('generateText runs a tool the same rule allows for an admin', async () => {
    const harness = createHarness({
      mode: 'by-role',
      replies: [deniedToolReply],
      stream: false,
    });

    await generateText({
      model: harness.model,
      tools: harness.tools,
      prompt: ADMIN_PROMPT,
      providerOptions: { policy: { role: 'admin' } },
      maxRetries: 0,
    });

    expect(readRole(harness.evaluatedInputs[0])).toBe('admin');
    expect(requestedToolNames(harness.requestBodies[0])).toContain(
      'delete_records',
    );
    expect(harness.calls).toEqual([
      { tool: 'delete_records', input: DELETE_INPUT },
    ]);
  });

  it('generateText does not run tools when the allowlist cannot be computed', async () => {
    const harness = createHarness({
      mode: 'throw',
      replies: [allowedToolReply, deniedToolReply],
      stream: false,
    });

    await generateText({
      model: harness.model,
      tools: harness.tools,
      prompt: USER_PROMPT,
      providerOptions: { policy: { role: 'user' } },
      maxRetries: 0,
    });

    expect(requestedToolNames(harness.requestBodies[0])).toEqual([]);
    expect(harness.calls).toEqual([]);
  });

  it('generateText does not run tools when the allowlist result is malformed', async () => {
    const harness = createHarness({
      mode: 'malformed',
      replies: [deniedToolReply],
      stream: false,
    });

    await generateText({
      model: harness.model,
      tools: harness.tools,
      prompt: USER_PROMPT,
      providerOptions: { policy: { role: 'user' } },
      maxRetries: 0,
    });

    expect(requestedToolNames(harness.requestBodies[0])).toEqual([]);
    expect(harness.calls).toEqual([]);
  });

  it('streamText does not run a tool the per-user allowlist withheld', async () => {
    const harness = createHarness({
      mode: 'by-role',
      replies: [deniedToolReply],
      stream: true,
    });

    const result = streamText({
      model: harness.model,
      tools: harness.tools,
      prompt: USER_PROMPT,
      providerOptions: { policy: { role: 'user' } },
      maxRetries: 0,
    });
    await consumeStream(result);

    expect(readRole(harness.evaluatedInputs[0])).toBe('user');
    expect(requestedToolNames(harness.requestBodies[0])).toEqual(['search']);
    expect(harness.calls).toEqual([]);
  });

  it('streamText runs the allowlisted tool and not the withheld tool from the same response', async () => {
    const harness = createHarness({
      mode: 'by-role',
      replies: [allowedToolReply, deniedToolReply],
      stream: true,
    });

    const result = streamText({
      model: harness.model,
      tools: harness.tools,
      prompt: USER_PROMPT,
      providerOptions: { policy: { role: 'user' } },
      maxRetries: 0,
    });
    await consumeStream(result);

    expect(requestedToolNames(harness.requestBodies[0])).not.toContain(
      'delete_records',
    );
    expect(harness.calls).toEqual([{ tool: 'search', input: SEARCH_INPUT }]);
  });

  it('streamText does not run tools when the allowlist cannot be computed', async () => {
    const harness = createHarness({
      mode: 'throw',
      replies: [allowedToolReply, deniedToolReply],
      stream: true,
    });

    const result = streamText({
      model: harness.model,
      tools: harness.tools,
      prompt: USER_PROMPT,
      providerOptions: { policy: { role: 'user' } },
      maxRetries: 0,
    });
    await consumeStream(result);

    expect(requestedToolNames(harness.requestBodies[0])).toEqual([]);
    expect(harness.calls).toEqual([]);
  });

  it('streamText does not run tools when the allowlist result is malformed', async () => {
    const harness = createHarness({
      mode: 'malformed',
      replies: [deniedToolReply],
      stream: true,
    });

    const result = streamText({
      model: harness.model,
      tools: harness.tools,
      prompt: USER_PROMPT,
      providerOptions: { policy: { role: 'user' } },
      maxRetries: 0,
    });
    await consumeStream(result);

    expect(requestedToolNames(harness.requestBodies[0])).toEqual([]);
    expect(harness.calls).toEqual([]);
  });

  it('ToolLoopAgent.generate does not run a tool the per-user allowlist withheld', async () => {
    const harness = createHarness({
      mode: 'by-role',
      replies: [allowedToolReply, deniedToolReply],
      stream: false,
    });
    const agent = new ToolLoopAgent({
      model: harness.model,
      tools: harness.tools,
      providerOptions: { policy: { role: 'user' } },
      maxRetries: 0,
      stopWhen: isStepCount(1),
    });

    await agent.generate({ prompt: USER_PROMPT });

    expect(requestedToolNames(harness.requestBodies[0])).not.toContain(
      'delete_records',
    );
    expect(harness.calls).toEqual([{ tool: 'search', input: SEARCH_INPUT }]);
  });

  it('ToolLoopAgent.stream does not run a tool the per-user allowlist withheld', async () => {
    const harness = createHarness({
      mode: 'by-role',
      replies: [allowedToolReply, deniedToolReply],
      stream: true,
    });
    const agent = new ToolLoopAgent({
      model: harness.model,
      tools: harness.tools,
      providerOptions: { policy: { role: 'user' } },
      maxRetries: 0,
      stopWhen: isStepCount(1),
    });

    const result = await agent.stream({ prompt: USER_PROMPT });
    await consumeStream(result);

    expect(requestedToolNames(harness.requestBodies[0])).not.toContain(
      'delete_records',
    );
    expect(harness.calls).toEqual([{ tool: 'search', input: SEARCH_INPUT }]);
  });
});
