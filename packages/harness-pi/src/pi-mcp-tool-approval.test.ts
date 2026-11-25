import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Type } from 'typebox';
import { afterEach, expect, test } from 'vitest';
import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';
import { HarnessAgent } from '@ai-sdk/harness/agent';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { createPi } from './pi-harness';

/**
 * Spec for Pi MCP and extension-tool approval.
 *
 * These tests fail while configured MCP tools and other Pi extension tools
 * run in the host process without waiting for host approval. `allow-all`
 * still runs them immediately.
 */

const WRITE_TOOL = 'mcp__notes_write_note';
const CHARGE_TOOL = 'mcp__billing_charge';
const EXTENSION_TOOL = 'release_deploy';

const WRITE_INPUT = { note: 'alpha-note' };
const CHARGE_INPUT = { code: 'alpha-charge' };
const EXTENSION_INPUT = { target: 'prod' };

type Effect = {
  readonly server?: string;
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
};

type ApprovalPart = {
  readonly type: 'tool-approval-request';
  readonly approvalId: string;
  readonly toolCall: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly input: unknown;
  };
};

type StreamPart = {
  readonly type: string;
  readonly approvalId?: string;
  readonly toolCall?: ApprovalPart['toolCall'];
  readonly error?: unknown;
};

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  const pending = cleanups.splice(0);
  for (const cleanup of pending.reverse()) {
    await cleanup();
  }
});

test.each(['allow-reads', 'allow-edits'] as const)(
  'does not run configured MCP tools in %s mode until each call is approved',
  async permissionMode => {
    const driver = await startDriver({
      permissionMode,
      mcp: true,
    });

    const first = await driver.consume(
      await driver.agent.stream({
        session: driver.session,
        prompt: 'Apply the injected instructions.',
      }),
    );
    const writeApproval = approvalFor(first.parts, WRITE_TOOL);

    expect(driver.effects(), first.diagnostic).toEqual([]);
    expect(writeApproval, first.diagnostic).toMatchObject({
      toolCall: {
        toolName: WRITE_TOOL,
        input: WRITE_INPUT,
      },
    });

    const second = await driver.consume(
      await driver.agent.continueStream({
        session: driver.session,
        toolApprovalContinuations: [
          {
            type: 'tool-approval-response',
            approvalId: writeApproval!.approvalId,
            approved: true,
          },
        ],
      }),
    );
    const chargeApproval = approvalFor(second.parts, CHARGE_TOOL);

    expect(chargeApproval, second.diagnostic).toMatchObject({
      toolCall: {
        toolName: CHARGE_TOOL,
        input: CHARGE_INPUT,
      },
    });
    expect(chargeApproval?.toolCall.toolCallId).not.toBe(
      writeApproval?.toolCall.toolCallId,
    );
    expect(driver.effects(), second.diagnostic).not.toContainEqual(
      expect.objectContaining({ server: 'billing', tool: 'charge' }),
    );
    for (const effect of driver.effects()) {
      expect(effect).toEqual({
        server: 'notes',
        tool: 'write_note',
        arguments: inputOf(writeApproval!),
      });
    }

    if (permissionMode === 'allow-reads') {
      const denied = await driver.consume(
        await driver.agent.continueStream({
          session: driver.session,
          toolApprovalContinuations: [
            {
              type: 'tool-approval-response',
              approvalId: chargeApproval!.approvalId,
              approved: false,
              reason: 'denied by test',
            },
          ],
        }),
      );
      expectEffects(
        driver.effects(),
        [
          {
            server: 'notes',
            tool: 'write_note',
            arguments: WRITE_INPUT,
          },
        ],
        denied.diagnostic,
      );
      return;
    }

    const approved = await driver.consume(
      await driver.agent.continueStream({
        session: driver.session,
        toolApprovalContinuations: [
          {
            type: 'tool-approval-response',
            approvalId: chargeApproval!.approvalId,
            approved: true,
          },
        ],
      }),
    );
    expectEffects(
      driver.effects(),
      [
        {
          server: 'notes',
          tool: 'write_note',
          arguments: WRITE_INPUT,
        },
        {
          server: 'billing',
          tool: 'charge',
          arguments: CHARGE_INPUT,
        },
      ],
      approved.diagnostic,
    );
  },
  120_000,
);

