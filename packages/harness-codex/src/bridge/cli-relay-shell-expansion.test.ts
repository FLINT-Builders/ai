import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { isToolRelayCommand, parseToolRelayCommands } from './cli-relay';

const cliShimPath = '/tmp/harness-codex-audit-shim/harness-tool.mjs';
const cliShimDir = '/tmp/harness-codex-audit-shim';

type ShellCommand = {
  shell: string;
  flag: '-lc' | '-c';
  command: string;
};

type ExpansionCase = {
  name: string;
  script: string;
  executed: string;
  unexpanded: string | null;
  commands: ShellCommand[];
};

const expansionCases = JSON.parse(
  readFileSync(
    new URL('./__fixtures__/cli-relay-shell-expansion.json', import.meta.url),
    'utf8',
  ),
) as ExpansionCase[];

const literalCase = expansionCases.find(entry => entry.name === 'literal-json');
const attackCases = expansionCases.filter(entry => entry.unexpanded != null);

if (!literalCase) {
  throw new Error('missing literal-json shell expansion fixture');
}

/**
 * Codex exec serializes the argv it spawns (`shell`, `-lc`/`-c`, script) with
 * shlex 1.3.0. The bridge then decides whether to drop that command string
 * from the host event stream. These strings are that serialization.
 */
function bashLoginCommand(entry: ExpansionCase): string {
  const match = entry.commands.find(
    command => command.shell === '/bin/bash' && command.flag === '-lc',
  );
  if (!match) {
    throw new Error(`missing bash -lc command for ${entry.name}`);
  }
  return match.command;
}

function helperSees(shell: string, flag: string, script: string): string {
  const bin = mkdtempSync(join(tmpdir(), 'relay-audit-node-'));
  const nodePath = join(bin, 'node');
  writeFileSync(nodePath, '#!/bin/sh\nprintf %s "$3"\n');
  chmodSync(nodePath, 0o755);
  return execFileSync(shell, [flag, script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      MARKER_VAR: 'expanded-var',
    },
  });
}

describe('tool relay command filter rejects shell expansion', () => {
  test('still recognizes a single-quoted JSON relay call', () => {
    const command = bashLoginCommand(literalCase);
    expect(parseToolRelayCommands({ command, cliShimPath })).toEqual([
      { toolName: 'weather', input: { city: 'Paris' } },
    ]);
    expect(isToolRelayCommand({ command, cliShimPath })).toBe(true);
    expect(helperSees('/bin/bash', '-lc', literalCase.script)).toBe(
      literalCase.executed,
    );
  });

  test.each(
    attackCases.flatMap(entry =>
      entry.commands.map(command => ({ entry, command })),
    ),
  )(
    '$entry.name is not classified as a relay call when Codex reports $command.shell $command.flag',
    ({ entry, command }) => {
      expect(
        parseToolRelayCommands({
          command: command.command,
          cliShimPath,
        }),
      ).toBeUndefined();
      expect(
        isToolRelayCommand({
          command: command.command,
          cliShimPath,
        }),
      ).toBe(false);
      expect(
        parseToolRelayCommands({ command: entry.script, cliShimPath }),
      ).toBeUndefined();
    },
  );

  test.each(
    attackCases.flatMap(entry =>
      entry.commands
        .filter(command => command.shell !== '/bin/zsh')
        .map(command => ({ entry, command })),
    ),
  )(
    '$entry.name expands inside $command.shell $command.flag before the helper reads the argument',
    ({ entry, command }) => {
      const seen = helperSees(command.shell, command.flag, entry.script);
      expect(seen).toBe(entry.executed);
      expect(seen).not.toContain(entry.unexpanded);
      const parsed = parseToolRelayCommands({
        command: command.command,
        cliShimPath,
      });
      expect(parsed).toBeUndefined();
    },
  );
});

const bridgeState = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
  emitted: [] as Array<Record<string, unknown>>,
  originalArgv: [] as string[],
  originalEnv: {} as Record<string, string | undefined>,
}));

const CODEX_ENV_KEYS = [
  'AI_GATEWAY_API_KEY',
  'AI_GATEWAY_BASE_URL',
  'OPENAI_BASE_URL',
  'CODEX_API_KEY',
] as const;

vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    startThread() {
      return {
        runStreamed: async () => ({
          events: (async function* events() {
            for (const event of bridgeState.events) {
              yield event;
            }
          })(),
        }),
      };
    }

    resumeThread() {
      return this.startThread();
    }
  },
}));

vi.mock('@ai-sdk/harness/bridge', () => ({
  runBridge: async ({
    onStart,
  }: {
    onStart: (start: unknown, turn: unknown) => Promise<void>;
  }) => {
    await onStart(
      {
        prompt: 'Read the repository and use the weather tool.',
        model: 'gpt-5.5',
        tools: [
          {
            name: 'weather',
            description: 'Get the weather.',
            inputSchema: { type: 'object' },
          },
        ],
      },
      {
        emit: (message: Record<string, unknown>) => {
          bridgeState.emitted.push(message);
        },
        requestToolResult: async () => ({ output: {} }),
        abortSignal: new AbortController().signal,
        emitWarning: () => {},
        emitError: () => {},
        experimental_userMessages: {
          pendingCount: 0,
          close: () => {},
          [Symbol.asyncIterator]: async function* empty() {},
        },
      },
    );
  },
}));

function commandExecution(id: string, command: string, output: string) {
  return [
    {
      type: 'item.started',
      item: {
        type: 'command_execution',
        id,
        command,
      },
    },
    {
      type: 'item.completed',
      item: {
        type: 'command_execution',
        id,
        command,
        exit_code: 0,
        aggregated_output: output,
        status: 'completed',
      },
    },
  ];
}

describe('Codex bridge event stream keeps expandable shell commands visible', () => {
  beforeEach(() => {
    bridgeState.events = [];
    bridgeState.emitted = [];
    bridgeState.originalArgv = [...process.argv];
    bridgeState.originalEnv = Object.fromEntries(
      CODEX_ENV_KEYS.map(key => [key, process.env[key]]),
    );
    for (const key of CODEX_ENV_KEYS) {
      delete process.env[key];
    }
    process.argv.splice(
      0,
      process.argv.length,
      'node',
      'bridge.mjs',
      '--workdir',
      '/tmp/harness-codex-audit-work',
      '--bridge-state-dir',
      '/tmp/harness-codex-audit-state',
      '--cli-shim-dir',
      cliShimDir,
    );
  });

  afterEach(() => {
    process.argv.splice(0, process.argv.length, ...bridgeState.originalArgv);
    for (const key of CODEX_ENV_KEYS) {
      const value = bridgeState.originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.resetModules();
  });

  test('emits shell tool-call and tool-result events for expandable relay-shaped commands', async () => {
    const safeCommand = bashLoginCommand(literalCase);
    const hidden = attackCases.map((entry, index) => ({
      command: bashLoginCommand(entry),
      output: `hidden-${entry.name}`,
      id: `hidden-${index}`,
    }));
    bridgeState.events = [
      ...commandExecution('safe-1', safeCommand, 'safe-output'),
      ...hidden.flatMap(entry =>
        commandExecution(entry.id, entry.command, entry.output),
      ),
      { type: 'turn.completed' },
    ];

    vi.resetModules();
    await import('./index');

    const bashCalls = bridgeState.emitted.filter(
      event => event.type === 'tool-call' && event.toolName === 'bash',
    );
    const bashResults = bridgeState.emitted.filter(
      event => event.type === 'tool-result' && event.toolName === 'bash',
    );

    expect(bashCalls.map(event => event.input)).not.toContain(
      JSON.stringify({ command: safeCommand }),
    );
    expect(bashResults.map(event => event.result)).not.toContainEqual(
      expect.objectContaining({ output: 'safe-output' }),
    );

    for (const entry of hidden) {
      expect(bashCalls.map(event => event.input)).toContain(
        JSON.stringify({ command: entry.command }),
      );
      expect(bashResults.map(event => event.result)).toContainEqual(
        expect.objectContaining({
          output: entry.output,
          exitCode: 0,
        }),
      );
    }
  });
});
