import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatAnthropic } from '@langchain/anthropic';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A resumed Deep Agents turn must enforce the permission mode and built-in
 * tool filter from that turn's start message. These tests drive the bridge's
 * real agent and fail while a cached agent keeps the first turn's gates.
 */

type StartMessage = {
  type: 'start';
  prompt: string;
  instructions: string;
  tools: [];
  model: string;
  permissionMode?: 'allow-all' | 'allow-edits' | 'allow-reads';
  builtinToolFiltering?:
    | { mode: 'allow'; toolNames: string[] }
    | { mode: 'deny'; toolNames: string[] };
};

type BridgeEvent = Record<string, unknown>;

type BridgeTurn = {
  emit: (event: BridgeEvent) => void;
  requestToolResult: (toolCallId: string) => Promise<{ output: unknown }>;
  requestToolApproval: (
    approvalId: string,
  ) => Promise<{ approved: boolean; reason?: string }>;
  abortSignal: AbortSignal;
};

const session = vi.hoisted(() => ({
  workdir: '',
  onStart: undefined as
    | ((start: StartMessage, turn: BridgeTurn) => Promise<void>)
    | undefined,
}));

const INSTRUCTIONS = 'Keep the session configuration stable.';
const MODEL = 'anthropic/claude-sonnet-4-5';
const SETUP_PROMPT = 'HARNESS_APPROVAL_PROBE:SETUP';
const FILES_PROMPT = 'HARNESS_APPROVAL_PROBE:FILES';
const WRITE_PROMPT = 'HARNESS_APPROVAL_PROBE:WRITE';
const EXECUTE_PROMPT = 'HARNESS_APPROVAL_PROBE:EXECUTE';
const TODOS_PROMPT = 'HARNESS_APPROVAL_PROBE:TODOS';
const TASK_PROMPT = 'HARNESS_APPROVAL_PROBE:TASK';
const FILTER_PROMPT = 'HARNESS_APPROVAL_PROBE:FILTER';
const WRITE_NAME = 'written-by-agent.txt';
const EDIT_NAME = 'edit-target.txt';
const EXECUTE_NAME = 'execute-marker.txt';
const WRITE_CONTENT = 'written-without-approval';
const EDIT_BEFORE = 'alpha';
const EDIT_AFTER = 'edited-without-approval';

vi.mock('@ai-sdk/harness/bridge', () => ({
  runBridge: async ({
    onStart,
  }: {
    onStart: (start: StartMessage, turn: BridgeTurn) => Promise<void>;
  }) => {
    session.onStart = onStart;
  },
}));

function toolCallsForPrompt(prompt: string, workdir: string) {
  const writePath = join(workdir, WRITE_NAME);
  const editPath = join(workdir, EDIT_NAME);
  if (prompt.includes(FILES_PROMPT) || prompt.includes(FILTER_PROMPT)) {
    return [
      toolCall('write_file', {
        file_path: writePath,
        content: WRITE_CONTENT,
      }),
      toolCall('edit_file', {
        file_path: editPath,
        old_string: EDIT_BEFORE,
        new_string: EDIT_AFTER,
      }),
      toolCall('execute', {
        command: `printf ${WRITE_CONTENT} > ${EXECUTE_NAME}`,
      }),
    ];
  }
  if (prompt.includes(WRITE_PROMPT)) {
    return [
      toolCall('write_file', {
        file_path: writePath,
        content: WRITE_CONTENT,
      }),
    ];
  }
  if (prompt.includes(EXECUTE_PROMPT)) {
    return [
      toolCall('execute', {
        command: `printf ${WRITE_CONTENT} > ${EXECUTE_NAME}`,
      }),
    ];
  }
  if (prompt.includes(TODOS_PROMPT)) {
    return [
      toolCall('write_todos', {
        todos: [{ content: 'unapproved todo', status: 'in_progress' }],
      }),
    ];
  }
  if (prompt.includes(TASK_PROMPT)) {
    return [
      toolCall('task', {
        description: 'unapproved subagent',
        subagent_type: 'general-purpose',
      }),
    ];
  }
  return [];
}

