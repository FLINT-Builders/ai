/**
 * Spec for the Release workflow's post-publish installs.
 *
 * These tests fail while a job that can mint an npm publish OIDC token, or
 * that passes a write-scoped GITHUB_TOKEN, executes code from a package
 * version chosen by an unpinned registry range. They pass once those steps
 * no longer do that.
 *
 * Run:
 *   node --test .github/scripts/release-install-privileges.test.mjs
 *
 * The workflow installs Node 24, whose bundled npm is 11.19.1
 * (nodejs.org/dist/v24.22.3). Run this file with that npm on PATH when
 * checking the release job's installer.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const workflowPath = path.join(repoRoot, '.github/workflows/release.yml');

const PLACEHOLDER_GITHUB_TOKEN = 'placeholder-github-token';
const PLACEHOLDER_OIDC_REQUEST_TOKEN = 'placeholder-oidc-request-token';
const PLACEHOLDER_PUBLISH_TOKEN = 'placeholder-npm-publish-token';
const MALICIOUS_NAME = 'release-install-probe';
const MALICIOUS_VERSION = '1.0.0';

const WRITE_PERMISSIONS = [
  'actions',
  'contents',
  'deployments',
  'discussions',
  'issues',
  'packages',
  'pages',
  'pull-requests',
  'repository-projects',
  'security-events',
  'statuses',
];

test('workflow parser finds multiline install steps and job permissions', () => {
  const parsed = parseWorkflow(`
name: Example
on: push
permissions:
  contents: read
jobs:
  build:
    permissions:
      id-token: write
      contents: write
    steps:
      - name: Install helper
        run: |
          cd .github/scripts/notify-released
          npm install --no-save
          node index.mjs
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`);
  assert.equal(parsed.jobs.build.permissions['id-token'], 'write');
  assert.equal(parsed.jobs.build.permissions.contents, 'write');
  assert.equal(parsed.jobs.build.steps.length, 1);
  assert.match(parsed.jobs.build.steps[0].run, /npm install --no-save/);
  assert.equal(
    parsed.jobs.build.steps[0].env.GITHUB_TOKEN,
    '${{ secrets.GITHUB_TOKEN }}',
  );
});

test(
  'release installs do not run unpinned registry code with publish credentials',
  { timeout: 180_000 },
  async () => {
    const workflow = parseWorkflow(await readFile(workflowPath, 'utf8'));
    const targets = installSteps(workflow);
    assert.ok(
      targets.length > 0,
      'expected the release workflow to contain package-manager install steps',
    );

    const records = [];
    const server = await startRegistry();
    try {
      for (const target of targets) {
        const stepRecords = await runInstallStep(target, server);
        records.push(...stepRecords.map(record => ({ step: target.name, ...record })));
      }
    } finally {
      await server.close();
    }

    const exposed = records.filter(record => credentialVisible(record));
    assert.deepEqual(
      exposed,
      [],
      'package code resolved from an unpinned range ran with the release job credentials',
    );
  },
);

function credentialVisible(record) {
  return (
    record.sawGithubToken === true ||
    record.idTokenReceived === true ||
    record.publishTokenReceived === true ||
    (record.sawOidcUrl === true && record.sawOidcRequestToken === true)
  );
}

/**
 * Install steps inside a job whose permissions let a step request an OIDC
 * token or pass a write-scoped GITHUB_TOKEN. pnpm installs of the workspace
 * root are not included: that tree is pinned by pnpm-lock.yaml.
 */
