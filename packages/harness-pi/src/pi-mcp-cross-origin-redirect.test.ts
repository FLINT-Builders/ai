import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';
import { createPiSession } from './pi-session';

/**
 * Spec for DHI-lwms-ju27-ibn3-btpi as reached by the published Pi harness.
 *
 * createPiSession forwards caller-supplied MCP server objects to pi-mcp-adapter.
 * That adapter opens Streamable HTTP, falls back to SSE, and runs OAuth through
 * @modelcontextprotocol/client 2.0.0-beta.5. These tests expect a cross-origin
 * redirect to drop the original request's custom headers, MCP session id, and
 * body. They fail while that client follows the redirect with those fields.
 */

const PLACEHOLDER_API_KEY = 'placeholder-api-key';
const PLACEHOLDER_SESSION = 'placeholder-session';
const PLACEHOLDER_CLIENT_ID = 'placeholder-client-id';
const PLACEHOLDER_CLIENT_SECRET = 'placeholder-client-secret';
const PLACEHOLDER_REFRESH_TOKEN = 'placeholder-refresh-token';
const API_KEY_HEADER = 'x-api-key';

type Hit = {
  method: string;
  path: string;
  headers: Headers;
  body: string;
};

const extensionHandlers = vi.hoisted(
  () => new Map<string, Array<(...args: unknown[]) => unknown>>(),
);

const extensionApi = vi.hoisted(() => {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'on') {
          return (event: string, handler: (...args: unknown[]) => unknown) => {
            const handlers = extensionHandlers.get(event) ?? [];
            handlers.push(handler);
            extensionHandlers.set(event, handlers);
          };
        }
        if (property === 'getActiveTools' || property === 'getAllTools') {
          return () => [];
        }
        if (property === 'getFlag') {
          return () => undefined;
        }
        return () => undefined;
      },
    },
  );
});

vi.mock('@earendil-works/pi-coding-agent', () => {
  return {
    createAgentSession: vi.fn(),
    DefaultResourceLoader: class {
      constructor(
        private readonly options: {
          extensionFactories?: Array<(api: unknown) => unknown>;
        },
      ) {}

      async reload() {
        for (const factory of this.options.extensionFactories ?? []) {
          await factory(extensionApi);
        }
      }

      getExtensions() {
        return { errors: [], extensions: [], runtime: {} };
      }
    },
    defineTool: vi.fn((tool: unknown) => tool),
    ModelRegistry: class {
      constructor(_runtime: unknown) {}
      getAll() {
        return [];
      }
      getRegisteredProviderConfig() {
        return undefined;
      }
      registerProvider() {}
      hasConfiguredAuth() {
        return false;
      }
    },
    ModelRuntime: {
      create: vi.fn(async () => ({
        getProviders: () => [],
        models: {},
        refresh: vi.fn(async () => {}),
        setRuntimeApiKey: vi.fn(async () => {}),
      })),
    },
    SessionManager: {
      create: vi.fn(),
      open: vi.fn(),
    },
    SettingsManager: {
      inMemory: vi.fn(() => ({})),
      create: vi.fn(() => ({})),
    },
  };
});

const require = createRequire(import.meta.url);

beforeAll(() => {
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(
    path.join(tmpdir(), 'pi-agent-'),
  );
  process.env.MCP_OAUTH_DIR = mkdtempSync(path.join(tmpdir(), 'pi-oauth-'));
});

afterEach(async () => {
  const handlers = extensionHandlers.get('session_shutdown') ?? [];
  extensionHandlers.set('session_shutdown', []);
  await Promise.all(
    handlers.map(handler => Promise.resolve(handler()).catch(() => undefined)),
  );
});

