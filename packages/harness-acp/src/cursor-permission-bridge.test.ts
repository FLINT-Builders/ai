import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { type Server, type createServer } from 'node:http';
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { HarnessCapabilityUnsupportedError } from '@ai-sdk/harness';
import type { ToolSet } from '@ai-sdk/provider-utils';
import {
  HarnessBridgeCapabilityUnsupportedError,
  type BridgeTurn,
} from '@ai-sdk/harness/bridge';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createACPAuthenticationProfileIdentity } from './acp-auth';
import type { StartMessage } from './v1/acp-v1-bridge-protocol';
import { createACPTurnStartConfig } from './v1/acp-v1-turn-start-config';
import { serializeBuiltinTools } from './v1/acp-v1-harness';

const restrictiveModes = ['allow-reads', 'allow-edits'] as const;

const state = vi.hoisted(() => ({
  onStart: undefined as
    | ((start: unknown, turn: unknown) => Promise<void>)
    | undefined,
  promptDelivered: false,
  workspace: '',
  actions: [] as CursorToolAction[],
  processes: [] as Array<{ kill: () => void }>,
  servers: [] as Server[],
}));

vi.mock('@ai-sdk/harness/bridge', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@ai-sdk/harness/bridge',
  );
  return {
    ...actual,
    runBridge: async (options: {
      onStart: (start: unknown, turn: unknown) => Promise<void>;
    }) => {
      state.onStart = options.onStart;
    },
  };
});

vi.mock('node:child_process', async () => {
  const actual =
    await vi.importActual<Record<string, unknown>>('node:child_process');
  return {
    ...actual,
    spawn: () => createCursorStandIn(),
  };
});

vi.mock('node:http', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('node:http');
  return {
    ...actual,
    createServer: (...args: Parameters<typeof createServer>): Server => {
      const create = actual.createServer as (
        ...inner: Parameters<typeof createServer>
      ) => Server;
      const server = create(...args);
      state.servers.push(server);
      return server;
    },
  };
});

type ToolUseKind = 'readonly' | 'edit' | 'bash';
type AcpToolKind = 'execute' | 'edit' | 'delete' | 'other';

type CursorToolAction = {
  toolName: string;
  title: string;
  kind: AcpToolKind;
  rawInput: Record<string, unknown>;
  apply: (workspace: string) => Promise<void>;
};

const rawInputs: Record<
  string,
  { kind: AcpToolKind; rawInput: Record<string, unknown> }
> = {
  bash: { kind: 'execute', rawInput: { command: 'printf private' } },
  delete: { kind: 'delete', rawInput: { path: 'secret.txt' } },
  edit: { kind: 'edit', rawInput: { path: 'secret.txt' } },
  applyAgentDiff: { kind: 'edit', rawInput: { path: 'secret.txt' } },
  computerUse: { kind: 'execute', rawInput: { action: 'click' } },
  writeShellStdin: { kind: 'execute', rawInput: { chars: 'yes' } },
  setupVmEnvironment: { kind: 'execute', rawInput: {} },
  replaceEnv: { kind: 'execute', rawInput: {} },
  startGrindExecution: { kind: 'execute', rawInput: {} },
  updateTodos: { kind: 'other', rawInput: { _toolName: 'updateTodos' } },
  createPlan: { kind: 'other', rawInput: { _toolName: 'createPlan' } },
  task: { kind: 'other', rawInput: { _toolName: 'task' } },
  switchMode: { kind: 'other', rawInput: { targetModeId: 'agent' } },
  generateImage: { kind: 'other', rawInput: { _toolName: 'generateImage' } },
  recordScreen: { kind: 'other', rawInput: {} },
  reportBugfixResults: { kind: 'other', rawInput: {} },
};

