import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { getTracer } from 'next/dist/server/lib/trace/tracer.js';

// The example does not depend on @opentelemetry/api directly. Load the copy
// that @opentelemetry/sdk-trace-node and Next.js both resolve, so register()
// and withPropagatedContext share one propagator.
const requireFromSdk = createRequire(
  createRequire(import.meta.url).resolve('@opentelemetry/sdk-trace-node'),
);
const { propagation } = requireFromSdk('@opentelemetry/api');

// examples/ai-e2e-next/instrumentation.ts constructs NodeTracerProvider and
// calls register() with no propagator. That installs the default composite
// propagator, including W3CBaggagePropagator. Next.js then calls
// getTracer().withPropagatedContext(req.headers, ...) for each request, which
// runs propagation.extract on the inbound baggage header.
new NodeTracerProvider().register();

const tracer = getTracer();
const W3C_MAX_ENTRIES = 180;
const W3C_MAX_BYTES = 8192;

const server = createServer((req, res) => {
  let payload;
  try {
    tracer.withPropagatedContext(req.headers, () => {
      const baggage = propagation.getActiveBaggage();
      const entries = baggage ? baggage.getAllEntries() : [];
      const header = req.headers.baggage;
      payload = {
        count: entries.length,
        valueBytes: entries.reduce((total, [, entry]) => {
          return total + entry.value.length;
        }, 0),
        headerType: Array.isArray(header) ? 'array' : typeof header,
        headerLength: typeof header === 'string' ? header.length : null,
      };
    });
  } catch (error) {
    payload = {
      count: 0,
      valueBytes: 0,
      headerType: 'error',
      headerLength: null,
      error: error instanceof Error ? error.name : 'unknown',
    };
  }
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
});

function entry(index, valueLength) {
  const key = `k${String(index).padStart(3, '0')}`;
  return `${key}=${'v'.repeat(valueLength)}`;
}

function baggageHeader(count, valueLength) {
  return Array.from({ length: count }, (_, index) => {
    return entry(index, valueLength);
  }).join(',');
}

function send(headers) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/',
        method: 'GET',
        headers,
      },
      response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (response.statusCode !== 200) {
            reject(new Error(`status ${response.statusCode}: ${body}`));
            return;
          }
          resolve(JSON.parse(body));
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test.before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
});

test.after(async () => {
  server.close();
  await once(server, 'close');
});

test('keeps a baggage header inside the W3C limits', async () => {
  const header = baggageHeader(2, 4);
  const result = await send({ baggage: header });

  assert.equal(result.headerType, 'string');
  assert.equal(result.count, 2);
  assert.equal(result.valueBytes, 8);
});

test('caps inbound baggage at 180 entries', async () => {
  const sent = 200;
  const first = baggageHeader(sent / 2, 1);
  const second = Array.from({ length: sent / 2 }, (_, index) => {
    return entry(index + sent / 2, 1);
  }).join(',');
  const result = await send({ baggage: [first, second] });

  // Node joins the duplicate headers into one string before Next extracts it.
  assert.equal(result.headerType, 'string');
  assert.ok(result.headerLength > first.length);
  assert.ok(
    result.count <= W3C_MAX_ENTRIES,
    `extracted ${result.count} baggage entries from an inbound request; limit is ${W3C_MAX_ENTRIES}`,
  );
});

test('caps inbound baggage at 8192 bytes', async () => {
  const sent = 20;
  const valueLength = 500;
  const header = baggageHeader(sent, valueLength);
  assert.ok(header.length > W3C_MAX_BYTES);
  assert.ok(header.length < 12_000);

  const result = await send({ baggage: header });

  assert.equal(result.headerType, 'string');
  assert.equal(result.headerLength, header.length);
  assert.ok(
    result.count < sent,
    `extracted all ${result.count} entries from a ${header.length}-byte baggage header`,
  );
  assert.ok(
    result.valueBytes <= W3C_MAX_BYTES,
    `retained ${result.valueBytes} bytes of baggage values; limit is ${W3C_MAX_BYTES}`,
  );
});