describe('Pi MCP cross-origin redirects', () => {
  it('does not forward Streamable HTTP headers or bodies to another origin', async () => {
    const other = await listen((_hit, response) => {
      response.writeHead(204);
      response.end();
    });
    const configured = await listen(async (_hit, response) => {
      response.writeHead(307, {
        location: other.url,
      });
      response.end();
    });

    try {
      const session = await startSession({
        remote: {
          url: configured.url,
          headers: { [API_KEY_HEADER]: PLACEHOLDER_API_KEY },
          auth: false,
          lifecycle: 'eager',
        },
      });
      await waitFor(
        () =>
          configured.hits.some(
            hit =>
              hit.method === 'POST' &&
              header(hit, API_KEY_HEADER) === PLACEHOLDER_API_KEY &&
              hit.body.includes('server/discover'),
          ),
        () => 'configured MCP server never received the credentialed POST',
      );
      expect(
        other.hits.some(
          hit =>
            header(hit, API_KEY_HEADER) === PLACEHOLDER_API_KEY ||
            hit.body.includes('server/discover'),
        ),
      ).toBe(false);
      await session.doStop();
    } finally {
      await configured.close();
      await other.close();
    }
  });

  it('does not forward mcp-session-id on a later cross-origin 308', async () => {
    const other = await listen((_hit, response) => {
      response.writeHead(202);
      response.end();
    });
    const configured = await listen(async (hit, response) => {
      // A discover failure selects the legacy initialize handshake, which is
      // the exchange that stores mcp-session-id for later requests.
      if (hit.body.includes('"server/discover"')) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (hit.body.includes('"initialize"')) {
        const protocolVersion =
          hit.body.match(/"protocolVersion"\s*:\s*"([^"]+)"/)?.[1] ??
          '2026-07-28';
        jsonRpc(
          response,
          hit,
          {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '0.0.0' },
          },
          { 'mcp-session-id': PLACEHOLDER_SESSION },
        );
        return;
      }
      response.writeHead(308, { location: other.url });
      response.end();
    });

    try {
      const session = await startSession({
        remote: {
          url: configured.url,
          headers: { [API_KEY_HEADER]: PLACEHOLDER_API_KEY },
          auth: false,
          lifecycle: 'eager',
        },
      });
      await waitFor(
        () =>
          configured.hits.some(
            hit =>
              hit.method === 'POST' &&
              !hit.body.includes('"method":"initialize"') &&
              header(hit, 'mcp-session-id') === PLACEHOLDER_SESSION,
          ),
        () =>
          'configured MCP server never received a follow-up request carrying the session id',
      );
      expect(
        other.hits.some(
          hit => header(hit, 'mcp-session-id') === PLACEHOLDER_SESSION,
        ),
      ).toBe(false);
      await session.doStop();
    } finally {
      await configured.close();
      await other.close();
    }
  });

  it('does not forward SSE request headers to another origin', async () => {
    const other = await listen((_hit, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end();
    });
    const configured = await listen(async (hit, response) => {
      if (hit.method === 'GET') {
        response.writeHead(307, { location: other.url });
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });

    try {
      const session = await startSession({
        remote: {
          url: configured.url,
          headers: { [API_KEY_HEADER]: PLACEHOLDER_API_KEY },
          auth: false,
          lifecycle: 'eager',
        },
      });
      await waitFor(
        () =>
          configured.hits.some(
            hit =>
              hit.method === 'GET' &&
              header(hit, API_KEY_HEADER) === PLACEHOLDER_API_KEY,
          ),
        () =>
          'SSE transport never sent the credentialed GET to the configured server',
      );
      expect(
        other.hits.some(
          hit => header(hit, API_KEY_HEADER) === PLACEHOLDER_API_KEY,
        ),
      ).toBe(false);
      await session.doStop();
    } finally {
      await configured.close();
      await other.close();
    }
  });

  it('does not forward an OAuth client secret on a cross-origin token redirect', async () => {
    await expectTokenRedirect({
      serverName: 'oauth-client-credentials',
      oauth: {
        grantType: 'client_credentials',
        clientId: PLACEHOLDER_CLIENT_ID,
        clientSecret: PLACEHOLDER_CLIENT_SECRET,
      },
      leakedMarkers: [PLACEHOLDER_CLIENT_SECRET],
    });
  });

  it('does not forward an OAuth refresh token on a cross-origin token redirect', async () => {
    await expectTokenRedirect({
      serverName: 'oauth-refresh',
      oauth: {
        grantType: 'authorization_code',
        clientId: PLACEHOLDER_CLIENT_ID,
        clientSecret: PLACEHOLDER_CLIENT_SECRET,
      },
      seedRefreshToken: true,
      leakedMarkers: [PLACEHOLDER_REFRESH_TOKEN, PLACEHOLDER_CLIENT_SECRET],
    });
  });
});

