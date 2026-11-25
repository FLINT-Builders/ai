import { execFile } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';
import { describe, expect, it } from 'vitest';
import type { HarnessV1 } from '@ai-sdk/harness';
import { prepareSandboxForHarness } from '../../harness/src/agent/prepare-sandbox-for-harness';
import { createFx } from '../../harness-fx/src/fx-harness';
import { createCursor } from './cursor-harness';

const execFileAsync = promisify(execFile);

const MARKER = 'UNPINNED_INSTALLER_EXECUTED';
const CREDENTIAL_PLACEHOLDER = 'PLACEHOLDER_CURSOR_API_KEY';
const FX_CREDENTIAL_PLACEHOLDER = 'PLACEHOLDER_FX_ACCESS_TOKEN';
const CURL_STAND_IN = fileURLToPath(
  new URL('./unpinned-remote-installer-curl.bash', import.meta.url),
);

// The bridge's own frozen lockfile install is not the implementation installer.
// Exiting 0 lets bootstrap reach the implementation command. A recipe that
// installs the implementation with a floating package version has no lockfile
// and fails implementationInstallIsPinned.
const PNPM_STAND_IN = `#!/usr/bin/env bash
exit 0
`;

describe('unpinned remote harness installers', () => {
  it('does not execute the remote Cursor installer during sandbox bootstrap', async () => {
    await expectBootstrapRejectsRemoteInstaller({
      createHarness: () => createCursor(),
    });
  });

  it('does not execute the remote fx installer during sandbox bootstrap', async () => {
    await expectBootstrapRejectsRemoteInstaller({
      createHarness: () => createFx(),
    });
  });
});

