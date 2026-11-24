import {
  convertBase64ToUint8Array,
  convertUint8ArrayToBase64,
  loadOptionalSetting,
  secureJsonParse,
} from '@ai-sdk/provider-utils';
import type { SignedAIState } from './types';

export const AI_STATE_SECRET_ENV_VAR = 'AI_SDK_RSC_STATE_SECRET';

const SIGNATURE_DOMAIN = 'ai-sdk-rsc-ai-state:v1:';
const FALLBACK_KEY_SYMBOL = Symbol.for('vercel.ai.rsc.aiStateFallbackKey');

const textEncoder = new TextEncoder();

let cachedKey: { secret: string | undefined; key: Promise<CryptoKey> } | null =
  null;

function importHmacKey(keyData: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

// Without a configured secret, a random key is generated once per server
// process. It is kept on globalThis so that it survives module reloads in
// development. Deployments that serve one session from multiple processes
// must set the secret so that every process shares the same key.
function getFallbackKeyData(): Uint8Array {
  const holder = globalThis as unknown as Record<symbol, Uint8Array>;
  if (!holder[FALLBACK_KEY_SYMBOL]) {
    holder[FALLBACK_KEY_SYMBOL] = globalThis.crypto.getRandomValues(
      new Uint8Array(32),
    );
  }
  return holder[FALLBACK_KEY_SYMBOL];
}

function getSigningKey(): Promise<CryptoKey> {
  const secret = loadOptionalSetting({
    settingValue: undefined,
    environmentVariableName: AI_STATE_SECRET_ENV_VAR,
  });

  if (cachedKey == null || cachedKey.secret !== secret) {
    cachedKey = {
      secret,
      key: importHmacKey(
        secret ? textEncoder.encode(secret) : getFallbackKeyData(),
      ),
    };
  }

  return cachedKey.key;
}

// Serializes once and parses the result, so that the returned value is plain
// JSON data that cannot change between being signed or verified and being used.
function toPlainJSON(value: unknown): unknown {
  return secureJsonParse(JSON.stringify(value) ?? 'null');
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function signingInput(plainState: unknown): Uint8Array {
  return textEncoder.encode(SIGNATURE_DOMAIN + canonicalize(plainState));
}

async function signPlainState(plainState: unknown): Promise<string> {
  const key = await getSigningKey();
  const signature = await globalThis.crypto.subtle.sign(
    'HMAC',
    key,
    signingInput(plainState),
  );
  return convertUint8ArrayToBase64(new Uint8Array(signature));
}

/**
 * Snapshots the AI state synchronously and signs the snapshot, so that later
 * mutations of `state` do not affect the signature.
 */
export function signAIState(state: unknown): Promise<string> {
  return signPlainState(toPlainJSON(state));
}

export async function createSignedAIState<T>(
  state: T,
): Promise<SignedAIState<T>> {
  return { state, signature: await signAIState(state) };
}

/**
 * Verifies an AI state that was sent by the client and returns the verified
 * value. Callers must use the returned value and not the input.
 *
 * @throws if the AI state was not signed by this server or has been modified.
 */
export async function verifySignedAIState(
  signedState: unknown,
): Promise<unknown> {
  if (
    signedState === null ||
    typeof signedState !== 'object' ||
    typeof (signedState as SignedAIState).signature !== 'string' ||
    !('state' in signedState)
  ) {
    throw new Error(
      'Invalid AI state: the AI state sent by the client is not signed.',
    );
  }

  const { state, signature } = signedState as SignedAIState;

  const plainState = toPlainJSON(state);

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = convertBase64ToUint8Array(signature);
  } catch {
    signatureBytes = new Uint8Array(0);
  }

  const key = await getSigningKey();
  const isValid = await globalThis.crypto.subtle.verify(
    'HMAC',
    key,
    signatureBytes,
    signingInput(plainState),
  );

  if (!isValid) {
    throw new Error(
      'Invalid AI state: the AI state sent by the client was modified or was ' +
        'signed with a different key. If your application runs on multiple ' +
        `server instances, set the ${AI_STATE_SECRET_ENV_VAR} environment ` +
        'variable to the same secret on all of them.',
    );
  }

  return plainState;
}
