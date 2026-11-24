import { dynamicTool, tool } from '@ai-sdk/provider-utils';
import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod/v4';
import type {
  HarnessV1,
  HarnessV1NetworkSandboxSession,
  HarnessV1PromptControl,
  HarnessV1PromptTurnOptions,
  HarnessV1SandboxProvider,
  HarnessV1Session,
  HarnessV1StreamPart,
  HarnessV1ToolSpec,
} from '../v1';
import { HarnessAgent } from './harness-agent';

/**
 * Host-tool approval regression.
 *
 * A host tool's own `needsApproval` flag must gate execution the same way
 * `generateText` / `streamText` do when `toolApproval` has no entry for that
 * tool. These tests fail while `runPrompt` ignores `needsApproval` and
 * executes the tool.
 */

type SubmittedToolResult = { toolCallId: string; output: unknown };

function mockHarness(options: {
  script: () => HarnessV1StreamPart[];
  continueScript?: () => HarnessV1StreamPart[];
  onPromptTurn?: (options: HarnessV1PromptTurnOptions) => void;
}): {
  harness: HarnessV1;
  toolResults: SubmittedToolResult[];
  continueTools: HarnessV1ToolSpec[][];
} {
  const toolResults: SubmittedToolResult[] = [];
  const continueTools: HarnessV1ToolSpec[][] = [];
  const resumeState = {
    type: 'resume-session' as const,
    harnessId: 'mock',
    specificationVersion: 'harness-v1' as const,
    data: {},
  };
  const continueState = {
    type: 'continue-turn' as const,
    harnessId: 'mock',
    specificationVersion: 'harness-v1' as const,
    data: {},
  };

  const emitScript = (
    events: HarnessV1StreamPart[],
    emit: (event: HarnessV1StreamPart) => void,
  ): HarnessV1PromptControl => {
    const control: HarnessV1PromptControl = {
      submitToolResult: async input => {
        toolResults.push({
          toolCallId: input.toolCallId,
          output: input.output,
        });
      },
      done: Promise.resolve(),
    };
    queueMicrotask(() => {
      for (const event of events) emit(event);
    });
    return control;
  };

  const session: HarnessV1Session = {
    sessionId: 'mock-session-1',
    isResume: false,
    doPromptTurn: async opts => {
      options.onPromptTurn?.(opts);
      return emitScript(options.script(), opts.emit);
    },
    doContinueTurn: async opts => {
      continueTools.push(opts.tools);
      return emitScript(options.continueScript?.() ?? [], opts.emit);
    },
    doCompact: async () => {},
    doDetach: async () => resumeState,
    doStop: async () => resumeState,
    doDestroy: async () => {},
    doSuspendTurn: async () => continueState,
  };

  return {
    harness: {
      specificationVersion: 'harness-v1',
      harnessId: 'mock',
      builtinTools: {},
      doStart: async () => session,
    },
    toolResults,
    continueTools,
  };
}

function makeSandboxProvider(): HarnessV1SandboxProvider {
  const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
  const sandboxSession = {
    id: 'sandbox',
    defaultWorkingDirectory: '/work',
    ports: [],
    getPortEndpoint: async () => ({ url: 'ws://example.test/' }),
    getPortUrl: async () => 'ws://example.test/',
    run,
    stop: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    restricted: () => ({ run }) as never,
  } as unknown as HarnessV1NetworkSandboxSession;
  return {
    specificationVersion: 'harness-sandbox-v1',
    providerId: 'mock-sandbox',
    createSession: async () => sandboxSession,
    resumeSession: async () => sandboxSession,
  };
}

const continuedSession = {
  type: 'continue-turn' as const,
  harnessId: 'mock',
  specificationVersion: 'harness-v1' as const,
  data: {},
};

function hostToolCall(input: {
  toolCallId: string;
  toolName: string;
  args: unknown;
}): HarnessV1StreamPart {
  return {
    type: 'tool-call',
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    input: JSON.stringify(input.args),
    providerExecuted: false,
  };
}

function zeroUsage() {
  return {
    inputTokens: {
      total: undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: undefined,
      text: undefined,
      reasoning: undefined,
    },
  };
}

/** A runtime that keeps going after the host tool call, as the real bridges do. */
function finishEvents(): HarnessV1StreamPart[] {
  return [
    {
      type: 'finish-step',
      finishReason: { unified: 'tool-calls', raw: 'tool_use' },
      usage: zeroUsage(),
    },
    {
      type: 'finish',
      finishReason: { unified: 'tool-calls', raw: 'tool_use' },
      totalUsage: zeroUsage(),
    },
  ];
}

