import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  applyBootstrapRecipe,
  hashHarnessBootstrap,
} from '../../../harness/src/agent/internal/bootstrap-recipe';
import type { HarnessV1Bootstrap } from '../../../harness/src/v1/harness-v1-bootstrap';

const PAYLOAD = 'PWNED_BRIDGE';
const ORIGINAL_DEP = 'original-dep';
const ORIGINAL_CELL = 'original-cell';

const BRIDGE_SOURCE = `import { marker } from './node_modules/dep/index.mjs';
process.stdout.write(String(marker));
`;

const DEP_SOURCE = `export const marker = "${ORIGINAL_DEP}";
`;

type ToolInput = Record<string, unknown>;

type PermissionDecision = {
  behavior?: string;
  updatedInput?: ToolInput;
};

type CanUseTool = (
  toolName: string,
  toolInput: ToolInput,
  options: { toolUseID: string },
) => Promise<PermissionDecision>;

const state = vi.hoisted(() => ({
  emitted: [] as Record<string, unknown>[],
  start: {} as Record<string, unknown>,
  approvalCalls: 0,
  queryOptions: undefined as Record<string, unknown> | undefined,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: Record<string, unknown> }) => {
    state.queryOptions = args.options;
    return (async function* () {
      yield { type: 'result', subtype: 'success', result: 'done' };
    })();
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    registerTool(): void {}
  },
}));

vi.mock('@ai-sdk/harness/bridge', () => ({
  runBridge: async ({
    onStart,
  }: {
    onStart: (start: unknown, turn: unknown) => Promise<void>;
  }) => {
    await onStart(state.start, {
      abortSignal: new AbortController().signal,
      experimental_userMessages: {
        pendingCount: 0,
        close: () => {},
        [Symbol.asyncIterator]: async function* () {},
      },
      firstTurn: true,
      emit: (event: Record<string, unknown>) => state.emitted.push(event),
      emitWarning: () => {},
      emitError: () => {},
      requestToolResult: async () => ({ output: {} }),
      requestToolApproval: async () => {
        state.approvalCalls += 1;
        return { approved: false, reason: 'denied in test' };
      },
    });
  },
}));

const originalArgv = [...process.argv];

afterEach(() => {
  process.argv.splice(0, process.argv.length, ...originalArgv);
  vi.resetModules();
});

describe.sequential('allow-edits bootstrap escape', () => {
  test('still auto-approves an ordinary edit inside the session working directory', async () => {
    const layout = await createLayout();
    try {
      const notes = join(layout.sessionDir, 'notes.txt');
      await writeFile(notes, 'before');
      const canUseTool = await loadCanUseTool(layout.sessionDir);
      const decision = await decide(canUseTool, 'Write', {
        file_path: notes,
        content: 'after',
      });

      expect(decision.behavior).toBe('allow');
      expect(state.approvalCalls).toBe(0);
      if (decision.behavior === 'allow') {
        await applyToolEffect(
          'Write',
          decision.updatedInput ?? {
            file_path: notes,
            content: 'after',
          },
        );
      }
      expect(await readFile(notes, 'utf8')).toBe('after');
    } finally {
      await rm(layout.root, { recursive: true, force: true });
    }
  });

  test.each([
    ['Write', 'absolute'],
    ['Write', 'dotdot'],
    ['Write', 'symlink'],
    ['Edit', 'absolute'],
    ['Edit', 'dotdot'],
    ['Edit', 'symlink'],
  ] as const)(
    '%s via a %s path cannot replace the bridge the next spawn executes',
    async (tool, shape) => {
      const layout = await createLayout();
      try {
        expect(runBridge(layout.bridgePath)).toBe(ORIGINAL_DEP);
        const target = await attackPath(layout, shape, layout.bridgePath);
        const canUseTool = await loadCanUseTool(layout.sessionDir);
        const input = toolInput(tool, target, 'bridge');
        const decision = await decide(canUseTool, tool, input);
        expectSamePathWhenApprovalRecorded(input, decision);
        if (decision.behavior === 'allow') {
          await applyToolEffect(tool, decision.updatedInput ?? input);
        }
        await resumeBootstrap(layout);
        expect(runBridge(layout.bridgePath)).toBe(ORIGINAL_DEP);
      } finally {
        await rm(layout.root, { recursive: true, force: true });
      }
    },
  );

  test.each([
    ['Write', 'absolute'],
    ['Write', 'dotdot'],
    ['Write', 'symlink'],
    ['Edit', 'absolute'],
    ['Edit', 'dotdot'],
    ['Edit', 'symlink'],
  ] as const)(
    '%s via a %s path cannot replace a module the spawned bridge imports',
    async (tool, shape) => {
      const layout = await createLayout();
      try {
        expect(runBridge(layout.bridgePath)).toBe(ORIGINAL_DEP);
        const target = await attackPath(layout, shape, layout.depPath);
        const canUseTool = await loadCanUseTool(layout.sessionDir);
        const input = toolInput(tool, target, 'dep');
        const decision = await decide(canUseTool, tool, input);
        expectSamePathWhenApprovalRecorded(input, decision);
        if (decision.behavior === 'allow') {
          await applyToolEffect(tool, decision.updatedInput ?? input);
        }
        await resumeBootstrap(layout);
        expect(runBridge(layout.bridgePath)).toBe(ORIGINAL_DEP);
      } finally {
        await rm(layout.root, { recursive: true, force: true });
      }
    },
  );

  test.each(['absolute', 'dotdot', 'symlink'] as const)(
    'NotebookEdit via a %s path cannot modify a notebook outside the session working directory',
    async shape => {
      const layout = await createLayout();
      try {
        const notebookPath = join(layout.bootstrapDir, 'outside-session.ipynb');
        await writeFile(notebookPath, notebookContents(ORIGINAL_CELL));
        const target = await attackPath(layout, shape, notebookPath);
        const canUseTool = await loadCanUseTool(layout.sessionDir);
        const input = {
          notebook_path: target,
          new_source: PAYLOAD,
          cell_id: 'c1',
          cell_type: 'code',
          edit_mode: 'replace',
        };
        const decision = await decide(canUseTool, 'NotebookEdit', input);
        expectSamePathWhenApprovalRecorded(input, decision);
        if (decision.behavior === 'allow') {
          await applyToolEffect('NotebookEdit', decision.updatedInput ?? input);
        }
        await resumeBootstrap(layout);
        const notebook = await readFile(notebookPath, 'utf8');
        expect(notebook).toContain(ORIGINAL_CELL);
        expect(notebook).not.toContain(PAYLOAD);
      } finally {
        await rm(layout.root, { recursive: true, force: true });
      }
    },
  );
});