type ScriptMessage = {
  content?: unknown;
  tool_calls?: Array<{ name?: string }>;
  _getType?: () => string;
  getType?: () => string;
};

function messageType(message: ScriptMessage): string {
  if (typeof message._getType === 'function') return message._getType();
  if (typeof message.getType === 'function') return message.getType();
  return '';
}

function messageText(message: ScriptMessage): string {
  const { content } = message;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      if (typeof part === 'string') return part;
      if (
        part != null &&
        typeof part === 'object' &&
        'text' in part &&
        typeof part.text === 'string'
      ) {
        return part.text;
      }
      return '';
    })
    .join('');
}

function scriptedAiMessage(messages: ScriptMessage[]) {
  let lastHumanIndex = -1;
  for (let index = 0; index < messages.length; index++) {
    if (messageType(messages[index]) === 'human') lastHumanIndex = index;
  }
  const human = lastHumanIndex === -1 ? undefined : messages[lastHumanIndex];
  const subsequent =
    lastHumanIndex === -1 ? [] : messages.slice(lastHumanIndex + 1);
  const alreadyAttempted = subsequent.some(
    message =>
      messageType(message) === 'tool' ||
      (messageType(message) === 'ai' && (message.tool_calls?.length ?? 0) > 0),
  );
  const prompt = human == null ? '' : messageText(human);
  const toolCalls = alreadyAttempted
    ? []
    : toolCallsForPrompt(prompt, session.workdir);
  return new AIMessage({
    content: toolCalls.length === 0 ? 'done' : '',
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  });
}

let scriptedModelInstalled = false;

function installScriptedModel() {
  if (scriptedModelInstalled) return;
  scriptedModelInstalled = true;
  // The bridge and Deep Agents build a real ChatAnthropic. Keep that
  // construction, and replace only the provider call with the scripted turn.
  ChatAnthropic.prototype.invoke = function invoke(input, options) {
    this.disableStreaming = true;
    return BaseChatModel.prototype.invoke.call(this, input, options);
  };
  ChatAnthropic.prototype._generate = async function _generate(messages) {
    const message = scriptedAiMessage(messages as ScriptMessage[]);
    return {
      generations: [{ text: message.text, message }],
      llmOutput: {},
    };
  };
}

function toolCall(name: string, args: Record<string, unknown>) {
  return {
    id: `${name}-probe`,
    name,
    args,
    type: 'tool_call' as const,
  };
}

const originalArgv = [...process.argv];

