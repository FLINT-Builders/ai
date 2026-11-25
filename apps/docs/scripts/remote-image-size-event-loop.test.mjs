/**
 * Spec for the docs-site image measurement hang.
 *
 * `apps/docs` compiles MDX with fumadocs-mdx's default preset, which enables
 * fumadocs-core `remarkImage` with remote fetching left on. That plugin
 * downloads each external image and passes the bytes to `image-size`.
 * image-size 2.0.2 never advances its read offset for a HEIF `ispe` box, a
 * JPEG XL `jxlp` box, or an ICNS entry whose size field is zero, so the
 * Node.js thread running the compile never returns.
 *
 * These tests fail while that hang is reachable from the docs MDX compiler
 * and pass once a remote image can no longer block compilation.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from 'node:worker_threads';

const HANG_AFTER_FETCH_MS = 2000;
const COMPILE_DEADLINE_MS = 30000;

function box(type, payload = Buffer.alloc(0), size = 8 + payload.length) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(size, 0);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

/** HEIF whose `ispe` box declares size 0, so the ipco walk never advances. */
function craftedHeif() {
  const ftyp = box(
    'ftyp',
    Buffer.concat([Buffer.from('heic'), Buffer.alloc(4)]),
  );
  const ispe = box('ispe', Buffer.alloc(16), 0);
  const ipco = box('ipco', ispe);
  const iprp = box('iprp', ipco);
  const meta = box('meta', Buffer.concat([Buffer.alloc(4), iprp]));
  return Buffer.concat([ftyp, meta]);
}

/** JPEG XL container whose `jxlp` box declares size 0. */
function craftedJxl() {
  const signature = box('JXL ', Buffer.from([0x0d, 0x0a, 0x87, 0x0a]));
  const ftyp = box(
    'ftyp',
    Buffer.concat([Buffer.from('jxl '), Buffer.alloc(4)]),
  );
  const jxlp = box('jxlp', Buffer.alloc(8), 0);
  return Buffer.concat([signature, ftyp, jxlp]);
}

/** ICNS whose first icon entry declares length 0. */
function craftedIcns() {
  const buffer = Buffer.alloc(16);
  buffer.write('icns', 0, 4, 'ascii');
  buffer.writeUInt32BE(100, 4);
  buffer.write('ic07', 8, 4, 'ascii');
  buffer.writeUInt32BE(0, 12);
  return buffer;
}

/** 1×1 PNG. The compiler must be able to measure an ordinary remote image. */
function tinyPng() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
}

function listen(payload) {
  const state = { hits: 0, firstHitAt: 0 };
  const server = http.createServer((request, response) => {
    state.hits += 1;
    if (state.firstHitAt === 0) state.firstHitAt = Date.now();
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(payload.length),
    });
    response.end(payload);
    request.resume();
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state }));
  });
}

function findRemarkImage(remarkPlugins, remarkImage) {
  for (const entry of remarkPlugins ?? []) {
    if (entry === remarkImage) return {};
    if (Array.isArray(entry) && entry[0] === remarkImage) return entry[1] ?? {};
  }
  return null;
}

async function loadCompiler() {
  const requireFromFumadocsMdx = createRequire(
    import.meta.resolve('fumadocs-mdx'),
  );
  const { createProcessor } = await import(
    pathToFileURL(requireFromFumadocsMdx.resolve('@mdx-js/mdx')).href
  );
  const { VFile } = await import(
    pathToFileURL(requireFromFumadocsMdx.resolve('vfile')).href
  );
  const { applyMdxPreset, remarkInclude } = await import(
    'fumadocs-mdx/config'
  );
  const { remarkImage } = await import('fumadocs-core/mdx-plugins');
  const config = (await import('../source.config.ts')).default;
  const mdxOptions = await applyMdxPreset(config.mdxOptions)('bundler');
  const imageOptions = findRemarkImage(mdxOptions.remarkPlugins, remarkImage);
  const processor = createProcessor({
    outputFormat: 'program',
    ...mdxOptions,
    remarkPlugins: [remarkInclude, ...(mdxOptions.remarkPlugins ?? [])],
  });
  return {
    VFile,
    processor,
    measuresRemote: imageOptions !== null && imageOptions.external !== false,
  };
}

async function compileRemoteImage(url) {
  const { VFile, processor, measuresRemote } = await loadCompiler();
  parentPort.postMessage({ type: 'ready', measuresRemote });
  const file = new VFile({
    path: 'content/v7/providers/probe.mdx',
    value: `# Probe\n\n![probe](${url})\n`,
  });
  try {
    const compiled = await processor.process(file);
    const text = String(compiled.value);
    parentPort.postMessage({
      type: 'done',
      hasWidth: /width["']?\s*[:=]\s*["']?\d+/.test(text) || text.includes('width'),
      threw: false,
    });
  } catch (error) {
    parentPort.postMessage({
      type: 'done',
      hasWidth: false,
      threw: true,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

if (!isMainThread) {
  await compileRemoteImage(workerData.url);
} else {
  async function compileThroughDocsPipeline(payload, { requireWidth }) {
    const { server, state } = await listen(payload);
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/image`;
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { url },
    });
    let ready = null;
    let done = null;
    let failure = null;
    worker.on('message', message => {
      if (message.type === 'ready') ready = message;
      if (message.type === 'done') done = message;
    });
    worker.on('error', error => {
      failure = error;
    });

    const started = Date.now();
    try {
      while (Date.now() - started < COMPILE_DEADLINE_MS) {
        if (failure || done) break;
        if (
          state.hits > 0 &&
          Date.now() - state.firstHitAt > HANG_AFTER_FETCH_MS
        ) {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    } finally {
      await worker.terminate();
      await new Promise(resolve => server.close(resolve));
    }

    if (failure) {
      throw failure;
    }
    assert.ok(
      ready,
      'the docs MDX compiler did not start; the test never reached remarkImage',
    );
    assert.ok(
      done,
      ready.measuresRemote
        ? `docs MDX compilation did not return after fetching the remote image (${state.hits} request(s)); the event loop was blocked inside image measurement`
        : 'docs MDX compilation did not return',
    );
    if (ready.measuresRemote) {
      assert.ok(
        state.hits > 0,
        'remarkImage is configured to fetch remote images, but compilation never requested the image URL',
      );
    }
    if (requireWidth && ready.measuresRemote) {
      assert.equal(
        done.hasWidth,
        true,
        `a normal remote PNG was not measured (${done.threw ? done.message : 'no width in output'})`,
      );
    }
  }

  test(
    'docs MDX compiler measures an ordinary remote PNG',
    { timeout: COMPILE_DEADLINE_MS + 5000 },
    async () => {
      await compileThroughDocsPipeline(tinyPng(), { requireWidth: true });
    },
  );

  test(
    'docs MDX compiler returns after a remote HEIF image whose ispe box size is zero',
    { timeout: COMPILE_DEADLINE_MS + 5000 },
    async () => {
      await compileThroughDocsPipeline(craftedHeif(), { requireWidth: false });
    },
  );

  test(
    'docs MDX compiler returns after a remote JPEG XL image whose jxlp box size is zero',
    { timeout: COMPILE_DEADLINE_MS + 5000 },
    async () => {
      await compileThroughDocsPipeline(craftedJxl(), { requireWidth: false });
    },
  );

  test(
    'docs MDX compiler returns after a remote ICNS image whose icon entry length is zero',
    { timeout: COMPILE_DEADLINE_MS + 5000 },
    async () => {
      await compileThroughDocsPipeline(craftedIcns(), { requireWidth: false });
    },
  );
}
