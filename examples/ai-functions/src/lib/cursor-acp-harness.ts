import { createACP, type ACPSource } from '@ai-sdk/harness-acp';
import type { HarnessV1PortEndpoint } from '@ai-sdk/harness';
import { createVerifiedArchiveInstallCommand } from '@ai-sdk/harness/utils';

const CURSOR_CLI_DOWNLOAD_URL =
  'https://downloads.cursor.com/lab/2026.11.22-e9042b2';

const CURSOR_ACP_SOURCE = {
  type: 'install-command',
  command: createVerifiedArchiveInstallCommand({
    archives: {
      'linux-x64': {
        url: `${CURSOR_CLI_DOWNLOAD_URL}/linux/x64/agent-cli-package.tar.gz`,
        sha256:
          '7663b1c5d1b56e095ef8e23bef38d66df6cfd665c4873470214e0e411f0f97b3',
      },
      'linux-arm64': {
        url: `${CURSOR_CLI_DOWNLOAD_URL}/linux/arm64/agent-cli-package.tar.gz`,
        sha256:
          '7b7dd0020fb9a2a9e1e7e3f39e2f9f512d1dd9577174ecda8aa82ac31dbc9565',
      },
      'darwin-x64': {
        url: `${CURSOR_CLI_DOWNLOAD_URL}/darwin/x64/agent-cli-package.tar.gz`,
        sha256:
          '16cc7314128243b24d74575cae5f7e1a215656d48115d55084e2d6725ef7c542',
      },
      'darwin-arm64': {
        url: `${CURSOR_CLI_DOWNLOAD_URL}/darwin/arm64/agent-cli-package.tar.gz`,
        sha256:
          '92f39e448218897538bd801cdb01d69106ab37a86aaf3dc0e6b55159c79b75e2',
      },
    },
    installDir: '.local/share/cursor-agent/versions/2026.11.22-e9042b2',
    stripComponents: 1,
    executables: { agent: 'cursor-agent' },
  }),
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