async function expectTokenRedirect({
  serverName,
  oauth,
  seedRefreshToken,
  leakedMarkers,
}: {
  serverName: string;
  oauth: {
    grantType: 'client_credentials' | 'authorization_code';
    clientId: string;
    clientSecret: string;
  };
  seedRefreshToken?: boolean;
  leakedMarkers: string[];
}) {
  const other = await listen((_hit, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      '{"access_token":"placeholder-access-token","token_type":"bearer"}',
    );
  });
  let configuredUrl = '';
  const configured = await listen(async (hit, response) => {
    if (hit.method === 'POST' && hit.path === '/token') {
      response.writeHead(307, { location: other.url });
      response.end();
      return;
    }
    if (hit.method === 'GET' && hit.path.includes('oauth-protected-resource')) {
      json(response, {
        resource: configuredUrl,
        authorization_servers: [configured.origin],
      });
      return;
    }
    if (
      hit.method === 'GET' &&
      hit.path.includes('oauth-authorization-server')
    ) {
      json(response, {
        issuer: configured.origin,
        authorization_endpoint: `${configured.origin}authorize`,
        token_endpoint: `${configured.origin}token`,
        response_types_supported: ['code'],
        grant_types_supported: ['client_credentials', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        code_challenge_methods_supported: ['S256'],
      });
      return;
    }
    if (hit.method === 'POST') {
      response.writeHead(401, {
        'www-authenticate': 'Bearer realm="mcp"',
      });
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });
  configuredUrl = `${configured.origin}mcp`;

  try {
    if (seedRefreshToken) {
      await seedRefreshTokenOnDisk(serverName, configuredUrl);
    }
    const session = await startSession({
      [serverName]: {
        url: configuredUrl,
        headers: { [API_KEY_HEADER]: PLACEHOLDER_API_KEY },
        auth: 'oauth',
        oauth,
        lifecycle: 'eager',
      },
    });
    await waitFor(
      () =>
        configured.hits.some(
          hit =>
            hit.method === 'POST' &&
            hit.path === '/token' &&
            leakedMarkers.every(marker => hit.body.includes(marker)),
        ),
      () => 'token endpoint never received the OAuth request body',
    );
    expect(
      other.hits.some(hit =>
        leakedMarkers.some(marker => hit.body.includes(marker)),
      ),
    ).toBe(false);
    expect(
      other.hits.some(
        hit => header(hit, API_KEY_HEADER) === PLACEHOLDER_API_KEY,
      ),
    ).toBe(false);
    await session.doStop();
  } finally {
    await configured.close();
    await other.close();
  }
}

async function seedRefreshTokenOnDisk(serverName: string, serverUrl: string) {
  const entry = require.resolve('pi-mcp-adapter');
  const authModule = await import(
    pathToFileURL(path.join(path.dirname(entry), 'mcp-auth.ts')).href
  );
  (
    authModule as {
      updateTokens: (
        name: string,
        tokens: { accessToken: string; refreshToken?: string },
        url?: string,
      ) => void;
    }
  ).updateTokens(
    serverName,
    {
      accessToken: 'placeholder-access-token',
      refreshToken: PLACEHOLDER_REFRESH_TOKEN,
    },
    serverUrl,
  );
}

async function startSession(mcpServers: Record<string, unknown>) {
  const sessionWorkDir = mkdtempSync(path.join(tmpdir(), 'pi-work-'));
  return createPiSession({
    sessionId: `redirect-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    sandboxSession: createSandbox(),
    sessionWorkDir,
    settings: {
      auth: {},
      mcpServers,
    },
    clientApp: 'ai-sdk/harness-pi/0.0.0-test',
    isResume: false,
  });
}

function createSandbox(): HarnessV1NetworkSandboxSession {
  const sandbox = {
    id: 'sandbox',
    defaultWorkingDirectory: '/sandbox',
    ports: [],
    destroy: vi.fn(async () => {}),
    getPortEndpoint: vi.fn(),
    getPortUrl: vi.fn(),
    readBinaryFile: vi.fn(async ({ path: filePath }: { path: string }) => {
      try {
        return new Uint8Array(readFileSync(filePath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        }
        throw error;
      }
    }),
    readTextFile: vi.fn(async () => undefined),
    restricted: vi.fn(() => sandbox),
    run: vi.fn(async ({ command }: { command: string }) => ({
      stdout: command === 'printf "%s" "$HOME"' ? '/tmp/sandbox-home' : '',
      stderr: '',
      exitCode: 0,
    })),
    stop: vi.fn(async () => {}),
    writeTextFile: vi.fn(async () => {}),
    writeBinaryFile: vi.fn(async () => {}),
  };
  return sandbox as unknown as HarnessV1NetworkSandboxSession;
}

async function listen(
  handle: (hit: Hit, response: ServerResponse) => void | Promise<void>,
): Promise<{
  url: string;
  origin: string;
  hits: Hit[];
  close: () => Promise<void>;
}> {
  const hits: Hit[] = [];
  const server = createServer(async (request, response) => {
    const hit = await capture(request);
    hits.push(hit);
    await handle(hit, response);
  });
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('test server did not bind a TCP port');
  }
  const origin = `http://127.0.0.1:${address.port}/`;
  return {
    origin,
    url: origin,
    hits,
    close: () =>
      new Promise(resolve => {
        server.close(() => resolve());
      }),
  };
}

async function capture(request: IncomingMessage): Promise<Hit> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return {
    method: request.method ?? 'GET',
    path: new URL(request.url ?? '/', 'http://127.0.0.1').pathname,
    headers: new Headers(
      Object.entries(request.headers).flatMap(([name, value]) => {
        if (value == null) return [];
        return Array.isArray(value)
          ? value.map(entry => [name, entry] as [string, string])
          : [[name, value] as [string, string]];
      }),
    ),
    body: Buffer.concat(chunks).toString('utf8'),
  };
}

function header(hit: Hit, name: string): string | null {
  return hit.headers.get(name);
}

function json(
  response: ServerResponse,
  value: unknown,
  extraHeaders?: Record<string, string>,
) {
  response.writeHead(200, {
    'content-type': 'application/json',
    ...extraHeaders,
  });
  response.end(JSON.stringify(value));
}

function jsonRpc(
  response: ServerResponse,
  hit: Hit,
  result: unknown,
  extraHeaders?: Record<string, string>,
) {
  const id = hit.body.match(/"id"\s*:\s*([^,}\s]+)/)?.[1] ?? 'null';
  response.writeHead(200, {
    'content-type': 'application/json',
    ...extraHeaders,
  });
  response.end(
    `{"jsonrpc":"2.0","id":${id},"result":${JSON.stringify(result)}}`,
  );
}

async function waitFor(predicate: () => boolean, failure: () => string) {
  const started = Date.now();
  while (Date.now() - started < 2_500) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(failure());
}
