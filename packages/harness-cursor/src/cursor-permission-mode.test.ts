import {
  HarnessCapabilityUnsupportedError,
  type HarnessV1NetworkSandboxSession,
  type HarnessV1SandboxProvider,
} from '@ai-sdk/harness';
import { HarnessAgent } from '@ai-sdk/harness/agent';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createCursor } from './cursor-harness';

const restrictiveModes = ['allow-reads', 'allow-edits'] as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createCursor permission modes', () => {
  test('accepts allow-all without opening a sandbox session', () => {
    const sandbox = rejectingSandbox();

    expect(
      () =>
        new HarnessAgent({
          harness: createCursor(),
          permissionMode: 'allow-all',
          sandbox: sandbox.provider,
        }),
    ).not.toThrow();
    expect(sandbox.events).toEqual([]);
  });

  test.each(restrictiveModes)(
    'rejects permissionMode %s before a sandbox session exists',
    mode => {
      const sandbox = rejectingSandbox();

      expect(
        () =>
          new HarnessAgent({
            harness: createCursor(),
            permissionMode: mode,
            sandbox: sandbox.provider,
          }),
      ).toThrow(HarnessCapabilityUnsupportedError);
      expect(sandbox.events).toEqual([]);
    },
  );

  test.each(restrictiveModes)(
    'doStart refuses permissionMode %s before it mutates the sandbox',
    async mode => {
      vi.stubEnv('CURSOR_API_KEY', 'placeholder');
      const sandbox = recordingSandbox();
      const harness = createCursor({
        port: 4319,
        portEndpoint: { url: 'ws://127.0.0.1:4319' },
        startupTimeoutMs: 1_000,
      });

      let failure: unknown;
      try {
        await harness.doStart({
          sessionId: 'cursor-session',
          sessionWorkDir: '/workspace/project',
          permissionMode: mode,
          sandboxSession: sandbox.session,
        });
      } catch (error) {
        failure = error;
      }

      expect(sandbox.events.filter(isSandboxMutation)).toEqual([]);
      expect(isPermissionRefusal(failure)).toBe(true);
    },
  );
});

function rejectingSandbox(): {
  provider: HarnessV1SandboxProvider;
  events: string[];
} {
  const events: string[] = [];
  const fail = async (event: string) => {
    events.push(event);
    throw new Error(`${event} ran before permission refusal`);
  };
  return {
    events,
    provider: {
      specificationVersion: 'harness-sandbox-v1',
      providerId: 'cursor-permission-test',
      createSession: () => fail('createSession'),
      resumeSession: () => fail('resumeSession'),
    },
  };
}

function recordingSandbox(): {
  session: HarnessV1NetworkSandboxSession;
  events: string[];
} {
  const events: string[] = [];
  const restricted = {
    readTextFile: async () => null,
    writeTextFile: async ({ path }: { path: string }) => {
      events.push(`write ${path}`);
    },
    run: async ({ command }: { command: string }) => {
      events.push(`run ${command}`);
      if (command === 'printf "%s" "$HOME"') {
        return { exitCode: 0, stdout: '/home/agent', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    spawn: async ({ command }: { command: string }) => {
      events.push(`spawn ${command}`);
      return {
        stdout: emptyStream(),
        stderr: emptyStream(),
        wait: async () => ({ exitCode: 1 }),
        kill: async () => {
          events.push(`kill ${command}`);
        },
      };
    },
  };
  return {
    events,
    session: {
      id: 'sandbox-1',
      defaultWorkingDirectory: '/workspace',
      ports: [4319],
      restricted: () => restricted,
      getPortEndpoint: async () => ({ url: 'ws://127.0.0.1:4319' }),
      getPortUrl: async () => 'ws://127.0.0.1:4319',
      stop: async () => {},
      ...restricted,
    } as unknown as HarnessV1NetworkSandboxSession,
  };
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

function isSandboxMutation(event: string): boolean {
  return event !== 'run printf "%s" "$HOME"';
}

function isPermissionRefusal(error: unknown): boolean {
  const chain = errorChain(error);
  const recognized = chain.some(item =>
    HarnessCapabilityUnsupportedError.isInstance(item),
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