function installSteps(workflow) {
  const workflowPermissions = workflow.permissions || {};
  const steps = [];
  for (const [jobName, job] of Object.entries(workflow.jobs || {})) {
    const permissions = job.permissions || workflowPermissions;
    const oidc = permissions['id-token'] === 'write';
    const tokenWrite = WRITE_PERMISSIONS.some(key => permissions[key] === 'write');
    if (!oidc && !tokenWrite) {
      continue;
    }
    for (const step of job.steps || []) {
      const run = typeof step.run === 'string' ? step.run : '';
      if (!/\bnpm\s+(install|ci|update|add)\b/.test(run)) {
        continue;
      }
      const passesToken = Object.prototype.hasOwnProperty.call(
        step.env || {},
        'GITHUB_TOKEN',
      );
      if (!oidc && !(tokenWrite && passesToken)) {
        continue;
      }
      steps.push({
        jobName,
        name: step.name || run.split('\n')[0],
        run,
        oidc,
        githubToken: tokenWrite && passesToken,
      });
    }
  }
  return steps;
}

async function runInstallStep(target, server) {
  const root = await mkdtemp(path.join(tmpdir(), 'release-install-'));
  const marker = path.join(root, 'marker.ndjson');
  try {
    await copyScripts(root);
    const env = {
      PATH: process.env.PATH,
      HOME: path.join(root, 'home'),
      TMPDIR: path.join(root, 'tmp'),
      npm_config_registry: server.registry,
      npm_config_cache: path.join(root, 'npm-cache'),
      npm_config_update_notifier: 'false',
      SUPPLY_CHAIN_MARKER: marker,
    };
    await mkdir(env.HOME, { recursive: true });
    await mkdir(env.TMPDIR, { recursive: true });
    if (target.githubToken) {
      env.GITHUB_TOKEN = PLACEHOLDER_GITHUB_TOKEN;
    }
    if (target.oidc) {
      env.ACTIONS_ID_TOKEN_REQUEST_URL = server.oidcUrl;
      env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = PLACEHOLDER_OIDC_REQUEST_TOKEN;
    }

    const scriptPath = path.join(root, 'step.sh');
    await writeFile(scriptPath, target.run);
    let exitError = null;
    try {
      await spawnChecked(
        'bash',
        ['--noprofile', '--norc', '-e', '-o', 'pipefail', scriptPath],
        { cwd: root, env },
      );
    } catch (error) {
      exitError = error;
    }
    const records = await readMarker(marker);
    // A helper script can exit because release inputs are absent. That is
    // independent of whether package code saw the job credentials. Surface
    // the exit only when this step is still the unpinned install and no
    // package code ran at all, which means the exercise itself failed.
    if (records.length === 0 && exitError && (await stillUnpinned(root, target.run))) {
      throw exitError;
    }
    return records;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function stillUnpinned(root, run) {
  if (!/\bnpm\s+install\b/.test(run) || /\b--ignore-scripts\b/.test(run)) {
    return false;
  }
  const directories = [root];
  for (const match of run.matchAll(/(?:^|\n)\s*cd\s+([^\s;&]+)/g)) {
    directories.push(path.resolve(root, match[1]));
  }
  for (const directory of directories) {
    const lockfile = path.join(directory, 'package-lock.json');
    try {
      await readFile(lockfile);
      return false;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return true;
}

async function copyScripts(root) {
  await cp(path.join(repoRoot, '.github/scripts'), path.join(root, '.github/scripts'), {
    recursive: true,
    filter: source => !source.split(path.sep).includes('node_modules'),
  });
}

async function readMarker(marker) {
  let text = '';
  try {
    text = await readFile(marker, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  return text
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line));
}

function spawnChecked(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(' ')} exited ${code}\n${stdout}\n${stderr}`,
        ),
      );
    });
  });
}

async function startRegistry() {
  const packs = await buildProbePackages();
  const upstreamCache = new Map();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/oidc/token') {
        await handleOidc(request, url, response);
        return;
      }
      if (
        request.method === 'POST' &&
        url.pathname.startsWith('/-/npm/v1/oidc/token/exchange/package/')
      ) {
        await handleExchange(request, url, response);
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(404);
        response.end();
        return;
      }
      const packed = packs.byPath.get(url.pathname);
      if (packed) {
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': packed.bytes.length,
        });
        response.end(request.method === 'HEAD' ? undefined : packed.bytes);
        return;
      }
      if (url.pathname === '/octokit' || url.pathname === '/octokit/') {
        const body = await octokitPackument(upstreamCache, packs.octokitManifest);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
        return;
      }
      if (
        url.pathname === `/${MALICIOUS_NAME}` ||
        url.pathname === `/${MALICIOUS_NAME}/`
      ) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(packs.probePackument));
        return;
      }
      await proxyRegistry(request, url, response);
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(error.stack || error.message);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const registry = `http://127.0.0.1:${port}/`;
  packs.octokitManifest.dist.tarball = `${registry}octokit/-/octokit-${packs.octokitVersion}.tgz`;
  packs.probePackument.versions[MALICIOUS_VERSION].dist.tarball =
    `${registry}${MALICIOUS_NAME}/-/${MALICIOUS_NAME}-${MALICIOUS_VERSION}.tgz`;
  return {
    registry,
    oidcUrl: `${registry}oidc/token`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      }),
  };
}

function handleOidc(request, url, response) {
  const header = request.headers.authorization || '';
  const audience = url.searchParams.get('audience');
  const authorized = header === `Bearer ${PLACEHOLDER_OIDC_REQUEST_TOKEN}`;
  if (!authorized || !audience) {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: 'unauthorized' }));
    return;
  }
  const payload = Buffer.from(
    JSON.stringify({
      repository: 'vercel/ai',
      workflow_ref: 'vercel/ai/.github/workflows/release.yml@refs/heads/main',
      aud: audience,
    }),
  ).toString('base64url');
  const value = `eyJhbGciOiJub25lIn0.${payload}.placeholder`;
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ value }));
}

