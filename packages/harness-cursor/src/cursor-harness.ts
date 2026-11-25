import {
  commonTool,
  type HarnessV1,
  type HarnessV1BuiltinTool,
  type HarnessV1CredentialForwarding,
  type HarnessV1MintBridgeTokenCallback,
  type HarnessV1PortEndpoint,
} from '@ai-sdk/harness';
import type { SandboxChannelReconnectOptions } from '@ai-sdk/harness/utils';
import { createACP, type ACPAuthenticationMode } from '@ai-sdk/harness-acp';
import { tool } from '@ai-sdk/provider-utils';
import { z } from 'zod/v4';
import { VERSION } from './version';
import { resolveCursorSubscriptionEnvironment } from './cursor-subscription';

const CURSOR_CLIENT_APP = `ai-sdk/harness-cursor/${VERSION}`;

const CURSOR_AGENT_RELEASE_VERSION = '2026.11.22-e9042b2';
const CURSOR_AGENT_RELEASE_SHA256 = {
  'linux/x64':
    '7663b1c5d1b56e095ef8e23bef38d66df6cfd665c4873470214e0e411f0f97b3',
  'linux/arm64':
    '7b7dd0020fb9a2a9e1e7e3f39e2f9f512d1dd9577174ecda8aa82ac31dbc9565',
  'darwin/x64':
    '16cc7314128243b24d74575cae5f7e1a215656d48115d55084e2d6725ef7c542',
  'darwin/arm64':
    '92f39e448218897538bd801cdb01d69106ab37a86aaf3dc0e6b55159c79b75e2',
} as const;

/*
 * Installs a pinned Cursor Agent CLI package and verifies its SHA-256 digest
 * before extracting it. The package is never executed or unpacked unless the
 * digest matches, so the bytes served by the download host cannot run in the
 * sandbox.
 */
const CURSOR_AGENT_INSTALL_COMMAND = `case "$(uname -s)-$(uname -m)" in
  Linux-x86_64|Linux-amd64) cursor_platform=linux/x64; cursor_sha256=${CURSOR_AGENT_RELEASE_SHA256['linux/x64']} ;;
  Linux-aarch64|Linux-arm64) cursor_platform=linux/arm64; cursor_sha256=${CURSOR_AGENT_RELEASE_SHA256['linux/arm64']} ;;
  Darwin-x86_64) cursor_platform=darwin/x64; cursor_sha256=${CURSOR_AGENT_RELEASE_SHA256['darwin/x64']} ;;
  Darwin-arm64|Darwin-aarch64) cursor_platform=darwin/arm64; cursor_sha256=${CURSOR_AGENT_RELEASE_SHA256['darwin/arm64']} ;;
  *) echo "cursor: unsupported platform $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac
cursor_download_dir="$(mktemp -d "$PWD/.cursor-agent-download.XXXXXX")"
trap 'rm -rf "$cursor_download_dir"' EXIT
cursor_archive="$cursor_download_dir/agent-cli-package.tar.gz"
cursor_url="https://downloads.cursor.com/lab/${CURSOR_AGENT_RELEASE_VERSION}/$cursor_platform/agent-cli-package.tar.gz"
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
cursor_version_dir="$HOME/.local/share/cursor-agent/versions/${CURSOR_AGENT_RELEASE_VERSION}"
mkdir -p "$(dirname "$cursor_version_dir")" "$HOME/.local/bin"
rm -rf "$cursor_version_dir"
mv "$cursor_download_dir/package" "$cursor_version_dir"
ln -sfn "$cursor_version_dir/cursor-agent" "$HOME/.local/bin/agent"
ln -sfn "$cursor_version_dir/cursor-agent" "$HOME/.local/bin/cursor-agent"`;

export type CursorAuthenticationMode = ACPAuthenticationMode;

