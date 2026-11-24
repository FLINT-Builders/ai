/**
 * Server Action replies are decoded with FormData.get, which scans every
 * stored field. A reply with one outlined value per field therefore spends
 * time proportional to the square of the field count and holds the Node
 * process until that scan finishes. The patched decoder indexes fields in a
 * map, so the same reply no longer delays a request that arrives while it
 * is being decoded.
 *
 * This test fails on the locked vulnerable Next.js release and passes once
 * that release is upgraded to the fixed one. It drives the production
 * server, not a reimplementation of the decoder.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

const BODY_LIMIT_BYTES = 1024 * 1024;
const FIELD_COUNT = 14000;
const HEALTH_BUDGET_MS = 200;

function lockedNextVersion() {
  const lockfile = fs.readFileSync(
    path.join(repoRoot, 'pnpm-lock.yaml'),
    'utf8',
  );
  const match = lockfile.match(/^ {2}next@(\d+\.\d+\.\d+):$/m);
  assert.ok(match, 'pnpm-lock.yaml does not pin a next version');
  return match[1];
}

function outlinedReply(fieldCount) {
  const boundary = 'b';
  const parts = [];
  const references = new Array(fieldCount);
  for (let id = 1; id <= fieldCount; id++) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${id}"\r\n\r\n0\r\n`,
    );
    // Outlined ids are decimal field names and hexadecimal references.
    references[id - 1] = `$${id.toString(16)}`;
  }
  // One action argument, so decoding is not rejected by the argument cap.
  const root = JSON.stringify([references]);
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="0"\r\n\r\n${root}\r\n`,
  );
  parts.push(`--${boundary}--\r\n`);
  return {
    body: Buffer.from(parts.join('')),
    boundary,
  };
}

function writeFixture(directory) {
  fs.mkdirSync(path.join(directory, 'app', 'api', 'health'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify(
      {
        name: 'server-action-reply-availability',
        private: true,
        dependencies: {
          next: lockedNextVersion(),
          react: '19.2.6',
          'react-dom': '19.2.6',
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(directory, 'next.config.mjs'),
    'export default {};\n',
  );
  fs.writeFileSync(
    path.join(directory, 'app', 'actions.js'),
    "'use server';\nexport async function ping() {}\n",
  );
  fs.writeFileSync(
    path.join(directory, 'app', 'page.js'),
    "import { ping } from './actions';\nexport default function Page() {\n  return (\n    <form action={ping}>\n      <button type=\"submit\">go</button>\n    </form>\n  );\n}\n",
  );
  fs.writeFileSync(
    path.join(directory, 'app', 'layout.js'),
    'export default function RootLayout({ children }) {\n  return (\n    <html>\n      <body>{children}</body>\n    </html>\n  );\n}\n',
  );
  fs.writeFileSync(
    path.join(directory, 'app', 'api', 'health', 'route.js'),
    "export function GET() {\n  return new Response('ok');\n}\n",
  );
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
    });
    child.stderr.on('data', chunk => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve(output);
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(' ')} exited ${code}\n${output.slice(-4000)}`,
        ),
      );
    });
  });
}

async function buildFixture(directory) {
  await run('npm', ['install', '--silent'], directory);
  try {
    await run('npx', ['next', 'build'], directory);
  } catch {
    // The Next.js CLI can stop once on a security notice and continue on retry.
    await run('npx', ['next', 'build'], directory);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function startServer(directory, port) {
  const child = spawn(
    'npx',
    ['next', 'start', '-H', '127.0.0.1', '-p', String(port)],
    {
      cwd: directory,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', chunk => {
    output += chunk;
  });
  child.stderr.on('data', chunk => {
    output += chunk;
  });
  return {
    child,
    output: () => output,
    stop() {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    },
  };
}

function request(port, { method, requestPath, headers, body }) {
  return new Promise((resolve, reject) => {
    const startedAt = process.hrtime.bigint();
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path: requestPath,
        headers,
      },
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            elapsedMs:
              Number(process.hrtime.bigint() - startedAt) / 1_000_000,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (body) {
      req.end(body);
    } else {
      req.end();
    }
  });
}

async function waitForHealth(port, output) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await request(port, {
        method: 'GET',
        requestPath: '/api/health',
      });
      if (response.status === 200) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(
    `server did not become ready: ${lastError}\n${output().slice(-2000)}`,
  );
}

function actionId(directory) {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(directory, '.next/server/server-reference-manifest.json'),
      'utf8',
    ),
  );
  const id = Object.keys(manifest.node).find(
    key => manifest.node[key].exportedName === 'ping',
  );
  assert.equal(typeof id, 'string');
  assert.equal(id.length, 42);
  return id;
}

test(
  'a server action reply under the body limit does not block another request',
  { timeout: 180_000 },
  async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'server-action-reply-'),
    );
    const port = await freePort();
    let server;
    try {
      writeFixture(directory);
      await buildFixture(directory);
      server = startServer(directory, port);
      await waitForHealth(port, server.output);

      const idle = await request(port, {
        method: 'GET',
        requestPath: '/api/health',
      });
      assert.equal(idle.status, 200);
      assert.ok(
        idle.elapsedMs < HEALTH_BUDGET_MS,
        `idle health took ${idle.elapsedMs}ms`,
      );

      const reply = outlinedReply(FIELD_COUNT);
      assert.ok(
        reply.body.length < BODY_LIMIT_BYTES,
        `reply is ${reply.body.length} bytes`,
      );

      const action = request(port, {
        method: 'POST',
        requestPath: '/',
        headers: {
          'content-type': `multipart/form-data; boundary=${reply.boundary}`,
          'content-length': String(reply.body.length),
          'next-action': actionId(directory),
          host: `127.0.0.1:${port}`,
        },
        body: reply.body,
      });
      await new Promise(resolve => setTimeout(resolve, 20));
      const during = await request(port, {
        method: 'GET',
        requestPath: '/api/health',
      });
      const posted = await action;

      assert.equal(
        posted.status,
        200,
        `action response ${posted.status}: ${posted.body.slice(0, 300)}`,
      );
      assert.equal(during.status, 200);
      assert.ok(
        during.elapsedMs < HEALTH_BUDGET_MS,
        `health request took ${Math.round(during.elapsedMs)}ms while a server action reply was decoded`,
      );
    } finally {
      server?.stop();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
