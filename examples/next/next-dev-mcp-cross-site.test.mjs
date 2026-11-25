import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createServer } from 'node:net';

const require = createRequire(import.meta.url);

// These requests are what a page on another origin sends to `next dev`.
// They must not receive project metadata, routes, logs, or error-report
// source locations. `next` 16.3.3 serves them; 16.3.8 refuses them.
const ATTACKER_ORIGIN = 'https://evil.example';
const BYPASS_PATHS = [
  '/_next/mcp?x=/_next/image',
  '/_next/mcp?x=/_next/static/media',
  '/_next/mcp?x=/_next/static/immutable/media',
  '/_next/image/../mcp',
  '/_next/static/media/../../mcp',
  '/_next/static/immutable/media/../../../mcp',
  '/foo/../_next/mcp?x=/_next/image',
];

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => (error ? reject(error) : resolve(port)));
    });
    server.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toolCall(name, args = {}) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

function postMcp(port, path, { origin, host, body }) {
  return new Promise((resolve, reject) => {
    const headers = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Sec-Fetch-Site': origin ? 'cross-site' : 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
    };
    if (origin) headers.Origin = origin;
    if (host) headers.Host = host;
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers,
      },
      response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

function disclosures(body, projectDir) {
  const hits = [];
  for (const needle of [projectDir, 'projectPath', 'logFilePath', '"appRouter"']) {
    if (body.includes(needle)) hits.push(needle);
  }
  if (body.includes('event: message') || body.includes('"jsonrpc"')) {
    for (const needle of [
      'marker-should-not-leak',
      'app/page.js',
      'actions.js',
    ]) {
      if (body.includes(needle)) hits.push(needle);
    }
  }
  return hits;
}

function writeFixture(appDir) {
  mkdirSync(join(appDir, 'app'), { recursive: true });
  writeFileSync(
    join(appDir, 'app/layout.js'),
    `export default function RootLayout({ children }) {
  return <html><body>{children}</body></html>;
}
`,
  );
  writeFileSync(
    join(appDir, 'app/page.js'),
    `export default function Page() {
  throw new Error('marker-should-not-leak');
}
`,
  );
  writeFileSync(
    join(appDir, 'app/actions.js'),
    `'use server';
export async function registeredAction() {
  return 'ok';
}
`,
  );
  mkdirSync(join(appDir, 'app/act'), { recursive: true });
  writeFileSync(
    join(appDir, 'app/act/page.js'),
    `import { registeredAction } from '../actions';
export default function ActPage() {
  return <form action={registeredAction}><button type="submit">run</button></form>;
}
`,
  );
  const modulesDir = join(appDir, 'node_modules');
  mkdirSync(modulesDir, { recursive: true });
  symlinkSync(dirname(require.resolve('next/package.json')), join(modulesDir, 'next'));
  symlinkSync(dirname(require.resolve('react/package.json')), join(modulesDir, 'react'));
  symlinkSync(
    dirname(require.resolve('react-dom/package.json')),
    join(modulesDir, 'react-dom'),
  );
}

async function startNext(appDir) {
  const port = await freePort();
  const nextBin = join(dirname(require.resolve('next/package.json')), 'dist/bin/next');
  const child = spawn(
    process.execPath,
    [nextBin, 'dev', '-p', String(port), '-H', '127.0.0.1'],
    {
      cwd: appDir,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
        NODE_ENV: 'development',
        NEXT_TELEMETRY_DISABLED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let log = '';
  child.stdout.on('data', chunk => {
    log += chunk;
  });
  child.stderr.on('data', chunk => {
    log += chunk;
  });
  const deadline = Date.now() + 60_000;
  let seen = false;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`next dev exited early\n${log.slice(-2000)}`);
    }
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      seen = true;
      break;
    } catch {
      await sleep(200);
    }
  }
  if (!seen) {
    child.kill('SIGTERM');
    throw new Error(`next dev did not accept connections\n${log.slice(-2000)}`);
  }
  return {
    port,
    async stop() {
      if (child.exitCode != null) return;
      child.kill('SIGTERM');
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        sleep(3_000).then(() => child.kill('SIGKILL')),
      ]);
    },
  };
}

