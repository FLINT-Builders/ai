/**
 * Attacker-controlled devalue documents posted to the generated workflow flow
 * route must be rejected before the workflow function runs.
 *
 * examples/next-workflow (workflow 5.0.0-beta.42, devalue 5.9.0) and
 * examples/harness-e2e-next (workflow 4.6.0, devalue 5.8.1) both mount
 * `withWorkflow`, which serves `POST /.well-known/workflow/v1/flow` with no
 * credentials. The handler JSON-parses the body, accepts `runInput.input` as
 * unknown, and the runtime passes that value to devalue. A JSON array takes
 * the legacy `unflatten` path. Bytes prefixed with `devl` take `parse`. Both
 * paths share `hydrate`, which before devalue 5.9.2 does not reject an index
 * `>= values.length`. The workflow then runs to completion.
 *
 * These tests fail while those locked devalue copies are vulnerable, and pass
 * once each copy is 5.9.2 or newer (the run is recorded as failed).
 *
 * Not covered here: devalue 5.9.1 inside the SvelteKit and Nuxt examples.
 * Those apps do not pass a request body to `devalue.parse`.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const workflowName = 'probe';
const bundle = `globalThis.__private_workflows = new Map([[${JSON.stringify(workflowName)}, async function probe(){ return 'ran'; }]]);`;

const repoRoot = new URL('../..', import.meta.url);

function outOfBoundsBytes() {
  const json = JSON.stringify([['Set', 7]]);
  const encoded = new TextEncoder().encode(json);
  const bytes = new Uint8Array(4 + encoded.length);
  bytes.set(new TextEncoder().encode('devl'), 0);
  bytes.set(encoded, 4);
  return bytes;
}

function encodeBody(value) {
  return JSON.stringify(value, (_key, item) => {
    if (item instanceof Uint8Array) {
      return {
        __type: 'Uint8Array',
        data: Buffer.from(item).toString('base64'),
      };
    }
    return item;
  });
}

async function loadRuntime(exampleDir) {
  const require = createRequire(new URL(`${exampleDir}/package.json`, repoRoot));
  return import(pathToFileURL(require.resolve('workflow/runtime')).href);
}

async function deliver(handler, world, runId, input, messageId) {
  const response = await handler(
    new Request('http://127.0.0.1/.well-known/workflow/v1/flow', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vqs-queue-name': `__wkf_workflow_${workflowName}`,
        'x-vqs-message-id': messageId,
        'x-vqs-message-attempt': '1',
      },
      body: encodeBody({
        runId,
        runInput: {
          deploymentId: 'dpl_test',
          workflowName,
          specVersion: world.specVersion,
          input,
        },
      }),
      duplex: 'half',
    }),
  );
  const body = await response.text();
  assert.equal(
    response.status,
    200,
    `flow route rejected the delivery before parsing: ${body}`,
  );
  const run = await world.runs.get(runId);
  assert.equal(
    run.status,
    'failed',
    `run ${runId} finished as ${run.status}; devalue accepted the out-of-bounds document`,
  );
}

async function exercise(exampleDir, label) {
  const { createWorld, setWorld, workflowEntrypoint } =
    await loadRuntime(exampleDir);
  const dataDir = await mkdtemp(join(tmpdir(), 'devalue-flow-'));
  const failures = [];
  try {
    const world = await Promise.resolve(
      createWorld({ dataDir, recoverActiveRuns: false }),
    );
    await world.start?.();
    setWorld(world);
    const handler = workflowEntrypoint(bundle);
    const cases = [
      ['array', [['Set', 7]]],
      ['bytes', outOfBoundsBytes()],
    ];
    for (const [kind, input] of cases) {
      const runId = `wrun_${label}_${kind}`.replace(/[^a-z0-9_]/g, '_');
      try {
        await deliver(handler, world, runId, input, `msg_${runId}`);
      } catch (error) {
        failures.push(`${label} ${kind}: ${error.message}`);
      }
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
  assert.deepEqual(failures, []);
}

test('public workflow flow routes reject out-of-bounds devalue parse and unflatten input', async () => {
  // One after the other: both runtimes register the world on globalThis.
  const failures = [];
  for (const [exampleDir, label] of [
    ['examples/next-workflow', 'v5'],
    ['examples/harness-e2e-next', 'v4'],
  ]) {
    try {
      await exercise(exampleDir, label);
    } catch (error) {
      failures.push(`${label}: ${error.message}`);
    }
  }
  assert.deepEqual(failures, []);
});
