import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:crypto';
import type * as NodeDns from 'node:dns';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:tls';
import { fileURLToPath } from 'node:url';

const entryPoint = process.env.TLS_RENEGOTIATION_ENTRY;
const localAddress = '1.2.3.4';
const requestedHost = 'files.example.com';

if (entryPoint) {
  await runChild(entryPoint);
} else {
  const { describe, expect, it } = await import('vitest');
  const certificateDirectory = mkdtempSync(
    join(tmpdir(), 'ai-sdk-tls-renegotiation-'),
  );
  ensureCertificates(certificateDirectory);

  describe('TLS 1.2 renegotiation through the download fetch', () => {
    it.each([
      'downloadBlob',
      'fetchWithValidatedRedirects',
      'fetchWithValidatedEndpoint',
      'getFromApi',
    ] as const)(
      '%s reports a mismatched renegotiated certificate instead of crashing',
      async entry => {
        const result = await runEntry(entry, certificateDirectory);
        expect(
          result.status,
          JSON.stringify({
            stderr: result.stderr,
            stdout: result.stdout,
            report: result.report,
          }),
        ).toBe(0);
        expect(
          result.report,
          JSON.stringify({
            status: result.status,
            stderr: result.stderr,
            stdout: result.stdout,
          }),
        ).toMatchObject({
          entry,
          handled: true,
          renegotiationStarted: true,
          code: 'ERR_TLS_CERT_ALTNAME_INVALID',
        });
      },
      20_000,
    );
  });

  process.on('exit', () => {
    rmSync(certificateDirectory, { recursive: true, force: true });
  });
}

async function runEntry(
  entry: string,
  certificateDirectory: string,
): Promise<{
  status: number | null;
  stderr: string;
  stdout: string;
  report: unknown;
}> {
  const childPath = fileURLToPath(import.meta.url);
  const child = spawn(
    'unshare',
    [
      '--user',
      '--map-root-user',
      '--net',
      process.execPath,
      '--import',
      resolveTsxRegister(),
      childPath,
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TLS_RENEGOTIATION_ENTRY: entry,
        TLS_RENEGOTIATION_CERT_DIR: certificateDirectory,
        NODE_EXTRA_CA_CERTS: join(certificateDirectory, 'ca.pem'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });

  const timeout = setTimeout(() => {
    child.kill('SIGKILL');
  }, 15_000);
  const [status] = await once(child, 'close');
  clearTimeout(timeout);

  let report: unknown;
  const line = stdout
    .trim()
    .split('\n')
    .find(item => item.startsWith('{'));
  if (line) {
    report = JSON.parse(line);
  }

  return { status, stderr, stdout, report };
}

function ensureCertificates(directory: string): void {
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-keyout',
    join(directory, 'ca-key.pem'),
    '-out',
    join(directory, 'ca.pem'),
    '-days',
    '2',
    '-nodes',
    '-subj',
    '/CN=Test CA',
  ]);
  issueCertificate({
    directory,
    name: 'matching',
    commonName: requestedHost,
    subjectAltName: `DNS:${requestedHost}`,
  });
  issueCertificate({
    directory,
    name: 'wrong',
    commonName: 'other.example.net',
    subjectAltName: 'DNS:other.example.net',
  });
}

function issueCertificate({
  directory,
  name,
  commonName,
  subjectAltName,
}: {
  directory: string;
  name: string;
  commonName: string;
  subjectAltName: string;
}): void {
  const key = join(directory, `${name}-key.pem`);
  const csr = join(directory, `${name}.csr`);
  const cert = join(directory, `${name}-cert.pem`);
  const extensionFile = join(directory, `${name}.ext`);
  writeFileSync(extensionFile, `subjectAltName=${subjectAltName}\n`);
  openssl([
    'req',
    '-newkey',
    'rsa:2048',
    '-keyout',
    key,
    '-out',
    csr,
    '-nodes',
    '-subj',
    `/CN=${commonName}`,
  ]);
  openssl([
    'x509',
    '-req',
    '-in',
    csr,
    '-CA',
    join(directory, 'ca.pem'),
    '-CAkey',
    join(directory, 'ca-key.pem'),
    '-CAserial',
    join(directory, 'ca.srl'),
    '-CAcreateserial',
    '-out',
    cert,
    '-days',
    '2',
    '-extfile',
    extensionFile,
  ]);
}

function openssl(args: string[]): void {
  const result = spawnSync('openssl', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || `openssl ${args.join(' ')} failed`);
  }
}

function resolveTsxRegister(): string {
  return resolve(
    fileURLToPath(new URL('../../..', import.meta.url)),
    'node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/esm/index.mjs',
  );
}