async function loadCanUseTool(workdir: string): Promise<CanUseTool> {
  vi.resetModules();
  state.emitted = [];
  state.approvalCalls = 0;
  state.queryOptions = undefined;
  state.start = {
    prompt: 'Inspect the project.',
    thinking: { type: 'disabled' },
    permissionMode: 'allow-edits',
  };
  process.argv.splice(
    0,
    process.argv.length,
    'node',
    'bridge.mjs',
    '--workdir',
    workdir,
    '--bridge-state-dir',
    join(workdir, '.bridge-state'),
  );
  await import('./index');
  const canUseTool = state.queryOptions?.canUseTool as CanUseTool | undefined;
  if (canUseTool == null) {
    throw new Error('Claude Code bridge did not register canUseTool.');
  }
  return canUseTool;
}

async function decide(
  canUseTool: CanUseTool,
  toolName: string,
  input: ToolInput,
): Promise<PermissionDecision> {
  state.emitted = [];
  state.approvalCalls = 0;
  const toolUseID = `approval-${toolName}`;
  return canUseTool(toolName, input, { toolUseID });
}

function expectSamePathWhenApprovalRecorded(
  requested: ToolInput,
  decision: PermissionDecision,
): void {
  if (decision.behavior !== 'allow' || state.approvalCalls === 0) return;
  const toolCall = [...state.emitted]
    .reverse()
    .find(event => event.type === 'tool-call');
  if (toolCall == null || typeof toolCall.input !== 'string') return;
  const approved = JSON.parse(toolCall.input) as ToolInput;
  const approvedPath = pathOf(approved);
  const usedPath = pathOf(decision.updatedInput ?? requested);
  expect(usedPath).toBe(approvedPath);
}

function pathOf(input: ToolInput): string {
  const value = input.file_path ?? input.notebook_path;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Tool input is missing a file path.');
  }
  return value;
}

function toolInput(
  tool: 'Write' | 'Edit',
  filePath: string,
  kind: 'bridge' | 'dep',
): ToolInput {
  if (tool === 'Write') {
    return {
      file_path: filePath,
      content:
        kind === 'bridge'
          ? `process.stdout.write(${JSON.stringify(PAYLOAD)});\n`
          : `export const marker = ${JSON.stringify(PAYLOAD)};\n`,
    };
  }
  if (kind === 'bridge') {
    return {
      file_path: filePath,
      old_string: 'process.stdout.write(String(marker));',
      new_string: `process.stdout.write(${JSON.stringify(PAYLOAD)});`,
    };
  }
  return {
    file_path: filePath,
    old_string: `"${ORIGINAL_DEP}"`,
    new_string: JSON.stringify(PAYLOAD),
  };
}

