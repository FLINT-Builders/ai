import type { ACPHarnessSettings } from '@ai-sdk/harness-acp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCursor } from './cursor-harness';

const mocks = vi.hoisted(() => ({
  createACP: vi.fn(),
}));

vi.mock('@ai-sdk/harness-acp', () => ({
  createACP: mocks.createACP,
}));

describe('createCursor', () => {
  beforeEach(() => {
    mocks.createACP.mockClear();
  });

  it('enforces the Cursor ACP implementation', () => {
    createCursor();

    const settings = mocks.createACP.mock.calls[0]?.[0] as ACPHarnessSettings;
    expect({
      version: settings.version,
      harnessId: settings.harnessId,
      clientApp: settings.clientApp,
      source: settings.source,
      executable: settings.executable,
      args: settings.args,
      credentialEnv: settings.credentialEnv,
      authentication: settings.authentication,
      providerAuthentication: settings.providerAuthentication,
      builtinToolNames: Object.keys(settings.builtinTools ?? {}),
    }).toMatchInlineSnapshot(`
      {
        "args": [
          "--disable-auto-update",
          "acp",
        ],
        "authentication": undefined,
        "builtinToolNames": [
          "bash",
          "delete",
          "glob",
          "grep",
          "read",
          "updateTodos",
          "readTodos",
          "edit",
          "ls",
          "readLints",
          "semanticSearch",
          "createPlan",
          "webSearch",
          "task",
          "listMcpResources",
          "readMcpResource",
          "applyAgentDiff",
          "fetch",
          "switchMode",
          "generateImage",
          "recordScreen",
          "computerUse",
          "writeShellStdin",
          "reflect",
          "setupVmEnvironment",
          "replaceEnv",
          "startGrindExecution",
          "startGrindPlanning",
          "webFetch",
          "reportBugfixResults",
        ],
        "clientApp": {
          "name": "ai-sdk/harness-cursor",
          "version": "0.0.0-test",
        },
        "credentialEnv": [
          "CURSOR_API_KEY",
        ],
        "executable": "agent",
        "harnessId": "cursor",
        "providerAuthentication": undefined,
        "source": {
          "command": "case "$(uname -s)-$(uname -m)" in
        Linux-x86_64|Linux-amd64) cursor_platform=linux/x64; cursor_sha256=7663b1c5d1b56e095ef8e23bef38d66df6cfd665c4873470214e0e411f0f97b3 ;;
        Linux-aarch64|Linux-arm64) cursor_platform=linux/arm64; cursor_sha256=7b7dd0020fb9a2a9e1e7e3f39e2f9f512d1dd9577174ecda8aa82ac31dbc9565 ;;
        Darwin-x86_64) cursor_platform=darwin/x64; cursor_sha256=16cc7314128243b24d74575cae5f7e1a215656d48115d55084e2d6725ef7c542 ;;
        Darwin-arm64|Darwin-aarch64) cursor_platform=darwin/arm64; cursor_sha256=92f39e448218897538bd801cdb01d69106ab37a86aaf3dc0e6b55159c79b75e2 ;;
        *) echo "cursor: unsupported platform $(uname -s) $(uname -m)" >&2; exit 1 ;;
      esac
      cursor_download_dir="$(mktemp -d "$PWD/.cursor-agent-download.XXXXXX")"
      trap 'rm -rf "$cursor_download_dir"' EXIT
      cursor_archive="$cursor_download_dir/agent-cli-package.tar.gz"
      cursor_url="https://downloads.cursor.com/lab/2026.11.22-e9042b2/$cursor_platform/agent-cli-package.tar.gz"
      if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$cursor_url" -o "$cursor_archive"
      else
        wget -qO "$cursor_archive" "$cursor_url"
      fi
      if command -v sha256sum >/dev/null 2>&1; then
        cursor_actual_sha256="$(sha256sum "$cursor_archive" | cut -d ' ' -f 1)"
      else
        cursor_actual_sha256="$(shasum -a 256 "$cursor_archive" | cut -d ' ' -f 1)"
      fi
      if [ "$cursor_actual_sha256" != "$cursor_sha256" ]; then
        echo "cursor: SHA-256 mismatch for $cursor_url" >&2
        exit 1
      fi
      mkdir "$cursor_download_dir/package"
      tar --strip-components=1 -xzf "$cursor_archive" -C "$cursor_download_dir/package"
      cursor_version_dir="$HOME/.local/share/cursor-agent/versions/2026.11.22-e9042b2"
      mkdir -p "$(dirname "$cursor_version_dir")" "$HOME/.local/bin"
      rm -rf "$cursor_version_dir"
      mv "$cursor_download_dir/package" "$cursor_version_dir"
      ln -sfn "$cursor_version_dir/cursor-agent" "$HOME/.local/bin/agent"
      ln -sfn "$cursor_version_dir/cursor-agent" "$HOME/.local/bin/cursor-agent"",
          "type": "install-command",
        },
        "version": "v1",
      }
    `);

    expect(
      settings.credentialBrokering?.({
        env: { CURSOR_API_KEY: 'cursor-secret' },
        sandboxEnv: { CURSOR_API_KEY: 'sandbox-cursor-secret' },
      }),
    ).toEqual([
      {
        match: {
          host: 'api2.cursor.sh',
          path: { exact: '/auth/exchange_user_api_key' },
          method: ['POST'],
          headers: [
            {
              key: { exact: 'Authorization' },
              value: { exact: 'Bearer sandbox-cursor-secret' },
            },
          ],
        },
        transform: {
          headers: { Authorization: 'Bearer cursor-secret' },
        },
      },
    ]);
    expect(settings.credentialBrokering?.({ env: {} })).toEqual([]);
    expect(settings.modelMapping).toEqual({
      type: 'session-config-option',
      path: 'model',
    });
    expect(settings.clientCapabilities).toEqual({
      _meta: { parameterizedModelPicker: true },
    });
  });

  it('forwards user-configurable settings', () => {
    const mintBridgeToken = (sandboxId: string) => `token-for-${sandboxId}`;
    const credentialForwarding = async ({
      credential,
    }: {
      credential: string;
    }) => `ephemeral-${credential}`;
    const portEndpoint = { url: 'wss://sandbox.example/bridge' };
    const reconnect = {
      maxElapsedMs: 120_000,
      initialDelayMs: 100,
      maxDelayMs: 5_000,
    };
    createCursor({
      credentialForwarding,
      port: 4319,
      portEndpoint,
      startupTimeoutMs: 45_000,
      reconnect,
      mcpServers: { external: { command: 'external-mcp' } },
      mintBridgeToken,
    });

    const settings = mocks.createACP.mock.calls[0]?.[0] as ACPHarnessSettings;
    expect({
      credentialForwarding: settings.credentialForwarding,
      port: settings.port,
      portEndpoint: settings.portEndpoint,
      startupTimeoutMs: settings.startupTimeoutMs,
      reconnect: settings.reconnect,
      mcpServers: settings.mcpServers,
      mintBridgeToken: settings.mintBridgeToken,
    }).toEqual({
      credentialForwarding,
      port: 4319,
      portEndpoint,
      startupTimeoutMs: 45_000,
      reconnect,
      mcpServers: { external: { command: 'external-mcp' } },
      mintBridgeToken,
    });
  });

  it('applies headers to configured model request routes', () => {
    createCursor({ auth: 'ai-gateway' });
    const gatewaySettings = mocks.createACP.mock
      .calls[0]?.[0] as ACPHarnessSettings;
    expect(
      gatewaySettings.credentialBrokering?.({
        env: {},
        headers: { 'x-tenant': 'acme' },
      }),
    ).toEqual([
      {
        match: {
          host: 'ai-gateway.vercel.sh',
          path: { startsWith: '/cursor/v1' },
        },
        transform: { headers: { 'x-tenant': 'acme' } },
      },
    ]);

    mocks.createACP.mockClear();
    createCursor();
    const autoSettings = mocks.createACP.mock
      .calls[0]?.[0] as ACPHarnessSettings;
    expect(
      autoSettings.credentialBrokering?.({
        env: {},
        headers: { 'x-tenant': 'acme' },
      }),
    ).toEqual([
      {
        match: { host: 'api2.cursor.sh' },
        transform: { headers: { 'x-tenant': 'acme' } },
      },
    ]);
  });

  it.each(['direct', 'ai-gateway'] as const)(
    'accepts %s auth and warns that Cursor configuration controls routing',
    auth => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      createCursor({ auth });

      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toContain(`auth: "${auth}"`);
      expect(warn.mock.calls[0]?.[0]).toContain('CURSOR_API_KEY');
      const settings = mocks.createACP.mock.calls[0]?.[0] as ACPHarnessSettings;
      expect(settings.auth).toBe(auth);
      expect(settings.providerAuthentication).toBeUndefined();
      warn.mockRestore();
    },
  );

  it('accepts auto auth without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    createCursor({ auth: 'auto' });

    expect(warn).not.toHaveBeenCalled();
    const settings = mocks.createACP.mock.calls[0]?.[0] as ACPHarnessSettings;
    expect(settings.auth).toBe('auto');
    expect(settings.providerAuthentication).toBeUndefined();
    warn.mockRestore();
  });

  it('forwards a supplied authentication environment for Cursor credentials', () => {
    const auth = { CURSOR_API_KEY: 'programmatic-cursor-key' };

    createCursor({ auth });

    const settings = mocks.createACP.mock.calls[0]?.[0] as ACPHarnessSettings;
    expect(settings.auth).toBe(auth);
    expect(settings.providerAuthentication).toBeUndefined();
  });

  it('classifies Cursor MCP calls from their raw input', () => {
    createCursor();
    const settings = mocks.createACP.mock.calls[0]?.[0] as ACPHarnessSettings;

    expect(
      settings.isMcpToolCall?.({
        toolCallId: 'call-1',
        title: 'ai-sdk-harness-tools: weather',
        rawInput: {
          providerIdentifier: 'ai-sdk-harness-tools',
          toolName: 'weather',
          args: { city: 'Lima' },
        },
      }),
    ).toBe(true);
    expect(
      settings.isMcpToolCall?.({
        toolCallId: 'call-2',
        title: 'Read README.md',
        rawInput: { path: 'README.md' },
      }),
    ).toBe(false);
  });
});
