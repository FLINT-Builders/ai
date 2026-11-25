import { execFile } from 'node:child_process';
import { readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DefaultResourceLoader,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { buildSystemPrompt } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js';
import type { Experimental_SandboxSession } from '@ai-sdk/provider-utils';
import { shellQuote } from '../../harness/src/utils/shell-quote.ts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPiPathMapper } from './pi-paths';
import { createPiRemoteOps } from './pi-remote-ops';
import { PiWorkspaceVfs } from './pi-workspace-vfs';
import { syncHostWorkspaceFromSandbox } from './pi-workspace-mirror';

const MARKER = 'OUTSIDE_WORKSPACE_MARKER';

/**
 * A regular file that already lives directly in `/`. The mirror splits listing
 * records on tabs with a limit, so a newline name can select this kind of
 * absolute path without also injecting a parent directory.
 */
function findRootLevelFile(): string {
  for (const name of readdirSync('/')) {
    const candidate = path.posix.join('/', name);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // The entry disappeared or is not stat-able.
    }
  }
  throw new Error(
    'This test needs a regular file directly in / so the sandbox can bind the marker over it.',
  );
}

function execFileText(
  file: string,
  args: string[],
  input: string,
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = execFile(
      file,
      args,
      { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const exitCode =
          error == null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({
          exitCode,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        });
      },
    );
    child.stdin?.end(input);
  });
}

function createSandbox(input: {
  markerPath: string;
  rootFile: string;
}): Experimental_SandboxSession {
  return {
    description: 'native shell with a root-level marker file',
    async run({ command, workingDirectory, env }) {
      return execFileText(
        'unshare',
        [
          '--user',
          '--map-root-user',
          '--mount',
          'bash',
          '-c',
          'mount --bind "$PI_MARKER" "$PI_ROOT_FILE" && if [ -n "$PI_CWD" ]; then cd "$PI_CWD"; fi && bash -s',
        ],
        command,
        {
          ...process.env,
          ...env,
          PI_MARKER: input.markerPath,
          PI_ROOT_FILE: input.rootFile,
          PI_CWD: workingDirectory ?? '',
        },
      );
    },
    async readBinaryFile({ path: inputPath }) {
      const resolved =
        inputPath === input.rootFile ? input.markerPath : inputPath;
      try {
        return await readFile(resolved);
      } catch (error) {
        if ((error as { code?: unknown }).code === 'ENOENT') return null;
        throw error;
      }
    },
    async readFile() {
      throw new Error('unused');
    },
    async readTextFile() {
      throw new Error('unused');
    },
    async writeFile() {
      throw new Error('unused');
    },
    async writeBinaryFile() {
      throw new Error('unused');
    },
    async writeTextFile({ path: inputPath, content }) {
      await mkdir(path.posix.dirname(inputPath), { recursive: true });
      await writeFile(inputPath, content);
    },
    async spawn() {
      throw new Error('unused');
    },
  } as unknown as Experimental_SandboxSession;
}

function isWithinDirectory(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

async function collectFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (current: string) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  };
  await visit(rootDir);
  return files;
}

async function hostContainsMarker(hostWorkDir: string): Promise<boolean> {
  for (const file of await collectFiles(hostWorkDir)) {
    const bytes = await readFile(file);
    if (bytes.includes(Buffer.from(MARKER))) return true;
  }
  return false;
}

describe('newline filenames in the Pi workspace mirror', () => {
  let root: string;
  let sandboxWorkDir: string;
  let hostWorkDir: string;
  let agentDir: string;
  let markerPath: string;
  let rootFile: string;
  let sandbox: Experimental_SandboxSession;
  const sessionWorkDir = '/pi-newline-session-workspace';
  let vfs: PiWorkspaceVfs | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'pi-newline-mirror-'));
    sandboxWorkDir = path.join(root, 'sandbox', 'work');
    hostWorkDir = path.join(root, 'host');
    agentDir = path.join(root, 'agent');
    markerPath = path.join(root, 'marker');
    await mkdir(sandboxWorkDir, { recursive: true });
    await mkdir(hostWorkDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    rootFile = findRootLevelFile();
    sandbox = createSandbox({ markerPath, rootFile });
  });

  afterEach(() => {
    vfs?.unmount();
    vfs = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  async function plantWithWriteTool(relativePath: string): Promise<void> {
    const ops = createPiRemoteOps({
      sandbox,
      paths: createPiPathMapper({
        hostWorkDir,
        sandboxWorkDir,
      }),
    });
    await ops.writeFile(relativePath, 'planted');
  }

  async function syncMirror(): Promise<void> {
    try {
      await syncHostWorkspaceFromSandbox({
        sandbox,
        sandboxWorkDir,
        hostWorkDir,
      });
    } catch {
      // A throw after the copy still leaves the outside bytes on the host.
    }
  }

  async function systemPrompt(): Promise<string> {
    vfs = new PiWorkspaceVfs();
    vfs.mount(hostWorkDir, sessionWorkDir);
    try {
      const loader = new DefaultResourceLoader({
        cwd: sessionWorkDir,
        agentDir,
        settingsManager: SettingsManager.inMemory(),
        noExtensions: true,
        noThemes: true,
        noPromptTemplates: true,
        skillsOverride: base => ({
          ...base,
          skills: base.skills.filter(
            skill =>
              isWithinDirectory(sessionWorkDir, skill.filePath) ||
              isWithinDirectory(hostWorkDir, skill.filePath),
          ),
        }),
      });
      await loader.reload();
      return buildSystemPrompt({
        cwd: sessionWorkDir,
        skills: loader.getSkills().skills,
        contextFiles: loader.getAgentsFiles().agentsFiles,
        selectedTools: ['read', 'write', 'bash'],
      });
    } finally {
      vfs.unmount();
      vfs = undefined;
    }
  }

  it('does not mirror a root-level sandbox file into a skill or the system prompt', async () => {
    writeFileSync(
      markerPath,
      `---\nname: pwn\ndescription: ${MARKER}\n---\nbody\n`,
    );
    const probe = await sandbox.run({
      command: `cat ${shellQuote(rootFile)}`,
    });
    expect(probe.exitCode).toBe(0);
    expect(probe.stdout).toContain(MARKER);

    await plantWithWriteTool(
      `.agents/prefix\nf\t.agents/skills/pwn/SKILL.md\t${rootFile}`,
    );
    await syncMirror();

    expect(await hostContainsMarker(hostWorkDir)).toBe(false);
    expect(await systemPrompt()).not.toContain(MARKER);
  });

  it('does not mirror a root-level sandbox file into AGENTS.md or the system prompt', async () => {
    writeFileSync(markerPath, `${MARKER}\n`);
    const probe = await sandbox.run({
      command: `cat ${shellQuote(rootFile)}`,
    });
    expect(probe.exitCode).toBe(0);
    expect(probe.stdout).toContain(MARKER);

    await plantWithWriteTool(`.agents/prefix\nf\tAGENTS.md\t${rootFile}`);
    await syncMirror();

    expect(await hostContainsMarker(hostWorkDir)).toBe(false);
    expect(await systemPrompt()).not.toContain(MARKER);
  });
});
