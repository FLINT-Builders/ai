import {
  generateText,
  stepCountIs,
  streamText,
  ToolLoopAgent,
  tool,
  type LanguageModelV4Usage,
} from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { experimental_codeModeTool as codeModeTool } from '../dist/index.js';

const VICTIM_ID = 'victim-record';
const ALLOWED_ID = 'allowed-record';

const usage: LanguageModelV4Usage = {
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

/**
 * Model output a chat user can induce: code-mode source that calls a host
 * tool. The surrounding generation is the real generateText / streamText /
 * ToolLoopAgent path, including code mode's sandbox.
 */
function codeModeProgram(recordId: string): string {
  return `return await tools.deleteRecord({ id: ${JSON.stringify(recordId)} });`;
}

const programDeletingVictimAndAllowed = `
  return await Promise.all([
    tools.deleteRecord({ id: ${JSON.stringify(ALLOWED_ID)} }),
    tools.deleteRecord({ id: ${JSON.stringify(VICTIM_ID)} }),
  ]);
`;

function codeModeCallInput(js: string): string {
  return JSON.stringify({ js });
}

function modelThatCallsCodeMode(js: string) {
  const input = codeModeCallInput(js);
  return {
    specificationVersion: 'v4' as const,
    provider: 'test',
    modelId: 'test',
    supportedUrls: Promise.resolve({}),
    doGenerate: async () => ({
      content: [
        {
          type: 'tool-call' as const,
          toolCallType: 'function' as const,
          toolCallId: 'code-call',
          toolName: 'code_mode',
          input,
        },
      ],
      finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
      usage,
      warnings: [],
    }),
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({
            type: 'tool-call',
            toolCallId: 'code-call',
            toolName: 'code_mode',
            input,
          });
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage,
          });
          controller.close();
        },
      }),
    }),
  };
}

function deleteRecordTool(
  executed: string[],
  needsApproval?: false | (() => Promise<boolean>),
) {
  return tool({
    description: 'Delete a record by id.',
    inputSchema: z.object({ id: z.string() }),
    // Call-level toolApproval is the gate under test. A tool-level flag that
    // does not request approval must not override a denied or user-approval
    // policy, whether the flag is absent, false, or a function returning false.
    ...(needsApproval === undefined ? {} : { needsApproval }),
    execute: async ({ id }: { id: string }) => {
      executed.push(id);
      return { deleted: id };
    },
  });
}

function toolsRoutingDeleteThroughCodeMode(
  executed: string[],
  needsApproval?: false | (() => Promise<boolean>),
) {
  return {
    code_mode: codeModeTool(),
    deleteRecord: deleteRecordTool(executed, needsApproval),
  };
}

const callers = {
  deleteRecord: ['code_mode'],
} as const;

/**
 * Privileged work is the id list recorded inside deleteRecord.execute.
 * Refusing the call, raising approval, or rejecting the configuration all
 * leave the list empty. Running the tool for an id the policy did not
 * approve fails the test.
 */
async function assertIdsNotActedOn(
  executed: string[],
  forbiddenIds: readonly string[],
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
  } catch {
    // A configuration or execution refusal is a closed outcome.
  }
  expect(executed.filter(id => forbiddenIds.includes(id))).toEqual([]);
}

