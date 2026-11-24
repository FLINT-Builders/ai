import { execFile } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Experimental_SandboxSession } from '@ai-sdk/provider-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { syncHostWorkspaceFromSandbox } from './pi-workspace-mirror';

/*
 * Budgets the host mirror must enforce before sandbox bytes are materialized
 * in this process or written under the host mirror directory.
 *
 * A skill document or AGENTS.md file fits under the per-file budget. The
 * fixtures below are larger than that on purpose: a sparse file created with
 * `truncate` (the same shape as `truncate -s 16G .agents/...`) and a batch of
 * files that are each under the per-file budget but over the batch budget.
 * Gzip of those zero files is a few kilobytes, which is what makes an
 * unbounded `gunzipSync` allocate the uncompressed size on the host.
 */
const MAX_MIRRORED_FILE_BYTES = 1024 * 1024;
const MAX_MIRRORED_BATCH_BYTES = 2 * 1024 * 1024;
const BOMB_BYTES = 8 * 1024 * 1024;
const BATCH_MEMBER_BYTES = 800 * 1024;
const BATCH_MEMBER_COUNT = 8;
/*
 * gunzipSync, the tar member copy, and the buffer passed to writeFile can
 * each hold the accepted bytes at once. Growth above this is the uncompressed
 * payload, not that bookkeeping.
 */
const MAX_HOST_BYTE_GROWTH = MAX_MIRRORED_BATCH_BYTES * 4;