export type CursorHarnessSettings = {
  /**
   * Declares the provider authentication configured in Cursor, or supplies an
   * isolated environment for Cursor CLI authentication. The adapter cannot
   * change provider routing and warns for explicit routing modes.
   */
  readonly auth?: CursorAuthenticationMode;
  /**
   * Customizes each credential value before it is forwarded into a sandbox
   * process. This does not restrict which credentials the harness adapter can
   * discover, read, or otherwise access in the host process.
   */
  readonly credentialForwarding?: HarnessV1CredentialForwarding;
  /**
   * Overrides the sandbox port used by the ACP bridge.
   */
  readonly port?: number;
  /**
   * Override the host endpoint used to connect to the sandbox bridge. Required
   * together with `port` when using a basic sandbox session.
   */
  readonly portEndpoint?: HarnessV1PortEndpoint;
  /**
   * Maximum milliseconds to wait for the ACP bridge to start.
   */
  readonly startupTimeoutMs?: number;
  /**
   * Configures reconnection attempts after an established bridge connection
   * drops. Defaults to a 30 second reconnect window with exponential backoff
   * from 50 milliseconds up to 2 seconds.
   */
  readonly reconnect?: SandboxChannelReconnectOptions;
  /**
   * MCP server definitions keyed by server name. Each definition uses the
   * underlying runtime's native MCP server configuration format.
   */
  readonly mcpServers?: Record<string, unknown>;
  /**
   * Creates the authentication token used by the sandbox bridge. Defaults to
   * a random 32-byte hexadecimal token.
   */
  readonly mintBridgeToken?: HarnessV1MintBridgeTokenCallback;
};

/*
 * Tool variants, display titles, ACP kinds, and raw input projections were
 * captured from the official Cursor CLI 2026.08.11-e8db854 ACP implementation.
 * `mcpToolCall` is dynamic and `truncatedToolCall` is a transport sentinel, so
 * neither is exposed as a built-in.
 */
