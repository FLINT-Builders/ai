import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';
import { runBridge } from '@ai-sdk/harness/bridge';
import { afterEach, expect, it } from 'vitest';
import { createCodex } from './codex-harness';

const TOKEN = 'test-token';
const HOST_API_KEY = 'placeholder-host-api-key';
const PROVIDER_HEADER_VALUE = 'placeholder-provider-header';
const ROUTING_HEADER_VALUE = 'placeholder-routing-header';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

it('persists Codex turn headers inside the sandbox after credential brokering', async () => {
  const bridge = await startBridge();
  const spawnEnvs: Array<Record<string, string | undefined>> = [];
  const session = await createCodex({
    auth: { OPENAI_API_KEY: HOST_API_KEY },
    port: bridge.port,
    portEndpoint: { url: bridge.url },
    mintBridgeToken: () => TOKEN,
  }).doStart({
    sessionId: 'header-persist',
    headers: {
      Authorization: `Bearer ${PROVIDER_HEADER_VALUE}`,
      'x-tenant': ROUTING_HEADER_VALUE,
    },
    sandboxSession: fakeSandbox({
      bridgeUrl: bridge.url,
      spawnEnvs,
    }),
    sessionWorkDir: '/vercel/sandbox/codex-header-persist',
  });
  cleanups.push(() => session.doDestroy());

  const control = await session.doPromptTurn({
    skills: [],
    tools: [],
    prompt: 'first turn',
    emit: () => {},
  });
  void Promise.resolve(control.done).catch(() => {});

  const startConfig = await readPersistedStart({
    bridgeStateDir: bridge.bridgeStateDir,
    fileName: 'start-config.json',
    prompt: 'first turn',
  });
  const rerunConfig = await readPersistedStart({
    bridgeStateDir: bridge.bridgeStateDir,
    fileName: 'rerun-start-config.json',
    prompt: 'first turn',
  });

  expect(spawnEnvs[0]?.CODEX_API_KEY).not.toBe(HOST_API_KEY);
  expect(JSON.stringify(spawnEnvs[0])).not.toContain(HOST_API_KEY);
  expectNoProviderHeader(startConfig);
  expectNoProviderHeader(rerunConfig);

  const second = await session.doPromptTurn({
    skills: [],
    tools: [],
    prompt: 'second turn',
    emit: () => {},
  });
  void Promise.resolve(second.done).catch(() => {});

  const secondStart = await readPersistedStart({
    bridgeStateDir: bridge.bridgeStateDir,
    fileName: 'start-config.json',
    prompt: 'second turn',
  });
  const frozenRerun = await readFile(
    join(bridge.bridgeStateDir, 'rerun-start-config.json'),
    'utf8',
  );
  expectNoProviderHeader(secondStart);
  expectNoProviderHeader(frozenRerun);
});

it('persists Codex rerun headers inside the sandbox after credential brokering', async () => {
  const bridge = await startBridge();
  let endpointCalls = 0;
  const session = await createCodex({
    auth: { OPENAI_API_KEY: HOST_API_KEY },
    mintBridgeToken: () => TOKEN,
  }).doStart({
    sessionId: 'header-persist-rerun',
    headers: {
      Authorization: `Bearer ${PROVIDER_HEADER_VALUE}`,
      'x-tenant': ROUTING_HEADER_VALUE,
    },
    continueFrom: {
      type: 'continue-turn',
      harnessId: 'codex',
      specificationVersion: 'harness-v1',
      data: {
        bridge: {
          port: 1,
          token: TOKEN,
          lastSeenEventId: 0,
          sandboxId: 'test-sandbox',
        },
      },
    },
    sandboxSession: fakeSandbox({
      bridgeUrl: bridge.url,
      spawnEnvs: [],
      getPortEndpoint: async () => {
        endpointCalls += 1;
        if (endpointCalls === 1) {
          throw new Error('bridge attach unavailable');
        }
        return { url: bridge.url };
      },
    }),
    sessionWorkDir: '/vercel/sandbox/codex-header-persist-rerun',
  });
  cleanups.push(() => session.doDestroy());

  const control = await session.doContinueTurn({
    skills: [],
    tools: [],
    emit: () => {},
  });
  void Promise.resolve(control.done).catch(() => {});

  const startConfig = await readPersistedStart({
    bridgeStateDir: bridge.bridgeStateDir,
    fileName: 'start-config.json',
    prompt: 'Continue.',
  });
  const rerunConfig = await readPersistedStart({
    bridgeStateDir: bridge.bridgeStateDir,
    fileName: 'rerun-start-config.json',
    prompt: 'Continue.',
  });
  expectNoProviderHeader(startConfig);
  expectNoProviderHeader(rerunConfig);
});

function expectNoProviderHeader(serialized: string): void {
  expect(serialized).not.toContain(PROVIDER_HEADER_VALUE);
  expect(serialized).not.toContain(ROUTING_HEADER_VALUE);
  expect(serialized).not.toContain(HOST_API_KEY);
  const parsed = JSON.parse(serialized) as {
    headers?: Record<string, string>;
  };
  expect(parsed.headers).toBeUndefined();
}

async function startBridge(): Promise<{
  port: number;
  url: string;
  bridgeStateDir: string;
  close: () => Promise<void>;
}> {
  const bridgeStateDir = await mkdtemp(join(tmpdir(), 'codex-header-persist-'));
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
  return {
    port: handle.port,
    url: `ws://127.0.0.1:${handle.port}/`,
    bridgeStateDir,
    close: () => handle.close(),
  };
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

function textStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (text.length > 0) {
        controller.enqueue(new TextEncoder().encode(text));
      }
      controller.close();
    },
  });
}

function fakeSandbox({
  bridgeUrl,
  spawnEnvs,
  getPortEndpoint,
}: {
  bridgeUrl: string;
  spawnEnvs: Array<Record<string, string | undefined>>;
  getPortEndpoint?: HarnessV1NetworkSandboxSession['getPortEndpoint'];
}): HarnessV1NetworkSandboxSession {
  const session = {
    run: async ({ command }: { command: string }) => ({
      exitCode: 0,
      stdout:
        command === 'pwd'
          ? '/vercel/sandbox\n'
          : command === 'printf "%s" "$HOME"'
            ? '/home/vercel-sandbox'
            : '',
      stderr: '',
    }),
    readTextFile: async () => null,
    writeTextFile: async () => {},
    spawn: async ({
      env,
    }: {
      command: string;
      env?: Record<string, string | undefined>;
    }) => {
      if (env) spawnEnvs.push(env);
      return {
        stdout: textStream('{"type":"bridge-ready","port":4319}\n'),
        stderr: textStream(''),
        kill: async () => {},
        wait: async () => ({ exitCode: 0 }),
      };
    },
  };
  return {
    id: 'test-sandbox',
    defaultWorkingDirectory: '/vercel/sandbox',
    restricted: () => session,
    ports: [4319],
    getPortEndpoint:
      getPortEndpoint ??
      (async () => {
        return { url: bridgeUrl };
      }),
    addRequestTransformations: async () => {},
    getPortUrl: async () => bridgeUrl,
    stop: async () => {},
    ...session,
  } as unknown as HarnessV1NetworkSandboxSession;
}