interface BashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runBash(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BashResult> {
  return new Promise(resolve => {
    execFile(
      'bash',
      ['-c', command],
      { maxBuffer: 32 * 1024 * 1024, env, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const exitCode =
          error == null
            ? 0
            : typeof (error as NodeJS.ErrnoException).code === 'number'
              ? ((error as NodeJS.ErrnoException).code as number)
              : 1;
        resolve({
          exitCode,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        });
      },
    );
  });
}

interface LocalSandboxOptions {
  /** When set, `tar ...` fails the way a sandbox without tar does. */
  tarMissing?: boolean;
  /**
   * Absolute sandbox path that becomes `BOMB_BYTES` sparse zeros when `tar`
   * is invoked, after any earlier command in the same script has already
   * observed the previous size. Models a file that grows between a size
   * check and the read.
   */
  growOnTar?: string;
  /**
   * When `readBinaryFile` is called for this path, grow it to `BOMB_BYTES`
   * before the bytes are loaded. Models a file that grows between a size
   * check command and the fallback read.
   */
  growOnRead?: string;
}

interface LocalSandbox {
  sandbox: Experimental_SandboxSession;
  /** Byte lengths `readBinaryFile` actually loaded into the host. */
  reads: number[];
}

async function createLocalSandbox(
  sandboxWorkDir: string,
  options: LocalSandboxOptions = {},
): Promise<LocalSandbox> {
  const reads: number[] = [];
  let pathEnv = process.env.PATH ?? '';

  if (options.growOnTar) {
    const tarLookup = await runBash('command -v tar');
    const truncateLookup = await runBash('command -v truncate');
    if (tarLookup.exitCode !== 0 || truncateLookup.exitCode !== 0) {
      throw new Error('tar and truncate are required on PATH for this test');
    }
    const binDir = path.join(sandboxWorkDir, '..', 'test-bin');
    await mkdir(binDir, { recursive: true });
    const wrapper = path.join(binDir, 'tar');
    await writeFile(
      wrapper,
      `#!/bin/bash\n${truncateLookup.stdout.trim()} -s ${BOMB_BYTES} ${shellSingleQuote(options.growOnTar)}\nexec ${tarLookup.stdout.trim()} "$@"\n`,
      { mode: 0o755 },
    );
    pathEnv = `${binDir}${path.delimiter}${pathEnv}`;
  }

  const env = { ...process.env, PATH: pathEnv };

  const sandbox = {
    description: 'local bash sandbox',
    async run({ command }: { command: string }) {
      if (options.tarMissing && command.startsWith('tar ')) {
        return {
          exitCode: 127,
          stdout: '',
          stderr: 'tar: not found\n',
        };
      }
      return runBash(command, env);
    },
    async readBinaryFile({ path: filePath }: { path: string }) {
      if (options.growOnRead === filePath) {
        const truncateLookup = await runBash('command -v truncate');
        await runBash(
          `${truncateLookup.stdout.trim()} -s ${BOMB_BYTES} ${shellSingleQuote(filePath)}`,
        );
      }
      const bytes = await readFile(filePath);
      reads.push(bytes.byteLength);
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    },
    readFile: async () => {
      throw new Error('readFile is not used by the mirror');
    },
    readTextFile: async () => {
      throw new Error('readTextFile is not used by the mirror');
    },
    writeFile: async () => {
      throw new Error('writeFile is not used by the mirror');
    },
    writeBinaryFile: async () => {
      throw new Error('writeBinaryFile is not used by the mirror');
    },
    writeTextFile: async () => {
      throw new Error('writeTextFile is not used by the mirror');
    },
    spawn: async () => {
      throw new Error('spawn is not used by the mirror');
    },
  } as unknown as Experimental_SandboxSession;

  return { sandbox, reads };
}

function shellSingleQuote(value: string): string {
  return `'${value.split("'").join(`'\\\\''`)}'`;
}

async function writeSparseFile(filePath: string, bytes: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const result = await runBash(
    `truncate -s ${bytes} ${shellSingleQuote(filePath)}`,
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || 'truncate failed');
  }
}

function hostFileSize(relativePath: string): number {
  try {
    return statSync(path.join(hostWorkDir, relativePath)).size;
  } catch {
    return 0;
  }
}

function maxHostFileSize(root: string): number {
  let max = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
      } else if (entry.isFile()) {
        try {
          max = Math.max(max, statSync(absolute).size);
        } catch {
          // The file can disappear while the mirror reconciles the tree.
        }
      }
    }
  }
  return max;
}

function totalHostFileBytes(root: string): number {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
      } else if (entry.isFile()) {
        try {
          total += statSync(absolute).size;
        } catch {
          // The file can disappear while the mirror reconciles the tree.
        }
      }
    }
  }
  return total;
}

interface SyncObservation {
  maxFileBytes: number;
  totalFileBytes: number;
  arrayBufferGrowth: number;
  heapGrowth: number;
  reads: number[];
}

async function observeSync(input: {
  sandbox: Experimental_SandboxSession;
  sandboxWorkDir: string;
  hostWorkDir: string;
  reads: number[];
}): Promise<SyncObservation> {
  let maxFileBytes = 0;
  const before = process.memoryUsage();
  const timer = setInterval(() => {
    maxFileBytes = Math.max(maxFileBytes, maxHostFileSize(input.hostWorkDir));
  }, 5);

  let thrown: unknown;
  try {
    await syncHostWorkspaceFromSandbox({
      sandbox: input.sandbox,
      sandboxWorkDir: input.sandboxWorkDir,
      hostWorkDir: input.hostWorkDir,
    });
  } catch (error) {
    thrown = error;
  } finally {
    clearInterval(timer);
  }

  maxFileBytes = Math.max(maxFileBytes, maxHostFileSize(input.hostWorkDir));
  const after = process.memoryUsage();
  if (thrown) throw thrown;

  return {
    maxFileBytes,
    totalFileBytes: totalHostFileBytes(input.hostWorkDir),
    arrayBufferGrowth: Math.max(0, after.arrayBuffers - before.arrayBuffers),
    heapGrowth: Math.max(0, after.heapUsed - before.heapUsed),
    reads: input.reads,
  };
}

let sandboxRoot: string;
let sandboxWorkDir: string;
let hostWorkDir: string;

afterEach(async () => {
  if (sandboxRoot) {
    await rm(sandboxRoot, { recursive: true, force: true });
  }
});

async function prepareDirs(): Promise<void> {
  sandboxRoot = await mkdtemp(path.join(tmpdir(), 'pi-mirror-bomb-'));
  sandboxWorkDir = path.join(sandboxRoot, 'work');
  hostWorkDir = path.join(sandboxRoot, 'host');
  await mkdir(sandboxWorkDir, { recursive: true });
  await mkdir(hostWorkDir, { recursive: true });
}

describe('syncHostWorkspaceFromSandbox archive limits', () => {
  it('does not materialize a truncated sparse file from the .agents archive', async () => {
    await prepareDirs();
    const bomb = path.join(sandboxWorkDir, '.agents', 'skills', 'x', 'data');
    await writeSparseFile(bomb, BOMB_BYTES);
    await writeFile(
      path.join(sandboxWorkDir, '.agents', 'skills', 'x', 'SKILL.md'),
      '# kept skill\n',
    );
    const { sandbox, reads } = await createLocalSandbox(sandboxWorkDir);

    const observed = await observeSync({
      sandbox,
      sandboxWorkDir,
      hostWorkDir,
      reads,
    });

    expect(
      await readFile(
        path.join(hostWorkDir, '.agents', 'skills', 'x', 'SKILL.md'),
        'utf8',
      ),
    ).toBe('# kept skill\n');
    expect(hostFileSize('.agents/skills/x/data')).toBe(0);
    expect(observed.maxFileBytes).toBeLessThanOrEqual(MAX_MIRRORED_FILE_BYTES);
    expect(observed.totalFileBytes).toBeLessThanOrEqual(
      MAX_MIRRORED_BATCH_BYTES,
    );
    expect(
      Math.max(observed.arrayBufferGrowth, observed.heapGrowth),
    ).toBeLessThan(MAX_HOST_BYTE_GROWTH);
    expect(
      observed.reads.reduce((sum, size) => sum + size, 0),
    ).toBeLessThanOrEqual(MAX_MIRRORED_FILE_BYTES);
  });

  it('does not materialize a truncated sparse AGENTS.md archive member', async () => {
    await prepareDirs();
    await writeSparseFile(path.join(sandboxWorkDir, 'AGENTS.md'), BOMB_BYTES);
    await mkdir(path.join(sandboxWorkDir, '.pi'), { recursive: true });
    await writeFile(
      path.join(sandboxWorkDir, '.pi', 'SYSTEM.md'),
      '# kept prompt\n',
    );
    const { sandbox, reads } = await createLocalSandbox(sandboxWorkDir);

    const observed = await observeSync({
      sandbox,
      sandboxWorkDir,
      hostWorkDir,
      reads,
    });

    expect(
      await readFile(path.join(hostWorkDir, '.pi', 'SYSTEM.md'), 'utf8'),
    ).toBe('# kept prompt\n');
    expect(hostFileSize('AGENTS.md')).toBe(0);
    expect(observed.maxFileBytes).toBeLessThanOrEqual(MAX_MIRRORED_FILE_BYTES);
    expect(
      Math.max(observed.arrayBufferGrowth, observed.heapGrowth),
    ).toBeLessThan(MAX_HOST_BYTE_GROWTH);
    expect(
      observed.reads.reduce((sum, size) => sum + size, 0),
    ).toBeLessThanOrEqual(MAX_MIRRORED_FILE_BYTES);
  });

  it('does not materialize a truncated sparse file from the .pi archive', async () => {
    await prepareDirs();
    await writeSparseFile(
      path.join(sandboxWorkDir, '.pi', 'skills', 'x', 'data'),
      BOMB_BYTES,
    );
    await writeFile(
      path.join(sandboxWorkDir, '.pi', 'skills', 'x', 'SKILL.md'),
      '# kept pi skill\n',
    );
    const { sandbox, reads } = await createLocalSandbox(sandboxWorkDir);

    const observed = await observeSync({
      sandbox,
      sandboxWorkDir,
      hostWorkDir,
      reads,
    });

    expect(
      await readFile(
        path.join(hostWorkDir, '.pi', 'skills', 'x', 'SKILL.md'),
        'utf8',
      ),
    ).toBe('# kept pi skill\n');
    expect(hostFileSize('.pi/skills/x/data')).toBe(0);
    expect(observed.maxFileBytes).toBeLessThanOrEqual(MAX_MIRRORED_FILE_BYTES);
    expect(
      Math.max(observed.arrayBufferGrowth, observed.heapGrowth),
    ).toBeLessThan(MAX_HOST_BYTE_GROWTH);
    expect(
      observed.reads.reduce((sum, size) => sum + size, 0),
    ).toBeLessThanOrEqual(MAX_MIRRORED_FILE_BYTES);
  });

  it('does not materialize a file that grows after listing and before tar reads it', async () => {
    await prepareDirs();
    const bomb = path.join(sandboxWorkDir, '.agents', 'skills', 'x', 'data');
    await mkdir(path.dirname(bomb), { recursive: true });
    await writeFile(bomb, 'small\n');
    await writeFile(
      path.join(sandboxWorkDir, '.agents', 'skills', 'x', 'SKILL.md'),
      '# kept skill\n',
    );
    const { sandbox, reads } = await createLocalSandbox(sandboxWorkDir, {
      growOnTar: bomb,
    });

    const observed = await observeSync({
      sandbox,
      sandboxWorkDir,
      hostWorkDir,
      reads,
    });

    expect(
      await readFile(
        path.join(hostWorkDir, '.agents', 'skills', 'x', 'SKILL.md'),
        'utf8',
      ),
    ).toBe('# kept skill\n');
    expect(hostFileSize('.agents/skills/x/data')).toBeLessThanOrEqual(
      'small\n'.length,
    );
    expect(observed.maxFileBytes).toBeLessThanOrEqual(MAX_MIRRORED_FILE_BYTES);
    expect(
      Math.max(observed.arrayBufferGrowth, observed.heapGrowth),
    ).toBeLessThan(MAX_HOST_BYTE_GROWTH);
    expect(
      observed.reads.reduce((sum, size) => sum + size, 0),
    ).toBeLessThanOrEqual(MAX_MIRRORED_FILE_BYTES);
  });

  it('does not load an oversized file when archive transfer is unavailable', async () => {
    await prepareDirs();
    await writeSparseFile(
      path.join(sandboxWorkDir, '.agents', 'skills', 'x', 'data'),
      BOMB_BYTES,
    );
    await writeFile(
      path.join(sandboxWorkDir, '.agents', 'skills', 'x', 'SKILL.md'),
      '# kept skill\n',
    );
    const { sandbox, reads } = await createLocalSandbox(sandboxWorkDir, {
      tarMissing: true,
    });

    const observed = await observeSync({
      sandbox,
      sandboxWorkDir,
      hostWorkDir,
      reads,
    });

    expect(
      await readFile(
        path.join(hostWorkDir, '.agents', 'skills', 'x', 'SKILL.md'),
        'utf8',
      ),
    ).toBe('# kept skill\n');
    expect(hostFileSize('.agents/skills/x/data')).toBe(0);
    expect(observed.maxFileBytes).toBeLessThanOrEqual(MAX_MIRRORED_FILE_BYTES);
    expect(
      observed.reads.reduce((sum, size) => sum + size, 0),
    ).toBeLessThanOrEqual(MAX_MIRRORED_FILE_BYTES);
    expect(
      Math.max(observed.arrayBufferGrowth, observed.heapGrowth),
    ).toBeLessThan(MAX_HOST_BYTE_GROWTH);
  });

  it('does not load a file that grows between a size check and readBinaryFile', async () => {
    await prepareDirs();
    const bomb = path.join(sandboxWorkDir, '.agents', 'skills', 'x', 'data');
    await mkdir(path.dirname(bomb), { recursive: true });
    await writeFile(bomb, 'small\n');
    await writeFile(
      path.join(sandboxWorkDir, '.agents', 'skills', 'x', 'SKILL.md'),
      '# kept skill\n',
    );
    const { sandbox, reads } = await createLocalSandbox(sandboxWorkDir, {
      tarMissing: true,
      growOnRead: bomb,
    });

    const observed = await observeSync({
      sandbox,
      sandboxWorkDir,
      hostWorkDir,
      reads,
    });

    expect(
      await readFile(
        path.join(hostWorkDir, '.agents', 'skills', 'x', 'SKILL.md'),
        'utf8',
      ),
    ).toBe('# kept skill\n');
    expect(hostFileSize('.agents/skills/x/data')).toBeLessThanOrEqual(
      'small\n'.length,
    );
    expect(observed.maxFileBytes).toBeLessThanOrEqual(MAX_MIRRORED_FILE_BYTES);
    expect(
      observed.reads.reduce((sum, size) => sum + size, 0),
    ).toBeLessThanOrEqual(MAX_MIRRORED_FILE_BYTES);
    expect(
      Math.max(observed.arrayBufferGrowth, observed.heapGrowth),
    ).toBeLessThan(MAX_HOST_BYTE_GROWTH);
  });

  it('does not materialize a batch whose uncompressed total exceeds the batch budget', async () => {
    await prepareDirs();
    for (let index = 0; index < BATCH_MEMBER_COUNT; index++) {
      await writeSparseFile(
        path.join(
          sandboxWorkDir,
          '.agents',
          'skills',
          `skill-${index}`,
          'data',
        ),
        BATCH_MEMBER_BYTES,
      );
    }
    await writeFile(
      path.join(sandboxWorkDir, '.agents', 'skills', 'skill-0', 'SKILL.md'),
      '# kept skill\n',
    );
    const { sandbox, reads } = await createLocalSandbox(sandboxWorkDir);

    const observed = await observeSync({
      sandbox,
      sandboxWorkDir,
      hostWorkDir,
      reads,
    });

    expect(
      await readFile(
        path.join(hostWorkDir, '.agents', 'skills', 'skill-0', 'SKILL.md'),
        'utf8',
      ),
    ).toBe('# kept skill\n');
    expect(observed.totalFileBytes).toBeLessThanOrEqual(
      MAX_MIRRORED_BATCH_BYTES,
    );
    expect(observed.maxFileBytes).toBeLessThanOrEqual(MAX_MIRRORED_FILE_BYTES);
    expect(
      observed.reads.reduce((sum, size) => sum + size, 0),
    ).toBeLessThanOrEqual(MAX_MIRRORED_BATCH_BYTES);
    expect(
      Math.max(observed.arrayBufferGrowth, observed.heapGrowth),
    ).toBeLessThan(MAX_HOST_BYTE_GROWTH);
  });
});