const CURSOR_BUILTIN_TOOLS = {
  bash: {
    ...commonTool('bash', {
      nativeName: 'shellToolCall',
      toolUseKind: 'bash',
      inputSchema: z.looseObject({ command: z.string() }),
    }),
    title: 'Terminal',
  },
  delete: {
    ...tool({
      title: 'Delete',
      inputSchema: z.looseObject({ path: z.string() }),
    }),
    nativeName: 'deleteToolCall',
    toolUseKind: 'edit',
  },
  glob: {
    ...commonTool('glob', {
      nativeName: 'globToolCall',
      toolUseKind: 'readonly',
      inputSchema: z.looseObject({ pattern: z.string() }),
    }),
    title: 'Find',
  },
  grep: {
    ...commonTool('grep', {
      nativeName: 'grepToolCall',
      toolUseKind: 'readonly',
      inputSchema: z.looseObject({
        pattern: z.string(),
        path: z.string().optional(),
      }),
    }),
    title: 'grep',
  },
  read: {
    ...tool({
      title: 'Read',
      inputSchema: z.looseObject({ path: z.string() }),
    }),
    nativeName: 'readToolCall',
    toolUseKind: 'readonly',
  },
  updateTodos: {
    ...tool({
      title: 'Update TODOs',
      inputSchema: z.looseObject({
        _toolName: z.literal('updateTodos'),
        todos: z
          .array(
            z.looseObject({
              id: z.string(),
              content: z.string(),
              status: z.string(),
            }),
          )
          .optional(),
      }),
    }),
    nativeName: 'updateTodosToolCall',
  },
  readTodos: {
    ...tool({
      title: 'Read TODOs',
      inputSchema: z.looseObject({}),
    }),
    nativeName: 'readTodosToolCall',
    toolUseKind: 'readonly',
  },
  edit: {
    ...tool({
      title: 'Edit',
      inputSchema: z.looseObject({ path: z.string() }),
    }),
    nativeName: 'editToolCall',
    toolUseKind: 'edit',
  },
  ls: {
    ...tool({
      title: 'List',
      inputSchema: z.looseObject({ path: z.string() }),
    }),
    nativeName: 'lsToolCall',
    toolUseKind: 'readonly',
  },
  readLints: {
    ...tool({
      title: 'Read Lints',
      inputSchema: z.looseObject({ paths: z.array(z.string()) }),
    }),
    nativeName: 'readLintsToolCall',
    toolUseKind: 'readonly',
  },
  semanticSearch: {
    ...tool({
      title: 'Codebase Search',
      inputSchema: z.looseObject({ query: z.string() }),
    }),
    nativeName: 'semSearchToolCall',
    toolUseKind: 'readonly',
  },
  createPlan: {
    ...tool({
      title: 'Create Plan',
      inputSchema: z.looseObject({
        _toolName: z.literal('createPlan'),
        name: z.string().optional(),
        plan: z.string().optional(),
      }),
    }),
    nativeName: 'createPlanToolCall',
  },
  webSearch: {
    ...tool({
      title: 'Web Search',
      inputSchema: z.looseObject({ searchTerm: z.string() }),
    }),
    nativeName: 'webSearchToolCall',
    toolUseKind: 'readonly',
  },
  task: {
    ...tool({
      title: 'Task',
      inputSchema: z.looseObject({
        _toolName: z.literal('task'),
        prompt: z.string().optional(),
        description: z.string().optional(),
        subagentType: z.unknown().optional(),
      }),
    }),
    nativeName: 'taskToolCall',
  },
  listMcpResources: {
    ...tool({
      title: 'List MCP Resources',
      inputSchema: z.looseObject({ server: z.string().optional() }),
    }),
    nativeName: 'listMcpResourcesToolCall',
    toolUseKind: 'readonly',
  },
  readMcpResource: {
    ...tool({
      title: 'Fetch MCP Resource',
      inputSchema: z.looseObject({
        server: z.string().optional(),
        uri: z.string().optional(),
        downloadPath: z.string().optional(),
      }),
    }),
    nativeName: 'readMcpResourceToolCall',
    toolUseKind: 'readonly',
  },
  applyAgentDiff: {
    ...tool({
      title: 'Apply Agent Diff',
      inputSchema: z.looseObject({ path: z.string().optional() }),
    }),
    nativeName: 'applyAgentDiffToolCall',
    toolUseKind: 'edit',
  },
  fetch: {
    ...tool({
      title: 'Fetch',
      inputSchema: z.looseObject({ url: z.string() }),
    }),
    nativeName: 'fetchToolCall',
    toolUseKind: 'readonly',
  },
  switchMode: {
    ...tool({
      title: 'Switch Mode',
      inputSchema: z.looseObject({
        targetModeId: z.string(),
        explanation: z.string().optional(),
      }),
    }),
    nativeName: 'switchModeToolCall',
  },
  generateImage: {
    ...tool({
      title: 'Generate Image',
      inputSchema: z.looseObject({
        _toolName: z.literal('generateImage'),
        description: z.string().optional(),
        filename: z.string().optional(),
      }),
    }),
    nativeName: 'generateImageToolCall',
  },
  recordScreen: {
    ...tool({
      title: 'Record Screen',
      inputSchema: z.looseObject({}),
    }),
    nativeName: 'recordScreenToolCall',
  },
  computerUse: {
    ...tool({
      title: 'Computer Use',
      inputSchema: z.looseObject({
        action: z.string().optional(),
        coordinate: z.unknown().optional(),
        text: z.string().optional(),
      }),
    }),
    nativeName: 'computerUseToolCall',
    toolUseKind: 'bash',
  },
  writeShellStdin: {
    ...tool({
      title: 'Write to stdin',
      inputSchema: z.looseObject({
        shellId: z.number().optional(),
        chars: z.string().optional(),
      }),
    }),
    nativeName: 'writeShellStdinToolCall',
    toolUseKind: 'bash',
  },
  reflect: {
    ...tool({
      title: 'Reflect',
      inputSchema: z.looseObject({ reflection: z.string().optional() }),
    }),
    nativeName: 'reflectToolCall',
    toolUseKind: 'readonly',
  },
  setupVmEnvironment: {
    ...tool({
      title: 'Setup VM Environment',
      inputSchema: z.looseObject({}),
    }),
    nativeName: 'setupVmEnvironmentToolCall',
    toolUseKind: 'bash',
  },
  replaceEnv: {
    ...tool({
      title: 'Replace Environment',
      inputSchema: z.looseObject({}),
    }),
    nativeName: 'replaceEnvToolCall',
    toolUseKind: 'bash',
  },
  startGrindExecution: {
    ...tool({
      title: 'Start Grind Execution',
      inputSchema: z.looseObject({}),
    }),
    nativeName: 'startGrindExecutionToolCall',
    toolUseKind: 'bash',
  },
  startGrindPlanning: {
    ...tool({
      title: 'Start Grind Planning',
      inputSchema: z.looseObject({}),
    }),
    nativeName: 'startGrindPlanningToolCall',
    toolUseKind: 'readonly',
  },
  webFetch: {
    ...tool({
      title: 'Web Fetch',
      inputSchema: z.looseObject({ url: z.string() }),
    }),
    nativeName: 'webFetchToolCall',
    toolUseKind: 'readonly',
  },
  reportBugfixResults: {
    ...tool({
      title: 'Report Bugfix Results',
      inputSchema: z.looseObject({}),
    }),
    nativeName: 'reportBugfixResultsToolCall',
  },
} as const satisfies Record<string, HarnessV1BuiltinTool<any, any>>;

