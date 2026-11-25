import type { JSONObject } from '@ai-sdk/provider';
import { tool } from '@ai-sdk/provider-utils';
import { createTestServer } from '@ai-sdk/test-server/with-vitest';
import { createAnthropic } from '../../../anthropic/src/anthropic-provider';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { ToolLoopAgent } from '../agent/tool-loop-agent';
import { startBatch } from '../batch/batch';
import { generateObject } from '../generate-object/generate-object';
import { streamObject } from '../generate-object/stream-object';
import { generateText } from '../generate-text/generate-text';
import { streamText } from '../generate-text/stream-text';
import { convertToModelMessages } from './convert-to-model-messages';
import { validateUIMessages } from './validate-ui-messages';
import type { UIMessage } from './ui-messages';

const isEdgeRuntime =
  (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime !== undefined;

const MESSAGE_URL = 'https://api.anthropic.com/v1/messages';
const BATCH_URL = 'https://api.anthropic.com/v1/messages/batches';

const textResponse = {
  type: 'message',
  id: 'msg_test',
  model: 'claude-opus-4-8',
  role: 'assistant',
  content: [{ type: 'text', text: '{"ok":true}' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 4 },
};

const textStreamChunks = [
  'data: {"type":"message_start","message":{"model":"claude-opus-4-8","id":"msg_test","type":"message","role":"assistant","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":12,"output_tokens":1}}}\n\n',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\\"ok\\":true}"}}\n\n',
  'data: {"type":"content_block_stop","index":0}\n\n',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":12,"output_tokens":4}}\n\n',
  'data: {"type":"message_stop"}\n\n',
  'data: [DONE]\n\n',
];

const batchResponse = {
  id: 'msgbatch_test',
  type: 'message_batch',
  processing_status: 'in_progress',
  request_counts: {
    processing: 1,
    succeeded: 0,
    errored: 0,
    canceled: 0,
    expired: 0,
  },
  created_at: '2026-01-01T00:00:00Z',
  expires_at: '2026-01-02T00:00:00Z',
};

type ClientControl = {
  name: string;
  metadata: JSONObject;
  beta: string;
};

const clientControls: ClientControl[] = [
  {
    name: 'tool_removal',
    metadata: {
      toolChanges: [{ type: 'tool_removal', toolName: 'get_weather' }],
    },
    beta: 'mid-conversation-tool-changes-2026-07-01',
  },
  {
    name: 'tool_addition',
    metadata: {
      toolChanges: [{ type: 'tool_addition', toolName: 'get_forecast' }],
    },
    beta: 'mid-conversation-tool-changes-2026-07-01',
  },
  {
    name: 'clearAt',
    metadata: { clearAt: 'next_user_message' },
    beta: 'mid-conversation-system-clear-at-2026-08-21',
  },
  {
    name: 'effort',
    metadata: { effort: 'max' },
    beta: 'mid-conversation-effort-2026-08-01',
  },
];

function appTools() {
  return {
    get_weather: tool({
      description: 'Get the current weather',
      inputSchema: z.object({ city: z.string() }),
    }),
    get_forecast: tool({
      description: 'Get the five day forecast',
      inputSchema: z.object({ city: z.string() }),
      providerOptions: {
        anthropic: { deferLoading: true },
      },
    }),
  };
}

function clientTranscript(metadata: JSONObject): UIMessage[] {
  return [
    {
      id: 'user-1',
      role: 'user',
      parts: [{ type: 'text', text: 'What is the weather in Paris?' }],
    },
    {
      id: 'client-system',
      role: 'system',
      parts: [
        {
          type: 'text',
          text: 'Context.',
          providerMetadata: { note: { source: 'client' } },
        },
        {
          type: 'text',
          text: 'Continue.',
          providerMetadata: { anthropic: metadata },
        },
      ],
    },
  ];
}

type AnthropicRequest = {
  messages?: AnthropicMessage[];
  tools?: Array<{ name?: string; defer_loading?: boolean }>;
};

type AnthropicMessage = {
  role?: string;
  content?: unknown;
  clear_at?: string;
  output_config?: { effort?: string };
};

type ToolChange = { type: string; name?: string };

function controlsFromMessages(messages: AnthropicMessage[] | undefined) {
  const toolChanges: ToolChange[] = [];
  const clearAt: string[] = [];
  const effort: string[] = [];

  for (const message of messages ?? []) {
    if (message.role !== 'system') {
      continue;
    }
    if (message.clear_at != null) {
      clearAt.push(message.clear_at);
    }
    if (message.output_config?.effort != null) {
      effort.push(message.output_config.effort);
    }
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (part == null || typeof part !== 'object') {
        continue;
      }
      const block = part as {
        type?: string;
        tool?: { name?: string };
      };
      if (block.type !== 'tool_addition' && block.type !== 'tool_removal') {
        continue;
      }
      toolChanges.push({
        type: block.type,
        name:
          typeof block.tool?.name === 'string' ? block.tool.name : undefined,
      });
    }
  }

  return { toolChanges, clearAt, effort };
}

