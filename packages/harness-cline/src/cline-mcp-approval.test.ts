import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  HarnessV1NetworkSandboxSession,
  HarnessV1PermissionMode,
  HarnessV1StreamPart,
} from '@ai-sdk/harness';
import type { AgentModel, AgentModelRequest } from '@cline/agents';
import type * as ClineCore from '@cline/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCline } from './cline-harness';

/**
 * Stands in for the language model only. It copies tool calls out of the
 * latest user message and does not apply any approval policy. Every step
 * after that — tool policies, `requestToolApproval`, and MCP `tools/call` —
 * is the real Cline runtime and the real `@cline/core` 0.0.79 stdio client.
 *
 * Prompt lines:
 *   MCP <tool> <json arguments>
 *   builtin <tool> <json arguments>
 *   host <tool> <json arguments>
 */
const modelScript = vi.hoisted(() => {
  const model: AgentModel = {
    stream(request: AgentModelRequest) {
      return (async function* () {
        const last = request.messages.at(-1);
        if (last == null || last.role !== 'user') {
          yield { type: 'text-delta', text: 'done' };
          yield { type: 'finish', reason: 'stop' };
          return;
        }
        const text = last.content
          .filter(part => part.type === 'text')
          .map(part => part.text)
          .join('\n');
        let index = 0;
        for (const line of text.split('\n')) {
          const match = /^(MCP|builtin|host) ([^\s]+) (\{.*\})$/.exec(
            line.trim(),
          );
          if (match == null) continue;
          const kind = match[1];
          const tool = match[2];
          const json = match[3];
          if (kind == null || tool == null || json == null) continue;
          const toolName = kind === 'MCP' ? `tracker__${tool}` : tool;
          yield {
            type: 'tool-call-delta' as const,
            index,
            toolCallId: `call-${index}-${toolName}`,
            toolName,
            input: JSON.parse(json) as unknown,
          };
          index += 1;
        }
        if (index === 0) {
          yield { type: 'text-delta', text: 'done' };
        }
        yield {
          type: 'finish',
          reason: index === 0 ? 'stop' : 'tool-calls',
        };
      })();
    },
  };
  return { model };
});

vi.mock('@cline/core', async importOriginal => {
  const original = await importOriginal<typeof ClineCore>();
  return {
    ...original,
    Llms: {
      ...original.Llms,
      createGateway: () => ({
        createAgentModel: () => modelScript.model,
      }),
    },
  };
});

const serverPath = fileURLToPath(
  new URL('./__fixtures__/cline-mcp-approval-server.mjs', import.meta.url),
);

interface McpInvocation {
  tool: string;
  arguments: Record<string, unknown>;
}

interface ObservedApproval {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: string;
}

const sessions: Array<{ destroy: () => Promise<void> }> = [];

afterEach(async () => {
  const open = sessions.splice(0);
  await Promise.all(open.map(session => session.destroy()));
});

