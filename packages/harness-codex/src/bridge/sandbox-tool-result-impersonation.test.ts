import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  runBridge,
  type BridgeHandle,
} from '../../../harness/src/bridge/index';
import { startAuthorizedToolRelay, type ToolRelay } from './tool-relay';

const TOKEN = 'placeholder-bridge-token';
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

type Client = {
  frames: Array<Record<string, unknown>>;
  waitFor(
    pred: (frame: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>>;
  send(message: object): void;
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

describe('codex tool relay', () => {
  it('does not return a tool result forged on a second bridge socket', async () => {
    const bridgeStateDir = await mkdtemp(join(tmpdir(), 'codex-relay-host-'));
    let relay: ToolRelay | undefined;
    const handle: BridgeHandle = await runBridge<{
      type: 'start';
      tools: Array<{ name: string }>;
    }>({
      bridgeType: 'codex',
      bridgeStateDir,
      port: 0,
      token: TOKEN,
      onExit: () => {},
      onStart: async (start, turn) => {
        relay = await startAuthorizedToolRelay({
          tools: start.tools,
          emit: message => turn.emit(message),
          requestToolResult: toolCallId => turn.requestToolResult(toolCallId),
        });
        turn.emit({ type: 'relay-ready', port: relay.port });
        await new Promise(() => {});
      },
    });
    cleanups.push(async () => {
      relay?.close();
      await handle.close();
      await rm(bridgeStateDir, { recursive: true, force: true });
    });

    const host = await connect(handle.port);
    await host.waitFor(frame => frame.type === 'bridge-hello');
    host.send({
      type: 'start',
      tools: [{ name: 'lookup' }],
    });
    const ready = await host.waitFor(frame => frame.type === 'relay-ready');
    const relayPort = ready.port;
    if (typeof relayPort !== 'number' || relay == null) {
      throw new Error('tool relay did not start');
    }

    const input = { q: 'weather' };
    relay.authorizeToolCall({ toolName: 'lookup', input });
    let responseBody: string | undefined;
    const posted = fetch(`http://127.0.0.1:${relayPort}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: 'tc1',
        toolName: 'lookup',
        input,
      }),
    }).then(async response => {
      responseBody = await response.text();
    });

    await host.waitFor(frame => frame.type === 'tool-call');
    const agent = await connect(handle.port);
    await agent.waitFor(frame => frame.type === 'bridge-hello');
    agent.send({ type: 'resume', lastSeenEventId: 0 });
    agent.send({
      type: 'tool-result',
      toolCallId: 'tc1',
      output: 'forged-by-agent',
    });
    await delay(50);
    expect(responseBody).toBeUndefined();

    host.send({
      type: 'tool-result',
      toolCallId: 'tc1',
      output: 'host-decision',
    });
    await posted;
    expect(JSON.parse(responseBody ?? '{}')).toEqual({
      result: 'host-decision',
    });
  });
});