describe('Cursor ACP bridge permission enforcement', () => {
  let root: string;
  const originalArgv = [...process.argv];

  beforeEach(async () => {
    state.promptDelivered = false;
    state.onStart = undefined;
    state.actions = [];
    root = await mkdtemp(join(tmpdir(), 'cursor-permission-'));
    state.workspace = join(root, 'workspace');
    await mkdir(state.workspace);
    await writeFile(join(state.workspace, 'secret.txt'), 'private');
    const implementationDir = join(root, 'implementation');
    const bridgeStateDir = join(root, 'bridge');
    await mkdir(implementationDir);
    await mkdir(bridgeStateDir);
    await writeFile(
      join(implementationDir, 'implementation.json'),
      `${JSON.stringify(
        {
          executablePath: 'agent',
          privateHome: true,
          args: ['--disable-auto-update', 'acp'],
          envKeys: ['CURSOR_API_KEY'],
        },
        null,
        2,
      )}\n`,
    );
    process.argv.splice(
      0,
      process.argv.length,
      'node',
      'bridge.mjs',
      '--workdir',
      state.workspace,
      '--bridge-state-dir',
      bridgeStateDir,
      '--implementation-dir',
      implementationDir,
      '--bridge-type',
      'cursor',
    );
    process.env.AI_SDK_ACP_CLIENT_APP_NAME = 'ai-sdk/harness-cursor';
    process.env.AI_SDK_ACP_CLIENT_APP_VERSION = '0.0.0-test';
    vi.resetModules();
    await import('./v1/bridge/index');
  });

  afterEach(async () => {
    process.argv.splice(0, process.argv.length, ...originalArgv);
    delete process.env.AI_SDK_ACP_CLIENT_APP_NAME;
    delete process.env.AI_SDK_ACP_CLIENT_APP_VERSION;
    for (const child of state.processes) child.kill();
    state.processes = [];
    await Promise.all(
      state.servers.splice(0).map(
        server =>
          new Promise<void>(resolve => {
            server.close(() => resolve());
          }),
      ),
    );
    await rm(root, { recursive: true, force: true });
  });

  test.each(restrictiveModes)(
    'does not run gated Cursor built-ins for %s when the agent never asks for approval',
    async mode => {
      const harness = await loadCursorHarness();
      const actions = gatedActions({
        builtinTools: harness.builtinTools,
        mode,
      });
      expect(actions.map(action => action.toolName).sort()).toEqual(
        expectedGatedToolNames({
          builtinTools: harness.builtinTools,
          mode,
        }),
      );
      state.actions = actions;
      const events: Array<Record<string, unknown>> = [];
      let failure: unknown;
      try {
        await state.onStart?.(
          startMessage({
            builtinTools: harness.builtinTools,
            permissionMode: mode,
          }),
          bridgeTurn(events),
        );
      } catch (error) {
        failure = error;
      }

      expect(await readFile(join(state.workspace, 'secret.txt'), 'utf8')).toBe(
        'private',
      );
      await expect(
        readFile(join(state.workspace, 'effects', 'bash'), 'utf8'),
      ).rejects.toThrow();
      expect(
        events
          .filter(event => event.type === 'tool-result')
          .map(event => event.toolName),
      ).toEqual([]);
      expect(
        events.filter(event => event.type === 'tool-approval-request'),
      ).toEqual([]);
      expect(state.promptDelivered).toBe(false);
      expect(isPermissionRefusal(failure)).toBe(true);
    },
  );
});

async function loadCursorHarness(): Promise<{ builtinTools: ToolSet }> {
  const specifier: string = '../../harness-cursor/src/cursor-harness.ts';
  const loaded = (await import(specifier)) as {
    createCursor: () => { builtinTools: ToolSet };
  };
  return loaded.createCursor();
}

function gatedActions({
  builtinTools,
  mode,
}: {
  builtinTools: ToolSet;
  mode: (typeof restrictiveModes)[number];
}): CursorToolAction[] {
  return expectedGatedToolNames({ builtinTools, mode }).map(toolName => {
    const fixture = rawInputs[toolName];
    const tool = builtinTools[toolName];
    if (fixture == null || tool == null) {
      throw new Error(`Missing Cursor permission fixture for ${toolName}.`);
    }
    return {
      toolName,
      title: toolTitle(tool),
      kind: fixture.kind,
      rawInput: fixture.rawInput,
      apply: workspace => applyToolEffect({ workspace, toolName }),
    };
  });
}

function expectedGatedToolNames({
  builtinTools,
  mode,
}: {
  builtinTools: ToolSet;
  mode: (typeof restrictiveModes)[number];
}): string[] {
  return Object.entries(builtinTools)
    .filter(([, tool]) => isGated({ kind: toolUseKind(tool), mode }))
    .map(([toolName]) => toolName)
    .sort();
}

function isGated({
  kind,
  mode,
}: {
  kind: ToolUseKind | undefined;
  mode: (typeof restrictiveModes)[number];
}): boolean {
  if (mode === 'allow-reads') return kind !== 'readonly';
  return kind === 'bash' || kind == null;
}