describe('Cline MCP tool approval', () => {
  it.each(['allow-reads', 'allow-edits'] as const)(
    'withholds side-effecting MCP tools until the app approves each call in %s mode',
    async permissionMode => {
      const logPath = createLogPath();
      const parts: HarnessV1StreamPart[] = [];
      const seenApprovals: ObservedApproval[] = [];
      let turnSettled = false;
      const session = await startSession({
        permissionMode,
        logPath,
      });

      const prompt = [
        'MCP create_issue {"title":"injected-from-readme"}',
        'MCP delete_issue {"id":"ISSUE-9"}',
        'MCP send_message {"text":"sent-from-untrusted-page"}',
      ].join('\n');
      const control = await session.doPromptTurn({
        skills: [],
        tools: [],
        prompt,
        emit: part => {
          parts.push(part);
        },
      });
      void Promise.resolve(control.done).then(() => {
        turnSettled = true;
      });

      const create = await nextApproval({
        logPath,
        parts,
        seenApprovals,
        isSettled: () => turnSettled,
      });
      expect(readInvocations(logPath)).toEqual([]);
      expect(create.toolName).toBe('tracker__create_issue');
      expect(JSON.parse(create.input)).toEqual({
        title: 'injected-from-readme',
      });
      await control.submitToolApproval?.({
        approvalId: create.approvalId,
        approved: true,
      });

      const remove = await nextApproval({
        logPath,
        parts,
        seenApprovals,
        isSettled: () => turnSettled,
      });
      expect(readInvocations(logPath)).toEqual([]);
      expect(remove.toolName).toBe('tracker__delete_issue');
      expect(JSON.parse(remove.input)).toEqual({ id: 'ISSUE-9' });
      await control.submitToolApproval?.({
        approvalId: remove.approvalId,
        approved: false,
        reason: 'denied',
      });

      const send = await nextApproval({
        logPath,
        parts,
        seenApprovals,
        isSettled: () => turnSettled,
      });
      expect(readInvocations(logPath)).toEqual([]);
      expect(send.toolName).toBe('tracker__send_message');
      expect(JSON.parse(send.input)).toEqual({
        text: 'sent-from-untrusted-page',
      });
      await control.submitToolApproval?.({
        approvalId: send.approvalId,
        approved: true,
      });

      await control.done;
      expect(invocationsByTool(logPath)).toEqual({
        create_issue: { title: 'injected-from-readme' },
        send_message: { text: 'sent-from-untrusted-page' },
      });
      expect(readInvocations(logPath).map(call => call.tool)).not.toContain(
        'delete_issue',
      );
    },
    20_000,
  );

  it('runs the same MCP tools without an approval prompt in allow-all mode', async () => {
    const logPath = createLogPath();
    const parts: HarnessV1StreamPart[] = [];
    const session = await startSession({
      permissionMode: 'allow-all',
      logPath,
    });
    const control = await session.doPromptTurn({
      skills: [],
      tools: [],
      prompt: [
        'MCP create_issue {"title":"allowed"}',
        'MCP delete_issue {"id":"ISSUE-1"}',
        'MCP send_message {"text":"allowed"}',
      ].join('\n'),
      emit: part => {
        parts.push(part);
      },
    });

    await control.done;
    expect(parts.some(part => part.type === 'tool-approval-request')).toBe(
      false,
    );
    expect(invocationsByTool(logPath)).toEqual({
      create_issue: { title: 'allowed' },
      delete_issue: { id: 'ISSUE-1' },
      send_message: { text: 'allowed' },
    });
  }, 20_000);

  it('still asks before the write built-in in allow-reads mode', async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const parts: HarnessV1StreamPart[] = [];
    const seenApprovals: ObservedApproval[] = [];
    let turnSettled = false;
    const session = await startSession({
      permissionMode: 'allow-reads',
      onWrite: (path, content) => {
        writes.push({ path, content });
      },
    });
    const control = await session.doPromptTurn({
      skills: [],
      tools: [],
      prompt: 'builtin write {"file_path":"note.txt","content":"unapproved"}',
      emit: part => {
        parts.push(part);
      },
    });
    void Promise.resolve(control.done).then(() => {
      turnSettled = true;
    });

    const approval = await nextApproval({
      parts,
      seenApprovals,
      isSettled: () => turnSettled,
      sideEffect: () => writes.length > 0,
      sideEffectLabel: `writeTextFile ${JSON.stringify(writes)}`,
    });
    expect(writes).toEqual([]);
    expect(approval.toolName).toBe('write');
    expect(JSON.parse(approval.input)).toEqual({
      file_path: 'note.txt',
      content: 'unapproved',
    });

    await control.submitToolApproval?.({
      approvalId: approval.approvalId,
      approved: false,
      reason: 'denied',
    });
    await control.done;
    expect(writes).toEqual([]);
  }, 20_000);

  it('still asks before the bash built-in in allow-edits mode', async () => {
    const commands: string[] = [];
    const parts: HarnessV1StreamPart[] = [];
    const seenApprovals: ObservedApproval[] = [];
    let turnSettled = false;
    const session = await startSession({
      permissionMode: 'allow-edits',
      onCommand: command => {
        commands.push(command);
      },
    });
    const control = await session.doPromptTurn({
      skills: [],
      tools: [],
      prompt: 'builtin bash {"command":"rm -rf note.txt"}',
      emit: part => {
        parts.push(part);
      },
    });
    void Promise.resolve(control.done).then(() => {
      turnSettled = true;
    });

    const approval = await nextApproval({
      parts,
      seenApprovals,
      isSettled: () => turnSettled,
      sideEffect: () =>
        commands.some(command => command.includes('rm -rf note.txt')),
      sideEffectLabel: `bash ${JSON.stringify(commands)}`,
    });
    expect(commands.some(command => command.includes('rm -rf note.txt'))).toBe(
      false,
    );
    expect(approval.toolName).toBe('bash');
    expect(JSON.parse(approval.input)).toEqual({
      command: 'rm -rf note.txt',
    });

    await control.submitToolApproval?.({
      approvalId: approval.approvalId,
      approved: false,
      reason: 'denied',
    });
    await control.done;
    expect(commands.some(command => command.includes('rm -rf note.txt'))).toBe(
      false,
    );
  }, 20_000);

  it('leaves host AI SDK tools for the framework instead of approving them as MCP tools', async () => {
    const parts: HarnessV1StreamPart[] = [];
    let turnSettled = false;
    const session = await startSession({
      permissionMode: 'allow-reads',
    });
    const control = await session.doPromptTurn({
      skills: [],
      tools: [
        {
          name: 'host_lookup',
          description: 'Host-executed lookup.',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ],
      prompt: 'host host_lookup {"query":"from-readme"}',
      emit: part => {
        parts.push(part);
      },
    });
    void Promise.resolve(control.done).then(() => {
      turnSettled = true;
    });

    const toolCall = await waitForToolCall({
      parts,
      toolName: 'host_lookup',
      isSettled: () => turnSettled,
    });
    await delay(50);
    expect(parts.some(part => part.type === 'tool-approval-request')).toBe(
      false,
    );
    expect(turnSettled).toBe(false);
    expect(JSON.parse(toolCall.input)).toEqual({ query: 'from-readme' });

    await control.submitToolResult({
      toolCallId: toolCall.toolCallId,
      output: { ok: true },
    });
    await control.done;
    expect(parts.some(part => part.type === 'tool-approval-request')).toBe(
      false,
    );
  }, 20_000);
});

