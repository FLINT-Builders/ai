/**
 * WorkflowAgent must enforce the tool's original input schema when it runs
 * the tool. JSON Schema conversion drops Zod refinements, superRefine checks,
 * transforms, and defaults, and the model step only applies the remaining
 * Ajv schema. These tests fail until local execution re-validates the
 * original schema and passes that parsed value to execute.
 */
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { dynamicTool, tool, type ToolSet } from 'ai';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import * as z3 from 'zod/v3';
import { WorkflowAgent } from './workflow-agent.js';

const traversalPath = '../../etc/passwd';
const relativePath = 'notes.txt';
const blockedUrl = 'http://169.254.169.254/latest/meta-data';
const allowedUrl = 'https://example.com/status';

type ExecutedCall = {
  toolCallId: string;
  input: unknown;
};

function readRelativeSchema(zod: typeof z | typeof z3) {
  return zod
    .object({
      path: zod.string().refine(path => !path.split('/').includes('..')),
      mode: zod.enum(['read']).default('read'),
    })
    .transform(value => ({
      path: `/data/${value.path}`,
      mode: value.mode,
    }));
}

function urlAllowlistSchema(zod: typeof z | typeof z3) {
  return zod.object({
    url: zod.string().superRefine((url, ctx) => {
      let hostname: string;
      try {
        hostname = new URL(url).hostname;
      } catch {
        ctx.addIssue({
          code: 'custom',
          message: 'invalid url',
        });
        return;
      }

      if (hostname !== 'example.com') {
        ctx.addIssue({
          code: 'custom',
          message: 'host is not allowlisted',
        });
      }
    }),
  });
}

const zod4ReadRelativeSchema = readRelativeSchema(z);
const zod3ReadRelativeSchema = readRelativeSchema(z3);
const zod4UrlSchema = urlAllowlistSchema(z);
const zod3UrlSchema = urlAllowlistSchema(z3);

function recordingTool({
  inputSchema,
  executed,
  dynamic = false,
  needsApproval = false,
}: {
  inputSchema: ToolSet[string]['inputSchema'];
  executed: ExecutedCall[];
  dynamic?: boolean;
  needsApproval?: boolean;
}) {
  const definition = {
    description: 'Guarded tool',
    inputSchema,
    needsApproval,
    execute: async (input: unknown, options: { toolCallId: string }) => {
      executed.push({ toolCallId: options.toolCallId, input });
      return { actedOn: input };
    },
  };

  return dynamic ? dynamicTool(definition) : tool(definition);
}

const finishUsage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: 1,
    text: 1,
    reasoning: undefined,
  },
};

function toolCallStream(
  calls: Array<{ toolCallId: string; toolName: string; input: unknown }>,
) {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      step += 1;
      const chunks: LanguageModelV4StreamPart[] =
        step === 1
          ? [
              { type: 'stream-start', warnings: [] },
              {
                type: 'response-metadata',
                id: 'id-0',
                modelId: 'mock-model-id',
                timestamp: new Date(0),
              },
              ...calls.map(call => ({
                type: 'tool-call' as const,
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                input: JSON.stringify(call.input),
              })),
              {
                type: 'finish' as const,
                finishReason: {
                  unified: 'tool-calls' as const,
                  raw: 'tool-calls',
                },
                usage: finishUsage,
              },
            ]
          : [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'text' },
              { type: 'text-delta', id: 'text', delta: 'done' },
              { type: 'text-end', id: 'text' },
              {
                type: 'finish' as const,
                finishReason: { unified: 'stop' as const, raw: 'stop' },
                usage: finishUsage,
              },
            ];

      return { stream: convertArrayToReadableStream(chunks) };
    },
  });
}