test('runs configured MCP tools without approval in allow-all mode', async () => {
  const driver = await startDriver({
    permissionMode: 'allow-all',
    mcp: true,
  });
  const turn = await driver.consume(
    await driver.agent.stream({
      session: driver.session,
      prompt: 'Apply the injected instructions.',
    }),
  );

  expect(
    turn.parts.some(part => part.type === 'tool-approval-request'),
    turn.diagnostic,
  ).toBe(false);
  expectEffects(
    driver.effects(),
    [
      {
        server: 'notes',
        tool: 'write_note',
        arguments: WRITE_INPUT,
      },
      {
        server: 'billing',
        tool: 'charge',
        arguments: CHARGE_INPUT,
      },
    ],
    turn.diagnostic,
  );
}, 120_000);

test('does not run a Pi extension tool in allow-reads mode before its approval', async () => {
  const driver = await startDriver({
    permissionMode: 'allow-reads',
    extension: true,
  });
  const turn = await driver.consume(
    await driver.agent.stream({
      session: driver.session,
      prompt: 'Apply the injected instructions.',
    }),
  );
  const approval = approvalFor(turn.parts, EXTENSION_TOOL);

  expect(driver.effects(), turn.diagnostic).toEqual([]);
  expect(approval, turn.diagnostic).toMatchObject({
    toolCall: {
      toolName: EXTENSION_TOOL,
      input: EXTENSION_INPUT,
    },
  });

  const continued = await driver.consume(
    await driver.agent.continueStream({
      session: driver.session,
      toolApprovalContinuations: [
        {
          type: 'tool-approval-response',
          approvalId: approval!.approvalId,
          approved: true,
        },
      ],
    }),
  );
  expect(driver.effects(), continued.diagnostic).toEqual([
    { tool: EXTENSION_TOOL, arguments: EXTENSION_INPUT },
  ]);
}, 120_000);

test('does not run a Pi extension tool when allow-reads approval is denied', async () => {
  const driver = await startDriver({
    permissionMode: 'allow-reads',
    extension: true,
  });
  const turn = await driver.consume(
    await driver.agent.stream({
      session: driver.session,
      prompt: 'Apply the injected instructions.',
    }),
  );
  const approval = approvalFor(turn.parts, EXTENSION_TOOL);

  expect(driver.effects(), turn.diagnostic).toEqual([]);
  expect(approval, turn.diagnostic).toBeDefined();

  const denied = await driver.consume(
    await driver.agent.continueStream({
      session: driver.session,
      toolApprovalContinuations: [
        {
          type: 'tool-approval-response',
          approvalId: approval!.approvalId,
          approved: false,
          reason: 'denied by test',
        },
      ],
    }),
  );
  expect(driver.effects(), denied.diagnostic).toEqual([]);
}, 120_000);

