import {
  createMCPClient,
  MCP_APP_MIME_TYPE,
  type JSONRPCMessage,
  type MCPTransport,
} from '@ai-sdk/mcp';
import { isJSONObject } from '@ai-sdk/provider';
import { safeParseJSON } from '@ai-sdk/provider-utils';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCPAppRenderer } from './app-renderer';
import type { MCPAppRendererProps } from './types';

const APP_URI = 'ui://ai-sdk-e2e/dice-game';
const PRIVATE_URI = 'ui://ai-sdk-e2e/dashboard';
const PREFIX_URI = 'ui://ai-sdk-e2e/dice-game-admin';
const APP_BODY = 'dice-game-public-body';
const PRIVATE_BODY = 'dashboard-private-body';
const PREFIX_BODY = 'dice-admin-private-body';
const PROXY_ORIGIN = 'https://proxy.example';

const RESOURCES = [
  { uri: APP_URI, name: 'dice-game', mimeType: MCP_APP_MIME_TYPE },
  {
    uri: PRIVATE_URI,
    name: 'private-dashboard',
    mimeType: MCP_APP_MIME_TYPE,
  },
  { uri: PREFIX_URI, name: 'dice-admin', mimeType: MCP_APP_MIME_TYPE },
];

const RESOURCE_BODIES: Record<string, string> = {
  [APP_URI]: APP_BODY,
  [PRIVATE_URI]: PRIVATE_BODY,
  [PREFIX_URI]: PREFIX_BODY,
};

/**
 * Same resources/read forwarding as the published host route: parse the JSON
 * body the page posts, require a string uri, and read that uri from the MCP
 * client with no comparison against the rendered app.
 *
 * examples/ai-e2e-next/app/chat/mcp-apps/page.tsx
 * examples/ai-e2e-next/app/chat/mcp-apps/host/route.ts
 */
async function exampleHostReadResource(
  client: Awaited<ReturnType<typeof createMCPClient>>,
  params: unknown,
) {
  const text = JSON.stringify({ method: 'resources/read', params });
  const bodyResult = await safeParseJSON({ text });
  if (!bodyResult.success) {
    throw new Error('Invalid JSON');
  }

  const body = isJSONObject(bodyResult.value) ? bodyResult.value : undefined;
  const parsedParams = isJSONObject(body?.params) ? body.params : undefined;
  if (typeof parsedParams?.uri !== 'string') {
    throw new Error('Missing uri');
  }

  return client.readResource({ uri: parsedParams.uri });
}

class RecordingTransport implements MCPTransport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  readonly readUris: string[] = [];
  listCalls = 0;

  async start(): Promise<void> {}

  async close(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    if (!('method' in message) || !('id' in message)) {
      return;
    }

    if (message.method === 'initialize') {
      this.onmessage?.({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-11-25',
          serverInfo: { name: 'mcp-apps-fixture', version: '1.0.0' },
          capabilities: { resources: {} },
        },
      });
      return;
    }

    if (message.method === 'resources/list') {
      this.listCalls += 1;
      this.onmessage?.({
        jsonrpc: '2.0',
        id: message.id,
        result: { resources: RESOURCES },
      });
      return;
    }

    if (message.method === 'resources/read') {
      const uri = (message.params as { uri?: string } | undefined)?.uri;
      if (typeof uri === 'string') {
        this.readUris.push(uri);
      }
      const text = typeof uri === 'string' ? RESOURCE_BODIES[uri] : undefined;
      if (text == null) {
        this.onmessage?.({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32002, message: `Resource ${uri} not found` },
        });
        return;
      }

      this.onmessage?.({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          contents: [{ uri, mimeType: MCP_APP_MIME_TYPE, text }],
        },
      });
    }
  }
}

function appPart(): MCPAppRendererProps['part'] {
  return {
    type: 'dynamic-tool',
    toolName: 'showDiceGame',
    toolCallId: 'call-dice',
    state: 'input-available',
    input: {},
    toolMetadata: {
      clientName: 'local-mcp-apps',
      app: {
        resourceUri: APP_URI,
        mimeType: MCP_APP_MIME_TYPE,
        visibility: ['model', 'app'],
      },
    },
  };
}

function createTargetWindow() {
  return {
    postMessage: vi.fn(),
  } as unknown as Window & { postMessage: ReturnType<typeof vi.fn> };
}

async function renderHostApp({
  listResources = false,
}: {
  listResources?: boolean;
} = {}) {
  const transport = new RecordingTransport();
  const client = await createMCPClient({
    transport,
    clientName: 'local-mcp-apps',
  });
  const targetWindow = createTargetWindow();
  const contentWindow = vi
    .spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get')
    .mockReturnValue(targetWindow);

  render(
    <MCPAppRenderer
      part={appPart()}
      resource={{
        uri: APP_URI,
        mimeType: MCP_APP_MIME_TYPE,
        html: '<!doctype html><title>dice</title>',
      }}
      handlers={{
        readResource: params => exampleHostReadResource(client, params),
        ...(listResources
          ? {
              // The published page does not register listResources. A host that
              // does, by passing the iframe params straight to the MCP client,
              // hits the same missing check.
              listResources: () => client.listResources(),
            }
          : {}),
      }}
      sandbox={{ url: `${PROXY_ORIGIN}/sandbox` }}
    />,
  );

  return {
    client,
    transport,
    targetWindow,
    restore() {
      cleanup();
      contentWindow.mockRestore();
    },
  };
}

function postedMessages(targetWindow: {
  postMessage: ReturnType<typeof vi.fn>;
}) {
  return targetWindow.postMessage.mock.calls.map(call => call[0]);
}