function requestParams(body: {
  messages?: AnthropicMessage[];
  tools?: AnthropicRequest['tools'];
  requests?: Array<{ params?: AnthropicRequest }>;
}): AnthropicRequest[] {
  if (Array.isArray(body.requests)) {
    return body.requests.map(request => request.params ?? {});
  }
  return [body];
}

describe.skipIf(isEdgeRuntime)(
  'client system metadata cannot change the Anthropic tool set',
  () => {
    const server = createTestServer({
      [MESSAGE_URL]: {
        response: { type: 'json-value', body: textResponse },
      },
      [BATCH_URL]: {
        response: { type: 'json-value', body: batchResponse },
      },
    });

    const provider = createAnthropic({ apiKey: 'test-api-key' });
    const model = provider('claude-opus-4-8');

    beforeEach(() => {
      server.urls[MESSAGE_URL].response = {
        type: 'json-value',
        body: textResponse,
      };
    });

    async function messagesFromClient(metadata: JSONObject) {
      return convertToModelMessages(clientTranscript(metadata), {
        tools: appTools(),
      });
    }

    async function readCall(index = 0) {
      const call = server.calls[index];
      expect(call, 'provider request was not sent').toBeDefined();
      const body = await call.requestBodyJson;
      const params = requestParams(body);
      return {
        body,
        params,
        controls: params.flatMap(item => controlsFromMessages(item.messages)),
        beta: call.requestHeaders['anthropic-beta'] ?? '',
      };
    }

    function expectClientControlsAbsent(
      sent: Awaited<ReturnType<typeof readCall>>,
      control: ClientControl,
      { declareTools }: { declareTools: boolean },
    ) {
      const toolChanges = sent.controls.flatMap(item => item.toolChanges);
      const clearAt = sent.controls.flatMap(item => item.clearAt);
      const effort = sent.controls.flatMap(item => item.effort);

      if (declareTools) {
        for (const params of sent.params) {
          const tools = params.tools;
          expect(tools).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ name: 'get_weather' }),
              expect.objectContaining({
                name: 'get_forecast',
                defer_loading: true,
              }),
            ]),
          );
          expect(
            tools?.find(
              toolDefinition => toolDefinition.name === 'get_weather',
            ),
          ).not.toHaveProperty('defer_loading', true);
        }
      }

      if (control.name === 'tool_removal' || control.name === 'tool_addition') {
        expect(toolChanges).toEqual([]);
      }
      if (control.name === 'clearAt') {
        expect(clearAt).toEqual([]);
      }
      if (control.name === 'effort') {
        expect(effort).toEqual([]);
      }
      expect(sent.beta.split(',')).not.toContain(control.beta);
    }

    async function runAndRead(run: () => Promise<unknown>) {
      await run();
      return readCall();
    }

    describe.each(clientControls)('$name', control => {
      it('generateText does not send it', async () => {
        const messages = await messagesFromClient(control.metadata);
        const sent = await runAndRead(() =>
          generateText({
            model,
            instructions: 'Stay within the app policy.',
            allowSystemInMessages: true,
            tools: appTools(),
            maxRetries: 0,
            messages,
          }),
        );
        expectClientControlsAbsent(sent, control, { declareTools: true });
      });

      it('streamText does not send it', async () => {
        server.urls[MESSAGE_URL].response = {
          type: 'stream-chunks',
          chunks: textStreamChunks,
        };
        const messages = await messagesFromClient(control.metadata);
        const sent = await runAndRead(async () => {
          const result = streamText({
            model,
            instructions: 'Stay within the app policy.',
            allowSystemInMessages: true,
            tools: appTools(),
            maxRetries: 0,
            messages,
          });
          await result.text;
        });
        expectClientControlsAbsent(sent, control, { declareTools: true });
      });

      it('generateObject does not send it', async () => {
        const messages = await messagesFromClient(control.metadata);
        const sent = await runAndRead(() =>
          generateObject({
            model,
            instructions: 'Stay within the app policy.',
            allowSystemInMessages: true,
            output: 'no-schema',
            maxRetries: 0,
            messages,
          }),
        );
        expectClientControlsAbsent(sent, control, { declareTools: false });
      });

      it('streamObject does not send it', async () => {
        server.urls[MESSAGE_URL].response = {
          type: 'stream-chunks',
          chunks: textStreamChunks,
        };
        const messages = await messagesFromClient(control.metadata);
        const sent = await runAndRead(async () => {
          const result = streamObject({
            model,
            instructions: 'Stay within the app policy.',
            allowSystemInMessages: true,
            output: 'no-schema',
            maxRetries: 0,
            messages,
          });
          // The object promise resolves only while the text stream is read.
          for await (const _chunk of result.textStream) {
            // Pull the provider request through to the finish chunk.
          }
          await result.object;
        });
        expectClientControlsAbsent(sent, control, { declareTools: false });
      });

      it('startBatch does not send it', async () => {
        const messages = await messagesFromClient(control.metadata);
        const sent = await runAndRead(() =>
          startBatch({
            provider,
            requests: [
              {
                id: 'request-1',
                type: 'text',
                model: 'claude-opus-4-8',
                instructions: 'Stay within the app policy.',
                allowSystemInMessages: true,
                tools: appTools(),
                messages,
              },
            ],
          }),
        );
        expectClientControlsAbsent(sent, control, { declareTools: true });
      });

      it('ToolLoopAgent.generate does not send it', async () => {
        const messages = await messagesFromClient(control.metadata);
        const agent = new ToolLoopAgent({
          model,
          instructions: 'Stay within the app policy.',
          allowSystemInMessages: true,
          tools: appTools(),
          maxRetries: 0,
        });
        const sent = await runAndRead(() => agent.generate({ messages }));
        expectClientControlsAbsent(sent, control, { declareTools: true });
      });
    });

    it('sends a removal and an addition from one client system message through generateText', async () => {
      const messages = await messagesFromClient({
        toolChanges: [
          { type: 'tool_addition', toolName: 'get_forecast' },
          { type: 'tool_removal', toolName: 'get_weather' },
        ],
      });
      const sent = await runAndRead(() =>
        generateText({
          model,
          instructions: 'Stay within the app policy.',
          allowSystemInMessages: true,
          tools: appTools(),
          maxRetries: 0,
          messages,
        }),
      );
      expect(sent.controls.flatMap(item => item.toolChanges)).toEqual([]);
      expect(sent.beta.split(',')).not.toContain(
        'mid-conversation-tool-changes-2026-07-01',
      );
    });

    it('validateUIMessages accepts the client transcript and generateText still must not send the controls', async () => {
      const transcript = clientTranscript({
        toolChanges: [{ type: 'tool_removal', toolName: 'get_weather' }],
        clearAt: 'next_user_message',
        effort: 'low',
      });
      const validated = await validateUIMessages({ messages: transcript });
      const messages = await convertToModelMessages(validated, {
        tools: appTools(),
      });
      const sent = await runAndRead(() =>
        generateText({
          model,
          instructions: 'Stay within the app policy.',
          allowSystemInMessages: true,
          tools: appTools(),
          maxRetries: 0,
          messages,
        }),
      );
      expect(sent.controls.flatMap(item => item.toolChanges)).toEqual([]);
      expect(sent.controls.flatMap(item => item.clearAt)).toEqual([]);
      expect(sent.controls.flatMap(item => item.effort)).toEqual([]);
    });

    it('still sends tool changes that the server put on a model message', async () => {
      const sent = await runAndRead(() =>
        generateText({
          model,
          instructions: 'Stay within the app policy.',
          allowSystemInMessages: true,
          tools: appTools(),
          maxRetries: 0,
          messages: [
            { role: 'user', content: 'What is the weather in Paris?' },
            {
              role: 'system',
              content: '',
              providerOptions: {
                anthropic: {
                  toolChanges: [
                    { type: 'tool_removal', toolName: 'get_weather' },
                    { type: 'tool_addition', toolName: 'get_forecast' },
                  ],
                  clearAt: 'next_user_message',
                  effort: 'high',
                },
              },
            },
          ],
        }),
      );

      expect(sent.controls.flatMap(item => item.toolChanges)).toEqual([
        { type: 'tool_removal', name: 'get_weather' },
        { type: 'tool_addition', name: 'get_forecast' },
      ]);
      expect(sent.controls.flatMap(item => item.clearAt)).toEqual([
        'next_user_message',
      ]);
      expect(sent.controls.flatMap(item => item.effort)).toEqual(['high']);
      expect(sent.beta).toContain('mid-conversation-tool-changes-2026-07-01');
    });
  },
);