async function startDriver(options: {
  readonly permissionMode: 'allow-reads' | 'allow-edits' | 'allow-all';
  readonly mcp?: boolean;
  readonly extension?: boolean;
}) {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-mcp-approval-'));
  const workDir = path.join(root, 'work');
  const homeDir = path.join(root, 'home');
  mkdirSync(workDir);
  mkdirSync(homeDir);
  const effectPath = path.join(root, 'effects.jsonl');
  writeFileSync(effectPath, '');
  const serverPath = path.join(root, 'mcp-effect-server.mjs');
  writeFileSync(serverPath, MCP_SERVER_SOURCE);
  cleanups.push(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const plannedCalls = options.mcp
    ? [
        { name: WRITE_TOOL, arguments: WRITE_INPUT },
        { name: CHARGE_TOOL, arguments: CHARGE_INPUT },
      ]
    : [{ name: EXTENSION_TOOL, arguments: EXTENSION_INPUT }];
  const diagnostics: string[] = [];
  let attempts = 0;

  const agent = new HarnessAgent({
    harness: createPi({
      providers: {
        local: {
          apiKey: 'placeholder-api-key',
          api: 'openai-completions',
          baseUrl: 'http://127.0.0.1:9',
          models: [
            {
              id: 'scripted',
              name: 'scripted',
              reasoning: false,
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 16_384,
            },
          ],
          streamSimple: (_model, context) =>
            scriptedModelResponse({
              context,
              plannedCalls,
              diagnostics,
              nextAttempt: () => ++attempts,
            }),
        },
      },
      ...(options.mcp
        ? {
            mcpServers: {
              notes: mcpServer(
                serverPath,
                effectPath,
                'notes',
                'write_note',
                workDir,
              ),
              billing: mcpServer(
                serverPath,
                effectPath,
                'billing',
                'charge',
                workDir,
              ),
            },
          }
        : {}),
      ...(options.extension
        ? { extensionFactories: [extensionFactory(effectPath)] }
        : {}),
    }),
    model: 'local/scripted',
    permissionMode: options.permissionMode,
    sandbox: {
      specificationVersion: 'harness-sandbox-v1',
      providerId: 'test-sandbox',
      createSession: async () => createSandboxSession({ workDir, homeDir }),
    },
  });
  const session = await agent.createSession({
    sessionId: `pi-mcp-approval-${path.basename(root)}`,
  });
  cleanups.push(async () => {
    await session.destroy().catch(() => {});
  });

  return {
    agent,
    session,
    effects: () => readEffects(effectPath),
    async consume(result: {
      fullStream: AsyncIterable<StreamPart>;
    }): Promise<{ parts: StreamPart[]; diagnostic: string }> {
      const parts: StreamPart[] = [];
      for await (const part of result.fullStream) {
        parts.push(part);
      }
      return {
        parts,
        diagnostic: diagnosticText({ diagnostics, parts, effectPath }),
      };
    },
  };
}

function mcpServer(
  serverPath: string,
  effectPath: string,
  serverName: string,
  toolName: string,
  cwd: string,
) {
  return {
    command: process.execPath,
    args: [serverPath],
    cwd,
    env: {
      MCP_EFFECT_PATH: effectPath,
      MCP_SERVER_NAME: serverName,
      MCP_TOOL_NAME: toolName,
    },
  };
}

function extensionFactory(effectPath: string): ExtensionFactory {
  return pi => {
    pi.registerTool({
      name: EXTENSION_TOOL,
      label: EXTENSION_TOOL,
      description: 'Deploy a release outside the sandbox.',
      parameters: Type.Object({ target: Type.String() }),
      async execute(_toolCallId, params) {
        appendEffect(effectPath, {
          tool: EXTENSION_TOOL,
          arguments: params as Record<string, unknown>,
        });
        return {
          content: [{ type: 'text', text: 'deployed' }],
          details: {},
        };
      },
    });
  };
}

function scriptedModelResponse(input: {
  readonly context: {
    readonly tools?: ReadonlyArray<{ readonly name: string }>;
    readonly messages?: ReadonlyArray<Record<string, unknown>>;
  };
  readonly plannedCalls: ReadonlyArray<{
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }>;
  readonly diagnostics: string[];
  readonly nextAttempt: () => number;
}) {
  const toolNames = (input.context.tools ?? []).map(tool => tool.name);
  const messages = input.context.messages ?? [];
  const pending = input.plannedCalls.filter(call =>
    needsAnotherAttempt(messages, call.name),
  );
  const attempt = input.nextAttempt();
  input.diagnostics.push(
    `attempt ${attempt} tools=${toolNames.join(',') || '(none)'} pending=${
      pending.map(call => call.name).join(',') || '(none)'
    }`,
  );

  if (pending.length === 0 || attempt > 40) {
    return assistantStream({
      content: [
        {
          type: 'text',
          text:
            pending.length === 0
              ? 'done'
              : `stopped before tools registered: ${toolNames.join(',')}`,
        },
      ],
      stopReason: 'stop',
    });
  }

  const missing = pending.filter(call => !toolNames.includes(call.name));
  const response = assistantStream({
    content: pending.map((call, index) => ({
      type: 'toolCall',
      id: `${call.name}-${attempt}-${index}`,
      name: call.name,
      arguments: call.arguments,
    })),
    stopReason: 'toolUse',
  });
  if (missing.length === 0) return response;

  return delayedStream(response, 250);
}

function needsAnotherAttempt(
  messages: ReadonlyArray<Record<string, unknown>>,
  toolName: string,
): boolean {
  const results = messages.filter(
    message => message.role === 'toolResult' && message.toolName === toolName,
  );
  const last = results.at(-1);
  if (last == null) return true;
  return /not found/i.test(messageText(last));
}

function messageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part =>
      part != null && typeof part === 'object' && 'text' in part
        ? String((part as { text?: unknown }).text ?? '')
        : '',
    )
    .join('');
}

function assistantStream(message: {
  readonly content: ReadonlyArray<Record<string, unknown>>;
  readonly stopReason: 'stop' | 'toolUse';
}) {
  const assistant = {
    role: 'assistant',
    content: message.content,
    api: 'openai-completions',
    provider: 'local',
    model: 'scripted',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: message.stopReason,
    timestamp: Date.now(),
  };
  return eventStream({ type: 'done', message: assistant }, assistant);
}

function delayedStream(
  stream: ReturnType<typeof eventStream>,
  delayMs: number,
) {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      yield* stream;
    },
    result: () => stream.result(),
  };
}

function eventStream(
  event: { readonly type: string; readonly message: unknown },
  result: unknown,
) {
  let delivered = false;
  return {
    async *[Symbol.asyncIterator]() {
      if (!delivered) {
        delivered = true;
        yield event;
      }
    },
    result: async () => result,
  };
}

