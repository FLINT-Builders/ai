import { createACP, type ACPSource } from '@ai-sdk/harness-acp';
import type { HarnessV1PortEndpoint } from '@ai-sdk/harness';

const CURSOR_AGENT_VERSION = '2026.11.22-e9042b2';

// Installs a pinned Cursor Agent CLI package and refuses to unpack it unless
// its SHA-256 digest matches.
const CURSOR_ACP_SOURCE = {
  type: 'install-command',
  command: `case "$(uname -s)-$(uname -m)" in
  Linux-x86_64|Linux-amd64) platform=linux/x64; sha256=7663b1c5d1b56e095ef8e23bef38d66df6cfd665c4873470214e0e411f0f97b3 ;;
  Linux-aarch64|Linux-arm64) platform=linux/arm64; sha256=7b7dd0020fb9a2a9e1e7e3f39e2f9f512d1dd9577174ecda8aa82ac31dbc9565 ;;
  Darwin-x86_64) platform=darwin/x64; sha256=16cc7314128243b24d74575cae5f7e1a215656d48115d55084e2d6725ef7c542 ;;
  Darwin-arm64|Darwin-aarch64) platform=darwin/arm64; sha256=92f39e448218897538bd801cdb01d69106ab37a86aaf3dc0e6b55159c79b75e2 ;;
  *) echo "unsupported platform $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac
download_dir="$(mktemp -d "$PWD/.cursor-agent-download.XXXXXX")"
trap 'rm -rf "$download_dir"' EXIT
curl -fsSL "https://downloads.cursor.com/lab/${CURSOR_AGENT_VERSION}/$platform/agent-cli-package.tar.gz" -o "$download_dir/package.tar.gz"
echo "$sha256  $download_dir/package.tar.gz" | sha256sum -c -
mkdir "$download_dir/package"
tar --strip-components=1 -xzf "$download_dir/package.tar.gz" -C "$download_dir/package"
version_dir="$HOME/.local/share/cursor-agent/versions/${CURSOR_AGENT_VERSION}"
mkdir -p "$(dirname "$version_dir")" "$HOME/.local/bin"
rm -rf "$version_dir"
mv "$download_dir/package" "$version_dir"
ln -sfn "$version_dir/cursor-agent" "$HOME/.local/bin/agent"`,
} as const satisfies ACPSource;

export type CursorACPHarnessSettings = {
  mcpServers?: Record<string, unknown>;
  mintBridgeToken?: (sandboxId: string) => string;
  port?: number;
  portEndpoint?: HarnessV1PortEndpoint;
  source?: ACPSource;
};

export function createCursorACP({
  mcpServers,
  mintBridgeToken,
  port,
  portEndpoint,
  source = CURSOR_ACP_SOURCE,
}: CursorACPHarnessSettings = {}) {
  return createACP({
    harnessId: 'cursor-acp',
    mcpServers,
    mintBridgeToken,
    port,
    portEndpoint,
    source,
    executable: 'agent',
    args: ['--disable-auto-update', 'acp'],
    modelMapping: {
      type: 'session-config-option',
      path: 'model',
    },
    clientCapabilities: {
      _meta: { parameterizedModelPicker: true },
    },
    credentialEnv: ['CURSOR_API_KEY'],
    credentialBrokering: ({ env, sandboxEnv }) => {
      const credential = env.CURSOR_API_KEY;
      const sandboxCredential = sandboxEnv?.CURSOR_API_KEY;
      if (!credential || !sandboxCredential) return [];
      return [
        {
          match: {
            host: 'api2.cursor.sh',
            path: { exact: '/auth/exchange_user_api_key' },
            method: ['POST'],
            headers: [
              {
                key: { exact: 'Authorization' },
                value: { exact: `Bearer ${sandboxCredential}` },
              },
            ],
          },
          transform: {
            headers: { Authorization: `Bearer ${credential}` },
          },
        },
      ];
    },
  });
}
