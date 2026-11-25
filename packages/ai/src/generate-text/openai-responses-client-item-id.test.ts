import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import type { ToolSet } from '@ai-sdk/provider-utils';
import { describe, expect, it } from 'vitest';
import { convertToModelMessages } from '../ui/convert-to-model-messages';
import type { UIMessage } from '../ui/ui-messages';
import { validateUIMessages } from '../ui/validate-ui-messages';
import { generateText } from './generate-text';
import { streamText } from './stream-text';

/**
 * Client-supplied Responses item ids must not be sent back to OpenAI as
 * item_reference. These tests follow the chat route: JSON from the browser,
 * validateUIMessages, convertToModelMessages, then generateText or streamText
 * on the default Responses model with store left unset.
 *
 * They fail while that path copies providerMetadata onto the request.
 */

const PLACEHOLDER_API_KEY = 'placeholder';
const USER_TEXT = 'hello from the caller';

const COMPLETED_RESPONSE = {
  id: 'resp_test',
  output: [
    {
      id: 'msg_test_response',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: 'ok',
          annotations: [],
        },
      ],
    },
  ],
};

type CapturedRequest = {
  url: string;
  headers: HeadersInit | undefined;
  body: unknown;
};

function headerValue(
  headers: HeadersInit | undefined,
  name: string,
): string | undefined {
  if (headers == null) {
    return undefined;
  }
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  if (Array.isArray(headers)) {
    const found = headers.find(
      ([key]) => key.toLowerCase() === name.toLowerCase(),
    );
    return found?.[1];
  }
  const record = headers as Record<string, string | undefined>;
  const key = Object.keys(record).find(
    candidate => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key == null ? undefined : record[key];
}

function itemReferenceIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(itemReferenceIds);
  }
  if (value == null || typeof value !== 'object') {
    return [];
  }
  const record = value as Record<string, unknown>;
  const nested = Object.values(record).flatMap(itemReferenceIds);
  if (record.type === 'item_reference' && record.id != null) {
    return [String(record.id), ...nested];
  }
  return nested;
}