describe('cached Deep Agents bridge permissions', () => {
  let workdir: string;
  let bridgeStateDir: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('ANTHROPIC_API_KEY', 'placeholder');
    installScriptedModel();
    session.onStart = undefined;
    workdir = await mkdtemp(join(tmpdir(), 'deepagents-approval-'));
    bridgeStateDir = await mkdtemp(join(tmpdir(), 'deepagents-bridge-state-'));
    session.workdir = workdir;
    process.argv.splice(
      0,
      process.argv.length,
      'node',
      'bridge.mjs',
      '--workdir',
      workdir,
      '--bridge-state-dir',
      bridgeStateDir,
    );
    await writeFile(join(workdir, EDIT_NAME), EDIT_BEFORE, 'utf8');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    process.argv.splice(0, process.argv.length, ...originalArgv);
    await rm(workdir, { recursive: true, force: true });
    await rm(bridgeStateDir, { recursive: true, force: true });
  });

  it('does not run write, edit, or shell tools when a resumed turn tightens allow-all to allow-reads', async () => {
    const { events, approvalSnapshots } = await runTurns([
      start(SETUP_PROMPT, { permissionMode: 'allow-all' }),
      start(FILES_PROMPT, { permissionMode: 'allow-reads' }),
    ]);

    expect(approvalTargets(events)).toEqual([
      'write_file',
      'edit_file',
      'execute',
    ]);
    expect(approvalSnapshots).toEqual([
      untouchedSnapshot(),
      untouchedSnapshot(),
      untouchedSnapshot(),
    ]);
    await expectWorkspaceUntouched(workdir);
    expect(executedToolResults(events)).toEqual([]);
  });

  it('does not run execute when a resumed turn tightens allow-all to allow-edits, and still allows writes', async () => {
    const { events, approvalSnapshots } = await runTurns([
      start(SETUP_PROMPT, { permissionMode: 'allow-all' }),
      start(WRITE_PROMPT, { permissionMode: 'allow-edits' }),
      start(EXECUTE_PROMPT, { permissionMode: 'allow-edits' }),
    ]);

    expect(approvalTargets(events)).toEqual(['execute']);
    expect(approvalSnapshots).toEqual([
      {
        write: WRITE_CONTENT,
        edit: EDIT_BEFORE,
        execute: undefined,
      },
    ]);
    expect(await readFile(join(workdir, WRITE_NAME), 'utf8')).toBe(
      WRITE_CONTENT,
    );
    expect(await readOptional(join(workdir, EXECUTE_NAME))).toBeUndefined();
    expect(executedToolResults(events).map(event => event.toolName)).toEqual([
      'write',
    ]);
  });

  it('does not run write_file when a resumed turn tightens allow-edits to allow-reads', async () => {
    const { events, approvalSnapshots } = await runTurns([
      start(SETUP_PROMPT, { permissionMode: 'allow-edits' }),
      start(WRITE_PROMPT, { permissionMode: 'allow-reads' }),
    ]);

    expect(approvalTargets(events)).toEqual(['write_file']);
    expect(approvalSnapshots).toEqual([untouchedSnapshot()]);
    expect(await readOptional(join(workdir, WRITE_NAME))).toBeUndefined();
    expect(executedToolResults(events)).toEqual([]);
  });

  it('does not run edit or shell tools when a resumed turn tightens allow-edits to allow-reads', async () => {
    const { events, approvalSnapshots } = await runTurns([
      start(SETUP_PROMPT, { permissionMode: 'allow-edits' }),
      start(FILES_PROMPT, { permissionMode: 'allow-reads' }),
    ]);

    expect(approvalTargets(events)).toEqual([
      'write_file',
      'edit_file',
      'execute',
    ]);
    expect(approvalSnapshots).toEqual([
      untouchedSnapshot(),
      untouchedSnapshot(),
      untouchedSnapshot(),
    ]);
    await expectWorkspaceUntouched(workdir);
  });

  it('does not run write_todos when a resumed turn tightens allow-all to allow-reads', async () => {
    const { events } = await runTurns([
      start(SETUP_PROMPT, { permissionMode: 'allow-all' }),
      start(TODOS_PROMPT, { permissionMode: 'allow-reads' }),
    ]);

    expect(approvalTargets(events)).toEqual(['write_todos']);
    expect(eventBlob(events)).not.toContain('Updated todo list');
    expect(executedToolResults(events)).toEqual([]);
  });

  it('does not run task when a resumed turn tightens allow-all to allow-reads', async () => {
    const { events } = await runTurns([
      start(SETUP_PROMPT, { permissionMode: 'allow-all' }),
      start(TASK_PROMPT, { permissionMode: 'allow-reads' }),
    ]);

    expect(approvalTargets(events)).toEqual(['task']);
    expect(executedToolResults(events)).toEqual([]);
  });

  it('does not run built-ins denied by a filtering policy added on a resumed turn', async () => {
    const { events } = await runTurns([
      start(SETUP_PROMPT, { permissionMode: 'allow-all' }),
      start(FILTER_PROMPT, {
        permissionMode: 'allow-all',
        builtinToolFiltering: {
          mode: 'deny',
          toolNames: ['write', 'edit', 'bash'],
        },
      }),
    ]);

    await expectWorkspaceUntouched(workdir);
    expect(denialTargets(events)).toEqual(['write', 'edit', 'bash']);
    expect(executedToolResults(events)).toEqual([]);
  });
});

