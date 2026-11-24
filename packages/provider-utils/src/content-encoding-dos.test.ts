import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Public download hosts are allowed through the SSRF guard. 192.0.2.0/24 is
 * blocked as documentation space; 192.0.3.10 is not, so the guarded fetch
 * will connect. The address is attached to loopback only for this test.
 */
const HOST = '192.0.3.10';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const harnessPath = path.join(
  repoRoot,
  'tools/content-encoding-dos-harness.mts',
);

const entries = [
  'redirects',
  'endpoint',
  'download-blob',
  'get-from-api',
  'ai-download',
  'ai-prompt-download',
  'ai-prompt-other-media',
  'google-tool-result',
  'mcp-metadata',
] as const;

function canListen(): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(0, HOST, () => {
      server.close(() => resolve(true));
    });
  });
}

function ensureHost(): void {
  const script = `
import fcntl, socket, struct
SIOCSIFADDR = 0x8916
SIOCSIFNETMASK = 0x891c
name = b'lo:0' + b'\\x00' * (16 - len(b'lo:0'))
def ifreq(ip):
    packed = socket.inet_aton(ip)
    return name + struct.pack('HH4s8s', socket.AF_INET, 0, packed, b'\\x00' * 8)
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
fcntl.ioctl(sock.fileno(), SIOCSIFADDR, ifreq('${HOST}'))
fcntl.ioctl(sock.fileno(), SIOCSIFNETMASK, ifreq('255.255.255.255'))
`;
  execFileSync('sudo', ['-n', 'python3', '-c', script], { stdio: 'inherit' });
}

function tsxLoader(): string {
  const require = createRequire(
    path.join(repoRoot, 'packages/ai/package.json'),
  );
  return require.resolve('tsx');
}

function runEntry(entry: (typeof entries)[number]): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      ['--import', tsxLoader(), harnessPath, entry],
      {
        cwd: repoRoot,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 20_000);

    child.once('error', error => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once('close', status => {
      clearTimeout(timer);
      resolvePromise({
        status,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

beforeAll(async () => {
  if (!(await canListen())) {
    ensureHost();
  }
  expect(await canListen()).toBe(true);
});

describe('undici content-encoding close does not kill the process', () => {
  it.each(entries)(
    '%s rejects the response and the process stays alive',
    async entry => {
      const result = await runEntry(entry);
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.status, output).toBe(0);
      expect(output).toContain('SERVED');
      expect(output).toMatch(/SERVED [1-9]/);
      expect(output).toContain('SURVIVED');
      expect(output).not.toContain('ResponseContentLengthMismatchError');

      if (entry !== 'mcp-metadata') {
        expect(output).toContain('too many content-encodings');
      }
    },
    30_000,
  );
});