describe('host tool needsApproval', () => {
  test('stream() pauses a needsApproval host tool instead of executing it', async () => {
    const executed: string[] = [];
    const deleteRecord = tool({
      description: 'Delete a record with the app credentials.',
      inputSchema: z.object({ id: z.string() }),
      needsApproval: true,
      execute: async ({ id }: { id: string }) => {
        executed.push(id);
        return { deleted: id };
      },
    });
    let forwardedSpecs: HarnessV1ToolSpec[] | undefined;
    const { harness, toolResults } = mockHarness({
      onPromptTurn: options => {
        forwardedSpecs = options.tools;
      },
      script: () => [
        hostToolCall({
          toolCallId: 'delete-1',
          toolName: 'deleteRecord',
          args: { id: 'row-1' },
        }),
      ],
    });
    const agent = new HarnessAgent({
      harness,
      sandbox: makeSandboxProvider(),
      tools: { deleteRecord },
      // A map that does not mention deleteRecord must not count as approval.
      toolApproval: { unrelated: 'denied' },
    });
    const session = await agent.createSession();

    const result = await agent.stream({
      session,
      prompt: 'Delete row-1.',
    });
    const parts = [];
    for await (const part of result.fullStream) parts.push(part);

    expect(executed).toEqual([]);
    expect(toolResults).toEqual([]);
    expect(forwardedSpecs).toEqual([
      expect.objectContaining({
        name: 'deleteRecord',
        description: 'Delete a record with the app credentials.',
      }),
    ]);
    expect(forwardedSpecs?.[0]).not.toHaveProperty('needsApproval');
    const approval = parts.find(part => part.type === 'tool-approval-request');
    expect(approval).toMatchObject({
      type: 'tool-approval-request',
      toolCall: {
        toolCallId: 'delete-1',
        toolName: 'deleteRecord',
        input: { id: 'row-1' },
      },
    });

    await session.destroy();
  });

  test('generate() pauses a needsApproval host tool instead of executing it', async () => {
    const executed: string[] = [];
    const sendEmail = tool({
      description: 'Send an email with the app credentials.',
      inputSchema: z.object({
        to: z.string(),
        body: z.string(),
      }),
      needsApproval: true,
      execute: async ({ to, body }: { to: string; body: string }) => {
        executed.push(`${to}:${body}`);
        return { sent: true };
      },
    });
    const { harness, toolResults } = mockHarness({
      script: () => [
        hostToolCall({
          toolCallId: 'mail-1',
          toolName: 'sendEmail',
          args: { to: 'ada@example.com', body: 'wire the funds' },
        }),
        ...finishEvents(),
      ],
    });
    const agent = new HarnessAgent({
      harness,
      sandbox: makeSandboxProvider(),
      tools: { sendEmail },
    });
    const session = await agent.createSession();

    const result = await agent.generate({
      session,
      prompt: 'Send the email.',
    });

    expect(executed).toEqual([]);
    expect(toolResults).toEqual([]);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.content).toContainEqual(
      expect.objectContaining({
        type: 'tool-approval-request',
        toolCall: expect.objectContaining({
          toolCallId: 'mail-1',
          toolName: 'sendEmail',
          input: { to: 'ada@example.com', body: 'wire the funds' },
        }),
      }),
    );

    await session.destroy();
  });

  test('a needsApproval function gates only the input it rejects', async () => {
    const executions: string[] = [];
    const deleteRecord = tool({
      description: 'Delete a record.',
      inputSchema: z.object({ id: z.string() }),
      needsApproval: async ({ id }: { id: string }) => id === 'sensitive-row',
      execute: async ({ id }: { id: string }) => {
        executions.push(id);
        return { deleted: id };
      },
    });
    const { harness, toolResults } = mockHarness({
      script: () => [
        hostToolCall({
          toolCallId: 'delete-public',
          toolName: 'deleteRecord',
          args: { id: 'public-row' },
        }),
        hostToolCall({
          toolCallId: 'delete-sensitive',
          toolName: 'deleteRecord',
          args: { id: 'sensitive-row' },
        }),
      ],
    });
    const agent = new HarnessAgent({
      harness,
      sandbox: makeSandboxProvider(),
      tools: { deleteRecord },
    });
    const session = await agent.createSession();

    const result = await agent.stream({
      session,
      prompt: 'Delete the rows.',
    });
    const parts = [];
    for await (const part of result.fullStream) parts.push(part);

    expect(executions).toEqual(['public-row']);
    expect(toolResults.map(result => result.toolCallId)).toEqual([
      'delete-public',
    ]);
    expect(
      toolResults.some(result => result.toolCallId === 'delete-sensitive'),
    ).toBe(false);
    const approvals = parts.filter(
      part => part.type === 'tool-approval-request',
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      type: 'tool-approval-request',
      toolCall: {
        toolCallId: 'delete-sensitive',
        toolName: 'deleteRecord',
        input: { id: 'sensitive-row' },
      },
    });

    await session.destroy();
  });

  test('continueStream() pauses a needsApproval host tool on a resumed turn', async () => {
    const executed: string[] = [];
    const sendEmail = tool({
      description: 'Send an email.',
      inputSchema: z.object({ to: z.string() }),
      needsApproval: true,
      execute: async ({ to }: { to: string }) => {
        executed.push(to);
        return { sent: true };
      },
    });
    const { harness, toolResults } = mockHarness({
      script: () => [],
      continueScript: () => [
        hostToolCall({
          toolCallId: 'mail-continued',
          toolName: 'sendEmail',
          args: { to: 'ada@example.com' },
        }),
      ],
    });
    const agent = new HarnessAgent({
      harness,
      sandbox: makeSandboxProvider(),
      tools: { sendEmail },
    });
    const session = await agent.createSession({
      continueFrom: continuedSession,
    });

    const result = await agent.continueStream({ session });
    const parts = [];
    for await (const part of result.fullStream) parts.push(part);

    expect(executed).toEqual([]);
    expect(toolResults).toEqual([]);
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: 'tool-approval-request',
        toolCall: expect.objectContaining({
          toolCallId: 'mail-continued',
          toolName: 'sendEmail',
          input: { to: 'ada@example.com' },
        }),
      }),
    );

    await session.destroy();
  });

  test('continueGenerate() pauses a dynamic host tool whose needsApproval function returns true', async () => {
    const executed: string[] = [];
    const chargeCard = dynamicTool({
      description: 'Charge a card with the app credentials.',
      inputSchema: z.object({ amount: z.number() }),
      needsApproval: async ({ amount }: { amount: number }) => amount > 0,
      execute: async (input: { amount: number }) => {
        executed.push(String(input.amount));
        return { charged: input.amount };
      },
    });
    const { harness, toolResults, continueTools } = mockHarness({
      script: () => [],
      continueScript: () => [
        hostToolCall({
          toolCallId: 'charge-1',
          toolName: 'chargeCard',
          args: { amount: 50 },
        }),
        ...finishEvents(),
      ],
    });
    const agent = new HarnessAgent({
      harness,
      sandbox: makeSandboxProvider(),
      tools: { chargeCard },
    });
    const session = await agent.createSession({
      continueFrom: continuedSession,
    });

    const result = await agent.continueGenerate({ session });

    expect(executed).toEqual([]);
    expect(toolResults).toEqual([]);
    expect(continueTools[0]?.map(spec => spec.name)).toEqual(['chargeCard']);
    expect(continueTools[0]?.[0]).not.toHaveProperty('needsApproval');
    expect(result.steps[0]?.content).toContainEqual(
      expect.objectContaining({
        type: 'tool-approval-request',
        toolCall: expect.objectContaining({
          toolCallId: 'charge-1',
          toolName: 'chargeCard',
          input: { amount: 50 },
        }),
      }),
    );

    await session.destroy();
  });

  test('an async needsApproval rejection is bound to the parsed input of that call', async () => {
    const seen: unknown[] = [];
    const executed: Array<{ id: string; status: string; via: string }> = [];
    let runUpdate = async (input: { id: string; status: string }) => {
      executed.push({ ...input, via: 'original' });
      return { updated: input.id };
    };
    const updateRecord = tool({
      description: 'Update a record.',
      inputSchema: z.object({
        id: z.string(),
        status: z.string(),
      }),
      needsApproval: async (input: { id: string; status: string }) => {
        seen.push(input);
        await Promise.resolve();
        if (input.status !== 'archived') return false;
        // A second lookup of this tool must not run the action that the
        // approval decision just refused.
        runUpdate = async (executedInput: { id: string; status: string }) => {
          executed.push({ ...executedInput, via: 'replacement' });
          return { updated: executedInput.id };
        };
        return true;
      },
      execute: async (input: { id: string; status: string }) =>
        runUpdate(input),
    });
    const { harness } = mockHarness({
      script: () => [
        hostToolCall({
          toolCallId: 'update-1',
          toolName: 'updateRecord',
          args: { id: 'row-9', status: 'archived' },
        }),
      ],
    });
    const agent = new HarnessAgent({
      harness,
      sandbox: makeSandboxProvider(),
      tools: { updateRecord },
    });
    const session = await agent.createSession();

    const result = await agent.stream({ session, prompt: 'Archive row-9.' });
    const parts = [];
    for await (const part of result.fullStream) parts.push(part);

    expect(seen).toEqual([{ id: 'row-9', status: 'archived' }]);
    expect(executed).toEqual([]);
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: 'tool-approval-request',
        toolCall: expect.objectContaining({
          toolCallId: 'update-1',
          input: { id: 'row-9', status: 'archived' },
        }),
      }),
    );

    await session.destroy();
  });
});
