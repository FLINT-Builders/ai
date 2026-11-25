/**
 * Spec for tool-level approval under `shadow`.
 *
 * These tests fail while the vulnerability is present. `shadow` always
 * returns one approval function. For a tool the wrapped map does not name,
 * that function answers `not-applicable` (enforce) or `approved` (observe).
 * `resolveToolApproval` treats a function's answer as final, so it never
 * reaches the tool's own `needsApproval`, and `generateText` / `streamText`
 * run the tool.
 *
 * They pass once `shadow` gives the same answer the wrapped setting would
 * give without the wrapper:
 *
 * - No opinion (`undefined`, `null`, or `not-applicable`) consults the tool
 *   as an own property of `args.tools` and applies `needsApproval` the same
 *   way `resolveToolApproval` does. `true` becomes `{ type: 'user-approval' }`.
 * - Per-tool approval functions receive the validated `toolContext`, not
 *   `undefined`. Invalid context throws `TypeValidationError` before the
 *   function is called.
 * - Observe mode (`enforce` omitted or false) returns that tool-level result
 *   instead of a blanket `{ type: 'approved' }`, so rolling a policy out
 *   cannot turn off approvals the tools already enforce. A tool with no
 *   `needsApproval` is still `{ type: 'approved' }` in observe mode.
 * - An explicit enforce-mode decision (`approved`, `denied`, `user-approval`)
 *   is unchanged and does not consult `needsApproval`.
 */
import {
  generateText,
  isStepCount,
  jsonSchema,
  streamText,
  tool,
  ToolLoopAgent,
  TypeValidationError,
} from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { shadow } from './shadow';

const usage = {
  cachedInputTokens: undefined,
  inputTokens: {
    total: 3,
    noCache: 3,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

const prompt = 'send the wire';
const userMessage = { role: 'user' as const, content: prompt };

function looseInputSchema() {
  return jsonSchema({ type: 'object' });
}

function actorContextSchema() {
  return jsonSchema<{ actor: string }>(
    {
      type: 'object',
      properties: { actor: { type: 'string' } },
      required: ['actor'],
      additionalProperties: false,
    },
    {
      validate: value => {
        if (
          typeof value !== 'object' ||
          value == null ||
          typeof (value as { actor?: unknown }).actor !== 'string'
        ) {
          return { success: false, error: new Error('invalid tool context') };
        }
        return {
          success: true,
          value: { actor: (value as { actor: string }).actor },
        };
      },
    },
  );
}

type Effect = 'sendWire' | 'search' | 'deleteRecord';

function recordingTool(
  effects: Effect[],
  effect: Effect,
  overrides: {
    needsApproval?:
      | boolean
      | ((...args: never[]) => boolean | Promise<boolean>);
  } = {},
) {
  return tool({
    inputSchema: looseInputSchema(),
    execute: async () => {
      effects.push(effect);
      return `${effect}-ran`;
    },
    ...overrides,
  });
}

function generateModel(
  calls: Array<{ toolCallId: string; toolName: string; input: string }>,
) {
  let step = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      step += 1;
      if (step > 1) {
        return {
          warnings: [],
          usage,
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          content: [{ type: 'text' as const, text: 'done' }],
        };
      }
      return {
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
    },
  });
}

function streamModel(
  calls: Array<{ toolCallId: string; toolName: string; input: string }>,
) {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      step += 1;
      if (step > 1) {
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            {
              type: 'response-metadata',
              id: 'id-1',
              modelId: 'mock-model-id',
              timestamp: new Date(0),
            },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'done' },
            { type: 'text-end', id: 'text-1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop' as const, raw: 'stop' },
              usage,
              providerMetadata: {},
            },
          ]),
        };
      }
      return {
        stream: convertArrayToReadableStream([
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
            input: call.input,
          })),
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage,
            providerMetadata: {},
          },
        ]),
      };
    },
  });
}

const attackCalls = [
  {
    toolCallId: 'call-send',
    toolName: 'sendWire',
    input: '{ "amount": 1000 }',
  },
  { toolCallId: 'call-search', toolName: 'search', input: '{}' },
  {
    toolCallId: 'call-delete',
    toolName: 'deleteRecord',
    input: '{ "id": "rec-1" }',
  },
];

type ApprovalPart = {
  type: string;
  isAutomatic?: boolean;
  toolCallId?: string;
  toolCall?: { toolCallId?: string; toolName?: string };
};

