import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * OpenCode 1.18.23 asks before webfetch, then fetches only after the reply.
 * An `always` reply also stores pattern `*` (`always: ['*']` / `save: ['*']`),
 * so later fetches of other URLs never ask again. These tests require a host
 * decision for that exact action and a `once` reply for the same request.
 */

const bridgeMock = vi.hoisted(() => ({
  start: undefined as unknown,
  turn: undefined as unknown,
}));

const sdkMock = vi.hoisted(() => ({
  client: undefined as unknown,
}));

const createOpencodeServerMock = vi.hoisted(() =>
  vi.fn(async (_options: Record<string, unknown>) => ({
    url: 'http://127.0.0.1:4096',
    close: vi.fn(),
  })),
);

vi.mock('@ai-sdk/harness/bridge', () => ({
  runBridge: vi.fn(async (options: unknown) => {
    const bridge = options as {
      onStart(start: unknown, turn: unknown): Promise<void>;
    };
    await bridge.onStart(bridgeMock.start, bridgeMock.turn);
    return { close: vi.fn() };
  }),
}));

vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencodeServer: createOpencodeServerMock,
  createOpencodeClient: vi.fn(() => sdkMock.client),
}));

vi.mock('./tool-relay', () => ({
  startAuthorizedToolRelay: vi.fn(async () => ({
    authorizeToolCall: vi.fn(),
    close: vi.fn(),
    port: 4097,
  })),
}));

vi.mock('./opencode-path', () => ({
  prependOpenCodeBinToPath: vi.fn(),
}));

type PermissionMode = 'allow-reads' | 'allow-edits';

type ApprovalDecision = { approved: boolean; reason?: string };

type LegacyPermissionEvent = {
  version: 'v1';
  id: string;
  permission: string;
  patterns: string[];
  callID: string;
  always?: string[];
};

type V2PermissionEvent = {
  version: 'v2';
  id: string;
  action: string;
  resources: string[];
  callID: string;
  save?: string[];
};

type PermissionEvent = LegacyPermissionEvent | V2PermissionEvent;

const METADATA_URL = 'http://169.254.169.254/latest/meta-data/';
const EXFIL_URL = 'https://attacker.example/collect?data=workspace-file';

function createUserMessages() {
  let closed = false;
  const iteratorWaiters: Array<(result: IteratorResult<never>) => void> = [];
  return {
    pendingCount: 0,
    close: vi.fn(() => {
      closed = true;
      while (iteratorWaiters.length > 0) {
        iteratorWaiters.shift()!({ done: true, value: undefined });
      }
    }),
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          closed
            ? Promise.resolve({ done: true as const, value: undefined })
            : new Promise<IteratorResult<never>>(resolve => {
                iteratorWaiters.push(resolve);
              }),
      };
    },
  };
}

function setBridgeArgv(workdir: string) {
  process.argv.length = 0;
  process.argv.push(
    process.execPath,
    'opencode-bridge',
    '--workdir',
    workdir,
    '--bridge-state-dir',
    `${workdir}-state`,
    '--bootstrap-dir',
    `${workdir}-bootstrap`,
  );
}

function permissionEvent(event: PermissionEvent): Record<string, unknown> {
  if (event.version === 'v1') {
    return {
      type: 'permission.asked',
      properties: {
        id: event.id,
        sessionID: 'session-1',
        permission: event.permission,
        patterns: event.patterns,
        metadata: { url: event.patterns[0] },
        always: event.always ?? ['*'],
        tool: { messageID: 'message-1', callID: event.callID },
      },
    };
  }
  return {
    type: 'permission.v2.asked',
    properties: {
      id: event.id,
      sessionID: 'session-1',
      action: event.action,
      resources: event.resources,
      save: event.save ?? ['*'],
      metadata: { url: event.resources[0] },
      source: { type: 'tool', messageID: 'message-1', callID: event.callID },
    },
  };
}

