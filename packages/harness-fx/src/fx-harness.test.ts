import type { HarnessV1BuiltinTool } from '@ai-sdk/harness';
import type { ACPHarnessSettings } from '@ai-sdk/harness-acp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFx } from './fx-harness';
import { VERSION } from './version';

const mocks = vi.hoisted(() => ({
  createACP: vi.fn(),
}));

vi.mock('@ai-sdk/harness-acp', () => ({
  createACP: mocks.createACP,
}));

describe('createFx', () => {
  beforeEach(() => {
    mocks.createACP.mockClear();
  });

  it('enforces the fx ACP implementation', () => {
    createFx();

    const settings = mocks.createACP.mock.calls[0]?.[0] as ACPHarnessSettings;

    expect({
      version: settings.version,
      harnessId: settings.harnessId,
      clientApp: settings.clientApp,
      source: settings.source,
      executable: settings.executable,
      args: settings.args,
      credentialEnv: settings.credentialEnv,
      providerAuthentication: settings.providerAuthentication,
      instructionMapping: settings.instructionMapping,
      permissionModeMapping: settings.permissionModeMapping,
      builtinTools: Object.fromEntries(
        Object.entries(
          (settings.builtinTools ?? {}) as Record<string, HarnessV1BuiltinTool>,
        ).map(([name, value]) => [
          name,
          {
            nativeName: value.nativeName,
            commonName: value.commonName,
            toolUseKind: value.toolUseKind,
          },
        ]),
      ),
    }).toMatchInlineSnapshot(`
      {
        "args": [
          "acp",
        ],
        "builtinTools": {
          "ask_user_question": {
            "commonName": undefined,
            "nativeName": undefined,
            "toolUseKind": undefined,
          },
          "copy_file": {
            "commonName": undefined,
            "nativeName": undefined,
            "toolUseKind": "edit",
          },
          "create_folder": {
            "commonName": undefined,
            "nativeName": undefined,
            "toolUseKind": "edit",
          },
          "delete_file": {
            "commonName": undefined,
            "nativeName": undefined,
            "toolUseKind": "edit",
          },
          "edit_file": {
            "commonName": undefined,
            "nativeName": undefined,
            "toolUseKind": "edit",
          },
          "file_info": {
            "commonName": undefined,
            "nativeName": undefined,
            "toolUseKind": "readonly",
          },
          "glob": {
            "commonName": "glob",
            "nativeName": "glob_files",
            "toolUseKind": "readonly",
          },
          "grep": {
            "commonName": "grep",
            "nativeName": "grep_files",
            "toolUseKind": "readonly",
          },
          "install_skill": {
            "commonName": undefined,
            "nativeName": undefined,
            "toolUseKind": "edit",
          },
          "list_files": {
            "commonName": undefined,
            "nativeName": undefined,
            "toolUseKind": "readonly",
          },
          "mcp_features": {
            "commonName": undefined,
            "nativeName": undefined,
            "toolUseKind": "readonly",
          },
          "mcp_search_tools": {
            "commonName": undefined,
            "nativeName": undefined,
            "toolUseKind": "readonly",
          },
          "mcp_select_tool": {
            "commonName": undefined,
            "nativeName": undefined,
            "toolUseKind": "readonly",
          },
          "memory": {
            "commonName": undefined,
            "nativeName": undefined,
            "toolUseKind": undefined,
          },
          "open_file": {
            "commonName": undefined,
            "nativeName": undefined,
            "toolUseKind": undefined,
          },
          "read_file": {
            "commonName": undefined,
            "nativeName": undefined,
            "toolUseKind": "readonly",
          },
          "read_tool_result": {
            "commonName": undefined,
            "nativeName": undefined,
            "toolUseKind": "readonly",
          },
          "rename_file": {
            "commonName": undefined,
            "nativeName": undefined,
            "toolUseKind": "edit",
          },
          "semantic_search": {
            "commonName": undefined,
            "nativeName": undefined,
            "toolUseKind": "readonly",
          },
          "skill": {
            "commonName": undefined,
            "nativeName": undefined,
            "toolUseKind": "readonly",
          },
          "subagent": {
            "commonName": undefined,
            "nativeName": undefined,
            "toolUseKind": undefined,
          },
          "terminal": {
            "commonName": undefined,
            "nativeName": undefined,
            "toolUseKind": "bash",
          },
          "vision": {
            "commonName": undefined,
            "nativeName": undefined,
            "toolUseKind": undefined,
          },
          "webSearch": {
            "commonName": "webSearch",
            "nativeName": "web_search",
            "toolUseKind": "readonly",
          },
          "web_fetch": {
            "commonName": undefined,
            "nativeName": undefined,
            "toolUseKind": "readonly",
          },
          "write_file": {
            "commonName": undefined,
            "nativeName": undefined,
            "toolUseKind": "edit",
          },
        },
        "clientApp": {
          "name": "ai-sdk/harness-fx",
          "version": "0.0.0-test",
        },
        "credentialEnv": [
          "VERCEL_OIDC_TOKEN",
          "AI_GATEWAY_API_KEY",
          "AI_SDK_FX_CHATGPT_ACCESS_TOKEN",
          "AI_SDK_FX_CHATGPT_ACCOUNT_ID",
          "AI_SDK_FX_GROK_ACCESS_TOKEN",
          "AI_SDK_FX_GROK_ACCOUNT_ID",
        ],
        "executable": "fx",
        "harnessId": "fx",
        "instructionMapping": {
          "path": ".fx/AGENTS.md",
          "type": "filesystem",
        },
        "permissionModeMapping": {
          "allow-all": {
            "modeId": "code",
            "type": "session-mode",
          },
          "allow-edits": {
            "modeId": "ask",
            "type": "session-mode",
          },
          "allow-reads": {
            "modeId": "ask",
            "type": "session-mode",
          },
        },
        "providerAuthentication": {
          "gateway": {
            "env": {
              "AI_GATEWAY_API_KEY": {
                "$source": "gateway-api-key",
              },
              "AI_GATEWAY_BASE_URL": {
                "$source": "gateway-base-url",
              },
            },
          },
        },
        "source": {
          "command": "case "$(uname -s)-$(uname -m)" in
        Linux-x86_64|Linux-amd64) fx_platform=linux-x86_64; fx_sha256=e4912040c1fb2a1cda4162fd8f40fc66aa80a1a0a306af6332b5426bdcac99b6 ;;
        Linux-aarch64|Linux-arm64) fx_platform=linux-aarch64; fx_sha256=432a343b7d0fb15dce454ab1e100401df1ee4f01fb1e689a64557e6b9a57ece5 ;;
        Darwin-x86_64) fx_platform=macos-x86_64; fx_sha256=becc6f68d42ff20606cd783b72630287ab92bc6eef2d700ed39de17d52b7dd3e ;;
        Darwin-arm64|Darwin-aarch64) fx_platform=macos-aarch64; fx_sha256=f37eea7eaf248f7a75765fc3f71be77bcfbc43eaef5cbe76d721dadb97479cfe ;;
        *) echo "fx: unsupported platform $(uname -s) $(uname -m)" >&2; exit 1 ;;
      esac
      fx_download_dir="$(mktemp -d "$PWD/.fx-download.XXXXXX")"
      trap 'rm -rf "$fx_download_dir"' EXIT
      fx_archive="$fx_download_dir/fx.tar.gz"
      fx_url="https://releases.fx.sh/v0.0.18/fx-$fx_platform.tar.gz"
      if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$fx_url" -o "$fx_archive"
      else
        wget -qO "$fx_archive" "$fx_url"
      fi
      if command -v sha256sum >/dev/null 2>&1; then
        fx_actual_sha256="$(sha256sum "$fx_archive" | cut -d ' ' -f 1)"
      else
        fx_actual_sha256="$(shasum -a 256 "$fx_archive" | cut -d ' ' -f 1)"
      fi
      if [ "$fx_actual_sha256" != "$fx_sha256" ]; then
        echo "fx: SHA-256 mismatch for $fx_url" >&2
        exit 1
      fi
      tar -xzf "$fx_archive" -C "$fx_download_dir" fx
      mkdir -p "$HOME/.local/bin"
      mv -f "$fx_download_dir/fx" "$HOME/.local/bin/fx"
      chmod +x "$HOME/.local/bin/fx"",
          "type": "install-command",
        },
        "version": "v1",
      }
    `);
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
    createFx({
      auth: 'direct',
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
      auth: settings.auth,
      credentialForwarding: settings.credentialForwarding,
      port: settings.port,
      portEndpoint: settings.portEndpoint,
      startupTimeoutMs: settings.startupTimeoutMs,
      reconnect: settings.reconnect,
      mcpServers: settings.mcpServers,
      mintBridgeToken: settings.mintBridgeToken,
    }).toEqual({
      auth: 'direct',
      credentialForwarding,
      port: 4319,
      portEndpoint,
      startupTimeoutMs: 45_000,
      reconnect,
      mcpServers: { external: { command: 'external-mcp' } },
      mintBridgeToken,
    });
    expect(settings.modelMapping).toEqual({
      type: 'session-config-option',
      path: 'model',
    });
  });

  it('classifies tool calls from configured external MCP servers', () => {
    createFx({
      mcpServers: {
        context7: { type: 'http', url: 'https://mcp.context7.com/mcp' },
        'github 🚀': { command: 'github-mcp' },
      },
    });

    const settings = mocks.createACP.mock.calls[0]?.[0] as ACPHarnessSettings;
    const isMcpToolCall = settings.isMcpToolCall!;

    expect(
      isMcpToolCall({
        toolCallId: 'context7-call',
        title: 'mcp_context7_resolve-library-id',
      }),
    ).toBe(true);
    expect(
      isMcpToolCall({
        toolCallId: 'github-call',
        title: 'mcp_github______create_issue',
      }),
    ).toBe(true);
    expect(
      isMcpToolCall({
        toolCallId: 'host-tool-call',
        title: 'mcp_ai-sdk-harness-tools_weather',
      }),
    ).toBe(false);
    expect(
      isMcpToolCall({
        toolCallId: 'fx-mcp-discovery-call',
        title: 'mcp_search_tools',
      }),
    ).toBe(false);
    expect(
      isMcpToolCall({
        toolCallId: 'builtin-call',
        title: 'Reading file',
      }),
    ).toBe(false);
  });

  it('brokers fx credentials only to AI Gateway', () => {
    createFx();

    const settings = mocks.createACP.mock.calls[0]?.[0] as ACPHarnessSettings;

    expect(
      settings.credentialBrokering?.({
        env: {
          VERCEL_OIDC_TOKEN: 'oidc-secret',
          AI_GATEWAY_API_KEY: 'gateway-secret',
        },
        sandboxEnv: {
          VERCEL_OIDC_TOKEN: 'sandbox-oidc-secret',
          AI_GATEWAY_API_KEY: 'sandbox-gateway-secret',
        },
        headers: { 'x-tenant': 'acme' },
      }),
    ).toEqual([
      {
        match: {
          host: 'ai-gateway.vercel.sh',
          headers: [
            {
              key: { exact: 'Authorization' },
              value: { exact: 'Bearer sandbox-oidc-secret' },
            },
          ],
        },
        transform: {
          headers: {
            'x-tenant': 'acme',
            Authorization: 'Bearer oidc-secret',
            'x-client-app': 'ai-sdk/harness-fx/0.0.0-test',
          },
        },
      },
    ]);

    expect(
      settings.credentialBrokering?.({
        env: { AI_GATEWAY_API_KEY: 'gateway-secret' },
        sandboxEnv: { AI_GATEWAY_API_KEY: 'sandbox-gateway-secret' },
      }),
    ).toEqual([
      {
        match: {
          host: 'ai-gateway.vercel.sh',
          headers: [
            {
              key: { exact: 'Authorization' },
              value: { exact: 'Bearer sandbox-gateway-secret' },
            },
          ],
        },
        transform: {
          headers: {
            Authorization: 'Bearer gateway-secret',
            'x-client-app': 'ai-sdk/harness-fx/0.0.0-test',
          },
        },
      },
    ]);

    expect(
      settings.credentialBrokering?.({
        env: {
          AI_GATEWAY_API_KEY: 'gateway-secret',
          AI_GATEWAY_BASE_URL: 'https://gateway.example/v1',
        },
        sandboxEnv: {
          AI_GATEWAY_API_KEY: 'sandbox-gateway-secret',
        },
      }),
    ).toEqual([
      {
        match: {
          host: 'gateway.example',
          path: { startsWith: '/v1' },
          headers: [
            {
              key: { exact: 'Authorization' },
              value: { exact: 'Bearer sandbox-gateway-secret' },
            },
          ],
        },
        transform: {
          headers: {
            Authorization: 'Bearer gateway-secret',
            'x-client-app': 'ai-sdk/harness-fx/0.0.0-test',
          },
        },
      },
    ]);

    expect(settings.credentialBrokering?.({ env: {}, sandboxEnv: {} })).toEqual(
      [],
    );
  });

  it('brokers native subscription access tokens to their provider route', () => {
    createFx();
    const settings = mocks.createACP.mock.calls[0]?.[0] as ACPHarnessSettings;
    const accessToken = createChatGptAccessToken({ accountId: 'account-1' });
    const sandboxAccessToken = createChatGptAccessToken({
      accountId: 'account-1',
      signature: 'sandbox-access',
    });

    expect(
      settings.credentialBrokering?.({
        env: {
          AI_SDK_FX_CHATGPT_ACCESS_TOKEN: accessToken,
          AI_SDK_FX_CHATGPT_ACCOUNT_ID: 'account-1',
        },
        sandboxEnv: {
          AI_SDK_FX_CHATGPT_ACCESS_TOKEN: 'sandbox-access',
          AI_SDK_FX_CHATGPT_ACCOUNT_ID: 'sandbox-account',
        },
      }),
    ).toEqual([
      {
        match: {
          host: 'chatgpt.com',
          path: { startsWith: '/backend-api/codex' },
          headers: [
            {
              key: { exact: 'Authorization' },
              value: { exact: `Bearer ${sandboxAccessToken}` },
            },
          ],
        },
        transform: {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'x-client-app': `ai-sdk/harness-fx/${VERSION}`,
          },
        },
      },
    ]);
  });

  it('materializes native subscription records through the ACP home hook', () => {
    createFx();
    const settings = mocks.createACP.mock.calls[0]?.[0] as ACPHarnessSettings;
    const accessToken = createChatGptAccessToken({ accountId: 'account-1' });

    const files = settings.authenticationFiles?.({
      env: {
        AI_SDK_FX_CHATGPT_ACCESS_TOKEN: accessToken,
        AI_SDK_FX_CHATGPT_ACCOUNT_ID: 'account-1',
      },
      sandboxEnv: {
        AI_SDK_FX_CHATGPT_ACCESS_TOKEN: 'sandbox-access',
        AI_SDK_FX_CHATGPT_ACCOUNT_ID: 'sandbox-account',
      },
      credentialBrokeringAvailable: true,
    });

    expect(files?.map(file => file.path)).toEqual(['.fx/chatgpt-auth.json']);
    expect(files?.[0].content).not.toContain(accessToken);
    expect(files?.[0].content).toContain('sandbox-access');
  });

  it('brokers the Gateway key selected from a supplied authentication environment', () => {
    createFx({
      auth: {
        AI_GATEWAY_API_KEY: 'explicit-gateway-key',
        AI_GATEWAY_BASE_URL: 'https://gateway.example/v1',
      },
    });

    const settings = mocks.createACP.mock.calls[0]?.[0] as ACPHarnessSettings;

    expect(
      settings.credentialBrokering?.({
        env: {
          AI_GATEWAY_API_KEY: 'explicit-gateway-key',
          AI_GATEWAY_BASE_URL: 'https://gateway.example/v1',
          VERCEL_OIDC_TOKEN: 'ambient-oidc-token',
        },
        sandboxEnv: {
          AI_GATEWAY_API_KEY: 'sandbox-explicit-gateway-key',
          VERCEL_OIDC_TOKEN: 'sandbox-ambient-oidc-token',
        },
      }),
    ).toEqual([
      {
        match: {
          host: 'gateway.example',
          path: { startsWith: '/v1' },
          headers: [
            {
              key: { exact: 'Authorization' },
              value: { exact: 'Bearer sandbox-explicit-gateway-key' },
            },
          ],
        },
        transform: {
          headers: {
            Authorization: 'Bearer explicit-gateway-key',
            'x-client-app': 'ai-sdk/harness-fx/0.0.0-test',
          },
        },
      },
    ]);
  });

  it('exposes a test version outside the bundle', () => {
    expect(VERSION).toBe('0.0.0-test');
  });
});

function createChatGptAccessToken({
  accountId,
  signature = 'signature',
}: {
  accountId: string;
  signature?: string;
}): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'none', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    }),
  ).toString('base64url');
  return `${header}.${payload}.${signature}`;
}
