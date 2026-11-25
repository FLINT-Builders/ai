import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { posix } from 'node:path';
import { promisify } from 'node:util';
import { prepareSandboxForHarness } from '@ai-sdk/harness/agent';
import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';
import { describe, expect, it } from 'vitest';
import { createCursor } from './cursor-harness';

const execFileAsync = promisify(execFile);

/**
 * Sandbox bootstrap must not execute bytes fetched from a live installer URL.
 * A fixed harness either verifies those bytes against a digest before running
 * them, or installs from a frozen lockfile that carries package integrity.
 * Each fetch returns a different response. Executing either one, including
 * after a check that used the other, is a failure, and so is deleting the
 * workspace canary or leaving the response's marker in the sandbox.
 */
describe('cursor harness installer supply chain', () => {
  it('does not execute an unpinned installer while bootstrapping cursor', async () => {
    await expectBootstrapRejectsUntrustedInstaller({
      createHarness: () => createCursor(),
      credentialEnvironmentNames: ['CURSOR_API_KEY'],
    });
  });
});

async function expectBootstrapRejectsUntrustedInstaller({
  createHarness,
  credentialEnvironmentNames,
}: {
  readonly createHarness: () => {
    readonly harnessId: string;
    readonly getBootstrap?: (options?: {
      readonly abortSignal?: AbortSignal;
    }) => PromiseLike<{
      readonly bootstrapDir: string;
      readonly files: ReadonlyArray<{
        readonly path: string;
        readonly content: string;
      }>;
      readonly commands: ReadonlyArray<{ readonly command: string }>;
    }>;
  };
  readonly credentialEnvironmentNames: ReadonlyArray<string>;
}): Promise<void> {
  const harness = createHarness();
  if (harness.getBootstrap == null) {
    throw new Error(`${harness.harnessId} does not expose a bootstrap recipe.`);
  }
  const recipe = await harness.getBootstrap();
  const implementationCommand = recipe.commands.find(command =>
    command.command.includes('implementation'),
  );
  if (implementationCommand == null) {
    throw new Error(
      `${harness.harnessId} bootstrap has no implementation install command.`,
    );
  }
  const installScript =
    recipe.files.find(file => file.path.endsWith('/implementation/install.sh'))
      ?.content ?? '';
  const installerText = `${installScript}\n${implementationCommand.command}`;
  const referencesUrl = /https?:\/\//.test(installerText);
  const hasDigestCheck =
    /sha(?:256|384|512)sum|\bshasum\b|openssl\s+dgst|createHash\(|crypto\.subtle/.test(
      installerText,
    );
  const lockfile = recipe.files.find(file =>
    file.path.endsWith('/implementation/pnpm-lock.yaml'),
  )?.content;
  const usesFrozenLock =
    implementationCommand.command.includes('--frozen-lockfile') &&
    lockfile != null &&
    /integrity:\s*sha(?:256|384|512)-/.test(lockfile);
  const descriptorFile = recipe.files.find(file =>
    file.path.endsWith('/implementation/implementation.json'),
  );
  if (descriptorFile == null) {
    throw new Error(
      `${harness.harnessId} bootstrap does not write an implementation descriptor.`,
    );
  }
  const declaredDescriptor = JSON.parse(descriptorFile.content) as {
    executablePath?: string;
  };
  if (typeof declaredDescriptor.executablePath !== 'string') {
    throw new Error(
      `${harness.harnessId} implementation descriptor has no executablePath.`,
    );
  }

  const sandboxRoot = await mkdtemp(
    posix.join(tmpdir(), `ai-sdk-${harness.harnessId}-sandbox-`),
  );
  const stateDir = await mkdtemp(
    posix.join(tmpdir(), `ai-sdk-${harness.harnessId}-installer-`),
  );
  const tokenPrefix = `untrusted-installer-${randomBytes(8).toString('hex')}`;
  const canaryPath = posix.join(sandboxRoot, 'project', 'canary.txt');
  const workspacePath = posix.join(sandboxRoot, 'project', 'source.txt');
  const canaryContent = 'canary-present\n';
  const workspaceContent = 'workspace-source\n';
  const executionLogPath = posix.join(stateDir, 'execution.log');
  const bootstrapDir = posix.resolve(sandboxRoot, recipe.bootstrapDir);
  const binaryPath = posix.join(
    bootstrapDir,
    'implementation',
    declaredDescriptor.executablePath,
  );
  await mkdir(posix.dirname(canaryPath), { recursive: true });
  await writeFile(canaryPath, canaryContent);
  await writeFile(workspacePath, workspaceContent);
  await writeFile(
    posix.join(stateDir, 'downloader.js'),
    downloaderStub({
      stateDir,
      tokenPrefix,
      executionLogPath,
      canaryPath,
      workspacePath,
      binaryPath,
    }),
  );
  await writeFile(
    posix.join(stateDir, 'pnpm'),
    `#!/bin/sh
if [ "$1" = "install" ] && [ "$2" = "--frozen-lockfile" ] && [ "$3" = "--store-dir" ] && [ "$4" = ".pnpm-store" ]; then
  exit 0
fi
echo "unexpected pnpm invocation: $*" >&2
exit 1
`,
  );
  await chmod(posix.join(stateDir, 'downloader.js'), 0o755);
  await chmod(posix.join(stateDir, 'pnpm'), 0o755);
  const { session, executedCommands } = createBashSandboxSession({
    sandboxRoot,
    stateDir,
  });

  let bootstrapError: unknown;
  try {
    await prepareSandboxForHarness({
      session,
      harnesses: [harness as never],
    });
  } catch (error) {
    bootstrapError = error;
  }

  try {
    const descriptorPath = posix.resolve(sandboxRoot, descriptorFile.path);
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as {
      envKeys?: readonly string[];
      executablePath?: string;
    };
    const executionLog = await readFile(executionLogPath, 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      },
    );
    const urls = await readFile(posix.join(stateDir, 'urls'), 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      },
    );
    const fetchCount = Number(
      await readFile(posix.join(stateDir, 'count'), 'utf8').catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return '0';
          throw error;
        },
      ),
    );
    const tokenInSandbox = await findNeedle(sandboxRoot, tokenPrefix);
    const canary = await readFile(canaryPath, 'utf8').catch(() => 'missing');
    const workspace = await readFile(workspacePath, 'utf8').catch(
      () => 'missing',
    );
    const launchedBinary = posix.resolve(
      bootstrapDir,
      'implementation',
      descriptor.executablePath ?? declaredDescriptor.executablePath,
    );
    const launchedBinaryText = await readFile(launchedBinary, 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      },
    );
    const remoteResponseExecuted =
      executionLog.includes(tokenPrefix) ||
      launchedBinaryText.includes(tokenPrefix) ||
      tokenInSandbox != null ||
      canary !== canaryContent ||
      workspace !== workspaceContent;
    const supplyPinned =
      usesFrozenLock ||
      (referencesUrl &&
        hasDigestCheck &&
        fetchCount > 0 &&
        !remoteResponseExecuted);

    const observed = {
      credentialEnvironmentNames: descriptor.envKeys,
      implementationCommandRan: executedCommands.includes(
        implementationCommand.command,
      ),
      remoteResponseExecuted,
      supplyPinned,
      executionLog,
      urls,
      fetchCount,
      tokenInSandbox,
      canary,
      workspace,
      bootstrapError:
        bootstrapError instanceof Error
          ? bootstrapError.message
          : bootstrapError == null
            ? undefined
            : String(bootstrapError),
    };
    expect(observed, JSON.stringify(observed, null, 2)).toMatchObject({
      credentialEnvironmentNames: expect.arrayContaining([
        ...credentialEnvironmentNames,
      ]),
      implementationCommandRan: true,
      remoteResponseExecuted: false,
      supplyPinned: true,
      executionLog: '',
      tokenInSandbox: undefined,
      canary: canaryContent,
      workspace: workspaceContent,
    });
  } finally {
    await rm(sandboxRoot, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
}

function createBashSandboxSession({
  sandboxRoot,
  stateDir,
}: {
  readonly sandboxRoot: string;
  readonly stateDir: string;
}): {
  readonly session: SandboxSession;
  readonly executedCommands: string[];
} {
  const executedCommands: string[] = [];
  const downloader = posix.join(stateDir, 'downloader.js');
  const session = {
    async readTextFile({ path }: { path: string }) {
      return readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
    },
    async writeTextFile({ path, content }: { path: string; content: string }) {
      await mkdir(posix.dirname(path), { recursive: true });
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
      executedCommands.push(command);
      // VercelSandboxSession and JustBashSandboxSession both execute
      // `bash -c <command>`. The user namespace only stands in for the
      // network: curl and wget are the successive untrusted responses, and
      // no other fetch can leave the sandbox.
      const wrapper = [
        'set -euo pipefail',
        'mount --bind "$1" /usr/bin/curl',
        'mount --bind "$1" /bin/curl',
        'if [ -e /usr/bin/wget ]; then mount --bind "$1" /usr/bin/wget; fi',
        'if [ -e /bin/wget ]; then mount --bind "$1" /bin/wget; fi',
        'export PATH="$2:${PATH:-/usr/bin:/bin}"',
        'exec bash -c "$3"',
      ].join('\n');
      try {
        const { stdout, stderr } = await execFileAsync(
          'unshare',
          [
            '-r',
            '-m',
            '-n',
            'bash',
            '-c',
            wrapper,
            'bash',
            downloader,
            stateDir,
            command,
          ],
          {
            cwd: workingDirectory ?? sandboxRoot,
            env: { ...process.env, ...env },
            encoding: 'utf8',
            timeout: 20_000,
          },
        );
        return { exitCode: 0, stdout, stderr };
      } catch (error) {
        const failed = error as NodeJS.ErrnoException & {
          stdout?: string;
          stderr?: string;
          code?: number | string;
        };
        if (typeof failed.code === 'number') {
          return {
            exitCode: failed.code,
            stdout: failed.stdout ?? '',
            stderr: failed.stderr ?? '',
          };
        }
        throw error;
      }
    },
  };
  return { session: session as unknown as SandboxSession, executedCommands };
}

function downloaderStub({
  stateDir,
  tokenPrefix,
  executionLogPath,
  canaryPath,
  workspacePath,
  binaryPath,
}: {
  readonly stateDir: string;
  readonly tokenPrefix: string;
  readonly executionLogPath: string;
  readonly canaryPath: string;
  readonly workspacePath: string;
  readonly binaryPath: string;
}): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const stateDir = ${JSON.stringify(stateDir)};
const tokenPrefix = ${JSON.stringify(tokenPrefix)};
const executionLogPath = ${JSON.stringify(executionLogPath)};
const canaryPath = ${JSON.stringify(canaryPath)};
const workspacePath = ${JSON.stringify(workspacePath)};
const binaryPath = ${JSON.stringify(binaryPath)};
const countPath = path.join(stateDir, 'count');
const urlsPath = path.join(stateDir, 'urls');
let count = 0;
if (fs.existsSync(countPath)) {
  count = Number(fs.readFileSync(countPath, 'utf8')) || 0;
}
count += 1;
fs.writeFileSync(countPath, String(count));
const args = process.argv.slice(2);
let outputPath;
const urls = [];
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (
    arg === '--output' ||
    arg === '-o' ||
    arg === '-O' ||
    arg === '--output-document'
  ) {
    const next = args[index + 1];
    if (next != null && !next.startsWith('-')) {
      outputPath = next;
      index += 1;
    } else if (arg === '-O') {
      outputPath = 'REMOTE';
    }
    continue;
  }
  if (arg.startsWith('--output=')) {
    outputPath = arg.slice('--output='.length);
    continue;
  }
  if (arg.startsWith('--output-document=')) {
    outputPath = arg.slice('--output-document='.length);
    continue;
  }
  if (/^https?:\\/\\//.test(arg)) urls.push(arg);
}
fs.appendFileSync(urlsPath, urls.join(' ') + '\\n');
function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\\\''") + "'";
}
const token = tokenPrefix + '-' + count;
const body = [
  'printf ' + shellQuote('%s\\\\n') + ' ' + shellQuote(token) + ' >> ' + shellQuote(executionLogPath),
  'rm -f -- ' + shellQuote(canaryPath) + ' ' + shellQuote(workspacePath),
  'mkdir -p ' + shellQuote(path.dirname(binaryPath)),
  'printf ' + shellQuote('%s\\\\n') + ' ' + shellQuote(token) + ' > ' + shellQuote(binaryPath),
  'chmod +x ' + shellQuote(binaryPath),
  '',
].join('\\n');
if (outputPath == null || outputPath === '-') {
  process.stdout.write(body);
} else {
  let file = outputPath;
  if (file === 'REMOTE') {
    const url = urls[urls.length - 1] || 'setup.sh';
    file = path.basename(new URL(url).pathname) || 'setup.sh';
  }
  fs.writeFileSync(file, body);
}
`;
}

async function findNeedle(
  root: string,
  needle: string,
): Promise<string | undefined> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const encoded = Buffer.from(needle);
  for (const entry of entries) {
    const full = posix.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = await findNeedle(full, needle);
      if (found != null) return found;
    } else if (entry.isFile()) {
      const bytes = await readFile(full).catch(() => undefined);
      if (bytes != null && bytes.includes(encoded)) return full;
    }
  }
  return undefined;
}