async function runPermissionTurn({
  permissionMode,
  workdir,
  events,
  decisions,
}: {
  permissionMode: PermissionMode;
  workdir: string;
  events: PermissionEvent[];
  decisions: Record<string, ApprovalDecision>;
}) {
  const emitted: Array<Record<string, unknown>> = [];
  const order: string[] = [];
  const legacyReply = vi.fn((args: { requestID: string; reply: string }) => {
    order.push(`v1:${args.requestID}:${args.reply}`);
    return Promise.resolve({ data: {} });
  });
  const v2Reply = vi.fn((args: { requestID: string; reply: string }) => {
    order.push(`v2:${args.requestID}:${args.reply}`);
    return Promise.resolve({ data: {} });
  });
  const requestToolApproval = vi.fn(async (approvalId: string) => {
    order.push(`approval:${approvalId}`);
    const decision = decisions[approvalId];
    if (decision == null) {
      throw new Error(`Unexpected approval request ${approvalId}`);
    }
    return decision;
  });

  bridgeMock.start = {
    type: 'start',
    operation: 'prompt',
    prompt: 'Read the notes and fetch the page they name.',
    permissionMode,
  };
  bridgeMock.turn = {
    emit: (event: Record<string, unknown>) => emitted.push(event),
    requestToolResult: vi.fn(),
    requestToolApproval,
    experimental_userMessages: createUserMessages(),
    abortSignal: new AbortController().signal,
    firstTurn: true,
    bridgeLog: vi.fn(),
    emitWarning: vi.fn(),
    emitError: vi.fn(),
  };
  sdkMock.client = {
    mcp: { status: vi.fn(async () => ({ data: {} })) },
    session: {
      create: vi.fn(async () => ({ data: { id: 'session-1' } })),
      get: vi.fn(async () => ({ data: {} })),
      messages: vi.fn(async () => ({ data: [] })),
      promptAsync: vi.fn(async () => ({ data: {} })),
    },
    permission: { reply: legacyReply },
    event: {
      subscribe: vi.fn(async () => ({
        stream: {
          async *[Symbol.asyncIterator]() {
            for (const event of events) yield permissionEvent(event);
            yield {
              type: 'session.next.step.failed',
              properties: {
                sessionID: 'session-1',
                error: 'end permission test turn',
              },
            };
          },
        },
      })),
    },
    v2: {
      session: {
        context: vi.fn(async () => ({ data: [] })),
        permission: { reply: v2Reply },
        switchModel: vi.fn(async () => ({ data: {} })),
      },
    },
  };
  setBridgeArgv(workdir);
  await import('./index');
  return { emitted, order, legacyReply, v2Reply, requestToolApproval };
}

function replyFor(
  event: PermissionEvent,
  legacyReply: ReturnType<typeof vi.fn>,
  v2Reply: ReturnType<typeof vi.fn>,
) {
  const mock = event.version === 'v1' ? legacyReply : v2Reply;
  const call = mock.mock.calls.find(
    (args: unknown[]) =>
      (args[0] as { requestID?: string }).requestID === event.id,
  );
  return call?.[0] as
    | { requestID: string; reply: string; message?: string; sessionID?: string }
    | undefined;
}

