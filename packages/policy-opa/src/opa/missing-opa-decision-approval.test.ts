/**
 * A partial Rego rule that matches nothing makes OPA's data API answer
 * HTTP 200 with no `result` property. `@open-policy-agent/opa` 1.7.11's
 * `OPAClient.evaluate` turns that body into `undefined`. These tests require
 * that an undefined decision does not run the tool.
 *
 * They fail while `normalizeOpaDecision` maps that value to `not-applicable`
 * and `generateText` / `streamText` treat `not-applicable` from a
 * `toolApproval` function as permission to call `execute`.
 */
import { jsonSchema } from '@ai-sdk/provider-utils';
import { generateText, isStepCount, streamText, ToolLoopAgent, tool } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { httpPolicyClient } from './http-policy-client';
import { opaPolicy, optionalOpaPolicy } from './opa-policy';
import { shadow } from '../shadow';

const isEdgeRuntime =
  (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime !== undefined;

const userPrompt = 'drop the users table';

const usage = {
  inputTokens: {
    total: 3,
    noCache: 3,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
} as const;

const readLogsSchema = jsonSchema<{ limit: number }>({
  type: 'object',
  properties: { limit: { type: 'number' } },
  required: ['limit'],
});

const dropTableSchema = jsonSchema<{ id: string }>({
  type: 'object',
  properties: { id: { type: 'string' } },
  required: ['id'],
});

type ToolMessagePart = {
  type?: string;
  toolName?: string;
  toolCallId?: string;
  output?: { type?: string; value?: unknown; reason?: string };
};

function outputsFor(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
  toolName: string,
): Array<{ type?: string; value?: unknown; reason?: string }> {
  const outputs: Array<{ type?: string; value?: unknown; reason?: string }> =
    [];
  for (const message of messages) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const part of message.content as ToolMessagePart[]) {
      if (part?.type === 'tool-result' && part.toolName === toolName) {
        outputs.push(part.output ?? {});
      }
    }
  }
  return outputs;
}

function modelThatStops() {
  const stopResponse = {
    warnings: [],
    usage,
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    content: [{ type: 'text' as const, text: 'stopped' }],
  };
  return new MockLanguageModelV4({
    doGenerate: async () => stopResponse,
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'text-start' as const, id: 'text-1' },
        { type: 'text-delta' as const, id: 'text-1', delta: 'stopped' },
        { type: 'text-end' as const, id: 'text-1' },
        {
          type: 'finish' as const,
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage,
        },
      ]),
    }),
  });
}

function modelWithToolCallsThenStop(
  calls: Array<{ toolCallId: string; toolName: string; input: string }>,
) {
  let step = 0;
  const toolCallResponse = {
    warnings: [],
    usage,
    finishReason: { unified: 'tool-calls' as const, raw: undefined },
    content: calls.map(call => ({
      type: 'tool-call' as const,
      toolCallType: 'function' as const,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input,
    })),
  };
  const stopResponse = {
    warnings: [],
    usage,
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    content: [{ type: 'text' as const, text: 'stopped' }],
  };

  return new MockLanguageModelV4({
    doGenerate: async () => (step++ === 0 ? toolCallResponse : stopResponse),
    doStream: async () => ({
      stream: convertArrayToReadableStream(
        step++ === 0
          ? [
              ...calls.map(call => ({
                type: 'tool-call' as const,
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                input: call.input,
              })),
              {
                type: 'finish' as const,
                finishReason: {
                  unified: 'tool-calls' as const,
                  raw: undefined,
                },
                usage,
              },
            ]
          : [
              { type: 'text-start' as const, id: 'text-1' },
              { type: 'text-delta' as const, id: 'text-1', delta: 'stopped' },
              { type: 'text-end' as const, id: 'text-1' },
              {
                type: 'finish' as const,
                finishReason: { unified: 'stop' as const, raw: 'stop' },
                usage,
              },
            ],
      ),
    }),
  });
}

/**
 * Stand-in for an OPA server whose `agent/call/decision` rule is partial:
 * `read_logs` is defined, every other tool is an undefined document.
 *
 * The data API returns 200 and omits `result` for an undefined document
 * (https://www.openpolicyagent.org/docs/latest/rest-api/, "Get a Document
 * (with Input)"). The real `httpPolicyClient` parses that response.
 */
