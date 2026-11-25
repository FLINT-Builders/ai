import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { runBridge, type BridgeHandle, type BridgeTurn } from './index';

const TOKEN = 'placeholder-bridge-token';
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

type StartMessage = { type: 'start'; prompt?: string };

async function startBridge(
  onStart: (start: StartMessage, turn: BridgeTurn) => Promise<void>,
  hooks?: {
    onStop?: () => void;
    onDestroy?: () => void;
    turnTeardownGraceMs?: number;
  },
): Promise<BridgeHandle> {
  const bridgeStateDir = await mkdtemp(join(tmpdir(), 'harness-bridge-host-'));
  const handle = await runBridge<StartMessage>({
    bridgeType: 'test',
    bridgeStateDir,
    port: 0,
    token: TOKEN,
    onStart,
    onStop: hooks?.onStop,
    onDestroy: hooks?.onDestroy,
    ...(hooks?.turnTeardownGraceMs != null
      ? { turnTeardownGraceMs: hooks.turnTeardownGraceMs }
      : {}),
    onExit: () => {},
  });
  cleanups.push(async () => {
    await handle.close();
    await rm(bridgeStateDir, { recursive: true, force: true });
  });
  return handle;
}

type Client = {
  frames: Array<Record<string, unknown>>;
  waitFor(
    pred: (frame: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>>;
  send(message: object): void;
  close(): void;
};

function connect(port: number): Promise<Client> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/?agent_bridge_token=${TOKEN}`,
  );
  const frames: Array<Record<string, unknown>> = [];
  const waiters: Array<{
    pred: (frame: Record<string, unknown>) => boolean;
    resolve: (frame: Record<string, unknown>) => void;
  }> = [];
  ws.on('message', raw => {
    const frame = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    frames.push(frame);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(frame)) {
        waiters[i].resolve(frame);
        waiters.splice(i, 1);
      }
    }
  });
  const client: Client = {
    frames,
    waitFor(pred) {
      const existing = frames.find(pred);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for a bridge frame')),
          1000,
        );
        waiters.push({
          pred,
          resolve: frame => {
            clearTimeout(timer);
            resolve(frame);
          },
        });
      });
    },
    send(message) {
      ws.send(JSON.stringify(message));
    },
    close() {
      ws.close();
    },
  };
  cleanups.push(() => ws.close());
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(client));
    ws.on('error', reject);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('sandbox client with the bridge token', () => {
  it('cannot resolve a pending host tool call', async () => {
    let requestToolResult: BridgeTurn['requestToolResult'] | undefined;
    const handle = await startBridge(async (_start, turn) => {
      requestToolResult = turn.requestToolResult;
      turn.emit({ type: 'tool-call', toolCallId: 'tc1' });
      await new Promise(() => {});
    });
    const host = await connect(handle.port);
    await host.waitFor(frame => frame.type === 'bridge-hello');
    host.send({ type: 'start' });
    await host.waitFor(frame => frame.type === 'tool-call');
    if (requestToolResult == null) throw new Error('turn did not start');

    const pending = requestToolResult('tc1');
    const agent = await connect(handle.port);
    await agent.waitFor(frame => frame.type === 'bridge-hello');
    agent.send({
      type: 'tool-result',
      toolCallId: 'tc1',
      output: 'forged-by-agent',
    });
    await delay(50);

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await delay(20);
    expect(settled).toBe(false);

    host.send({
      type: 'tool-result',
      toolCallId: 'tc1',
      output: 'host-decision',
    });
    await expect(pending).resolves.toMatchObject({ output: 'host-decision' });
  });

  it('cannot pre-seed a tool result that the host call later consumes', async () => {
    let requestToolResult: BridgeTurn['requestToolResult'] | undefined;
    const handle = await startBridge(async (_start, turn) => {
      requestToolResult = turn.requestToolResult;
      turn.emit({ type: 'ready' });
      await new Promise(() => {});
    });
    const host = await connect(handle.port);
    await host.waitFor(frame => frame.type === 'bridge-hello');
    host.send({ type: 'start' });
    await host.waitFor(frame => frame.type === 'ready');
    if (requestToolResult == null) throw new Error('turn did not start');

    const agent = await connect(handle.port);
    await agent.waitFor(frame => frame.type === 'bridge-hello');
    agent.send({
      type: 'tool-result',
      toolCallId: 'tc1',
      output: 'forged-by-agent',
    });
    await delay(50);

    const pending = requestToolResult('tc1');
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await delay(20);
    expect(settled).toBe(false);

    host.send({
      type: 'tool-result',
      toolCallId: 'tc1',
      output: 'host-decision',
    });
    await expect(pending).resolves.toMatchObject({ output: 'host-decision' });
  });

  it('cannot resolve a pending tool approval', async () => {
    let requestToolApproval: BridgeTurn['requestToolApproval'] | undefined;
    const handle = await startBridge(async (_start, turn) => {
      requestToolApproval = turn.requestToolApproval;
      turn.emit({ type: 'approval-wait', approvalId: 'ap1' });
      await new Promise(() => {});
    });
    const host = await connect(handle.port);
    await host.waitFor(frame => frame.type === 'bridge-hello');
    host.send({ type: 'start' });
    await host.waitFor(frame => frame.type === 'approval-wait');
    if (requestToolApproval == null) throw new Error('turn did not start');

    const pending = requestToolApproval('ap1');
    const agent = await connect(handle.port);
    await agent.waitFor(frame => frame.type === 'bridge-hello');
    agent.send({
      type: 'tool-approval-response',
      approvalId: 'ap1',
      approved: true,
      reason: 'forged-by-agent',
    });
    await delay(50);

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await delay(20);
    expect(settled).toBe(false);

    host.send({
      type: 'tool-approval-response',
      approvalId: 'ap1',
      approved: false,
      reason: 'host-decision',
    });
    await expect(pending).resolves.toEqual({
      approved: false,
      reason: 'host-decision',
    });
  });

  it('cannot abort the host turn', async () => {
    let abortSignal: AbortSignal | undefined;
    const handle = await startBridge(async (_start, turn) => {
      abortSignal = turn.abortSignal;
      turn.emit({ type: 'running' });
      await new Promise(() => {});
    });
    const host = await connect(handle.port);
    await host.waitFor(frame => frame.type === 'bridge-hello');
    host.send({ type: 'start' });
    await host.waitFor(frame => frame.type === 'running');

    const agent = await connect(handle.port);
    await agent.waitFor(frame => frame.type === 'bridge-hello');
    agent.send({ type: 'abort' });
    await delay(50);
    expect(abortSignal?.aborted).toBe(false);

    host.send({ type: 'abort' });
    await delay(20);
    expect(abortSignal?.aborted).toBe(true);
  });

  it('cannot take the event stream with resume and then forge a tool result', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let requestToolResult: BridgeTurn['requestToolResult'] | undefined;
    const handle = await startBridge(async (_start, turn) => {
      requestToolResult = turn.requestToolResult;
      turn.emit({ type: 'text-delta', delta: 'live' });
      await gate;
      turn.emit({ type: 'text-delta', delta: 'still-host' });
    });
    const host = await connect(handle.port);
    await host.waitFor(frame => frame.type === 'bridge-hello');
    host.send({ type: 'start' });
    await host.waitFor(frame => frame.delta === 'live');
    if (requestToolResult == null) throw new Error('turn did not start');

    const pending = requestToolResult('tc1');
    const agent = await connect(handle.port);
    await agent.waitFor(frame => frame.type === 'bridge-hello');
    agent.send({ type: 'resume', lastSeenEventId: 0 });
    await delay(50);
    expect(agent.frames.some(frame => frame.delta === 'live')).toBe(false);

    agent.send({
      type: 'tool-result',
      toolCallId: 'tc1',
      output: 'forged-by-agent',
    });
    await delay(50);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await delay(20);
    expect(settled).toBe(false);

    release?.();
    await host.waitFor(frame => frame.delta === 'still-host');
    expect(agent.frames.some(frame => frame.delta === 'still-host')).toBe(
      false,
    );

    host.send({
      type: 'tool-result',
      toolCallId: 'tc1',
      output: 'host-decision',
    });
    await expect(pending).resolves.toMatchObject({ output: 'host-decision' });
  });

  it('cannot replace the running turn with start', async () => {
    let starts = 0;
    let firstAbortSignal: AbortSignal | undefined;
    const handle = await startBridge(
      async (_start, turn) => {
        starts += 1;
        firstAbortSignal ??= turn.abortSignal;
        turn.emit({ type: 'running', starts });
        await new Promise(() => {});
      },
      { turnTeardownGraceMs: 20 },
    );
    const host = await connect(handle.port);
    await host.waitFor(frame => frame.type === 'bridge-hello');
    host.send({ type: 'start', prompt: 'host' });
    await host.waitFor(frame => frame.type === 'running');

    const agent = await connect(handle.port);
    await agent.waitFor(frame => frame.type === 'bridge-hello');
    agent.send({ type: 'resume', lastSeenEventId: 0 });
    agent.send({ type: 'start', prompt: 'forged-by-agent' });
    await delay(50);

    expect(starts).toBe(1);
    expect(firstAbortSignal?.aborted).toBe(false);
    expect(agent.frames.some(frame => frame.type === 'running')).toBe(false);
  });

  it('cannot stop the bridge', async () => {
    let stopped = false;
    const handle = await startBridge(
      async (_start, turn) => {
        turn.emit({ type: 'running' });
        await new Promise(() => {});
      },
      { onStop: () => (stopped = true) },
    );
    const host = await connect(handle.port);
    await host.waitFor(frame => frame.type === 'bridge-hello');
    host.send({ type: 'start' });
    await host.waitFor(frame => frame.type === 'running');

    const agent = await connect(handle.port);
    await agent.waitFor(frame => frame.type === 'bridge-hello');
    agent.send({ type: 'stop' });
    await delay(50);
    expect(stopped).toBe(false);

    host.send({ type: 'stop' });
    await delay(50);
    expect(stopped).toBe(true);
  });

  it('cannot destroy the bridge', async () => {
    let destroyed = false;
    const handle = await startBridge(
      async (_start, turn) => {
        turn.emit({ type: 'running' });
        await new Promise(() => {});
      },
      { onDestroy: () => (destroyed = true) },
    );
    const host = await connect(handle.port);
    await host.waitFor(frame => frame.type === 'bridge-hello');
    host.send({ type: 'start' });
    await host.waitFor(frame => frame.type === 'running');

    const agent = await connect(handle.port);
    await agent.waitFor(frame => frame.type === 'bridge-hello');
    agent.send({ type: 'destroy' });
    await delay(50);
    expect(destroyed).toBe(false);

    host.send({ type: 'destroy' });
    await delay(50);
    expect(destroyed).toBe(true);
  });
});