describe('OpenCode webfetch permission approval', () => {
  const originalArgv = [...process.argv];
  const tempDirectories: string[] = [];
  let workdir = '';

  afterEach(() => {
    process.argv.length = 0;
    for (const arg of originalArgv) process.argv.push(arg);
    for (const directory of tempDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
    vi.resetModules();
    createOpencodeServerMock.mockClear();
    vi.unstubAllEnvs();
  });

  function createWorkdir(): string {
    const directory = mkdtempSync(path.join(tmpdir(), 'opencode-webfetch-'));
    tempDirectories.push(directory);
    workdir = path.join(directory, 'workspace');
    mkdirSync(workdir);
    writeFileSync(path.join(workdir, 'notes.txt'), 'workspace notes');
    return workdir;
  }

  it.each(['allow-reads', 'allow-edits'] as const)(
    'asks the host before webfetch and replies once for that url in %s',
    async permissionMode => {
      const root = createWorkdir();
      const workspaceFile = path.join(root, 'notes.txt');
      const metadata: LegacyPermissionEvent = {
        version: 'v1',
        id: 'per-metadata',
        permission: 'webfetch',
        patterns: [METADATA_URL],
        callID: 'call-metadata',
        always: ['*'],
      };
      const exfil: V2PermissionEvent = {
        version: 'v2',
        id: 'per-exfil',
        action: 'webfetch',
        resources: [EXFIL_URL],
        callID: 'call-exfil',
        save: ['*'],
      };
      const workspaceRead: LegacyPermissionEvent = {
        version: 'v1',
        id: 'per-read',
        permission: 'read',
        patterns: [workspaceFile],
        callID: 'call-read',
        always: [workspaceFile],
      };

      const { emitted, order, legacyReply, v2Reply, requestToolApproval } =
        await runPermissionTurn({
          permissionMode,
          workdir: root,
          events: [workspaceRead, metadata, exfil],
          decisions: {
            'per-metadata': { approved: true },
            'per-exfil': { approved: false, reason: 'network fetch denied' },
          },
        });

      expect(createOpencodeServerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            permission: expect.objectContaining({ webfetch: 'ask' }),
          }),
        }),
      );

      expect(replyFor(workspaceRead, legacyReply, v2Reply)).toMatchObject({
        requestID: 'per-read',
        directory: root,
        reply: 'always',
      });
      expect(requestToolApproval).not.toHaveBeenCalledWith('per-read');

      expect(emitted).toContainEqual({
        type: 'tool-approval-request',
        approvalId: 'per-metadata',
        toolCallId: 'call-metadata',
      });
      expect(order.indexOf('approval:per-metadata')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('approval:per-metadata')).toBeLessThan(
        order.indexOf('v1:per-metadata:once'),
      );
      expect(replyFor(metadata, legacyReply, v2Reply)).toEqual({
        requestID: 'per-metadata',
        directory: root,
        reply: 'once',
      });

      expect(emitted).toContainEqual({
        type: 'tool-approval-request',
        approvalId: 'per-exfil',
        toolCallId: 'call-exfil',
      });
      expect(order.indexOf('approval:per-exfil')).toBeLessThan(
        order.indexOf('v2:per-exfil:reject'),
      );
      expect(replyFor(exfil, legacyReply, v2Reply)).toEqual({
        sessionID: 'session-1',
        requestID: 'per-exfil',
        reply: 'reject',
        message: 'network fetch denied',
      });

      const replies = [...legacyReply.mock.calls, ...v2Reply.mock.calls].map(
        call => (call[0] as { reply: string; requestID: string }).reply,
      );
      expect(replies.filter(reply => reply === 'always')).toEqual(['always']);
    },
  );

  it.each(['allow-reads', 'allow-edits'] as const)(
    'does not let approval of one webfetch url authorize a different url in %s',
    async permissionMode => {
      const root = createWorkdir();
      const first: LegacyPermissionEvent = {
        version: 'v1',
        id: 'per-first',
        permission: 'webfetch',
        patterns: [METADATA_URL],
        callID: 'call-first',
        always: ['*'],
      };
      const second: LegacyPermissionEvent = {
        version: 'v1',
        id: 'per-second',
        permission: 'webfetch',
        patterns: [EXFIL_URL],
        callID: 'call-second',
        always: ['*'],
      };
      const { legacyReply, v2Reply } = await runPermissionTurn({
        permissionMode,
        workdir: root,
        events: [first, second],
        decisions: {
          'per-first': { approved: true },
          'per-second': { approved: true },
        },
      });

      expect(replyFor(first, legacyReply, v2Reply)).toEqual({
        requestID: 'per-first',
        directory: root,
        reply: 'once',
      });
      expect(replyFor(second, legacyReply, v2Reply)).toEqual({
        requestID: 'per-second',
        directory: root,
        reply: 'once',
      });
      expect(legacyReply).not.toHaveBeenCalledWith(
        expect.objectContaining({ reply: 'always' }),
      );
    },
  );

  it.each(['read', 'glob', 'grep', 'list'] as const)(
    'rejects a %s permission whose resource is a url',
    async action => {
      const root = createWorkdir();
      const workspaceFile = path.join(root, 'notes.txt');
      const urlOnly: LegacyPermissionEvent = {
        version: 'v1',
        id: `per-${action}-url`,
        permission: action,
        patterns: [EXFIL_URL],
        callID: `call-${action}-url`,
      };
      const mixed: LegacyPermissionEvent = {
        version: 'v1',
        id: `per-${action}-mixed`,
        permission: action,
        patterns: [workspaceFile, METADATA_URL],
        callID: `call-${action}-mixed`,
      };
      const { legacyReply, v2Reply, requestToolApproval } =
        await runPermissionTurn({
          permissionMode: 'allow-reads',
          workdir: root,
          events: [urlOnly, mixed],
          decisions: {},
        });

      for (const event of [urlOnly, mixed]) {
        expect(replyFor(event, legacyReply, v2Reply)).toMatchObject({
          requestID: event.id,
          reply: 'reject',
        });
        expect(requestToolApproval).not.toHaveBeenCalledWith(event.id);
      }
      expect(legacyReply).not.toHaveBeenCalledWith(
        expect.objectContaining({ reply: 'always' }),
      );
    },
  );

  it('matches the permission action exactly', async () => {
    const root = createWorkdir();
    const workspaceFile = path.join(root, 'notes.txt');
    const events: LegacyPermissionEvent[] = [
      {
        version: 'v1',
        id: 'per-not-webfetch',
        permission: 'notwebfetch',
        patterns: [EXFIL_URL],
        callID: 'call-not-webfetch',
      },
      {
        version: 'v1',
        id: 'per-pread',
        permission: 'pread',
        patterns: [workspaceFile],
        callID: 'call-pread',
      },
      {
        version: 'v1',
        id: 'per-grepping',
        permission: 'grepping',
        patterns: [workspaceFile],
        callID: 'call-grepping',
      },
      {
        version: 'v1',
        id: 'per-globbing',
        permission: 'globbing',
        patterns: [workspaceFile],
        callID: 'call-globbing',
      },
      {
        version: 'v1',
        id: 'per-listing',
        permission: 'listing',
        patterns: [workspaceFile],
        callID: 'call-listing',
      },
      {
        version: 'v1',
        id: 'per-writeup',
        permission: 'writeup',
        patterns: [workspaceFile],
        callID: 'call-writeup',
      },
      {
        version: 'v1',
        id: 'per-editing',
        permission: 'editing',
        patterns: [workspaceFile],
        callID: 'call-editing',
      },
    ];
    const decisions: Record<string, ApprovalDecision> = {};
    for (const event of events) {
      if (event.id === 'per-not-webfetch') continue;
      decisions[event.id] = { approved: true };
    }

    const { legacyReply, v2Reply, requestToolApproval } =
      await runPermissionTurn({
        permissionMode: 'allow-edits',
        workdir: root,
        events,
        decisions,
      });

    expect(replyFor(events[0]!, legacyReply, v2Reply)).toMatchObject({
      requestID: 'per-not-webfetch',
      reply: 'reject',
    });
    expect(requestToolApproval).not.toHaveBeenCalledWith('per-not-webfetch');

    for (const event of events.slice(1)) {
      expect(requestToolApproval).toHaveBeenCalledWith(event.id);
      expect(replyFor(event, legacyReply, v2Reply)).toEqual({
        requestID: event.id,
        directory: root,
        reply: 'once',
      });
    }
    expect(legacyReply).not.toHaveBeenCalledWith(
      expect.objectContaining({ reply: 'always' }),
    );
  });
});