async function expectBootstrapRejectsRemoteInstaller({
  createHarness,
}: {
  createHarness: () => HarnessV1;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'unpinned-installer-'));
  const probeDir = join(root, 'probe');
  const stateDir = join(root, 'curl-state');
  const stubDir = join(root, 'stub-bin');
  const workspace = join(root, 'workspace');
  const sandboxHome = join(root, 'sandbox-home');
  await mkdir(probeDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(stubDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(sandboxHome, { recursive: true });
  await writeFile(join(workspace, 'workspace-sentinel'), 'workspace');
  await copyFile(CURL_STAND_IN, join(stubDir, 'curl'));
  await copyFile(CURL_STAND_IN, join(stubDir, 'wget'));
  await writeFile(join(stubDir, 'pnpm'), PNPM_STAND_IN);
  await chmod(join(stubDir, 'curl'), 0o755);
  await chmod(join(stubDir, 'wget'), 0o755);
  await chmod(join(stubDir, 'pnpm'), 0o755);

  const ranCommands: string[] = [];
  const session = createLocalBashSandbox({
    root,
    probeDir,
    stateDir,
    stubDir,
    sandboxHome,
    ranCommands,
  });

  try {
    const harness = createHarness();
    const recipe = await harness.getBootstrap!();
    try {
      await prepareSandboxForHarness({
        session,
        harnesses: [harness],
      });
    } catch {
      // A bootstrap that refuses before executing the remote body is the
      // secure outcome. Execution is checked below.
    }

    const recipeCommands = recipe.commands.map(command => command.command);
    expect(
      ranCommands.filter(command => recipeCommands.includes(command)),
    ).toEqual(recipeCommands);

    await launchInstalledExecutable({
      root,
      probeDir,
      workspace,
    });

    const probePath = join(probeDir, 'unpinned-installer-executed');
    let probe = '';
    try {
      probe = await readFile(probePath, 'utf8');
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    expect(
      probe,
      'bootstrap executed bytes served for the installer URL; verify a checksum or signature pinned in this repository before execution',
    ).toBe('');

    const installed = await readInstalledExecutables({ root });
    expect(
      installed.some(executable => executable.includes(MARKER)),
      'the executable bootstrap launches was written by the unpinned installer',
    ).toBe(false);
    expect(
      implementationInstallIsPinned(recipe),
      'the implementation install must be an integrity-checked install script or a lockfile pinned in the recipe',
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createLocalBashSandbox({
  root,
  probeDir,
  stateDir,
  stubDir,
  sandboxHome,
  ranCommands,
}: {
  root: string;
  probeDir: string;
  stateDir: string;
  stubDir: string;
  sandboxHome: string;
  ranCommands: string[];
}): SandboxSession {
  const baseEnv = {
    PATH: `${stubDir}:/usr/bin:/bin`,
    HOME: sandboxHome,
    TMPDIR: join(root, 'tmp'),
    INSTALLER_PROBE_DIR: probeDir,
    CURL_STATE_DIR: stateDir,
    LANG: 'C',
  };

  return {
    description: 'local bash sandbox',
    defaultWorkingDirectory: root,
    async readTextFile({ path }) {
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if (isEnoent(error)) return null;
        throw error;
      }
    },
    async writeTextFile({ path, content }) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    },
    async run({ command, workingDirectory, env }) {
      ranCommands.push(command);
      const cwd = workingDirectory ?? root;
      await mkdir(cwd, { recursive: true });
      await mkdir(baseEnv.TMPDIR, { recursive: true });
      try {
        const { stdout, stderr } = await execFileAsync(
          '/bin/bash',
          ['-c', command],
          {
            cwd,
            env: { ...baseEnv, ...env },
            timeout: 20_000,
          },
        );
        return { exitCode: 0, stdout, stderr };
      } catch (error) {
        const failed = error as {
          code?: number | string;
          stdout?: string;
          stderr?: string;
        };
        const exitCode = typeof failed.code === 'number' ? failed.code : 1;
        return {
          exitCode,
          stdout: failed.stdout ?? '',
          stderr: failed.stderr ?? '',
        };
      }
    },
  } as unknown as SandboxSession;
}

async function launchInstalledExecutable({
  root,
  probeDir,
  workspace,
}: {
  root: string;
  probeDir: string;
  workspace: string;
}): Promise<void> {
  const descriptors = await findFiles({
    dir: root,
    name: 'implementation.json',
  });
  for (const descriptorPath of descriptors) {
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as {
      executablePath?: string;
      args?: string[];
    };
    if (typeof descriptor.executablePath !== 'string') continue;
    const executable = join(dirname(descriptorPath), descriptor.executablePath);
    let bytes: Buffer;
    try {
      bytes = await readFile(executable);
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
    if (!bytes.includes(Buffer.from(MARKER))) continue;
    try {
      await execFileAsync(executable, descriptor.args ?? [], {
        cwd: workspace,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: join(dirname(descriptorPath), 'home'),
          INSTALLER_PROBE_DIR: probeDir,
          CURSOR_API_KEY: CREDENTIAL_PLACEHOLDER,
          AI_SDK_FX_CHATGPT_ACCESS_TOKEN: FX_CREDENTIAL_PLACEHOLDER,
          LANG: 'C',
        },
        timeout: 5_000,
      });
    } catch {
      // The payload exiting non-zero is still execution. The probe asserts it.
    }
  }
}

async function readInstalledExecutables({
  root,
}: {
  root: string;
}): Promise<string[]> {
  const descriptors = await findFiles({
    dir: root,
    name: 'implementation.json',
  });
  const contents: string[] = [];
  for (const descriptorPath of descriptors) {
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as {
      executablePath?: string;
    };
    if (typeof descriptor.executablePath !== 'string') continue;
    const executable = join(dirname(descriptorPath), descriptor.executablePath);
    try {
      contents.push(await readFile(executable, 'utf8'));
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }
  return contents;
}

async function findFiles({
  dir,
  name,
}: {
  dir: string;
  name: string;
}): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return found;
    throw error;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await findFiles({ dir: path, name })));
    } else if (entry.name === name) {
      found.push(path);
    }
  }
  return found;
}

function implementationInstallIsPinned(recipe: {
  readonly files: ReadonlyArray<{ readonly path: string }>;
}): boolean {
  const hasInstallScript = recipe.files.some(file =>
    file.path.endsWith('/implementation/install.sh'),
  );
  if (hasInstallScript) return true;
  return recipe.files.some(file =>
    file.path.endsWith('/implementation/pnpm-lock.yaml'),
  );
}

function isEnoent(error: unknown): boolean {
  return (
    error != null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
