import { describe, expect, it } from 'vitest';
import { createVerifiedArchiveInstallCommand } from './verified-archive-install-command';

const SHA256 = 'a'.repeat(64);

describe('createVerifiedArchiveInstallCommand', () => {
  it('pins each platform archive to its digest', () => {
    const command = createVerifiedArchiveInstallCommand({
      archives: {
        'linux-x64': {
          url: 'https://example.com/1.0.0/linux-x64.tar.gz',
          sha256: SHA256,
        },
        'darwin-arm64': {
          url: 'https://example.com/1.0.0/darwin-arm64.tar.gz',
          sha256: 'b'.repeat(64),
        },
      },
      installDir: '.local/share/example/versions/1.0.0',
      stripComponents: 1,
      executables: { example: 'bin/example' },
    });

    expect(command).toContain(
      `Linux-x86_64|Linux-amd64) archive_url='https://example.com/1.0.0/linux-x64.tar.gz'; archive_sha256='${SHA256}' ;;`,
    );
    expect(command).toContain(
      `Darwin-arm64|Darwin-aarch64) archive_url='https://example.com/1.0.0/darwin-arm64.tar.gz'; archive_sha256='${'b'.repeat(64)}' ;;`,
    );
    expect(command).not.toContain('Linux-aarch64');
    expect(command).toContain(
      'tar --strip-components=1 -xzf "$archive" -C "$download_dir/extract"',
    );
    expect(command).toContain(
      `ln -sfn "$install_dir/"'bin/example' "$HOME/.local/bin/"'example'`,
    );
    expect(command).not.toMatch(/\|\s*(ba)?sh\b/);
  });

  it('verifies the digest before extracting', () => {
    const command = createVerifiedArchiveInstallCommand({
      archives: {
        'linux-x64': { url: 'https://example.com/a.tar.gz', sha256: SHA256 },
      },
      installDir: 'example',
      executables: { example: 'example' },
    });

    const comparison = command.indexOf(
      'if [ "$actual_sha256" != "$archive_sha256" ]; then',
    );
    expect(comparison).toBeGreaterThan(-1);
    expect(command.indexOf('tar ')).toBeGreaterThan(comparison);
    expect(command.match(/^\s*curl /gm)).toHaveLength(1);
    expect(command.match(/^\s*wget /gm)).toHaveLength(1);
  });

  it('rejects archives without an HTTPS URL', () => {
    expect(() =>
      createVerifiedArchiveInstallCommand({
        archives: {
          'linux-x64': { url: 'http://example.com/a.tar.gz', sha256: SHA256 },
        },
        installDir: 'example',
        executables: { example: 'example' },
      }),
    ).toThrow('must use HTTPS');
  });

  it('rejects malformed digests', () => {
    expect(() =>
      createVerifiedArchiveInstallCommand({
        archives: {
          'linux-x64': {
            url: 'https://example.com/a.tar.gz',
            sha256: 'A'.repeat(64),
          },
        },
        installDir: 'example',
        executables: { example: 'example' },
      }),
    ).toThrow('64 lowercase hexadecimal characters');
  });

  it('requires at least one archive', () => {
    expect(() =>
      createVerifiedArchiveInstallCommand({
        archives: {},
        installDir: 'example',
        executables: { example: 'example' },
      }),
    ).toThrow('at least one archive');
  });

  it.each(['/opt/example', '../example', 'a/./b', 'a b', ''])(
    'rejects install directory %j',
    installDir => {
      expect(() =>
        createVerifiedArchiveInstallCommand({
          archives: {
            'linux-x64': {
              url: 'https://example.com/a.tar.gz',
              sha256: SHA256,
            },
          },
          installDir,
          executables: { example: 'example' },
        }),
      ).toThrow('installDir must be a relative path');
    },
  );

  it('rejects invalid executable names and paths', () => {
    const archives = {
      'linux-x64': { url: 'https://example.com/a.tar.gz', sha256: SHA256 },
    };
    expect(() =>
      createVerifiedArchiveInstallCommand({
        archives,
        installDir: 'example',
        executables: { '../example': 'example' },
      }),
    ).toThrow('executable name is invalid');
    expect(() =>
      createVerifiedArchiveInstallCommand({
        archives,
        installDir: 'example',
        executables: { example: '../example' },
      }),
    ).toThrow('executables.example must be a relative path');
    expect(() =>
      createVerifiedArchiveInstallCommand({
        archives,
        installDir: 'example',
        executables: {},
      }),
    ).toThrow('at least one executable');
  });

  it('rejects invalid strip component counts', () => {
    expect(() =>
      createVerifiedArchiveInstallCommand({
        archives: {
          'linux-x64': { url: 'https://example.com/a.tar.gz', sha256: SHA256 },
        },
        installDir: 'example',
        stripComponents: -1,
        executables: { example: 'example' },
      }),
    ).toThrow('non-negative integer');
  });
});
