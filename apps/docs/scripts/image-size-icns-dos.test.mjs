import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import test from 'node:test';

/**
 * ICNS with a valid magic and file length, and an icon entry whose length is 0.
 * image-size detects this from the leading "icns" bytes, then never advances
 * the parser offset.
 */
function craftedIcns() {
  const body = Buffer.alloc(16);
  body.write('icns', 0, 'ascii');
  body.writeUInt32BE(body.length, 4);
  body.write('ic07', 8, 'ascii');
  body.writeUInt32BE(0, 12);
  return body;
}

function startServer() {
  const requests = [];
  const server = createServer((request, response) => {
    const body = craftedIcns();
    requests.push({ url: request.url, bytes: body.length });
    response.writeHead(200, {
      'content-type': 'image/gif',
      'content-length': String(body.length),
    });
    response.end(body);
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        port: typeof address === 'object' && address ? address.port : 0,
        requests,
      });
    });
  });
}

function runPipeline(url) {
  const worker = new URL(
    './image-size-icns-pipeline-worker.mjs',
    import.meta.url,
  );
  const cwd = new URL('..', import.meta.url);

  return new Promise(resolve => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        worker.pathname,
        url,
      ],
      { cwd: cwd.pathname, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    let settled = false;
    let parseTimer;

    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(importTimer);
      clearTimeout(parseTimer);
      resolve({ ...result, stdout, stderr });
    };

    const importTimer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ timedOut: true, phase: 'import', code: null });
    }, 30_000);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (parseTimer || !stdout.includes('READY')) return;
      clearTimeout(importTimer);
      parseTimer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ timedOut: true, phase: 'parse', code: null });
      }, 2_000);
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('exit', code => {
      finish({ timedOut: false, phase: 'exit', code });
    });
  });
}

test(
  'docs MDX image pipeline does not block the event loop on a crafted remote ICNS',
  { timeout: 40_000 },
  async () => {
    const started = await startServer();
    try {
      const url = `http://127.0.0.1:${started.port}/maxim_vercel.gif`;
      const result = await runPipeline(url);

      if (result.timedOut) {
        assert.equal(
          result.phase,
          'parse',
          `pipeline did not become ready: ${result.stderr}`,
        );
        assert.ok(
          started.requests.some(request => request.url === '/maxim_vercel.gif'),
          `event loop blocked before the image body was fetched: ${result.stderr}`,
        );
        assert.fail(
          `image pipeline blocked the event loop after fetching a ${started.requests[0]?.bytes}-byte ICNS body served as image/gif. stderr=${result.stderr}`,
        );
      }

      assert.equal(
        result.code,
        0,
        `pipeline exited ${result.code}. stderr=${result.stderr}`,
      );
      assert.match(result.stdout, /DONE/);
    } finally {
      await new Promise(resolve => {
        started.server.close(resolve);
      });
    }
  },
);