function actionIds(appDir) {
  const manifestPath = join(
    appDir,
    '.next/dev/server/server-reference-manifest.json',
  );
  if (!existsSync(manifestPath)) return [];
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return Object.keys(manifest.node ?? {}).filter(
    id => manifest.node[id] && typeof manifest.node[id] === 'object',
  );
}

async function openErrorPage(port) {
  const chrome = process.env.CHROME_PATH || 'google-chrome';
  const debugPort = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'mcp-chrome-'));
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debugPort}`,
      `http://127.0.0.1:${port}/`,
    ],
    { stdio: 'ignore' },
  );
  const deadline = Date.now() + 15_000;
  let version;
  while (Date.now() < deadline) {
    if (child.exitCode != null) break;
    try {
      version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
      break;
    } catch {
      await sleep(200);
    }
  }
  return {
    connected: Boolean(version),
    async stop() {
      child.kill('SIGTERM');
      await sleep(200);
      rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    },
  };
}

test(
  'next dev does not give a cross-site page the project path, routes, logs, or error locations',
  { timeout: 180_000 },
  async () => {
    const appDir = mkdtempSync(join(tmpdir(), 'next-dev-mcp-'));
    writeFixture(appDir);
    const server = await startNext(appDir);
    let browser;
    const problems = [];
    try {
      await fetch(`http://127.0.0.1:${server.port}/act`);
      browser = await openErrorPage(server.port);

      const local = await postMcp(server.port, '/_next/mcp', {
        body: toolCall('get_project_metadata'),
      });
      if (!local.body.includes('projectPath') || !local.body.includes(appDir)) {
        problems.push(
          `a same-machine request without an Origin header did not receive project metadata (status ${local.status})`,
        );
      }

      if (browser?.connected) {
        const deadline = Date.now() + 15_000;
        let primed = false;
        while (Date.now() < deadline) {
          const probe = await postMcp(server.port, BYPASS_PATHS[0], {
            origin: ATTACKER_ORIGIN,
            body: toolCall('get_errors'),
          });
          if (
            probe.status === 403 ||
            probe.body.includes('marker-should-not-leak')
          ) {
            primed = true;
            break;
          }
          await sleep(250);
        }
        if (!primed) {
          problems.push(
            'the browser session never produced an error report and the endpoint did not refuse the cross-site request',
          );
        }
      }

      const calls = [
        ['get_project_metadata', {}],
        ['get_routes', {}],
        ['get_logs', {}],
        ['get_errors', {}],
        ['get_page_metadata', {}],
        ['get_compilation_issues', {}],
        ['get_server_action_by_id', { actionId: 'missing-action' }],
      ];
      for (const id of actionIds(appDir)) {
        calls.push(['get_server_action_by_id', { actionId: id }]);
      }

      const hosts = [
        { origin: ATTACKER_ORIGIN, host: undefined },
        {
          origin: `http://evil.test:${server.port}`,
          host: `evil.test:${server.port}`,
        },
      ];

      for (const path of BYPASS_PATHS) {
        for (const host of hosts) {
          for (const [name, args] of calls) {
            const response = await postMcp(server.port, path, {
              origin: host.origin,
              host: host.host,
              body: toolCall(name, args),
            });
            const hits = disclosures(response.body, appDir);
            if (hits.length > 0) {
              problems.push(
                `${host.origin} ${path} ${name} status ${response.status} disclosed ${hits.join(', ')}: ${response.body.slice(0, 400).replaceAll('\n', ' ')}`,
              );
            }
          }
        }
      }
    } finally {
      try {
        await browser?.stop();
      } catch {
        // Chrome can still be releasing its profile after the process exits.
      }
      await server.stop();
      try {
        rmSync(appDir, { recursive: true, force: true });
      } catch {
        // The dev server can release its output directory after exit.
      }
    }

    assert.deepEqual(problems, []);
  },
);