async function handleExchange(request, url, response) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  void Buffer.concat(chunks);
  const header = request.headers.authorization || '';
  if (!header.startsWith('Bearer ') || header.length < 'Bearer ey'.length) {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: 'unauthorized' }));
    return;
  }
  const packageName = decodeURIComponent(
    url.pathname.slice('/-/npm/v1/oidc/token/exchange/package/'.length),
  );
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      token: PLACEHOLDER_PUBLISH_TOKEN,
      package: packageName,
    }),
  );
}

async function octokitPackument(cache, manifest) {
  let upstream = cache.get('octokit');
  if (!upstream) {
    const response = await fetch('https://registry.npmjs.org/octokit', {
      headers: {
        accept:
          'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*',
      },
    });
    if (!response.ok) {
      throw new Error(`upstream octokit packument returned ${response.status}`);
    }
    upstream = await response.json();
    cache.set('octokit', upstream);
  }
  const versions = { ...upstream.versions, [manifest.version]: manifest };
  const distTags = { ...(upstream['dist-tags'] || {}), latest: manifest.version };
  return { ...upstream, versions, 'dist-tags': distTags };
}

async function proxyRegistry(request, url, response) {
  const upstreamUrl = new URL(url.pathname + url.search, 'https://registry.npmjs.org');
  const upstream = await fetch(upstreamUrl, {
    method: request.method,
    headers: { accept: request.headers.accept || '*/*' },
  });
  const body = Buffer.from(await upstream.arrayBuffer());
  const headers = {};
  const type = upstream.headers.get('content-type');
  if (type) {
    headers['content-type'] = type;
  }
  response.writeHead(upstream.status, headers);
  response.end(request.method === 'HEAD' ? undefined : body);
}