function start(
  prompt: string,
  options: {
    permissionMode: NonNullable<StartMessage['permissionMode']>;
    builtinToolFiltering?: StartMessage['builtinToolFiltering'];
  },
): StartMessage {
  return {
    type: 'start',
    prompt,
    instructions: INSTRUCTIONS,
    tools: [],
    model: MODEL,
    permissionMode: options.permissionMode,
    ...(options.builtinToolFiltering
      ? { builtinToolFiltering: options.builtinToolFiltering }
      : {}),
  };
}

type WorkspaceSnapshot = {
  write: string | undefined;
  edit: string;
  execute: string | undefined;
};

async function runTurns(starts: StartMessage[]): Promise<{
  events: BridgeEvent[];
  approvalSnapshots: WorkspaceSnapshot[];
}> {
  await import('./index');
  const onStart = session.onStart;
  if (onStart == null)
    throw new Error('bridge did not register a turn handler');

  const events: BridgeEvent[] = [];
  const approvalSnapshots: WorkspaceSnapshot[] = [];
  for (const startMessage of starts) {
    await onStart(startMessage, {
      emit: event => {
        events.push(event);
      },
      requestToolResult: async () => ({ output: {} }),
      requestToolApproval: async () => {
        // Captured before the decision is returned, so a tool that already
        // ran cannot be hidden by a later denial.
        approvalSnapshots.push(await snapshotWorkspace(session.workdir));
        return { approved: false, reason: 'denied by test' };
      },
      abortSignal: new AbortController().signal,
    });
    events.push({ type: 'test-turn-end', prompt: startMessage.prompt });
  }
  return { events, approvalSnapshots };
}

function approvalTargets(events: BridgeEvent[]): string[] {
  const names: string[] = [];
  let pending: string | undefined;
  for (const event of events) {
    if (event.type === 'test-turn-end') pending = undefined;
    if (event.type === 'tool-call' && typeof event.nativeName === 'string') {
      pending = event.nativeName;
    }
    if (event.type === 'tool-approval-request' && pending != null) {
      names.push(pending);
      pending = undefined;
    }
  }
  return names;
}

function executedToolResults(events: BridgeEvent[]): BridgeEvent[] {
  const approved = new Set<string>();
  const results: BridgeEvent[] = [];
  for (const event of events) {
    if (
      event.type === 'tool-approval-request' &&
      typeof event.toolCallId === 'string'
    ) {
      approved.add(event.toolCallId);
    }
    if (event.type !== 'tool-result') continue;
    if (
      typeof event.toolCallId === 'string' &&
      approved.has(event.toolCallId)
    ) {
      continue;
    }
    if (isFilteringDenial(event)) continue;
    results.push(event);
  }
  return results;
}

function denialTargets(events: BridgeEvent[]): string[] {
  return events.filter(isFilteringDenial).map(event => String(event.toolName));
}

function isFilteringDenial(event: BridgeEvent): boolean {
  return (
    event.type === 'tool-result' &&
    eventText(event).includes(
      'is inactive due to the HarnessAgent tool filtering policy',
    )
  );
}

function eventBlob(events: BridgeEvent[]): string {
  return events.map(event => eventText(event)).join('\n');
}

function eventText(event: BridgeEvent): string {
  const { result } = event;
  if (typeof result === 'string') return result;
  if (result == null) return '';
  try {
    return JSON.stringify(result);
  } catch {
    return '';
  }
}

function untouchedSnapshot(): WorkspaceSnapshot {
  return { write: undefined, edit: EDIT_BEFORE, execute: undefined };
}

async function snapshotWorkspace(workdir: string): Promise<WorkspaceSnapshot> {
  return {
    write: await readOptional(join(workdir, WRITE_NAME)),
    edit: await readFile(join(workdir, EDIT_NAME), 'utf8'),
    execute: await readOptional(join(workdir, EXECUTE_NAME)),
  };
}

async function expectWorkspaceUntouched(workdir: string) {
  expect(await snapshotWorkspace(workdir)).toEqual(untouchedSnapshot());
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