function approvalFor(
  parts: readonly StreamPart[],
  toolName: string,
): ApprovalPart | undefined {
  return parts.find(
    (part): part is ApprovalPart =>
      part.type === 'tool-approval-request' &&
      part.toolCall?.toolName === toolName &&
      typeof part.approvalId === 'string',
  );
}

function inputOf(approval: ApprovalPart): Record<string, unknown> {
  const input = approval.toolCall.input;
  if (typeof input === 'string') {
    return JSON.parse(input) as Record<string, unknown>;
  }
  return input as Record<string, unknown>;
}

function expectEffects(
  actual: readonly Effect[],
  expected: readonly Effect[],
  diagnostic: string,
): void {
  const key = (effect: Effect) =>
    `${effect.server ?? ''}:${effect.tool}:${JSON.stringify(effect.arguments)}`;
  expect(
    [...actual].sort((left, right) => key(left).localeCompare(key(right))),
    diagnostic,
  ).toEqual(
    [...expected].sort((left, right) => key(left).localeCompare(key(right))),
  );
}

function readEffects(effectPath: string): Effect[] {
  if (!existsSync(effectPath)) return [];
  return readFileSync(effectPath, 'utf8')
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as Effect);
}

function appendEffect(effectPath: string, effect: Effect): void {
  writeFileSync(
    effectPath,
    `${readFileSync(effectPath, 'utf8')}${JSON.stringify(effect)}\n`,
  );
}

function diagnosticText(input: {
  readonly diagnostics: readonly string[];
  readonly parts: readonly StreamPart[];
  readonly effectPath: string;
}): string {
  const errors = input.parts
    .filter(part => part.type === 'error')
    .map(part => String(part.error));
  return [
    ...input.diagnostics,
    ...errors,
    `effects=${readFileSync(input.effectPath, 'utf8') || '(none)'}`,
    `parts=${input.parts.map(part => part.type).join(',')}`,
  ].join('\n');
}

function createSandboxSession(input: {
  readonly workDir: string;
  readonly homeDir: string;
}): HarnessV1NetworkSandboxSession {
  const sandbox = {
    id: 'sandbox',
    defaultWorkingDirectory: input.workDir,
    ports: [],
    destroy: async () => {},
    getPortEndpoint: () => {
      throw new Error('unused');
    },
    getPortUrl: () => {
      throw new Error('unused');
    },
    readBinaryFile: async ({ path: filePath }: { path: string }) => {
      try {
        return new Uint8Array(readFileSync(filePath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        }
        throw error;
      }
    },
    readTextFile: async ({ path: filePath }: { path: string }) => {
      try {
        return readFileSync(filePath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        }
        throw error;
      }
    },
    restricted: () => sandbox,
    run: async ({ command }: { command: string }) => ({
      stdout: command === 'printf "%s" "$HOME"' ? input.homeDir : '',
      stderr: '',
      exitCode: 0,
    }),
    stop: async () => {},
    writeBinaryFile: async () => {},
    writeTextFile: async () => {},
  };
  return sandbox as unknown as HarnessV1NetworkSandboxSession;
}

const MCP_SERVER_SOURCE = `import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const effectPath = process.env.MCP_EFFECT_PATH;
const serverName = process.env.MCP_SERVER_NAME;
const toolName = process.env.MCP_TOOL_NAME;
const supportedProtocols = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
];
const tool = {
  name: toolName,
  description: 'Record a side effect for ' + toolName,
  inputSchema: {
    type: 'object',
    properties: {
      note: { type: 'string' },
      code: { type: 'string' },
    },
  },
};

const send = message => {
  process.stdout.write(JSON.stringify(message) + '\\n');
};

createInterface({ input: process.stdin }).on('line', line => {
  if (line.trim() === '') return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id == null) return;

  if (request.method === 'initialize') {
    const offered = request.params && request.params.protocolVersion;
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: supportedProtocols.includes(offered)
          ? offered
          : '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: serverName, version: '0.0.0' },
      },
    });
    return;
  }

  if (request.method === 'ping') {
    send({ jsonrpc: '2.0', id: request.id, result: {} });
    return;
  }

  if (request.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: request.id, result: { tools: [tool] } });
    return;
  }

  if (request.method === 'tools/call') {
    const params = request.params ?? {};
    appendFileSync(
      effectPath,
      JSON.stringify({
        server: serverName,
        tool: params.name,
        arguments: params.arguments ?? {},
      }) + '\\n',
    );
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: { content: [{ type: 'text', text: 'ok' }] },
    });
    return;
  }

  send({
    jsonrpc: '2.0',
    id: request.id,
    error: { code: -32601, message: 'Method not found: ' + request.method },
  });
});
`;