describe('code mode nested calls honor call-level toolApproval', () => {
  describe('generateText', () => {
    it('does not run a nested tool that toolApproval denies', async () => {
      const executed: string[] = [];

      await assertIdsNotActedOn(executed, [VICTIM_ID], () =>
        generateText({
          model: modelThatCallsCodeMode(codeModeProgram(VICTIM_ID)),
          tools: toolsRoutingDeleteThroughCodeMode(executed),
          experimental_toolCallers: callers,
          toolApproval: { deleteRecord: 'denied' },
          prompt: 'Delete the record.',
        }),
      );
    });

    it('does not run a nested tool that toolApproval denies with an object status', async () => {
      const executed: string[] = [];

      await assertIdsNotActedOn(executed, [VICTIM_ID], () =>
        generateText({
          model: modelThatCallsCodeMode(codeModeProgram(VICTIM_ID)),
          tools: toolsRoutingDeleteThroughCodeMode(executed, false),
          experimental_toolCallers: callers,
          toolApproval: {
            deleteRecord: { type: 'denied', reason: 'members cannot delete' },
          },
          prompt: 'Delete the record.',
        }),
      );
    });

    it('does not run a nested tool that toolApproval marks user-approval', async () => {
      const executed: string[] = [];

      await assertIdsNotActedOn(executed, [VICTIM_ID], () =>
        generateText({
          model: modelThatCallsCodeMode(codeModeProgram(VICTIM_ID)),
          tools: toolsRoutingDeleteThroughCodeMode(executed),
          experimental_toolCallers: callers,
          toolApproval: { deleteRecord: 'user-approval' },
          prompt: 'Delete the record.',
        }),
      );
    });

    it('does not run a nested tool when a tool-level approval function returns false and toolApproval denies it', async () => {
      const executed: string[] = [];

      await assertIdsNotActedOn(executed, [VICTIM_ID], () =>
        generateText({
          model: modelThatCallsCodeMode(codeModeProgram(VICTIM_ID)),
          tools: toolsRoutingDeleteThroughCodeMode(executed, async () => false),
          experimental_toolCallers: callers,
          toolApproval: { deleteRecord: 'denied' },
          prompt: 'Delete the record.',
        }),
      );
    });

    it('does not run a nested tool when a per-tool policy denies the runtime context', async () => {
      const executed: string[] = [];

      await assertIdsNotActedOn(executed, [VICTIM_ID], () =>
        generateText({
          model: modelThatCallsCodeMode(codeModeProgram(VICTIM_ID)),
          tools: toolsRoutingDeleteThroughCodeMode(executed, false),
          experimental_toolCallers: callers,
          runtimeContext: { role: 'member' },
          toolApproval: {
            deleteRecord: (_input, { runtimeContext }) =>
              runtimeContext.role === 'admin' ? 'approved' : 'denied',
          },
          prompt: 'Delete the record.',
        }),
      );
    });

    it('does not run a nested tool when a generic toolApproval function denies it', async () => {
      const executed: string[] = [];

      await assertIdsNotActedOn(executed, [VICTIM_ID], () =>
        generateText({
          model: modelThatCallsCodeMode(codeModeProgram(VICTIM_ID)),
          tools: toolsRoutingDeleteThroughCodeMode(executed),
          experimental_toolCallers: callers,
          runtimeContext: { role: 'member' },
          toolApproval: ({ toolCall, runtimeContext }) => {
            if (toolCall.toolName !== 'deleteRecord') {
              return 'not-applicable';
            }
            return runtimeContext.role === 'admin' ? 'approved' : 'denied';
          },
          prompt: 'Delete the record.',
        }),
      );
    });

    it('does not delete an id the policy did not approve when another id is approved', async () => {
      const executed: string[] = [];

      await assertIdsNotActedOn(executed, [VICTIM_ID], () =>
        generateText({
          model: modelThatCallsCodeMode(programDeletingVictimAndAllowed),
          tools: toolsRoutingDeleteThroughCodeMode(executed, false),
          experimental_toolCallers: callers,
          toolApproval: {
            deleteRecord: (input: { id: string }) =>
              input.id === ALLOWED_ID ? 'approved' : 'denied',
          },
          prompt: 'Delete the records.',
        }),
      );
    });
  });

  describe('streamText', () => {
    it('does not run a nested tool that toolApproval denies', async () => {
      const executed: string[] = [];

      await assertIdsNotActedOn(executed, [VICTIM_ID], async () => {
        const result = streamText({
          model: modelThatCallsCodeMode(codeModeProgram(VICTIM_ID)),
          tools: toolsRoutingDeleteThroughCodeMode(executed),
          experimental_toolCallers: callers,
          toolApproval: { deleteRecord: 'denied' },
          prompt: 'Delete the record.',
        });
        await result.consumeStream();
      });
    });

    it('does not run a nested tool that toolApproval marks user-approval', async () => {
      const executed: string[] = [];

      await assertIdsNotActedOn(executed, [VICTIM_ID], async () => {
        const result = streamText({
          model: modelThatCallsCodeMode(codeModeProgram(VICTIM_ID)),
          tools: toolsRoutingDeleteThroughCodeMode(executed),
          experimental_toolCallers: callers,
          toolApproval: {
            deleteRecord: { type: 'user-approval', reason: 'confirm delete' },
          },
          prompt: 'Delete the record.',
        });
        await result.consumeStream();
      });
    });

    it('does not run a nested tool when a per-tool policy denies the runtime context', async () => {
      const executed: string[] = [];

      await assertIdsNotActedOn(executed, [VICTIM_ID], async () => {
        const result = streamText({
          model: modelThatCallsCodeMode(codeModeProgram(VICTIM_ID)),
          tools: toolsRoutingDeleteThroughCodeMode(executed),
          experimental_toolCallers: callers,
          runtimeContext: { role: 'member' },
          toolApproval: {
            deleteRecord: async (_input, { runtimeContext }) =>
              runtimeContext.role === 'admin' ? 'approved' : 'denied',
          },
          prompt: 'Delete the record.',
        });
        await result.consumeStream();
      });
    });

    it('does not delete an id the policy did not approve when another id is approved', async () => {
      const executed: string[] = [];

      await assertIdsNotActedOn(executed, [VICTIM_ID], async () => {
        const result = streamText({
          model: modelThatCallsCodeMode(programDeletingVictimAndAllowed),
          tools: toolsRoutingDeleteThroughCodeMode(executed),
          experimental_toolCallers: callers,
          toolApproval: ({ toolCall }) => {
            if (toolCall.toolName !== 'deleteRecord') {
              return 'not-applicable';
            }
            const input = toolCall.input as { id?: string };
            return input.id === ALLOWED_ID ? 'approved' : 'denied';
          },
          prompt: 'Delete the records.',
        });
        await result.consumeStream();
      });
    });
  });

  describe('ToolLoopAgent', () => {
    it('does not run a nested tool that toolApproval denies in generate', async () => {
      const executed: string[] = [];
      const agent = new ToolLoopAgent({
        model: modelThatCallsCodeMode(codeModeProgram(VICTIM_ID)),
        tools: toolsRoutingDeleteThroughCodeMode(executed),
        experimental_toolCallers: callers,
        toolApproval: { deleteRecord: 'denied' },
        stopWhen: stepCountIs(1),
      });

      await assertIdsNotActedOn(executed, [VICTIM_ID], () =>
        agent.generate({ prompt: 'Delete the record.' }),
      );
    });

    it('does not delete an id the policy did not approve in generate', async () => {
      const executed: string[] = [];
      const agent = new ToolLoopAgent({
        model: modelThatCallsCodeMode(programDeletingVictimAndAllowed),
        tools: toolsRoutingDeleteThroughCodeMode(executed, false),
        experimental_toolCallers: callers,
        runtimeContext: { role: 'member' },
        stopWhen: stepCountIs(1),
        toolApproval: {
          deleteRecord: (input, { runtimeContext }) => {
            if (runtimeContext.role !== 'member') {
              return 'denied';
            }
            return input.id === ALLOWED_ID ? 'approved' : 'denied';
          },
        },
      });

      await assertIdsNotActedOn(executed, [VICTIM_ID], () =>
        agent.generate({ prompt: 'Delete the records.' }),
      );
    });

    it('does not run a nested tool that toolApproval marks user-approval in stream', async () => {
      const executed: string[] = [];
      const agent = new ToolLoopAgent({
        model: modelThatCallsCodeMode(codeModeProgram(VICTIM_ID)),
        tools: toolsRoutingDeleteThroughCodeMode(executed, false),
        experimental_toolCallers: callers,
        toolApproval: { deleteRecord: 'user-approval' },
        stopWhen: stepCountIs(1),
      });

      await assertIdsNotActedOn(executed, [VICTIM_ID], async () => {
        const result = await agent.stream({ prompt: 'Delete the record.' });
        await result.consumeStream();
      });
    });

    it('does not run a nested tool when a generic toolApproval function denies it in stream', async () => {
      const executed: string[] = [];
      const agent = new ToolLoopAgent({
        model: modelThatCallsCodeMode(codeModeProgram(VICTIM_ID)),
        tools: toolsRoutingDeleteThroughCodeMode(executed),
        experimental_toolCallers: callers,
        runtimeContext: { role: 'member' },
        stopWhen: stepCountIs(1),
        toolApproval: ({ toolCall, runtimeContext }) => {
          if (toolCall.toolName !== 'deleteRecord') {
            return 'not-applicable';
          }
          return runtimeContext.role === 'admin' ? 'approved' : 'denied';
        },
      });

      await assertIdsNotActedOn(executed, [VICTIM_ID], async () => {
        const result = await agent.stream({ prompt: 'Delete the record.' });
        await result.consumeStream();
      });
    });
  });
});