async function applyToolEffect(tool: string, input: ToolInput): Promise<void> {
  if (tool === 'NotebookEdit') {
    const notebookPath = pathOf(input);
    if (!notebookPath.endsWith('.ipynb')) return;
    const source =
      typeof input.new_source === 'string' ? input.new_source : PAYLOAD;
    await writeFile(notebookPath, notebookContents(source));
    return;
  }
  const filePath = pathOf(input);
  if (tool === 'Write') {
    const content = typeof input.content === 'string' ? input.content : '';
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
    return;
  }
  const oldString = String(input.old_string ?? '');
  const newString = String(input.new_string ?? '');
  const current = await readFile(filePath, 'utf8');
  const next =
    input.replace_all === true
      ? current.replaceAll(oldString, newString)
      : current.replace(oldString, newString);
  if (next === current) return;
  await writeFile(filePath, next);
}

type Layout = {
  root: string;
  sessionDir: string;
  bootstrapDir: string;
  bridgePath: string;
  depPath: string;
  recipe: HarnessV1Bootstrap;
  identity: string;
};

async function createLayout(): Promise<Layout> {
  const root = await mkdtemp(join(tmpdir(), 'allow-edits-bridge-'));
  const sessionDir = join(root, 'claude-code-session');
  const bootstrapDir = join(root, '.harness-bootstrap', 'claude-code');
  await mkdir(sessionDir, { recursive: true });
  const recipe: HarnessV1Bootstrap = {
    harnessId: 'claude-code',
    bootstrapDir: '.harness-bootstrap/claude-code',
    files: [
      {
        path: '.harness-bootstrap/claude-code/bridge.mjs',
        content: BRIDGE_SOURCE,
      },
      {
        path: '.harness-bootstrap/claude-code/package.json',
        content: '{}\n',
      },
      {
        path: '.harness-bootstrap/claude-code/install-dep.mjs',
        content: `import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('node_modules/dep', { recursive: true });
writeFileSync(
  'node_modules/dep/index.mjs',
  'export const marker = "${ORIGINAL_DEP}";\\n',
);
`,
      },
    ],
    commands: [{ command: 'node ./install-dep.mjs' }],
  };
  const identity = await hashHarnessBootstrap(recipe);
  await applyBootstrapRecipe({
    session: createFsSandbox(),
    recipe,
    identity,
    defaultWorkingDirectory: root,
  });
  return {
    root,
    sessionDir,
    bootstrapDir,
    bridgePath: join(bootstrapDir, 'bridge.mjs'),
    depPath: join(bootstrapDir, 'node_modules', 'dep', 'index.mjs'),
    recipe,
    identity,
  };
}

async function resumeBootstrap(layout: Layout): Promise<void> {
  await applyBootstrapRecipe({
    session: createFsSandbox(),
    recipe: layout.recipe,
    identity: layout.identity,
    defaultWorkingDirectory: layout.root,
  });
}

async function attackPath(
  layout: Layout,
  shape: 'absolute' | 'dotdot' | 'symlink',
  absoluteTarget: string,
): Promise<string> {
  if (shape === 'absolute') return absoluteTarget;
  if (shape === 'dotdot') {
    const relative = absoluteTarget.slice(layout.root.length + 1);
    return `${layout.sessionDir}/../${relative}`;
  }
  const linkPath = join(
    layout.sessionDir,
    `link-${absoluteTarget.split('/').at(-1)}`,
  );
  await symlink(absoluteTarget, linkPath);
  return linkPath;
}

function createFsSandbox() {
  return {
    description: 'filesystem',
    async readTextFile({ path }: { path: string }) {
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if (
          error != null &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          return null;
        }
        throw error;
      }
    },
    async writeTextFile({ path, content }: { path: string; content: string }) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    },
    async run({
      command,
      workingDirectory,
      env,
    }: {
      command: string;
      workingDirectory?: string;
      env?: Record<string, string>;
    }) {
      const result = spawnSync('bash', ['-lc', command], {
        cwd: workingDirectory,
        env: { ...process.env, ...env },
        encoding: 'utf8',
      });
      return {
        exitCode: result.status ?? 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    },
  };
}

function runBridge(bridgePath: string): string {
  return execFileSync(process.execPath, [bridgePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function notebookContents(source: string): string {
  return `${JSON.stringify(
    {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        {
          id: 'c1',
          cell_type: 'code',
          source,
          metadata: {},
          execution_count: null,
          outputs: [],
        },
      ],
    },
    null,
    2,
  )}\n`;
}
