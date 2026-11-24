import { inflateSync, zstdDecompressSync } from 'node:zlib';
import { getWorld } from 'workflow/runtime';
import { start } from 'workflow/api';
import { expect, it } from 'vitest';
import { persistProviderModelsWorkflow } from './test/credential-header-workflow.js';

/**
 * Obvious stand-ins for provider credentials. Each value is unique so a
 * failure shows which provider's resolved header was stored.
 */
const CREDENTIAL_PLACEHOLDERS = {
  OPENAI_API_KEY: 'placeholder-credential-openai',
  ANTHROPIC_API_KEY: 'placeholder-credential-anthropic',
  COHERE_API_KEY: 'placeholder-credential-cohere',
  VOYAGE_API_KEY: 'placeholder-credential-voyage',
  FAL_API_KEY: 'placeholder-credential-fal',
  LUMA_API_KEY: 'placeholder-credential-luma',
  REPLICATE_API_TOKEN: 'placeholder-credential-replicate',
  TOGETHER_API_KEY: 'placeholder-credential-together',
  TYPESAFE_AI_API_KEY: 'placeholder-credential-typesafe',
  AZURE_API_KEY: 'placeholder-credential-azure',
  AZURE_RESOURCE_NAME: 'placeholder-resource',
  ELEVENLABS_API_KEY: 'placeholder-credential-elevenlabs',
  GOOGLE_GENERATIVE_AI_API_KEY: 'placeholder-credential-google',
  GROQ_API_KEY: 'placeholder-credential-groq',
  MINIMAX_API_KEY: 'placeholder-credential-minimax',
} as const;

const STORED_CREDENTIALS = Object.values(CREDENTIAL_PLACEHOLDERS).filter(
  value => value.startsWith('placeholder-credential-'),
);

it('does not write resolved provider credentials into durable workflow step input', async () => {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(CREDENTIAL_PLACEHOLDERS)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }

  try {
    const run = await start(persistProviderModelsWorkflow, []);
    // The step input is written before the step body runs. Revival in the
    // step worker is not required for the credential to already be durable.
    await run.returnValue.catch(() => undefined);

    const world = await getWorld();
    const [steps, events] = await Promise.all([
      world.steps.list({ runId: run.runId, resolveData: 'all' }),
      world.events.list({ runId: run.runId, resolveData: 'all' }),
    ]);

    const stored = decodeStoredPayloads([steps.data, events.data]);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored).toContain('gpt-4o-mini');
    expect(stored).toContain('claude-3-haiku-20240307');
    expect(stored).toContain('photon-1');
    expect(stored).toContain('jev-latest');

    for (const credential of STORED_CREDENTIALS) {
      expect(stored).not.toContain(credential);
    }
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

/**
 * Reads durable step and event payloads the way the local world stores them:
 * optional zstd or gzip wrapping around a devalue payload, with no encryption
 * key on the local world. Throws if a payload is encrypted, so a compressed
 * or encrypted blob cannot hide a credential from the assertion.
 */
function decodeStoredPayloads(roots: unknown[]): string {
  const chunks: string[] = [];
  const seen = new Set<unknown>();

  const visit = (value: unknown) => {
    if (value == null || typeof value !== 'object') {
      return;
    }
    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    if (value instanceof Uint8Array) {
      chunks.push(decodePayload(value));
      return;
    }

    if (isEncodedBytes(value)) {
      chunks.push(decodePayload(Buffer.from(value.data, 'base64')));
      return;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry);
      }
      return;
    }

    for (const entry of Object.values(value)) {
      visit(entry);
    }
  };

  for (const root of roots) {
    visit(root);
  }
  return chunks.join('\n');
}

function isEncodedBytes(
  value: object,
): value is { __type: 'Uint8Array'; data: string } {
  return (
    '__type' in value &&
    value.__type === 'Uint8Array' &&
    'data' in value &&
    typeof value.data === 'string'
  );
}

function decodePayload(data: Uint8Array): string {
  const prefix = Buffer.from(data.subarray(0, 4)).toString('utf8');
  if (prefix === 'encr' || prefix === 'encp') {
    throw new Error(
      'Workflow step input was encrypted, so this test cannot see whether a credential was stored.',
    );
  }

  let body = data;
  if (prefix === 'zstd') {
    body = new Uint8Array(zstdDecompressSync(data.subarray(4)));
  } else if (prefix === 'gzip') {
    body = new Uint8Array(inflateSync(data.subarray(4)));
  }

  return Buffer.from(body).toString('utf8');
}
