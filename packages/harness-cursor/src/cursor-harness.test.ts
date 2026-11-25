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
      source: settings.source.type,
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
        "source": "install-command",
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

  it('installs a pinned Cursor CLI archive verified by SHA-256', () => {
    createCursor();

    const settings = mocks.createACP.mock.calls[0]?.[0] as ACPHarnessSettings;
    if (settings.source.type !== 'install-command') {
      throw new Error('Expected an install-command source.');
    }
    const { command } = settings.source;
    expect(command).not.toContain('cursor.com/install');
    expect(command).not.toMatch(/\|\s*(ba)?sh\b/);
    for (const platform of [
      'linux/x64',
      'linux/arm64',
      'darwin/x64',
      'darwin/arm64',
    ]) {
      expect(command).toMatch(
        new RegExp(
          `archive_url='https://downloads\\.cursor\\.com/lab/\\d{4}\\.\\d{2}\\.\\d{2}-[0-9a-f]+/${platform}/agent-cli-package\\.tar\\.gz'; archive_sha256='[0-9a-f]{64}'`,
        ),
      );
    }
    expect(command).toContain(
      `ln -sfn "$install_dir/"'cursor-agent' "$HOME/.local/bin/"'agent'`,
    );
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