function deliverFromProxy(targetWindow: Window, data: unknown) {
  window.dispatchEvent(
    new MessageEvent('message', {
      data,
      origin: PROXY_ORIGIN,
      source: targetWindow,
    }),
  );
}

async function initializeApp(
  targetWindow: Window & { postMessage: ReturnType<typeof vi.fn> },
) {
  deliverFromProxy(targetWindow, {
    jsonrpc: '2.0',
    id: 'init',
    method: 'ui/initialize',
    params: {},
  });

  await vi.waitFor(() => {
    expect(
      postedMessages(targetWindow).some(message => message?.id === 'init'),
    ).toBe(true);
  });
}

describe('MCP App resource authorization', () => {
  afterEach(() => {
    cleanup();
  });

  it('returns the rendered app resource when the iframe reads its own ui:// uri', async () => {
    const host = await renderHostApp();
    try {
      await initializeApp(host.targetWindow);
      deliverFromProxy(host.targetWindow, {
        jsonrpc: '2.0',
        id: 'read-own',
        method: 'resources/read',
        params: { uri: APP_URI },
      });

      await vi.waitFor(() => {
        expect(
          postedMessages(host.targetWindow).some(
            message => message?.id === 'read-own',
          ),
        ).toBe(true);
      });

      const response = postedMessages(host.targetWindow).find(
        message => message?.id === 'read-own',
      );
      expect(response?.error).toBeUndefined();
      expect(response?.result).toMatchObject({
        contents: [{ uri: APP_URI, text: APP_BODY }],
      });
      expect(host.transport.readUris).toContain(APP_URI);
    } finally {
      await host.client.close();
      host.restore();
    }
  });

  it('does not read or return another ui:// resource to the sandboxed app', async () => {
    const host = await renderHostApp();
    try {
      await initializeApp(host.targetWindow);
      deliverFromProxy(host.targetWindow, {
        jsonrpc: '2.0',
        id: 'read-other',
        method: 'resources/read',
        params: { uri: PRIVATE_URI },
      });

      await vi.waitFor(() => {
        expect(
          postedMessages(host.targetWindow).some(
            message => message?.id === 'read-other',
          ),
        ).toBe(true);
      });

      const response = postedMessages(host.targetWindow).find(
        message => message?.id === 'read-other',
      );
      expect(JSON.stringify(response)).not.toContain(PRIVATE_BODY);
      expect(host.transport.readUris).not.toContain(PRIVATE_URI);
      expect(response?.result).toBeUndefined();
    } finally {
      await host.client.close();
      host.restore();
    }
  });

  it('does not treat a longer ui:// uri as the rendered app resource', async () => {
    const host = await renderHostApp();
    try {
      await initializeApp(host.targetWindow);
      deliverFromProxy(host.targetWindow, {
        jsonrpc: '2.0',
        id: 'read-prefix',
        method: 'resources/read',
        params: { uri: PREFIX_URI },
      });

      await vi.waitFor(() => {
        expect(
          postedMessages(host.targetWindow).some(
            message => message?.id === 'read-prefix',
          ),
        ).toBe(true);
      });

      const response = postedMessages(host.targetWindow).find(
        message => message?.id === 'read-prefix',
      );
      expect(JSON.stringify(response)).not.toContain(PREFIX_BODY);
      expect(host.transport.readUris).not.toContain(PREFIX_URI);
      expect(response?.result).toBeUndefined();
    } finally {
      await host.client.close();
      host.restore();
    }
  });

  it('authorizes the uri that is checked, not a later read of the same property', async () => {
    const host = await renderHostApp();
    try {
      await initializeApp(host.targetWindow);

      // isJSONObject, the type check, and the ui:// prefix check each read
      // `uri`. A later read must not be able to swap in a different resource
      // after those checks have seen the rendered app's uri.
      let reads = 0;
      const params: { uri?: string } = {};
      Object.defineProperty(params, 'uri', {
        enumerable: true,
        get() {
          reads += 1;
          return reads < 4 ? APP_URI : PRIVATE_URI;
        },
      });

      deliverFromProxy(host.targetWindow, {
        jsonrpc: '2.0',
        id: 'read-swap',
        method: 'resources/read',
        params,
      });

      await vi.waitFor(() => {
        expect(
          postedMessages(host.targetWindow).some(
            message => message?.id === 'read-swap',
          ),
        ).toBe(true);
      });

      const response = postedMessages(host.targetWindow).find(
        message => message?.id === 'read-swap',
      );
      expect(JSON.stringify(response)).not.toContain(PRIVATE_BODY);
      expect(host.transport.readUris).not.toContain(PRIVATE_URI);
      for (const uri of host.transport.readUris) {
        expect(uri).toBe(APP_URI);
      }
    } finally {
      await host.client.close();
      host.restore();
    }
  });

  it('does not list other ui:// resources to the sandboxed app', async () => {
    const host = await renderHostApp({ listResources: true });
    try {
      await initializeApp(host.targetWindow);
      deliverFromProxy(host.targetWindow, {
        jsonrpc: '2.0',
        id: 'list',
        method: 'resources/list',
      });

      await vi.waitFor(() => {
        expect(
          postedMessages(host.targetWindow).some(
            message => message?.id === 'list',
          ),
        ).toBe(true);
      });

      const response = postedMessages(host.targetWindow).find(
        message => message?.id === 'list',
      );
      const serialized = JSON.stringify(response);
      expect(serialized).not.toContain(PRIVATE_URI);
      expect(serialized).not.toContain(PREFIX_URI);
      expect(serialized).not.toContain(PRIVATE_BODY);
    } finally {
      await host.client.close();
      host.restore();
    }
  });
});