async function runChild(entry: string): Promise<void> {
  const directory = process.env.TLS_RENEGOTIATION_CERT_DIR;
  if (directory == null) {
    throw new Error('TLS_RENEGOTIATION_CERT_DIR is not set');
  }

  configureLoopback();
  patchDnsLookup();

  const matching = {
    key: readFileSync(join(directory, 'matching-key.pem')),
    cert: readFileSync(join(directory, 'matching-cert.pem')),
  };
  const wrongHost = {
    key: readFileSync(join(directory, 'wrong-key.pem')),
    cert: readFileSync(join(directory, 'wrong-cert.pem')),
  };

  let renegotiationStarted = false;
  const server = createServer(
    {
      ...matching,
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
      secureOptions: constants.SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION,
      ALPNProtocols: ['http/1.1'],
    },
    socket => {
      socket.on('error', () => {});
      socket.once('data', () => {
        setTimeout(() => {
          socket.setKeyCert(wrongHost);
          renegotiationStarted =
            socket.renegotiate(
              { requestCert: false, rejectUnauthorized: false },
              () => {},
            ) !== false;
        }, 50);
      });
    },
  );
  server.on('error', error => {
    process.stderr.write(`server error ${error.message}\n`);
    process.exit(1);
  });
  // 1.2.3.4 is a public address the download guard allows. It is assigned
  // inside this network namespace, so the socket never leaves the machine.
  server.listen(0, localAddress);
  await once(server, 'listening');
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('Expected a TCP listener');
  }

  const timeout = setTimeout(() => {
    console.error('timed out waiting for the certificate error');
    process.exit(1);
  }, 10_000);
  timeout.unref();

  process.on('uncaughtException', error => {
    console.error(error.stack ?? error);
    process.exit(9);
  });

  const url = `https://${requestedHost}:${address.port}/file`;
  try {
    await dispatch(entry, url);
    finish(1, {
      entry,
      handled: false,
      renegotiationStarted,
      code: null,
    });
  } catch (error) {
    const code = findErrorCode(error, 'ERR_TLS_CERT_ALTNAME_INVALID');
    finish(code == null || !renegotiationStarted ? 1 : 0, {
      entry,
      handled: code != null,
      renegotiationStarted,
      code,
    });
  }
}

function finish(status: number, report: unknown): void {
  process.stdout.write(`${JSON.stringify(report)}\n`, () => {
    process.exit(status);
  });
}

async function dispatch(entry: string, url: string): Promise<void> {
  if (entry === 'downloadBlob') {
    const { downloadBlob } = await import('./download-blob');
    await downloadBlob(url);
    return;
  }

  if (entry === 'fetchWithValidatedRedirects') {
    const { fetchWithValidatedRedirects } =
      await import('./fetch-with-validated-redirects');
    await fetchWithValidatedRedirects({ url });
    return;
  }

  if (entry === 'fetchWithValidatedEndpoint') {
    const { fetchWithValidatedEndpoint } =
      await import('./fetch-with-validated-redirects');
    await fetchWithValidatedEndpoint({ url });
    return;
  }

  if (entry === 'getFromApi') {
    const { getFromApi } = await import('./get-from-api');
    await getFromApi({
      url,
      validateUrl: true,
      failedResponseHandler: async () => ({
        value: new Error('failed response'),
      }),
      successfulResponseHandler: async ({ response }) => ({
        value: await response.text(),
      }),
    });
    return;
  }

  throw new Error(`Unknown entry point ${entry}`);
}

function configureLoopback(): void {
  const result = spawnSync(
    'python3',
    [
      '-c',
      `
import socket, struct, fcntl
SIOCGIFFLAGS = 0x8913
SIOCSIFFLAGS = 0x8914
SIOCSIFADDR = 0x8916
IFF_UP = 1
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
name = b'lo' + bytes(14)
buf = bytearray(name[:16] + bytes(16))
fcntl.ioctl(sock.fileno(), SIOCGIFFLAGS, buf)
flags = struct.unpack_from('H', buf, 16)[0]
fcntl.ioctl(
    sock.fileno(),
    SIOCSIFFLAGS,
    bytearray(name[:16]) + struct.pack('H', flags | IFF_UP) + bytes(14),
)
sockaddr = (
    struct.pack('H', socket.AF_INET)
    + struct.pack('>H', 0)
    + socket.inet_aton('${localAddress}')
    + bytes(8)
)
fcntl.ioctl(sock.fileno(), SIOCSIFADDR, name[:16] + sockaddr)
probe = socket.socket()
probe.bind(('${localAddress}', 0))
probe.close()
`,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(2);
  }
}

function patchDnsLookup(): void {
  const dns = process.getBuiltinModule('node:dns') as typeof NodeDns;
  const lookup = (
    hostname: string,
    options: unknown,
    callback?: (
      error: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ) => {
    const all =
      typeof options === 'object' &&
      options != null &&
      'all' in options &&
      options.all === true;
    const done = typeof options === 'function' ? options : callback;
    if (done == null) {
      return;
    }
    if (hostname !== requestedHost && hostname !== localAddress) {
      done(new Error(`Unexpected lookup for ${hostname}`), '', 0);
      return;
    }
    if (all) {
      (done as (error: null, addresses: LookupAddress[]) => void)(null, [
        { address: localAddress, family: 4 },
      ]);
      return;
    }
    done(null, localAddress, 4);
  };
  dns.lookup = lookup as typeof dns.lookup;
}

type LookupAddress = { address: string; family: number };

function findErrorCode(error: unknown, code: string): string | undefined {
  const seen = new Set<unknown>();
  const pending = [error];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current == null || typeof current !== 'object' || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const record = current as {
      code?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (record.code === code) {
      return code;
    }
    pending.push(record.cause);
    if (Array.isArray(record.errors)) {
      pending.push(...record.errors);
    }
  }
  return undefined;
}