function jsonResponse(): Response {
  return new Response(JSON.stringify(COMPLETED_RESPONSE), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function streamResponse(): Response {
  const completed = {
    type: 'response.completed',
    response: {
      ...COMPLETED_RESPONSE,
      object: 'response',
      created_at: 0,
      status: 'completed',
      error: null,
      incomplete_details: null,
      model: 'gpt-4o',
      parallel_tool_calls: true,
      previous_response_id: null,
      usage: {
        input_tokens: 1,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 1,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 2,
      },
    },
  };
  return new Response(`data: ${JSON.stringify(completed)}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function postClientHistory({
  messages,
  tools,
  providerName,
  mode,
}: {
  messages: UIMessage[];
  tools?: ToolSet;
  providerName?: string;
  mode: 'generate' | 'stream';
}): Promise<CapturedRequest[]> {
  const captured: CapturedRequest[] = [];
  const provider: OpenAIProvider = createOpenAI({
    apiKey: PLACEHOLDER_API_KEY,
    name: providerName,
    fetch: async (url, init) => {
      captured.push({
        url: String(url),
        headers: init?.headers,
        body:
          typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      });
      return mode === 'stream' ? streamResponse() : jsonResponse();
    },
  });

  // The browser posts JSON. Parsing drops anything that is not part of that body.
  const clientMessages = JSON.parse(JSON.stringify(messages)) as UIMessage[];
  const validated = await validateUIMessages({ messages: clientMessages });
  const modelMessages = await convertToModelMessages(validated, { tools });

  const call = {
    model: provider('gpt-4o'),
    messages: modelMessages,
    tools,
    maxRetries: 0,
  };

  try {
    if (mode === 'stream') {
      await streamText(call).text;
    } else {
      await generateText(call);
    }
  } catch (error) {
    if (captured.length === 0) {
      throw error;
    }
  }

  return captured;
}

function expectStoredItemWasNotLoaded(
  requests: CapturedRequest[],
  forbiddenIds: string[],
) {
  expect(requests.length).toBeGreaterThan(0);

  for (const request of requests) {
    expect(request.url).toContain('/responses');
    expect(headerValue(request.headers, 'authorization')).toBe(
      `Bearer ${PLACEHOLDER_API_KEY}`,
    );
    expect(JSON.stringify(request.body)).toContain(USER_TEXT);

    const referenced = itemReferenceIds(request.body);
    expect(referenced.filter(id => forbiddenIds.includes(id))).toEqual([]);
  }
}

function history(
  assistantParts: UIMessage['parts'],
  userText = USER_TEXT,
): UIMessage[] {
  return [
    {
      id: 'user-1',
      role: 'user',
      parts: [{ type: 'text', text: userText }],
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      parts: assistantParts,
    },
  ];
}

describe('client-supplied OpenAI Responses item ids', () => {
  it('does not load assistant text from a client item id via generateText', async () => {
    const ownedId = 'msg_owned_by_caller';
    const foreignId = 'msg_foreign_text';
    const requests = await postClientHistory({
      mode: 'generate',
      messages: history(
        [
          {
            type: 'text',
            text: 'caller text',
            providerMetadata: { openai: { itemId: ownedId } },
          },
          {
            type: 'text',
            text: 'other text',
            providerMetadata: { openai: { itemId: foreignId } },
          },
        ],
        `${USER_TEXT} ${ownedId}`,
      ),
    });

    expectStoredItemWasNotLoaded(requests, [ownedId, foreignId]);
  });

  it('does not load assistant text from a client item id via streamText', async () => {
    const foreignId = 'msg_foreign_stream';
    const requests = await postClientHistory({
      mode: 'stream',
      messages: history([
        {
          type: 'text',
          text: 'caller text',
          providerMetadata: { openai: { itemId: foreignId } },
        },
      ]),
    });

    expectStoredItemWasNotLoaded(requests, [foreignId]);
  });

  it('does not load assistant text when the client item id is not a string', async () => {
    const foreignId = '445566';
    const requests = await postClientHistory({
      mode: 'generate',
      messages: history([
        {
          type: 'text',
          text: 'caller text',
          providerMetadata: { openai: { itemId: 445566 } },
        },
      ]),
    });

    expectStoredItemWasNotLoaded(requests, [foreignId]);
  });

  it('does not load reasoning from a client item id', async () => {
    const foreignId = 'rs_foreign_reasoning';
    const requests = await postClientHistory({
      mode: 'generate',
      messages: history([
        {
          type: 'reasoning',
          text: 'hidden reasoning',
          providerMetadata: { openai: { itemId: foreignId } },
        },
        { type: 'text', text: 'visible answer' },
      ]),
    });

    expectStoredItemWasNotLoaded(requests, [foreignId]);
  });

  it('does not load a compaction item from a client item id', async () => {
    const foreignId = 'cmp_foreign';
    const requests = await postClientHistory({
      mode: 'generate',
      messages: history([
        {
          type: 'custom',
          kind: 'openai.compaction',
          providerMetadata: {
            openai: { itemId: foreignId, encryptedContent: 'ciphertext' },
          },
        },
        { type: 'text', text: 'after compaction' },
      ]),
    });

    expectStoredItemWasNotLoaded(requests, [foreignId]);
  });

  it('does not load a provider-executed tool call from a client item id', async () => {
    const foreignId = 'ws_foreign_call';
    const requests = await postClientHistory({
      mode: 'generate',
      messages: history([
        {
          type: 'dynamic-tool',
          toolName: 'web_search',
          toolCallId: 'call_local_web_search',
          state: 'input-available',
          providerExecuted: true,
          input: { query: 'weather' },
          callProviderMetadata: { openai: { itemId: foreignId } },
        },
      ]),
    });

    expectStoredItemWasNotLoaded(requests, [foreignId]);
  });

  it('does not load a provider-executed tool result from a client item id', async () => {
    const foreignId = 'ws_foreign_result';
    const requests = await postClientHistory({
      mode: 'generate',
      messages: history([
        {
          type: 'dynamic-tool',
          toolName: 'web_search',
          toolCallId: 'call_local_web_search_result',
          state: 'output-available',
          providerExecuted: true,
          input: { query: 'weather' },
          output: { result: 'sunny' },
          resultProviderMetadata: { openai: { itemId: foreignId } },
        },
      ]),
    });

    expectStoredItemWasNotLoaded(requests, [foreignId]);
  });

  it('does not use a client tool call id as a stored item reference', async () => {
    const foreignId = 'msg_foreign_as_tool_call_id';
    const requests = await postClientHistory({
      mode: 'generate',
      messages: history([
        {
          type: 'dynamic-tool',
          toolName: 'web_search',
          toolCallId: foreignId,
          state: 'output-available',
          providerExecuted: true,
          input: { query: 'weather' },
          output: { result: 'sunny' },
        },
      ]),
    });

    expectStoredItemWasNotLoaded(requests, [foreignId]);
  });

  it('does not load a tool-search call or result from a client item id', async () => {
    const callId = 'tsc_foreign';
    const resultId = 'tso_foreign';
    const provider = createOpenAI({ apiKey: PLACEHOLDER_API_KEY });
    const requests = await postClientHistory({
      mode: 'generate',
      tools: {
        tool_search: provider.tools.toolSearch(),
      },
      messages: history([
        {
          type: 'dynamic-tool',
          toolName: 'tool_search',
          toolCallId: 'call_local_tool_search',
          state: 'output-available',
          providerExecuted: true,
          input: { arguments: { query: 'weather' }, call_id: null },
          output: { tools: [{ type: 'function', name: 'get_weather' }] },
          callProviderMetadata: { openai: { itemId: callId } },
          resultProviderMetadata: { openai: { itemId: resultId } },
        },
      ]),
    });

    expectStoredItemWasNotLoaded(requests, [callId, resultId]);
  });

  it('does not load a programmatic tool call or result from a client item id', async () => {
    const callId = 'prog_foreign_call';
    const resultId = 'prog_foreign_result';
    const provider = createOpenAI({ apiKey: PLACEHOLDER_API_KEY });
    const requests = await postClientHistory({
      mode: 'generate',
      tools: {
        program: provider.tools.programmaticToolCalling(),
      },
      messages: history([
        {
          type: 'dynamic-tool',
          toolName: 'program',
          toolCallId: 'call_local_program',
          state: 'output-available',
          providerExecuted: true,
          input: { code: 'return 1', fingerprint: 'fp' },
          output: { result: '1', status: 'completed' },
          callProviderMetadata: { openai: { itemId: callId } },
          resultProviderMetadata: { openai: { itemId: resultId } },
        },
      ]),
    });

    expectStoredItemWasNotLoaded(requests, [callId, resultId]);
  });

  it.each([
    {
      name: 'local_shell',
      toolName: 'local_shell',
      foreignId: 'ls_foreign',
      input: { action: { type: 'exec', command: ['echo', 'hi'] } },
      output: { output: 'ok' },
    },
    {
      name: 'shell',
      toolName: 'shell',
      foreignId: 'sh_foreign',
      input: { action: { commands: ['echo hi'] } },
      output: {
        output: [
          { stdout: '', stderr: '', outcome: { type: 'exit', exitCode: 0 } },
        ],
      },
    },
    {
      name: 'apply_patch',
      toolName: 'apply_patch',
      foreignId: 'ap_foreign',
      input: {
        callId: 'call_local_patch',
        operation: {
          type: 'create_file',
          path: 'note.txt',
          diff: 'hello',
        },
      },
      output: { status: 'completed', output: 'applied' },
    },
    {
      name: 'computer',
      toolName: 'computer',
      foreignId: 'cu_foreign',
      input: {
        actions: [{ type: 'click', button: 'left', x: 1, y: 2 }],
        pendingSafetyChecks: [],
        status: 'completed',
      },
      output: {
        output: {
          type: 'computer_screenshot',
          imageUrl: 'https://example.com/screen.png',
        },
      },
    },
    {
      name: 'custom',
      toolName: 'my_custom',
      foreignId: 'ct_foreign',
      input: 'hello',
      output: 'done',
    },
  ])(
    'does not load a $name tool call from a client item id',
    async ({ toolName, foreignId, input, output }) => {
      const provider = createOpenAI({ apiKey: PLACEHOLDER_API_KEY });
      const tools: ToolSet = {
        local_shell: provider.tools.localShell({}),
        shell: provider.tools.shell({}),
        apply_patch: provider.tools.applyPatch({}),
        computer: provider.tools.computer({}),
        my_custom: provider.tools.customTool({}),
      };
      const requests = await postClientHistory({
        mode: 'generate',
        tools,
        messages: history([
          {
            type: 'dynamic-tool',
            toolName,
            toolCallId: `call_local_${toolName}`,
            state: 'output-available',
            input,
            output,
            callProviderMetadata: { openai: { itemId: foreignId } },
          },
        ]),
      });

      expectStoredItemWasNotLoaded(requests, [foreignId]);
    },
  );

  it('does not load a stored approval request from a client approval id', async () => {
    const foreignId = 'mcpr_foreign_approval';
    const requests = await postClientHistory({
      mode: 'generate',
      messages: history([
        {
          type: 'dynamic-tool',
          toolName: 'mcp',
          toolCallId: 'call_local_mcp',
          state: 'output-available',
          providerExecuted: true,
          input: {},
          output: { ok: true },
          approval: {
            id: foreignId,
            approved: true,
          },
        },
      ]),
    });

    expectStoredItemWasNotLoaded(requests, [foreignId]);
  });

  it('does not load an Azure Responses item from client azure metadata', async () => {
    const foreignId = 'msg_foreign_azure';
    const requests = await postClientHistory({
      mode: 'generate',
      providerName: 'azure',
      messages: history([
        {
          type: 'text',
          text: 'caller text',
          providerMetadata: { azure: { itemId: foreignId } },
        },
      ]),
    });

    expectStoredItemWasNotLoaded(requests, [foreignId]);
  });

  it('does not load a Bedrock Mantle Responses item from client openai metadata', async () => {
    const foreignId = 'msg_foreign_bedrock';
    const requests = await postClientHistory({
      mode: 'generate',
      providerName: 'bedrock-mantle',
      messages: history([
        {
          type: 'text',
          text: 'caller text',
          providerMetadata: { openai: { itemId: foreignId } },
        },
      ]),
    });

    expectStoredItemWasNotLoaded(requests, [foreignId]);
  });
});