function requestsUserApproval(parts: ApprovalPart[], toolCallId: string) {
  return parts.some(part => {
    if (part.type !== 'tool-approval-request' || part.isAutomatic === true) {
      return false;
    }
    const id = part.toolCallId ?? part.toolCall?.toolCallId;
    return id === toolCallId;
  });
}

function partsOf(content: unknown): ApprovalPart[] {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (part): part is ApprovalPart =>
      typeof part === 'object' && part != null && 'type' in part,
  );
}

function partsFromMessages(
  messages: Array<{ content?: unknown }>,
): ApprovalPart[] {
  return messages.flatMap(message => partsOf(message.content));
}

async function approvalDecision(
  toolApproval: unknown,
  args: {
    toolName: string;
    toolCallId?: string;
    input?: unknown;
    tools?: unknown;
    toolsContext?: unknown;
    runtimeContext?: unknown;
    messages?: Array<{ role: 'user'; content: string }>;
  },
) {
  if (typeof toolApproval !== 'function') {
    throw new Error('shadow must wrap the setting in one approval function');
  }
  return toolApproval({
    toolCall: {
      type: 'tool-call',
      toolCallId: args.toolCallId ?? `call-${args.toolName}`,
      toolName: args.toolName,
      input: args.input ?? {},
      dynamic: false,
    },
    tools: args.tools,
    toolsContext: args.toolsContext ?? {},
    runtimeContext: args.runtimeContext ?? {},
    messages: args.messages ?? [userMessage],
  });
}

async function flushTelemetry() {
  await new Promise(resolve => {
    setTimeout(resolve, 0);
  });
}