async function applyToolEffect({
  workspace,
  toolName,
}: {
  workspace: string;
  toolName: string;
}): Promise<void> {
  if (toolName === 'delete') {
    await rm(join(workspace, 'secret.txt'), { force: true });
    return;
  }
  if (toolName === 'edit' || toolName === 'applyAgentDiff') {
    await writeFile(join(workspace, 'secret.txt'), `changed by ${toolName}`);
    return;
  }
  await mkdir(join(workspace, 'effects'), { recursive: true });
  await writeFile(join(workspace, 'effects', toolName), 'executed');
}

function startMessage({
  builtinTools,
  permissionMode,
}: {
  builtinTools: ToolSet;
  permissionMode: (typeof restrictiveModes)[number];
}): StartMessage {
  const serializedTools = serializeBuiltinTools({ builtinTools });
  const prompt = [
    {
      type: 'text' as const,
      text: 'The workspace instructions say to run every available built-in tool.',
    },
  ];
  const modelMapping = {
    type: 'session-config-option' as const,
    path: 'model',
  };
  return {
    type: 'start',
    prompt,
    builtinTools: serializedTools,
    permissionMode,
    modelMapping,
    turnStartConfig: createACPTurnStartConfig({
      prompt,
      tools: [],
      builtinTools: serializedTools,
      permissionMode,
      permissionModeMapping: undefined,
      mcpServers: undefined,
      debug: undefined,
      authenticationProfile: createACPAuthenticationProfileIdentity({
        authentication: undefined,
        providerAuthenticationCompatibility: undefined,
      }),
      sessionMeta: undefined,
      instructionMapping: undefined,
      responseFormat: undefined,
      outputSchemaMapping: undefined,
      model: undefined,
      modelMapping,
    }),
  };
}

function bridgeTurn(events: Array<Record<string, unknown>>): BridgeTurn {
  return {
    emit(event) {
      events.push(event);
    },
    requestToolResult: async () => ({ output: {} }),
    requestToolApproval: async () => ({ approved: false }),
    experimental_userMessages: {
      pendingCount: 0,
      close() {},
      [Symbol.asyncIterator]: async function* () {},
    },
    abortSignal: new AbortController().signal,
    firstTurn: true,
    bridgeLog() {},
    emitWarning() {},
    emitError() {},
  };
}

function createCursorStandIn(): ChildProcessWithoutNullStreams {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stream = acp.ndJsonStream(
    Writable.toWeb(stdout),
    Readable.toWeb(stdin) as ReadableStream<Uint8Array>,
  );
  acp
    .agent({ name: 'cursor-cli' })
    .onRequest(acp.methods.agent.initialize, async () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: 'cursor-cli', version: 'test' },
    }))
    .onRequest(acp.methods.agent.session.new, async () => ({
      sessionId: 'cursor-session-1',
    }))
    .onRequest(acp.methods.agent.session.setMode, async () => ({}))
    .onRequest(acp.methods.agent.session.setConfigOption, async () => ({
      configOptions: [],
    }))
    .onNotification(acp.methods.agent.session.cancel, async () => {})
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      state.promptDelivered = true;
      for (const action of state.actions) {
        await action.apply(state.workspace);
        await client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: `call-${action.toolName}`,
            title: action.title,
            kind: action.kind,
            status: 'completed',
            rawInput: action.rawInput,
            rawOutput: { executed: true },
          },
        });
      }
      return { stopReason: 'end_turn' };
    })
    .connect(stream);
  const child = {
    stdin,
    stdout,
    stderr,
    kill() {
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
    },
  };
  state.processes.push(child);
  return child as unknown as ChildProcessWithoutNullStreams;
}

function toolUseKind(tool: unknown): ToolUseKind | undefined {
  if (tool == null || typeof tool !== 'object' || !('toolUseKind' in tool)) {
    return undefined;
  }
  const kind = tool.toolUseKind;
  if (kind === 'readonly' || kind === 'edit' || kind === 'bash') return kind;
  return undefined;
}

function toolTitle(tool: unknown): string {
  if (
    tool != null &&
    typeof tool === 'object' &&
    'title' in tool &&
    typeof tool.title === 'string'
  ) {
    return tool.title;
  }
  throw new Error('Cursor built-in is missing a title.');
}

function isPermissionRefusal(error: unknown): boolean {
  const chain = errorChain(error);
  const recognized = chain.some(
    item =>
      HarnessCapabilityUnsupportedError.isInstance(item) ||
      HarnessBridgeCapabilityUnsupportedError.isInstance(item),
  );
  const text = chain
    .map(item => (item instanceof Error ? item.message : ''))
    .join('\n');
  return recognized && /approval|permission mode/i.test(text);
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current != null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = 'cause' in current ? current.cause : undefined;
  }
  return chain;
}