async function buildProbePackages() {
  const root = await mkdtemp(path.join(tmpdir(), 'release-probe-'));
  try {
    const probeDir = path.join(root, 'probe', 'package');
    const octokitDir = path.join(root, 'octokit', 'package');
    await mkdir(probeDir, { recursive: true });
    await mkdir(octokitDir, { recursive: true });
    await writeFile(path.join(probeDir, 'payload.js'), probeSource(MALICIOUS_NAME));
    await writeFile(
      path.join(probeDir, 'package.json'),
      JSON.stringify({
        name: MALICIOUS_NAME,
        version: MALICIOUS_VERSION,
        type: 'module',
        exports: './payload.js',
        scripts: {
          preinstall: 'node payload.js',
          install: 'node payload.js',
          postinstall: 'node payload.js',
        },
      }),
    );
    const octokitVersion = '5.99.0';
    await writeFile(path.join(octokitDir, 'payload.js'), probeSource('octokit'));
    await writeFile(
      path.join(octokitDir, 'index.js'),
      `import '${MALICIOUS_NAME}';\nimport './payload.js';\nexport class Octokit {}\n`,
    );
    await writeFile(
      path.join(octokitDir, 'package.json'),
      JSON.stringify({
        name: 'octokit',
        version: octokitVersion,
        type: 'module',
        exports: './index.js',
        dependencies: { [MALICIOUS_NAME]: MALICIOUS_VERSION },
        scripts: {
          preinstall: 'node payload.js',
          install: 'node payload.js',
          postinstall: 'node payload.js',
        },
      }),
    );
    const probeTar = await packDirectory(probeDir);
    const octokitTar = await packDirectory(octokitDir);
    const probeMeta = tarballMeta(probeTar);
    const octokitMeta = tarballMeta(octokitTar);
    const octokitManifest = {
      name: 'octokit',
      version: octokitVersion,
      dependencies: { [MALICIOUS_NAME]: MALICIOUS_VERSION },
      scripts: {
        preinstall: 'node payload.js',
        install: 'node payload.js',
        postinstall: 'node payload.js',
      },
      dist: {
        tarball: '',
        shasum: octokitMeta.shasum,
        integrity: octokitMeta.integrity,
      },
      hasInstallScript: true,
    };
    const probePackument = {
      name: MALICIOUS_NAME,
      'dist-tags': { latest: MALICIOUS_VERSION },
      versions: {
        [MALICIOUS_VERSION]: {
          name: MALICIOUS_NAME,
          version: MALICIOUS_VERSION,
          dist: {
            tarball: '',
            shasum: probeMeta.shasum,
            integrity: probeMeta.integrity,
          },
          hasInstallScript: true,
          scripts: {
            preinstall: 'node payload.js',
            install: 'node payload.js',
            postinstall: 'node payload.js',
          },
        },
      },
    };
    const byPath = new Map([
      [`/${MALICIOUS_NAME}/-/${MALICIOUS_NAME}-${MALICIOUS_VERSION}.tgz`, { bytes: probeTar }],
      [`/octokit/-/octokit-${octokitVersion}.tgz`, { bytes: octokitTar }],
    ]);
    return { byPath, octokitManifest, octokitVersion, probePackument };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function tarballMeta(bytes) {
  return {
    shasum: createHash('sha1').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  };
}

function packDirectory(packageDir) {
  const archive = path.join(path.dirname(packageDir), 'package.tgz');
  return spawnChecked('tar', ['-czf', archive, '-C', path.dirname(packageDir), 'package']).then(
    () => readFile(archive),
  );
}

function probeSource(packageName) {
  return `
const fs = await import('node:fs');
const phase = process.env.npm_lifecycle_event || 'module-load';
const record = {
  packageName: ${JSON.stringify(packageName)},
  phase,
  sawGithubToken: Boolean(process.env.GITHUB_TOKEN),
  sawOidcUrl: Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL),
  sawOidcRequestToken: Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN),
  idTokenReceived: false,
  publishTokenReceived: false,
};
try {
  if (record.sawOidcUrl && record.sawOidcRequestToken) {
    const registry = process.env.npm_config_registry || 'https://registry.npmjs.org/';
    const audience = 'npm:' + new URL(registry).hostname;
    const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
    url.searchParams.append('audience', audience);
    const tokenResponse = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer ' + process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
      },
    });
    const tokenBody = await tokenResponse.json();
    if (tokenResponse.ok && tokenBody.value) {
      record.idTokenReceived = true;
      const exchange = new URL('/-/npm/v1/oidc/token/exchange/package/ai', registry);
      const exchangeResponse = await fetch(exchange, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + tokenBody.value,
          'Content-Type': 'application/json',
        },
      });
      const exchangeBody = await exchangeResponse.json();
      record.publishTokenReceived = Boolean(exchangeResponse.ok && exchangeBody.token);
    }
  }
} catch (error) {
  record.error = error instanceof Error ? error.name : 'Error';
}
if (process.env.SUPPLY_CHAIN_MARKER) {
  fs.appendFileSync(process.env.SUPPLY_CHAIN_MARKER, JSON.stringify(record) + '\\n');
}
`;
}

function parseWorkflow(source) {
  const lines = source.split(/\r?\n/);
  let index = 0;

  function peek() {
    while (index < lines.length) {
      const raw = lines[index];
      if (/^\s*(#.*)?$/.test(raw)) {
        index += 1;
        continue;
      }
      const indent = raw.match(/^ */)[0].length;
      return { indent, text: raw.slice(indent), line: index };
    }
    return null;
  }

  function parseBlock(indent) {
    const first = peek();
    if (!first || first.indent < indent) {
      return null;
    }
    if (first.text.startsWith('- ')) {
      const list = [];
      while (peek() && peek().indent === first.indent && peek().text.startsWith('- ')) {
        const itemLine = peek();
        index = itemLine.line + 1;
        const rest = itemLine.text.slice(2);
        let item;
        if (rest === '' || rest === '|' || rest === '|-' || rest === '|-') {
          item = rest.startsWith('|') ? parseLiteral(itemLine.indent + 2) : parseBlock(itemLine.indent + 2);
        } else if (rest.includes(': ') || rest.endsWith(':')) {
          const keyValue = parseKeyValue(rest, itemLine.indent + 2);
          item = { [keyValue.key]: keyValue.value };
          const more = parseMapping(itemLine.indent + 2);
          if (more) {
            Object.assign(item, more);
          }
        } else {
          item = parseScalar(rest);
        }
        list.push(item);
      }
      return list;
    }
    return parseMapping(first.indent);
  }

  function parseMapping(indent) {
    const mapping = {};
    let any = false;
    while (peek() && peek().indent === indent && !peek().text.startsWith('- ')) {
      const current = peek();
      index = current.line + 1;
      const keyValue = parseKeyValue(current.text, indent);
      mapping[keyValue.key] = keyValue.value;
      any = true;
    }
    return any ? mapping : null;
  }

  function parseKeyValue(text, indent) {
    const splitAt = text.indexOf(':');
    if (splitAt === -1) {
      throw new Error(`expected key: value, received ${text}`);
    }
    const key = parseScalar(text.slice(0, splitAt));
    const rest = text.slice(splitAt + 1).trim();
    let value;
    if (rest === '' || rest === '|' || rest === '|-' || rest === '>') {
      if (rest.startsWith('|')) {
        value = parseLiteral(indent + 2);
      } else if (rest === '>') {
        value = parseLiteral(indent + 2).replace(/\n/g, ' ').trim();
      } else {
        value = parseBlock(indent + 2);
      }
    } else {
      value = parseScalar(rest);
    }
    return { key, value };
  }

  function parseLiteral(minIndent) {
    const collected = [];
    while (index < lines.length) {
      const raw = lines[index];
      if (/^\s*$/.test(raw)) {
        collected.push('');
        index += 1;
        continue;
      }
      const indent = raw.match(/^ */)[0].length;
      if (indent < minIndent) {
        break;
      }
      collected.push(raw.slice(minIndent));
      index += 1;
    }
    while (collected.length > 0 && collected[collected.length - 1] === '') {
      collected.pop();
    }
    return collected.join('\n');
  }

  function parseScalar(text) {
    const comment = text.search(/\s+#/);
    const value = (comment === -1 ? text : text.slice(0, comment)).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1);
    }
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null' || value === '~') return null;
    return value;
  }

  const document = parseBlock(0);
  return document || {};
}