export function createCursor(
  settings: CursorHarnessSettings = {},
): HarnessV1<typeof CURSOR_BUILTIN_TOOLS> {
  const clientAppSegments = CURSOR_CLIENT_APP.split('/');
  const clientAppVersion = clientAppSegments.pop()!;

  if (settings.auth === 'direct' || settings.auth === 'ai-gateway') {
    warnCursorAuthenticationConfiguration({ auth: settings.auth });
  }

  return createACP({
    auth: settings.auth,
    resolveAuthenticationEnvironment: resolveCursorSubscriptionEnvironment,
    credentialForwarding: settings.credentialForwarding,
    port: settings.port,
    portEndpoint: settings.portEndpoint,
    startupTimeoutMs: settings.startupTimeoutMs,
    reconnect: settings.reconnect,
    mcpServers: settings.mcpServers,
    isMcpToolCall: toolCall => {
      const rawInput = toolCall.rawInput;
      return (
        isRecord(rawInput) &&
        typeof rawInput.providerIdentifier === 'string' &&
        typeof rawInput.toolName === 'string' &&
        isRecord(rawInput.args)
      );
    },
    mintBridgeToken: settings.mintBridgeToken,
    version: 'v1',
    harnessId: 'cursor',
    builtinTools: CURSOR_BUILTIN_TOOLS,
    clientApp: {
      name: clientAppSegments.join('/'),
      version: clientAppVersion,
    },
    source: {
      type: 'install-command',
      command: CURSOR_AGENT_INSTALL_COMMAND,
    },
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
    credentialBrokering: ({ env, sandboxEnv, headers }) => {
      const transformations = [];
      if (env.CURSOR_API_KEY && sandboxEnv?.CURSOR_API_KEY) {
        transformations.push({
          match: {
            host: 'api2.cursor.sh',
            path: { exact: '/auth/exchange_user_api_key' },
            method: ['POST'],
            headers: [
              {
                key: { exact: 'Authorization' },
                value: {
                  exact: `Bearer ${sandboxEnv.CURSOR_API_KEY}`,
                },
              },
            ],
          },
          transform: {
            headers: {
              Authorization: `Bearer ${env.CURSOR_API_KEY}`,
            },
          },
        });
      }
      if (headers != null) {
        transformations.push({
          match:
            settings.auth === 'ai-gateway'
              ? {
                  host: 'ai-gateway.vercel.sh',
                  path: { startsWith: '/cursor/v1' },
                }
              : { host: 'api2.cursor.sh' },
          transform: { headers },
        });
      }
      return transformations;
    },
  });
}

function warnCursorAuthenticationConfiguration({
  auth,
}: {
  auth: Exclude<CursorAuthenticationMode, 'auto'>;
}): void {
  const detail =
    auth === 'ai-gateway'
      ? "Configure an AI Gateway API key as Cursor's OpenAI API key and set Override OpenAI Base URL to https://ai-gateway.vercel.sh/cursor/v1."
      : 'Configure Cursor to use its direct model-provider routing.';
  console.warn(
    `[cursor] auth: ${JSON.stringify(auth)} cannot configure Cursor provider authentication. ${detail} CURSOR_API_KEY is still required for Cursor CLI authentication.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
