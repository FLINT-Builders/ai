import { createHash, randomBytes } from 'node:crypto';
import type { HarnessV1PortEndpoint } from '../v1';

export function createBridgeToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Hex SHA-256 digest of a bridge token. Pass it to the bridge process as
 * `BRIDGE_CHANNEL_TOKEN_SHA256` so the token itself never enters the sandbox.
 */
export function hashBridgeToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function withBridgeToken({
  endpoint,
  token,
}: {
  endpoint: HarnessV1PortEndpoint;
  token: string;
}): HarnessV1PortEndpoint {
  const bridgeUrl = new URL(endpoint.url);
  bridgeUrl.searchParams.set('agent_bridge_token', token);
  return { ...endpoint, url: bridgeUrl.toString() };
}