async function runAgent(
  tools: ToolSet,
  calls: Array<{ toolCallId: string; toolName: string; input: unknown }>,
) {
  const agent = new WorkflowAgent({
    model: toolCallStream(calls),
    tools,
  });
  const result = await agent.stream({
    messages: [{ role: 'user', content: 'use the tools' }],
    writable: new WritableStream({ write() {} }),
  });
  const toolStep = result.steps.find(step =>
    step.content.some(
      part => part.type === 'tool-result' || part.type === 'tool-error',
    ),
  );

  return { result, toolStep };
}

describe('WorkflowAgent original tool schema', () => {
  it('rejects refinements and applies transforms before function, dynamic, and Zod 3 tools run', async () => {
    expect(() =>
      zod4ReadRelativeSchema.parse({ path: traversalPath }),
    ).toThrow();
    expect(() =>
      zod3ReadRelativeSchema.parse({ path: traversalPath }),
    ).toThrow();
    expect(() => zod4UrlSchema.parse({ url: blockedUrl })).toThrow();
    expect(() => zod3UrlSchema.parse({ url: blockedUrl })).toThrow();

    const acceptedRelative = { path: relativePath };
    const acceptedUrl = { url: allowedUrl };
    const expected = {
      zod4Read: zod4ReadRelativeSchema.parse(acceptedRelative),
      zod4Url: zod4UrlSchema.parse(acceptedUrl),
      zod3Read: zod3ReadRelativeSchema.parse(acceptedRelative),
      zod3Url: zod3UrlSchema.parse(acceptedUrl),
    };
    const executed: ExecutedCall[] = [];
    const tools = {
      zod4Read: recordingTool({
        inputSchema: zod4ReadRelativeSchema,
        executed,
      }),
      zod4ReadDynamic: recordingTool({
        inputSchema: zod4ReadRelativeSchema,
        executed,
        dynamic: true,
      }),
      zod4Url: recordingTool({
        inputSchema: zod4UrlSchema,
        executed,
      }),
      zod4UrlDynamic: recordingTool({
        inputSchema: zod4UrlSchema,
        executed,
        dynamic: true,
      }),
      zod3Read: recordingTool({
        inputSchema: zod3ReadRelativeSchema,
        executed,
      }),
      zod3Url: recordingTool({
        inputSchema: zod3UrlSchema,
        executed,
      }),
    };
    const calls = [
      {
        toolCallId: 'zod4-read-blocked',
        toolName: 'zod4Read',
        input: { path: traversalPath },
      },
      {
        toolCallId: 'zod4-read-allowed',
        toolName: 'zod4Read',
        input: acceptedRelative,
      },
      {
        toolCallId: 'zod4-dynamic-read-blocked',
        toolName: 'zod4ReadDynamic',
        input: { path: traversalPath },
      },
      {
        toolCallId: 'zod4-dynamic-read-allowed',
        toolName: 'zod4ReadDynamic',
        input: acceptedRelative,
      },
      {
        toolCallId: 'zod4-url-blocked',
        toolName: 'zod4Url',
        input: { url: blockedUrl },
      },
      {
        toolCallId: 'zod4-url-allowed',
        toolName: 'zod4Url',
        input: acceptedUrl,
      },
      {
        toolCallId: 'zod4-dynamic-url-blocked',
        toolName: 'zod4UrlDynamic',
        input: { url: blockedUrl },
      },
      {
        toolCallId: 'zod4-dynamic-url-allowed',
        toolName: 'zod4UrlDynamic',
        input: acceptedUrl,
      },
      {
        toolCallId: 'zod3-read-blocked',
        toolName: 'zod3Read',
        input: { path: traversalPath },
      },
      {
        toolCallId: 'zod3-read-allowed',
        toolName: 'zod3Read',
        input: acceptedRelative,
      },
      {
        toolCallId: 'zod3-url-blocked',
        toolName: 'zod3Url',
        input: { url: blockedUrl },
      },
      {
        toolCallId: 'zod3-url-allowed',
        toolName: 'zod3Url',
        input: acceptedUrl,
      },
    ];

    const { toolStep } = await runAgent(tools, calls);
    const successfulResults = (toolStep?.toolResults ?? []).map(result => ({
      toolCallId: result.toolCallId,
      output: result.output,
    }));

    expect(executed).toEqual([
      { toolCallId: 'zod4-read-allowed', input: expected.zod4Read },
      {
        toolCallId: 'zod4-dynamic-read-allowed',
        input: expected.zod4Read,
      },
      { toolCallId: 'zod4-url-allowed', input: expected.zod4Url },
      {
        toolCallId: 'zod4-dynamic-url-allowed',
        input: expected.zod4Url,
      },
      { toolCallId: 'zod3-read-allowed', input: expected.zod3Read },
      { toolCallId: 'zod3-url-allowed', input: expected.zod3Url },
    ]);
    expect(successfulResults).toEqual([
      {
        toolCallId: 'zod4-read-allowed',
        output: { actedOn: expected.zod4Read },
      },
      {
        toolCallId: 'zod4-dynamic-read-allowed',
        output: { actedOn: expected.zod4Read },
      },
      {
        toolCallId: 'zod4-url-allowed',
        output: { actedOn: expected.zod4Url },
      },
      {
        toolCallId: 'zod4-dynamic-url-allowed',
        output: { actedOn: expected.zod4Url },
      },
      {
        toolCallId: 'zod3-read-allowed',
        output: { actedOn: expected.zod3Read },
      },
      {
        toolCallId: 'zod3-url-allowed',
        output: { actedOn: expected.zod3Url },
      },
    ]);
    expect(JSON.stringify(executed)).not.toContain(traversalPath);
    expect(JSON.stringify(executed)).not.toContain('169.254.169.254');
    expect(JSON.stringify(successfulResults)).not.toContain(traversalPath);
    expect(JSON.stringify(successfulResults)).not.toContain('169.254.169.254');
  });

  it('applies the original schema output when an approved tool resumes', async () => {
    const executed: ExecutedCall[] = [];
    const agent = new WorkflowAgent({
      model: new MockLanguageModelV4({
        doStream: async () => ({
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text' },
            { type: 'text-delta', id: 'text', delta: 'done' },
            { type: 'text-end', id: 'text' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: finishUsage,
            },
          ]),
        }),
      }),
      tools: {
        readRelative: recordingTool({
          inputSchema: zod4ReadRelativeSchema,
          executed,
          needsApproval: true,
        }),
      },
    });

    await agent.stream({
      messages: [
        { role: 'user', content: 'read the file' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'approved-read',
              toolName: 'readRelative',
              input: { path: relativePath },
            },
            {
              type: 'tool-approval-request',
              approvalId: 'approval-read',
              toolCallId: 'approved-read',
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-approval-response',
              approvalId: 'approval-read',
              approved: true,
            },
          ],
        },
      ] as any,
      writable: new WritableStream({ write() {} }),
    });

    expect(executed).toEqual([
      {
        toolCallId: 'approved-read',
        input: zod4ReadRelativeSchema.parse({ path: relativePath }),
      },
    ]);
  });

  it('does not run an approved tool when the original refinement rejects the input', async () => {
    const executed: ExecutedCall[] = [];
    const agent = new WorkflowAgent({
      model: new MockLanguageModelV4({
        doStream: async () => ({
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: finishUsage,
            },
          ]),
        }),
      }),
      tools: {
        readRelative: recordingTool({
          inputSchema: zod4ReadRelativeSchema,
          executed,
          needsApproval: true,
        }),
      },
    });

    await agent.stream({
      messages: [
        { role: 'user', content: 'read the file' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'approved-blocked',
              toolName: 'readRelative',
              input: { path: traversalPath },
            },
            {
              type: 'tool-approval-request',
              approvalId: 'approval-blocked',
              toolCallId: 'approved-blocked',
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-approval-response',
              approvalId: 'approval-blocked',
              approved: true,
            },
          ],
        },
      ] as any,
      writable: new WritableStream({ write() {} }),
    });

    expect(executed).toEqual([]);
  });
});
