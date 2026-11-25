import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createVerifiedArchiveInstallCommand } from '@ai-sdk/harness/utils';
import { describe, expect, it } from 'vitest';
import {
  type ACPImplementation,
  getImplementationInstallScript,
} from './implementation';

const execFileAsync = promisify(execFile);

describe('getImplementationInstallScript', () => {
  it('installs into the harness-owned implementation directory', async () => {
    const implementation = {
      source: {
        type: 'install-command',
        command: [
          'mkdir -p "$HOME/.local/share/acp-agent/versions/1.0.0" "$HOME/.local/bin"',
          `printf '#!/usr/bin/env bash\\nexit 0\\n' > "$HOME/.local/share/acp-agent/versions/1.0.0/acp-agent"`,
          'chmod +x "$HOME/.local/share/acp-agent/versions/1.0.0/acp-agent"',
          'ln -s "$HOME/.local/share/acp-agent/versions/1.0.0/acp-agent" "$HOME/.local/bin/acp-agent"',
          'pwd > "$HOME/install-working-directory.txt"',
        ].join('\n'),
      },
      executable: 'acp-agent',
    } as const satisfies ACPImplementation;
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'ai-sdk-harness-acp-install-'),
    );
    const implementationDirectory = join(
      temporaryDirectory,
      '.harness-bootstrap',
      'example-acp',
      'implementation',
    );
    const ambientHome = join(temporaryDirectory, 'ambient-home');
    const scriptPath = join(implementationDirectory, 'install.sh');
    await mkdir(implementationDirectory, { recursive: true });
    await mkdir(ambientHome, { recursive: true });
    await writeFile(
      scriptPath,
      getImplementationInstallScript({ implementation })!,
    );

    try {
      await execFileAsync('bash', [scriptPath], {
        env: { ...process.env, HOME: ambientHome },
      });

      const installationHome = join(implementationDirectory, 'home');
      const executableTarget = join(
        installationHome,
        '.local',
        'share',
        'acp-agent',
        'versions',
        '1.0.0',
        'acp-agent',
      );
      await expect(
        realpath(join(installationHome, '.local', 'bin', 'acp-agent')),
      ).resolves.toBe(await realpath(executableTarget));
      await expect(
        readFile(
          join(installationHome, 'install-working-directory.txt'),
          'utf8',
        ),
      ).resolves.toBe(`${implementationDirectory}\n`);
      await expect(
        access(join(ambientHome, '.local', 'bin', 'acp-agent')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('fails when the download side of an installer pipeline fails', async () => {
    const implementation = {
      source: {
        type: 'install-command',
        command: 'false | true',
      },
      executable: 'acp-agent',
    } as const satisfies ACPImplementation;
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'ai-sdk-harness-acp-install-'),
    );
    const scriptPath = join(temporaryDirectory, 'install.sh');
    await writeFile(
      scriptPath,
      getImplementationInstallScript({ implementation })!,
    );

    try {
      await expect(execFileAsync('bash', [scriptPath])).rejects.toMatchObject({
        code: 1,
      });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

const ARCHIVE_TOOLS = [
  'bash',
  'cat',
  'chmod',
  'cut',
  'dirname',
  'gzip',
  'ln',
  'mkdir',
  'mktemp',
  'mv',
  'rm',
  'sha256sum',
  'shasum',
  'tar',
  'uname',
];

const DOWNLOADER_STAND_IN = `#!/bin/bash
set -euo pipefail
count=$(( $(cat "$DOWNLOAD_STATE/count" 2>/dev/null || printf 0) + 1 ))
printf '%s' "$count" > "$DOWNLOAD_STATE/count"
output=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o|-O) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
response="$DOWNLOAD_STATE/response-$count"
[ -f "$response" ] || response="$DOWNLOAD_STATE/response"
cat "$response" > "$output"
`;

describe('getImplementationInstallScript with a verified archive', () => {
  it('installs the archive whose digest matches', async () => {
    await withArchiveFixture(async fixture => {
      await fixture.serve({ response: fixture.genuineArchive });

      await fixture.install();

      await expect(
        execFileAsync(join(fixture.installationHome, '.local/bin/acp-agent')),
      ).resolves.toMatchObject({ stdout: 'genuine\n' });
      await expect(fixture.downloadCount()).resolves.toBe(1);
    });
  });

  it('refuses a tampered archive without extracting or executing it', async () => {
    await withArchiveFixture(async fixture => {
      await fixture.serve({
        'response-1': fixture.tamperedArchive,
        response: fixture.genuineArchive,
      });

      await expect(fixture.install()).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('SHA-256 mismatch'),
      });

      await expect(fixture.downloadCount()).resolves.toBe(1);
      await expect(
        access(join(fixture.installationHome, '.local/bin/acp-agent')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        access(join(fixture.installationHome, '.local/share/acp-agent')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(fixture.tamperMarker)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  it('verifies archives downloaded with wget', async () => {
    await withArchiveFixture(
      async fixture => {
        await fixture.serve({ 'response-1': fixture.tamperedArchive });

        await expect(fixture.install()).rejects.toMatchObject({
          stderr: expect.stringContaining('SHA-256 mismatch'),
        });
        await expect(
          access(join(fixture.installationHome, '.local/bin/acp-agent')),
        ).rejects.toMatchObject({ code: 'ENOENT' });

        await fixture.serve({ response: fixture.genuineArchive });
        await fixture.install();
        await expect(
          execFileAsync(join(fixture.installationHome, '.local/bin/acp-agent')),
        ).resolves.toMatchObject({ stdout: 'genuine\n' });
      },
      { downloader: 'wget' },
    );
  });
});

async function withArchiveFixture(
  run: (fixture: {
    genuineArchive: Buffer;
    tamperedArchive: Buffer;
    tamperMarker: string;
    installationHome: string;
    serve: (responses: Record<string, Buffer>) => Promise<void>;
    install: () => Promise<unknown>;
    downloadCount: () => Promise<number>;
  }) => Promise<void>,
  { downloader = 'curl' }: { downloader?: 'curl' | 'wget' } = {},
): Promise<void> {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'ai-sdk-harness-acp-verified-archive-'),
  );
  try {
    const toolDirectory = join(temporaryDirectory, 'tools');
    const stateDirectory = join(temporaryDirectory, 'download-state');
    const tamperMarker = join(temporaryDirectory, 'tampered-executed');
    await mkdir(toolDirectory, { recursive: true });
    await mkdir(stateDirectory, { recursive: true });
    for (const tool of ARCHIVE_TOOLS) {
      const resolved = await execFileAsync('bash', [
        '-c',
        `command -v ${tool} || true`,
      ]);
      const toolPath = resolved.stdout.trim();
      if (toolPath.length > 0) {
        await symlink(toolPath, join(toolDirectory, tool));
      }
    }
    const downloaderPath = join(toolDirectory, downloader);
    await writeFile(downloaderPath, DOWNLOADER_STAND_IN);
    await chmod(downloaderPath, 0o755);

    const genuineArchive = await createArchive({
      directory: join(temporaryDirectory, 'genuine'),
      script: `#!/bin/sh\necho genuine\n`,
    });
    const tamperedArchive = await createArchive({
      directory: join(temporaryDirectory, 'tampered'),
      script: `#!/bin/sh\necho tampered > '${tamperMarker}'\n`,
    });
    const archive = {
      url: 'https://downloads.example.com/acp-agent/1.0.0/acp-agent.tar.gz',
      sha256: createHash('sha256').update(genuineArchive).digest('hex'),
    };
    const implementation = {
      source: {
        type: 'install-command',
        command: createVerifiedArchiveInstallCommand({
          archives: {
            'linux-x64': archive,
            'linux-arm64': archive,
            'darwin-x64': archive,
            'darwin-arm64': archive,
          },
          installDir: '.local/share/acp-agent/versions/1.0.0',
          stripComponents: 1,
          executables: { 'acp-agent': 'acp-agent' },
        }),
      },
      executable: 'acp-agent',
    } as const satisfies ACPImplementation;
    const implementationDirectory = join(temporaryDirectory, 'implementation');
    const scriptPath = join(implementationDirectory, 'install.sh');
    await mkdir(implementationDirectory, { recursive: true });
    await writeFile(
      scriptPath,
      getImplementationInstallScript({ implementation })!,
    );

    await run({
      genuineArchive,
      tamperedArchive,
      tamperMarker,
      installationHome: join(implementationDirectory, 'home'),
      serve: async responses => {
        await rm(stateDirectory, { recursive: true, force: true });
        await mkdir(stateDirectory, { recursive: true });
        for (const [name, content] of Object.entries(responses)) {
          await writeFile(join(stateDirectory, name), content);
        }
      },
      install: () =>
        execFileAsync(join(toolDirectory, 'bash'), [scriptPath], {
          env: {
            PATH: toolDirectory,
            HOME: join(temporaryDirectory, 'ambient-home'),
            TMPDIR: temporaryDirectory,
            DOWNLOAD_STATE: stateDirectory,
          },
        }),
      downloadCount: async () =>
        Number(await readFile(join(stateDirectory, 'count'), 'utf8')),
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function createArchive({
  directory,
  script,
}: {
  directory: string;
  script: string;
}): Promise<Buffer> {
  const packageDirectory = join(directory, 'package');
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(packageDirectory, 'acp-agent'), script);
  await chmod(join(packageDirectory, 'acp-agent'), 0o755);
  const archivePath = join(directory, 'archive.tar.gz');
  await execFileAsync('tar', ['-czf', archivePath, '-C', directory, 'package']);
  return readFile(archivePath);
}