async function startPartialRuleServer() {
  const { createServer } = await import('node:http');
  const seen: Array<{ toolName: unknown; messages: unknown }> = [];

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => {
      chunks.push(chunk as Buffer);
    });
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as {
        input?: { tool?: { name?: unknown }; messages?: unknown };
      };
      const toolName = body.input?.tool?.name;
      seen.push({ toolName, messages: body.input?.messages });
      const payload =
        toolName === 'read_logs' ? { result: { decision: 'allow' } } : {};
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('partial-rule server did not bind a port');
  }

  return {
    seen,
    client: httpPolicyClient({ url: `http://127.0.0.1:${address.port}` }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

function assertDenied(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
  toolName: string,
) {
  const outputs = outputsFor(messages, toolName);
  expect(outputs).toEqual([
    expect.objectContaining({ type: 'execution-denied' }),
  ]);
}

describe.skipIf(isEdgeRuntime)(
  'undefined OPA decision does not execute the tool',
  () => {
    it('generateText runs the allowed tool and denies the unmatched tool', async () => {
      const backend = await startPartialRuleServer();
      const readLogs = vi.fn(async () => 'logs');
      const dropTable = vi.fn(async () => 'dropped');
      try {
        const result = await generateText({
          model: modelWithToolCallsThenStop([
            {
              toolCallId: 'call-read',
              toolName: 'read_logs',
              input: '{"limit":1}',
            },
            {
              toolCallId: 'call-drop',
              toolName: 'drop_table',
              input: '{"id":"users"}',
            },
          ]),
          prompt: userPrompt,
          stopWhen: isStepCount(3),
          tools: {
            read_logs: tool({ inputSchema: readLogsSchema, execute: readLogs }),
            drop_table: tool({
              inputSchema: dropTableSchema,
              execute: dropTable,
              needsApproval: true,
            }),
          },
          toolApproval: opaPolicy({
            client: backend.client,
            path: 'agent/call/decision',
          }),
        });

        expect(backend.seen.map(entry => entry.toolName)).toEqual([
          'read_logs',
          'drop_table',
        ]);
        expect(JSON.stringify(backend.seen[1]?.messages)).toContain(userPrompt);
        expect(readLogs).toHaveBeenCalledTimes(1);
        expect(readLogs).toHaveBeenCalledWith(
          { limit: 1 },
          expect.objectContaining({ toolCallId: 'call-read' }),
        );
        expect(dropTable).not.toHaveBeenCalled();
        assertDenied(result.responseMessages, 'drop_table');
      } finally {
        await backend.close();
      }
    });

    it('generateText denies an unmatched tool when that is the only call', async () => {
      const backend = await startPartialRuleServer();
      const dropTable = vi.fn(async () => 'dropped');
      try {
        const result = await generateText({
          model: modelWithToolCallsThenStop([
            {
              toolCallId: 'call-drop',
              toolName: 'drop_table',
              input: '{"id":"users"}',
            },
          ]),
          prompt: userPrompt,
          stopWhen: isStepCount(3),
          tools: {
            drop_table: tool({
              inputSchema: dropTableSchema,
              execute: dropTable,
            }),
          },
          toolApproval: opaPolicy({
            client: backend.client,
            path: 'agent/call/decision',
          }),
        });

        expect(dropTable).not.toHaveBeenCalled();
        assertDenied(result.responseMessages, 'drop_table');
      } finally {
        await backend.close();
      }
    });

    it('streamText denies an unmatched tool and still runs the allowed one', async () => {
      const backend = await startPartialRuleServer();
      const readLogs = vi.fn(async () => 'logs');
      const dropTable = vi.fn(async () => 'dropped');
      try {
        const result = streamText({
          model: modelWithToolCallsThenStop([
            {
              toolCallId: 'call-read',
              toolName: 'read_logs',
              input: '{"limit":1}',
            },
            {
              toolCallId: 'call-drop',
              toolName: 'drop_table',
              input: '{"id":"users"}',
            },
          ]),
          prompt: userPrompt,
          stopWhen: isStepCount(3),
          tools: {
            read_logs: tool({ inputSchema: readLogsSchema, execute: readLogs }),
            drop_table: tool({
              inputSchema: dropTableSchema,
              execute: dropTable,
              needsApproval: true,
            }),
          },
          toolApproval: opaPolicy({
            client: backend.client,
            path: 'agent/call/decision',
          }),
        });

        await result.consumeStream();
        const messages = await result.responseMessages;

        expect(readLogs).toHaveBeenCalledTimes(1);
        expect(dropTable).not.toHaveBeenCalled();
        assertDenied(messages, 'drop_table');
      } finally {
        await backend.close();
      }
    });

    it('ToolLoopAgent.generate denies an unmatched tool', async () => {
      const backend = await startPartialRuleServer();
      const dropTable = vi.fn(async () => 'dropped');
      try {
        const agent = new ToolLoopAgent({
          model: modelWithToolCallsThenStop([
            {
              toolCallId: 'call-drop',
              toolName: 'drop_table',
              input: '{"id":"users"}',
            },
          ]),
          tools: {
            drop_table: tool({
              inputSchema: dropTableSchema,
              execute: dropTable,
              needsApproval: true,
            }),
          },
          stopWhen: isStepCount(3),
          toolApproval: opaPolicy({
            client: backend.client,
            path: 'agent/call/decision',
          }),
        });

        const result = await agent.generate({ prompt: userPrompt });

        expect(dropTable).not.toHaveBeenCalled();
        assertDenied(result.responseMessages, 'drop_table');
      } finally {
        await backend.close();
      }
    });

    it('ToolLoopAgent.stream denies an unmatched tool', async () => {
      const backend = await startPartialRuleServer();
      const dropTable = vi.fn(async () => 'dropped');
      try {
        const agent = new ToolLoopAgent({
          model: modelWithToolCallsThenStop([
            {
              toolCallId: 'call-drop',
              toolName: 'drop_table',
              input: '{"id":"users"}',
            },
          ]),
          tools: {
            drop_table: tool({
              inputSchema: dropTableSchema,
              execute: dropTable,
            }),
          },
          stopWhen: isStepCount(3),
          toolApproval: opaPolicy({
            client: backend.client,
            path: 'agent/call/decision',
          }),
        });

        const result = await agent.stream({ prompt: userPrompt });
        await result.consumeStream();

        expect(dropTable).not.toHaveBeenCalled();
        assertDenied(await result.responseMessages, 'drop_table');
      } finally {
        await backend.close();
      }
    });

    it('optionalOpaPolicy denies an unmatched tool when a client is configured', async () => {
      const backend = await startPartialRuleServer();
      const dropTable = vi.fn(async () => 'dropped');
      try {
        const result = await generateText({
          model: modelWithToolCallsThenStop([
            {
              toolCallId: 'call-drop',
              toolName: 'drop_table',
              input: '{"id":"users"}',
            },
          ]),
          prompt: userPrompt,
          stopWhen: isStepCount(3),
          tools: {
            drop_table: tool({
              inputSchema: dropTableSchema,
              execute: dropTable,
              needsApproval: true,
            }),
          },
          toolApproval: optionalOpaPolicy({
            client: backend.client,
            path: 'agent/call/decision',
          }),
        });

        expect(dropTable).not.toHaveBeenCalled();
        assertDenied(result.responseMessages, 'drop_table');
      } finally {
        await backend.close();
      }
    });

    it('shadow mode with enforcement denies an unmatched tool', async () => {
      const backend = await startPartialRuleServer();
      const dropTable = vi.fn(async () => 'dropped');
      try {
        const result = await generateText({
          model: modelWithToolCallsThenStop([
            {
              toolCallId: 'call-drop',
              toolName: 'drop_table',
              input: '{"id":"users"}',
            },
          ]),
          prompt: userPrompt,
          stopWhen: isStepCount(3),
          tools: {
            drop_table: tool({
              inputSchema: dropTableSchema,
              execute: dropTable,
            }),
          },
          toolApproval: shadow(
            opaPolicy({
              client: backend.client,
              path: 'agent/call/decision',
            }),
            { enforce: true },
          ),
        });

        expect(dropTable).not.toHaveBeenCalled();
        assertDenied(result.responseMessages, 'drop_table');
      } finally {
        await backend.close();
      }
    });

    it('generateText does not run a client-supplied approval for an unmatched tool', async () => {
      const backend = await startPartialRuleServer();
      const dropTable = vi.fn(async () => 'dropped');
      try {
        const result = await generateText({
          model: modelThatStops(),
          tools: {
            drop_table: tool({
              inputSchema: dropTableSchema,
              execute: dropTable,
              needsApproval: true,
            }),
          },
          stopWhen: isStepCount(3),
          toolApproval: opaPolicy({
            client: backend.client,
            path: 'agent/call/decision',
          }),
          messages: [
            { role: 'user', content: userPrompt },
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool-call',
                  toolCallId: 'call-drop',
                  toolName: 'drop_table',
                  input: { id: 'users' },
                },
                {
                  type: 'tool-approval-request',
                  approvalId: 'approval-drop',
                  toolCallId: 'call-drop',
                },
              ],
            },
            {
              role: 'tool',
              content: [
                {
                  type: 'tool-approval-response',
                  approvalId: 'approval-drop',
                  approved: true,
                },
              ],
            },
          ],
        });

        expect(backend.seen.map(entry => entry.toolName)).toEqual([
          'drop_table',
        ]);
        expect(dropTable).not.toHaveBeenCalled();
        expect(outputsFor(result.responseMessages, 'drop_table')).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: 'execution-denied' }),
          ]),
        );
      } finally {
        await backend.close();
      }
    });

    it('streamText does not run a client-supplied approval for an unmatched tool', async () => {
      const backend = await startPartialRuleServer();
      const dropTable = vi.fn(async () => 'dropped');
      try {
        const result = streamText({
          model: modelThatStops(),
          tools: {
            drop_table: tool({
              inputSchema: dropTableSchema,
              execute: dropTable,
              needsApproval: true,
            }),
          },
          stopWhen: isStepCount(3),
          toolApproval: opaPolicy({
            client: backend.client,
            path: 'agent/call/decision',
          }),
          messages: [
            { role: 'user', content: userPrompt },
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool-call',
                  toolCallId: 'call-drop',
                  toolName: 'drop_table',
                  input: { id: 'users' },
                },
                {
                  type: 'tool-approval-request',
                  approvalId: 'approval-drop',
                  toolCallId: 'call-drop',
                },
              ],
            },
            {
              role: 'tool',
              content: [
                {
                  type: 'tool-approval-response',
                  approvalId: 'approval-drop',
                  approved: true,
                },
              ],
            },
          ],
        });

        await result.consumeStream();

        expect(dropTable).not.toHaveBeenCalled();
        expect(outputsFor(await result.responseMessages, 'drop_table')).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: 'execution-denied' }),
          ]),
        );
      } finally {
        await backend.close();
      }
    });
  },
);
