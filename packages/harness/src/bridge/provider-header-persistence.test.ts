import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { runBridge, type BridgeHandle } from './index';

const TOKEN = 'test-token';
const PROVIDER_HEADER_VALUE = 'placeholder-provider-header';
const ROUTING_HEADER_VALUE = 'placeholder-routing-header';
const CUSTOM_HEADER_VALUE = 'placeholder-custom-header';
const SECOND_PROVIDER_HEADER_VALUE = 'placeholder-provider-header-turn-two';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('persisted bridge start config', () => {
  it('omits provider headers from the sandbox start files on every turn', async () => {
    const bridgeStateDir = await mkdtemp(
      join(tmpdir(), 'harness-header-persist-'),
    );
    cleanups.push(() => rm(bridgeStateDir, { recursive: true, force: true }));
    const handle = await runBridge<{ type: 'start' }>({
      bridgeType: 'codex',
      bridgeStateDir,
      port: 0,
      token: TOKEN,
      onStart: async () => {},
      onExit: () => {},
    });
    cleanups.push(() => handle.close());

    const client = await connect(handle);
    client.send(
      JSON.stringify({
        type: 'start',
        prompt: 'first turn',
        headers: {
          Authorization: `Bearer ${PROVIDER_HEADER_VALUE}`,
          'x-tenant': ROUTING_HEADER_VALUE,
        },
        env: {
          ANTHROPIC_CUSTOM_HEADERS: `x-provider: ${CUSTOM_HEADER_VALUE}`,
        },
      }),
    );

    const firstStart = await readPersistedStart({
      bridgeStateDir,
      fileName: 'start-config.json',
      prompt: 'first turn',
    });
    const firstRerun = await readPersistedStart({
      bridgeStateDir,
      fileName: 'rerun-start-config.json',
      prompt: 'first turn',
    });
    expectNoProviderHeader(firstStart);
    expectNoProviderHeader(firstRerun);

    client.send(
      JSON.stringify({
        type: 'start',
        prompt: 'second turn',
        headers: {
          Authorization: `Bearer ${SECOND_PROVIDER_HEADER_VALUE}`,
        },
        env: {
          ANTHROPIC_CUSTOM_HEADERS: `x-provider: ${CUSTOM_HEADER_VALUE}`,
        },
      }),
    );

    const secondStart = await readPersistedStart({
      bridgeStateDir,
      fileName: 'start-config.json',
      prompt: 'second turn',
    });
    const frozenRerun = await readFile(
      join(bridgeStateDir, 'rerun-start-config.json'),
      'utf8',
    );
    expectNoProviderHeader(secondStart);
    expectNoProviderHeader(frozenRerun);
    expect(frozenRerun).toContain('first turn');
  });
});

function expectNoProviderHeader(serialized: string): void {
  expect(serialized).not.toContain(PROVIDER_HEADER_VALUE);
  expect(serialized).not.toContain(ROUTING_HEADER_VALUE);
  expect(serialized).not.toContain(CUSTOM_HEADER_VALUE);
  expect(serialized).not.toContain(SECOND_PROVIDER_HEADER_VALUE);
  const parsed = JSON.parse(serialized) as {
    headers?: Record<string, string>;
    env?: Record<string, string>;
  };
  expect(parsed.headers).toBeUndefined();
  expect(parsed.env?.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
}

async function readPersistedStart({
  bridgeStateDir,
  fileName,
  prompt,
}: {
  bridgeStateDir: string;
  fileName: string;
  prompt: string;
}): Promise<string> {
  const path = join(bridgeStateDir, fileName);
  const deadline = Date.now() + 3_000;
  let latest = '';
  while (Date.now() < deadline) {
    latest = await readFile(path, 'utf8').catch(() => '');
    if (latest.includes(prompt)) return latest;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(
    `${fileName} was not persisted with the turn prompt. Last contents: ${latest}`,
  );
}

function connect(handle: BridgeHandle): Promise<WebSocket> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${handle.port}/?agent_bridge_token=${TOKEN}`,
  );
  cleanups.push(() => ws.close());
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
