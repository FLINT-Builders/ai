import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// These tests fail while the installed `next` dev server answers cross-site
// requests for its MCP endpoint and the other dev endpoints behind the same
// guard. They pass once that server rejects the requests.

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const require = createRequire(path.join(repoRoot, 'package.json'));
const execFileAsync = promisify(execFile);

function declaredNextVersion() {
  const manifest = require(path.join(repoRoot, 'package.json'));
  const spec = manifest.devDependencies?.next ?? manifest.dependencies?.next;
  if (!spec) throw new Error('The repository package.json does not declare next');
  return spec;
}

const attackerOrigin = 'http://evil.example';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function writeFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'next-dev-cross-site-'));
  await mkdir(path.join(directory, 'app/api/health'), { recursive: true });
  await writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({
      name: 'next-dev-cross-site-fixture',
      private: true,
      dependencies: {
        next: declaredNextVersion(),
        react: '19.2.3',
        'react-dom': '19.2.3',
      },
    }),
  );
  await writeFile(
    path.join(directory, 'app/layout.js'),
    "export default function RootLayout({ children }) { return <html><body>{children}</body></html>; }\n",
  );
  await writeFile(
    path.join(directory, 'app/page.js'),
    "export default function Page() { return <h1>fixture</h1>; }\n",
  );
  await writeFile(
    path.join(directory, 'app/api/health/route.js'),
    "export function GET() { return Response.json({ ok: true }); }\n",
  );
  await execFileAsync(
    'npm',
    ['install', '--silent', '--no-audit', '--no-fund', '--ignore-scripts'],
    { cwd: directory },
  );
  return directory;
}

function startDevServer(directory, port) {
  const nextBin = path.join(directory, 'node_modules/next/dist/bin/next');
  const child = spawn(
    process.execPath,
    [nextBin, 'dev', '--port', String(port), '--hostname', '127.0.0.1'],
    {
      cwd: directory,
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', chunk => {
    output += chunk.toString();
  });
  child.stderr.on('data', chunk => {
    output += chunk.toString();
  });
  return { child, readOutput: () => output };
}

async function waitForReady(port, child, readOutput) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(
        `next dev exited ${child.exitCode} before it was ready\n${readOutput()}`,
      );
    }
    try {
      const response = await sendHttp({
        port,
        method: 'GET',
        path: '/',
        headers: { host: `127.0.0.1:${port}` },
      });
      if (response.status === 200) return;
    } catch {
      // The server is still booting.
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`next dev did not become ready\n${readOutput()}`);
}

function sendHttp({ port, method, path: requestPath, headers, body }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(body);
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: requestPath,
        headers: {
          ...headers,
          ...(payload ? { 'content-length': payload.length } : {}),
        },
      },
      response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        const finish = () =>
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        response.on('end', finish);
        response.on('error', reject);
        setTimeout(() => {
          request.destroy();
          finish();
        }, 1500);
      },
    );
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function crossSiteHeaders(port) {
  return {
    host: `evil.example:${port}`,
    origin: `${attackerOrigin}:${port}`,
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
  };
}

function toolCall(name, id) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: {} },
  });
}

function sendUpgrade(port, requestPath) {
  const request = [
    `GET ${requestPath} HTTP/1.1`,
    `Host: evil.example:${port}`,
    `Origin: ${attackerOrigin}:${port}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-Fetch-Site: cross-site',
    '',
    '',
  ].join('\r\n');
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
    const chunks = [];
    const finish = () => {
      socket.destroy();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    socket.on('data', chunk => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 2048) finish();
    });
    socket.on('error', reject);
    socket.setTimeout(1500, finish);
  });
}

function assertRejected(response, label) {
  assert.equal(
    response.status,
    403,
    `${label} was handled (${response.status}): ${response.body.slice(0, 240)}`,
  );
  assert.equal(response.body, 'Unauthorized', label);
}

test('next dev rejects cross-site reads of dev server internals', async t => {
  const port = await freePort();
  const directory = await writeFixture();
  const { child, readOutput } = startDevServer(directory, port);
  t.after(async () => {
    if (child.exitCode == null) {
      child.kill('SIGTERM');
      await Promise.race([
        once(child, 'exit'),
        new Promise(resolve => setTimeout(resolve, 5000)),
      ]);
      if (child.exitCode == null) child.kill('SIGKILL');
    }
    await rm(directory, { recursive: true, force: true });
  });

  await waitForReady(port, child, readOutput);

  const mcpHeaders = {
    ...crossSiteHeaders(port),
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  const cases = [
    [
      'project metadata',
      '/_next/mcp?x=/_next/image',
      toolCall('get_project_metadata', 1),
    ],
    [
      'route inventory',
      '/_next/mcp?x=/_next/static/media',
      toolCall('get_routes', 2),
    ],
    [
      'development logs',
      '/_next/mcp?x=/_next/static/immutable/media/dev.log',
      toolCall('get_logs', 3),
    ],
    [
      'error reports',
      '/_next/mcp?ignored=/_next/image',
      toolCall('get_errors', 4),
    ],
    [
      'mcp path prefix',
      '/_next/mcp/extra?x=/_next/image',
      toolCall('get_project_metadata', 5),
    ],
  ];

  for (const [label, requestPath, body] of cases) {
    const response = await sendHttp({
      port,
      method: 'POST',
      path: requestPath,
      headers: mcpHeaders,
      body,
    });
    assertRejected(response, label);
    assert.equal(response.body.includes(directory), false, label);
    assert.equal(response.body.includes('projectPath'), false, label);
    assert.equal(response.body.includes('appRouter'), false, label);
    assert.equal(response.body.includes('logFilePath'), false, label);
  }

  const sameOriginRebind = await sendHttp({
    port,
    method: 'POST',
    path: '/_next/mcp?x=/_next/image',
    headers: {
      ...mcpHeaders,
      'sec-fetch-site': 'same-origin',
    },
    body: toolCall('get_project_metadata', 6),
  });
  assertRejected(sameOriginRebind, 'rebinding origin');

  const status = await sendHttp({
    port,
    method: 'GET',
    path: '/__nextjs_server_status?x=/_next/image',
    headers: crossSiteHeaders(port),
  });
  assertRejected(status, 'dev server status');
  assert.equal(status.body.includes('executionId'), false);

  const frames = await sendHttp({
    port,
    method: 'POST',
    path: '/__nextjs_original-stack-frames?x=/_next/static/media',
    headers: {
      ...crossSiteHeaders(port),
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assertRejected(frames, 'original stack frames');

  const upgrade = await sendUpgrade(port, '/_next/hmr?x=/_next/image');
  assert.equal(
    upgrade.startsWith('HTTP/1.1 101'),
    false,
    `HMR upgrade was accepted: ${upgrade.slice(0, 240)}`,
  );
  assert.equal(upgrade.includes('Unauthorized'), true, upgrade.slice(0, 240));
  assert.equal(upgrade.includes('isrManifest'), false);
  assert.equal(upgrade.includes('turbopack-connected'), false);
});