async function startSession(input: {
  permissionMode: HarnessV1PermissionMode;
  logPath?: string;
  onWrite?: (path: string, content: string) => void;
  onCommand?: (command: string) => void;
}) {
  const sandbox = createSandbox({
    ...(input.onWrite ? { onWrite: input.onWrite } : {}),
    ...(input.onCommand ? { onCommand: input.onCommand } : {}),
  });
  const harness = createCline({
    providerId: 'openai',
    apiKey: 'test-api-key',
    maxIterations: 4,
    ...(input.logPath
      ? {
          mcpServers: {
            tracker: {
              command: process.execPath,
              args: [serverPath, input.logPath],
            },
          },
        }
      : {}),
  });
  const session = await harness.doStart({
    sessionId: `session-${Math.random().toString(36).slice(2)}`,
    sandboxSession: sandbox,
    sessionWorkDir: '/sandbox/work',
    permissionMode: input.permissionMode,
  });
  sessions.push({
    destroy: async () => {
      await session.doDestroy();
    },
  });
  return session;
}

function createSandbox(input: {
  onWrite?: (path: string, content: string) => void;
  onCommand?: (command: string) => void;
}): HarnessV1NetworkSandboxSession {
  const sandbox = {
    defaultWorkingDirectory: '/sandbox',
    description: 'Test sandbox',
    destroy: vi.fn(async () => {}),
    getPortUrl: vi.fn(),
    readBinaryFile: vi.fn(async () => undefined),
    readTextFile: vi.fn(async () => 'original'),
    restricted: vi.fn(() => sandbox),
    run: vi.fn(async ({ command }: { command: string }) => {
      if (command.includes('$HOME')) {
        return { stdout: '/sandbox/home', stderr: '', exitCode: 0 };
      }
      input.onCommand?.(command);
      if (command.includes('rm -rf note.txt')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return {
        stdout: '/sandbox/work/note.txt\n',
        stderr: '',
        exitCode: 0,
      };
    }),
    stop: vi.fn(async () => {}),
    writeBinaryFile: vi.fn(async () => {}),
    writeTextFile: vi.fn(
      async ({ path, content }: { path: string; content: string }) => {
        input.onWrite?.(path, content);
      },
    ),
  };
  return sandbox as unknown as HarnessV1NetworkSandboxSession;
}

function createLogPath(): string {
  return join(
    mkdtempSync(join(tmpdir(), 'cline-mcp-approval-')),
    'calls.ndjson',
  );
}

function readInvocations(logPath: string): McpInvocation[] {
  let text = '';
  try {
    text = readFileSync(logPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return text
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as McpInvocation);
}

function invocationsByTool(
  logPath: string,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    readInvocations(logPath).map(call => [call.tool, call.arguments]),
  );
}

async function nextApproval(input: {
  parts: HarnessV1StreamPart[];
  seenApprovals: ObservedApproval[];
  isSettled: () => boolean;
  logPath?: string;
  sideEffect?: () => boolean;
  sideEffectLabel?: string;
}): Promise<ObservedApproval> {
  const started = Date.now();
  while (Date.now() - started < 8_000) {
    if (input.logPath != null) {
      const calls = readInvocations(input.logPath);
      if (calls.length > 0) {
        throw new Error(
          `MCP tool ran before approval: ${JSON.stringify(calls)}`,
        );
      }
    }
    if (input.sideEffect?.()) {
      throw new Error(
        `Side effect landed before approval: ${input.sideEffectLabel ?? ''}`,
      );
    }
    const approval = takeApproval(input.parts, input.seenApprovals);
    if (approval != null) return approval;
    if (input.isSettled()) {
      throw new Error(
        `Turn finished without an approval request: ${JSON.stringify(input.parts)}`,
      );
    }
    await delay(15);
  }
  throw new Error(
    `Timed out waiting for tool approval: ${JSON.stringify(input.parts)}`,
  );
}

function takeApproval(
  parts: HarnessV1StreamPart[],
  seenApprovals: ObservedApproval[],
): ObservedApproval | undefined {
  for (const part of parts) {
    if (part.type !== 'tool-approval-request') continue;
    if (seenApprovals.some(seen => seen.approvalId === part.approvalId)) {
      continue;
    }
    const toolCall = parts.find(
      candidate =>
        candidate.type === 'tool-call' &&
        candidate.toolCallId === part.toolCallId,
    );
    if (toolCall == null || toolCall.type !== 'tool-call') continue;
    const approval = {
      approvalId: part.approvalId,
      toolCallId: part.toolCallId,
      toolName: toolCall.toolName,
      input: toolCall.input,
    };
    seenApprovals.push(approval);
    return approval;
  }
  return undefined;
}

async function waitForToolCall(input: {
  parts: HarnessV1StreamPart[];
  toolName: string;
  isSettled: () => boolean;
}): Promise<Extract<HarnessV1StreamPart, { type: 'tool-call' }>> {
  const started = Date.now();
  while (Date.now() - started < 8_000) {
    const toolCall = input.parts.find(
      part => part.type === 'tool-call' && part.toolName === input.toolName,
    );
    if (toolCall?.type === 'tool-call') return toolCall;
    if (input.isSettled()) {
      throw new Error(
        `Turn finished before ${input.toolName}: ${JSON.stringify(input.parts)}`,
      );
    }
    await delay(15);
  }
  throw new Error(
    `Timed out waiting for ${input.toolName}: ${JSON.stringify(input.parts)}`,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}