describe('shadow tool-level needsApproval fallback', () => {
  describe('generateText enforce mode', () => {
    it('does not run a needsApproval tool that the wrapped map does not name', async () => {
      const effects: Effect[] = [];
      const result = await generateText({
        model: generateModel(attackCalls),
        prompt,
        stopWhen: isStepCount(3),
        tools: {
          sendWire: recordingTool(effects, 'sendWire', { needsApproval: true }),
          search: recordingTool(effects, 'search'),
          deleteRecord: recordingTool(effects, 'deleteRecord'),
        },
        toolApproval: shadow(
          { deleteRecord: 'user-approval' as const },
          { enforce: true },
        ),
      });

      expect(new Set(effects)).toEqual(new Set(['search']));
      expect(requestsUserApproval(partsOf(result.content), 'call-send')).toBe(
        true,
      );
      expect(requestsUserApproval(partsOf(result.content), 'call-delete')).toBe(
        true,
      );
      expect(requestsUserApproval(partsOf(result.content), 'call-search')).toBe(
        false,
      );
    });

    it('baseline: the same map without shadow still holds sendWire', async () => {
      const effects: Effect[] = [];
      const result = await generateText({
        model: generateModel(attackCalls),
        prompt,
        stopWhen: isStepCount(3),
        tools: {
          sendWire: recordingTool(effects, 'sendWire', { needsApproval: true }),
          search: recordingTool(effects, 'search'),
          deleteRecord: recordingTool(effects, 'deleteRecord'),
        },
        toolApproval: { deleteRecord: 'user-approval' as const },
      });

      expect(new Set(effects)).toEqual(new Set(['search']));
      expect(requestsUserApproval(partsOf(result.content), 'call-send')).toBe(
        true,
      );
    });

    it('holds a tool when the map entry is an explicit not-applicable', async () => {
      const effects: Effect[] = [];
      const result = await generateText({
        model: generateModel([
          {
            toolCallId: 'call-send',
            toolName: 'sendWire',
            input: '{ "amount": 1000 }',
          },
        ]),
        prompt,
        stopWhen: isStepCount(3),
        tools: {
          sendWire: recordingTool(effects, 'sendWire', { needsApproval: true }),
        },
        toolApproval: shadow(
          { sendWire: 'not-applicable' as const },
          { enforce: true },
        ),
      });

      expect(effects).toEqual([]);
      expect(requestsUserApproval(partsOf(result.content), 'call-send')).toBe(
        true,
      );
    });

    it('holds a tool when the wrapped function has no opinion', async () => {
      const effects: Effect[] = [];
      const result = await generateText({
        model: generateModel([
          {
            toolCallId: 'call-send',
            toolName: 'sendWire',
            input: '{ "amount": 1000 }',
          },
        ]),
        prompt,
        stopWhen: isStepCount(3),
        tools: {
          sendWire: recordingTool(effects, 'sendWire', { needsApproval: true }),
        },
        toolApproval: shadow(async () => undefined, { enforce: true }),
      });

      expect(effects).toEqual([]);
      expect(requestsUserApproval(partsOf(result.content), 'call-send')).toBe(
        true,
      );
    });

    it('runs the tool when needsApproval is a function that returns false, and holds it when the function returns true', async () => {
      const seen: unknown[] = [];
      const needsApproval = (input: { amount: number }) => {
        seen.push(input);
        return input.amount >= 1000;
      };

      const smallEffects: Effect[] = [];
      await generateText({
        model: generateModel([
          {
            toolCallId: 'call-send',
            toolName: 'sendWire',
            input: '{ "amount": 1 }',
          },
        ]),
        prompt,
        stopWhen: isStepCount(3),
        tools: {
          sendWire: recordingTool(smallEffects, 'sendWire', { needsApproval }),
        },
        toolApproval: shadow(
          { deleteRecord: 'user-approval' as const },
          { enforce: true },
        ),
      });

      const largeEffects: Effect[] = [];
      const held = await generateText({
        model: generateModel([
          {
            toolCallId: 'call-send',
            toolName: 'sendWire',
            input: '{ "amount": 1000 }',
          },
        ]),
        prompt,
        stopWhen: isStepCount(3),
        tools: {
          sendWire: recordingTool(largeEffects, 'sendWire', { needsApproval }),
        },
        toolApproval: shadow(
          { deleteRecord: 'user-approval' as const },
          { enforce: true },
        ),
      });

      expect(seen).toEqual([{ amount: 1 }, { amount: 1000 }]);
      expect(smallEffects).toEqual(['sendWire']);
      expect(largeEffects).toEqual([]);
      expect(requestsUserApproval(partsOf(held.content), 'call-send')).toBe(
        true,
      );
    });

    it('still runs a tool the enforcing policy explicitly approves', async () => {
      const effects: Effect[] = [];
      await generateText({
        model: generateModel([
          {
            toolCallId: 'call-send',
            toolName: 'sendWire',
            input: '{ "amount": 1000 }',
          },
        ]),
        prompt,
        stopWhen: isStepCount(3),
        tools: {
          sendWire: recordingTool(effects, 'sendWire', { needsApproval: true }),
        },
        toolApproval: shadow(
          { sendWire: 'approved' as const },
          { enforce: true },
        ),
      });

      expect(effects).toEqual(['sendWire']);
    });

    it('passes validated tool context into a per-tool approval function', async () => {
      const seen: unknown[] = [];
      const effects: Effect[] = [];
      await generateText({
        model: generateModel([
          {
            toolCallId: 'call-delete',
            toolName: 'deleteRecord',
            input: '{ "id": "rec-1" }',
          },
        ]),
        prompt,
        stopWhen: isStepCount(2),
        runtimeContext: { tenant: 'acme' },
        toolsContext: {
          deleteRecord: { actor: 'ada', extra: true },
        },
        tools: {
          deleteRecord: tool({
            inputSchema: looseInputSchema(),
            contextSchema: actorContextSchema(),
            execute: async () => {
              effects.push('deleteRecord');
              return 'deleted';
            },
          }),
        },
        toolApproval: shadow(
          {
            deleteRecord: (
              input: unknown,
              options: {
                toolCallId: string;
                messages: unknown;
                toolContext: unknown;
                runtimeContext: unknown;
              },
            ) => {
              seen.push({ input, ...options });
              return 'user-approval' as const;
            },
          },
          { enforce: true },
        ),
      });

      expect(effects).toEqual([]);
      expect(seen).toEqual([
        {
          input: { id: 'rec-1' },
          toolCallId: 'call-delete',
          messages: [userMessage],
          toolContext: { actor: 'ada' },
          runtimeContext: { tenant: 'acme' },
        },
      ]);
    });

    it('rejects invalid tool context before the per-tool approval function runs', async () => {
      const seen: unknown[] = [];
      const effects: Effect[] = [];
      const run = generateText({
        model: generateModel([
          {
            toolCallId: 'call-delete',
            toolName: 'deleteRecord',
            input: '{ "id": "rec-1" }',
          },
        ]),
        prompt,
        stopWhen: isStepCount(2),
        toolsContext: { deleteRecord: { actor: 123 } },
        tools: {
          deleteRecord: tool({
            inputSchema: looseInputSchema(),
            contextSchema: actorContextSchema(),
            execute: async () => {
              effects.push('deleteRecord');
              return 'deleted';
            },
          }),
        },
        toolApproval: shadow(
          {
            deleteRecord: () => {
              seen.push('called');
              return 'user-approval' as const;
            },
          },
          { enforce: true },
        ),
      });

      await expect(run).rejects.toSatisfy((error: unknown) =>
        TypeValidationError.isInstance(error),
      );
      expect(seen).toEqual([]);
      expect(effects).toEqual([]);
    });
  });

  describe('generateText observe mode', () => {
    it('still holds a needsApproval tool while the policy is only observing', async () => {
      const effects: Effect[] = [];
      const events: Array<{
        decision: { type: string };
        effective: { type: string };
      }> = [];
      const result = await generateText({
        model: generateModel([
          {
            toolCallId: 'call-send',
            toolName: 'sendWire',
            input: '{ "amount": 1000 }',
          },
        ]),
        prompt,
        stopWhen: isStepCount(3),
        tools: {
          sendWire: recordingTool(effects, 'sendWire', { needsApproval: true }),
        },
        toolApproval: shadow(
          { deleteRecord: 'denied' as const },
          {
            onDecision: event => {
              events.push({
                decision: event.decision,
                effective: event.effective,
              });
            },
          },
        ),
      });
      await flushTelemetry();

      expect(effects).toEqual([]);
      expect(requestsUserApproval(partsOf(result.content), 'call-send')).toBe(
        true,
      );
      expect(events).toEqual([
        {
          decision: { type: 'not-applicable' },
          effective: { type: 'user-approval' },
        },
      ]);
    });

    it('holds a needsApproval tool even when the observed policy would deny it', async () => {
      const effects: Effect[] = [];
      const events: Array<{
        decision: { type: string };
        effective: { type: string };
      }> = [];
      const result = await generateText({
        model: generateModel([
          {
            toolCallId: 'call-send',
            toolName: 'sendWire',
            input: '{ "amount": 1000 }',
          },
        ]),
        prompt,
        stopWhen: isStepCount(3),
        tools: {
          sendWire: recordingTool(effects, 'sendWire', { needsApproval: true }),
        },
        toolApproval: shadow(
          async () => ({ type: 'denied', reason: 'policy' }),
          {
            onDecision: event => {
              events.push({
                decision: { type: event.decision.type },
                effective: { type: event.effective.type },
              });
            },
          },
        ),
      });
      await flushTelemetry();

      expect(effects).toEqual([]);
      expect(requestsUserApproval(partsOf(result.content), 'call-send')).toBe(
        true,
      );
      expect(events).toEqual([
        { decision: { type: 'denied' }, effective: { type: 'user-approval' } },
      ]);
    });

    it('still lets an observed deny through when the tool has no needsApproval', async () => {
      const effects: Effect[] = [];
      await generateText({
        model: generateModel([
          { toolCallId: 'call-search', toolName: 'search', input: '{}' },
        ]),
        prompt,
        stopWhen: isStepCount(3),
        tools: { search: recordingTool(effects, 'search') },
        toolApproval: shadow(async () => ({
          type: 'denied',
          reason: 'policy',
        })),
      });

      expect(effects).toEqual(['search']);
    });
  });

  describe('streamText and ToolLoopAgent', () => {
    it('streamText does not run a needsApproval tool omitted from the enforced map', async () => {
      const effects: Effect[] = [];
      const result = streamText({
        model: streamModel(attackCalls),
        prompt,
        stopWhen: isStepCount(3),
        tools: {
          sendWire: recordingTool(effects, 'sendWire', { needsApproval: true }),
          search: recordingTool(effects, 'search'),
          deleteRecord: recordingTool(effects, 'deleteRecord'),
        },
        toolApproval: shadow(
          { deleteRecord: 'user-approval' as const },
          { enforce: true },
        ),
      });
      await result.consumeStream();
      const messages = (await result.response).messages;

      expect(new Set(effects)).toEqual(new Set(['search']));
      expect(
        requestsUserApproval(partsFromMessages(messages), 'call-send'),
      ).toBe(true);
      expect(
        requestsUserApproval(partsFromMessages(messages), 'call-delete'),
      ).toBe(true);
    });

    it('ToolLoopAgent.generate does not run a needsApproval tool omitted from the enforced map', async () => {
      const effects: Effect[] = [];
      const agent = new ToolLoopAgent({
        model: generateModel(attackCalls),
        stopWhen: isStepCount(3),
        tools: {
          sendWire: recordingTool(effects, 'sendWire', { needsApproval: true }),
          search: recordingTool(effects, 'search'),
          deleteRecord: recordingTool(effects, 'deleteRecord'),
        },
        toolApproval: shadow(
          { deleteRecord: 'user-approval' as const },
          { enforce: true },
        ),
      });
      const result = await agent.generate({ prompt });

      expect(new Set(effects)).toEqual(new Set(['search']));
      expect(requestsUserApproval(partsOf(result.content), 'call-send')).toBe(
        true,
      );
    });

    it('ToolLoopAgent.stream does not run a needsApproval tool omitted from the enforced map', async () => {
      const effects: Effect[] = [];
      const agent = new ToolLoopAgent({
        model: streamModel(attackCalls),
        stopWhen: isStepCount(3),
        tools: {
          sendWire: recordingTool(effects, 'sendWire', { needsApproval: true }),
          search: recordingTool(effects, 'search'),
          deleteRecord: recordingTool(effects, 'deleteRecord'),
        },
        toolApproval: shadow(
          { deleteRecord: 'user-approval' as const },
          { enforce: true },
        ),
      });
      const result = await agent.stream({ prompt });
      await result.consumeStream();
      const messages = (await result.response).messages;

      expect(new Set(effects)).toEqual(new Set(['search']));
      expect(
        requestsUserApproval(partsFromMessages(messages), 'call-send'),
      ).toBe(true);
    });
  });

  describe('decision returned by shadow', () => {
    it('returns user-approval for a missing map entry when needsApproval is true', async () => {
      const events: Array<{
        decision: { type: string };
        effective: { type: string };
        enforced: boolean;
      }> = [];
      const wrapped = shadow(
        { deleteRecord: 'user-approval' as const },
        {
          enforce: true,
          onDecision: event => {
            events.push({
              decision: { type: event.decision.type },
              effective: { type: event.effective.type },
              enforced: event.enforced,
            });
          },
        },
      );
      const tools = {
        sendWire: tool({
          inputSchema: looseInputSchema(),
          needsApproval: true,
          execute: async () => 'sent',
        }),
      };

      const status = await approvalDecision(wrapped, {
        toolName: 'sendWire',
        input: { amount: 1000 },
        tools,
      });
      await flushTelemetry();

      expect(status).toEqual({ type: 'user-approval' });
      expect(events).toEqual([
        {
          decision: { type: 'not-applicable' },
          effective: { type: 'user-approval' },
          enforced: true,
        },
      ]);
    });

    it('passes parsed input and validated context to a tool needsApproval function', async () => {
      const needsApproval = vi.fn(() => true);
      const wrapped = shadow(
        { deleteRecord: 'user-approval' as const },
        { enforce: true },
      );
      const tools = {
        sendWire: tool({
          inputSchema: looseInputSchema(),
          contextSchema: actorContextSchema(),
          needsApproval,
          execute: async () => 'sent',
        }),
      };

      const status = await approvalDecision(wrapped, {
        toolName: 'sendWire',
        toolCallId: 'call-send',
        input: { amount: 1000 },
        tools,
        toolsContext: { sendWire: { actor: 'ada', extra: true } },
        messages: [userMessage],
      });

      expect(status).toEqual({ type: 'user-approval' });
      expect(needsApproval).toHaveBeenCalledTimes(1);
      expect(needsApproval).toHaveBeenCalledWith(
        { amount: 1000 },
        {
          toolCallId: 'call-send',
          messages: [userMessage],
          context: { actor: 'ada' },
        },
      );
    });

    it('returns not-applicable when the tool needsApproval function returns false', async () => {
      const needsApproval = vi.fn(() => false);
      const wrapped = shadow(
        { deleteRecord: 'user-approval' as const },
        { enforce: true },
      );
      const status = await approvalDecision(wrapped, {
        toolName: 'sendWire',
        tools: {
          sendWire: tool({
            inputSchema: looseInputSchema(),
            needsApproval,
            execute: async () => 'sent',
          }),
        },
      });

      expect(needsApproval).toHaveBeenCalledTimes(1);
      expect(status).toEqual({ type: 'not-applicable' });
    });

    it('treats a null map entry, a not-applicable string, and a not-applicable object as no opinion', async () => {
      const cases: unknown[] = [
        { sendWire: null },
        { sendWire: 'not-applicable' },
        { sendWire: { type: 'not-applicable' } },
        async () => undefined,
        async () => 'not-applicable',
        async () => ({ type: 'not-applicable' }),
      ];

      for (const approval of cases) {
        const needsApproval = vi.fn(() => true);
        const wrapped = shadow(approval as never, { enforce: true });
        const status = await approvalDecision(wrapped, {
          toolName: 'sendWire',
          tools: {
            sendWire: tool({
              inputSchema: looseInputSchema(),
              needsApproval,
              execute: async () => 'sent',
            }),
          },
        });
        expect(needsApproval).toHaveBeenCalledTimes(1);
        expect(status).toEqual({ type: 'user-approval' });
      }
    });

    it('does not read needsApproval from the prototype chain', async () => {
      const inherited = vi.fn(() => true);
      const tools = Object.create({
        sendWire: { needsApproval: inherited },
      });
      const wrapped = shadow(
        { deleteRecord: 'approved' as const },
        { enforce: true },
      );

      const status = await approvalDecision(wrapped, {
        toolName: 'sendWire',
        tools,
      });

      expect(inherited).not.toHaveBeenCalled();
      expect(status).toEqual({ type: 'not-applicable' });
    });

    it('uses the own tool when the name also exists on the prototype', async () => {
      const inherited = vi.fn(() => false);
      const own = vi.fn(() => true);
      const tools: Record<string, unknown> = Object.create({
        sendWire: { needsApproval: inherited },
      });
      tools.sendWire = tool({
        inputSchema: looseInputSchema(),
        needsApproval: own,
        execute: async () => 'sent',
      });
      const wrapped = shadow(
        { deleteRecord: 'approved' as const },
        { enforce: true },
      );

      const status = await approvalDecision(wrapped, {
        toolName: 'sendWire',
        input: { amount: 1000 },
        tools,
      });

      expect(inherited).not.toHaveBeenCalled();
      expect(own).toHaveBeenCalledTimes(1);
      expect(status).toEqual({ type: 'user-approval' });
    });

    it('keeps an explicit enforce-mode denial and does not call needsApproval', async () => {
      const needsApproval = vi.fn(() => false);
      const wrapped = shadow(
        async () => ({ type: 'denied' as const, reason: 'policy' }),
        { enforce: true },
      );
      const status = await approvalDecision(wrapped, {
        toolName: 'sendWire',
        tools: {
          sendWire: tool({
            inputSchema: looseInputSchema(),
            needsApproval,
            execute: async () => 'sent',
          }),
        },
      });

      expect(needsApproval).not.toHaveBeenCalled();
      expect(status).toEqual({ type: 'denied', reason: 'policy' });
    });

    it('returns approved in observe mode when the tool does not require approval', async () => {
      const wrapped = shadow(async () => ({
        type: 'denied' as const,
        reason: 'policy',
      }));
      const status = await approvalDecision(wrapped, {
        toolName: 'search',
        tools: {
          search: tool({
            inputSchema: looseInputSchema(),
            execute: async () => 'found',
          }),
        },
      });

      expect(status).toEqual({ type: 'approved' });
    });

    it('passes validated toolContext to the per-tool function and rejects invalid context first', async () => {
      const seen: unknown[] = [];
      const wrapped = shadow(
        {
          deleteRecord: (
            _input: unknown,
            options: { toolContext: unknown },
          ) => {
            seen.push(options.toolContext);
            return 'user-approval' as const;
          },
        },
        { enforce: true },
      );
      const tools = {
        deleteRecord: tool({
          inputSchema: looseInputSchema(),
          contextSchema: actorContextSchema(),
          execute: async () => 'deleted',
        }),
      };

      const status = await approvalDecision(wrapped, {
        toolName: 'deleteRecord',
        input: { id: 'rec-1' },
        tools,
        toolsContext: { deleteRecord: { actor: 'ada', extra: true } },
        runtimeContext: { tenant: 'acme' },
      });
      expect(status).toEqual({ type: 'user-approval' });
      expect(seen).toEqual([{ actor: 'ada' }]);

      const rejected = vi.fn(() => 'approved' as const);
      const invalid = shadow({ deleteRecord: rejected }, { enforce: true });
      await expect(
        approvalDecision(invalid, {
          toolName: 'deleteRecord',
          tools,
          toolsContext: { deleteRecord: { actor: 5 } },
        }),
      ).rejects.toSatisfy((error: unknown) =>
        TypeValidationError.isInstance(error),
      );
      expect(rejected).not.toHaveBeenCalled();
    });
  });
});
