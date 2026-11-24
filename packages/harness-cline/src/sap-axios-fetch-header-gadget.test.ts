import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Spec for DHI-er6l-luca-eghd-f3rk as it is reached from this repo.
 *
 * @cline/llms builds the SAP AI Core provider with axios `adapter: 'fetch'`.
 * The SAP clients then send the chat or embedding body through
 * `@sap-ai-sdk/core` `executeRequest`, which JSON.stringifies it and calls
 * the locked axios. Axios 1.19.0 `resolveConfig` treats that string as
 * FormData when `Object.prototype` has been polluted with `append`,
 * `Symbol.toStringTag`, and `getHeaders`, and merges the inherited
 * `getHeaders()` result into the outbound fetch headers.
 *
 * These tests assert the safe outcome. They fail on axios 1.19.0 and pass
 * once that header merge no longer accepts the inherited `getHeaders`.
 */

const ATTACK_HEADER = 'x-attacker-controlled';
const LEGITIMATE_AUTHORIZATION = 'Bearer legitimate-placeholder';

const clineFetchRequestConfig = {
  headers: { 'ai-client-type': 'Cline' },
  adapter: 'fetch' as const,
  maxBodyLength: Number.POSITIVE_INFINITY,
  maxContentLength: Number.POSITIVE_INFINITY,
};

const destination = {
  url: 'https://example.test',
  authentication: 'NoAuthentication',
  type: 'HTTP',
  headers: { authorization: LEGITIMATE_AUTHORIZATION },
};

type CapturedRequest = {
  url: string;
  authorization: string | null;
  attackerHeader: string | null;
};

function asFilePath(entry: string): string {
  return entry.startsWith('file:') ? fileURLToPath(entry) : entry;
}

function packageJsonAbove(entry: string): string {
  let dir = dirname(realpathSync(asFilePath(entry)));
  while (true) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const name = JSON.parse(readFileSync(candidate, 'utf8')).name;
      if (typeof name === 'string' && name.length > 0) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`package.json not found above ${entry}`);
    }
    dir = parent;
  }
}

function resolveImportEntry(parent: string, specifier: string): string {
  const parentDir = dirname(packageJsonAbove(asFilePath(parent)));
  const segments = specifier.split('/');
  let dir = parentDir;
  let packageDir: string | undefined;
  while (true) {
    const candidate = join(dir, 'node_modules', ...segments);
    if (existsSync(join(candidate, 'package.json'))) {
      packageDir = candidate;
      break;
    }
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  if (!packageDir) {
    throw new Error(`Cannot resolve ${specifier} from ${parent}`);
  }
  const manifest = JSON.parse(
    readFileSync(join(packageDir, 'package.json'), 'utf8'),
  ) as {
    main?: string;
    module?: string;
    exports?: Record<string, unknown>;
  };
  const exported = manifest.exports?.['.'];
  const relative = exportTarget(exported) ?? manifest.module ?? manifest.main;
  if (!relative) {
    throw new Error(`${specifier} does not publish an import entry`);
  }
  return join(packageDir, relative);
}

function exportTarget(exported: unknown): string | undefined {
  if (typeof exported === 'string') return exported;
  if (!exported || typeof exported !== 'object') return undefined;
  const record = exported as Record<string, unknown>;
  for (const key of ['import', 'default', 'require'] as const) {
    const value = record[key];
    if (typeof value === 'string') return value;
    const nested = exportTarget(value);
    if (nested) return nested;
  }
  return undefined;
}

async function loadExport<T>(
  parentPackageJson: string,
  specifier: string,
): Promise<T> {
  const entry = resolveImportEntry(parentPackageJson, specifier);
  return import(pathToFileURL(entry).href) as Promise<T>;
}

async function loadSapClients() {
  const coreEntry = resolveImportEntry(import.meta.url, '@cline/core');
  const llmsEntry = resolveImportEntry(coreEntry, '@cline/llms');
  const sapProviderPackageJson = packageJsonAbove(
    resolveImportEntry(llmsEntry, '@jerome-benoit/sap-ai-provider'),
  );
  const orchestration = await loadExport<{
    OrchestrationClient: new (
      config: unknown,
      deploymentConfig: unknown,
      destination: unknown,
    ) => {
      chatCompletion(
        request: unknown,
        requestConfig: unknown,
      ): Promise<unknown>;
      stream(
        request: unknown,
        signal: unknown,
        options: unknown,
        requestConfig: unknown,
      ): Promise<unknown>;
    };
    OrchestrationEmbeddingClient: new (
      config: unknown,
      deploymentConfig: unknown,
      destination: unknown,
    ) => {
      embed(request: unknown, requestConfig: unknown): Promise<unknown>;
    };
  }>(sapProviderPackageJson, '@sap-ai-sdk/orchestration');
  const foundation = await loadExport<{
    AzureOpenAiChatClient: new (
      modelDeployment: unknown,
      destination: unknown,
    ) => {
      run(request: unknown, requestConfig: unknown): Promise<unknown>;
      stream(
        request: unknown,
        signal: unknown,
        requestConfig: unknown,
      ): Promise<unknown>;
    };
    AzureOpenAiEmbeddingClient: new (
      modelDeployment: unknown,
      destination: unknown,
    ) => {
      run(request: unknown, requestConfig: unknown): Promise<unknown>;
    };
  }>(sapProviderPackageJson, '@sap-ai-sdk/foundation-models');

  return { orchestration, foundation };
}

function polluteObjectPrototype(): () => void {
  const proto = Object.prototype;
  const tag = Symbol.toStringTag;
  const previous = {
    append: Object.getOwnPropertyDescriptor(proto, 'append'),
    getHeaders: Object.getOwnPropertyDescriptor(proto, 'getHeaders'),
    tag: Object.getOwnPropertyDescriptor(proto, tag),
  };

  Object.defineProperty(proto, 'append', {
    configurable: true,
    writable: true,
    value() {},
  });
  Object.defineProperty(proto, 'getHeaders', {
    configurable: true,
    writable: true,
    value() {
      return {
        [ATTACK_HEADER]: 'injected-by-getHeaders',
        authorization: 'Bearer injected',
      };
    },
  });
  Object.defineProperty(proto, tag, {
    configurable: true,
    writable: true,
    value: 'FormData',
  });

  return () => {
    if (previous.append)
      Object.defineProperty(proto, 'append', previous.append);
    else delete proto.append;
    if (previous.getHeaders)
      Object.defineProperty(proto, 'getHeaders', previous.getHeaders);
    else delete proto.getHeaders;
    if (previous.tag) Object.defineProperty(proto, tag, previous.tag);
    else delete proto[tag];
  };
}

async function captureSapFetch(
  send: () => Promise<unknown>,
): Promise<CapturedRequest> {
  const restorePollution = polluteObjectPrototype();
  const originalFetch = globalThis.fetch;
  const captured: CapturedRequest[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(
      input instanceof Request ? input.headers : init?.headers,
    );
    captured.push({
      url: input instanceof Request ? input.url : String(input),
      authorization: headers.get('authorization'),
      attackerHeader: headers.get(ATTACK_HEADER),
    });
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    await send();
  } catch (error) {
    if (captured.length === 0) throw error;
  } finally {
    globalThis.fetch = originalFetch;
    restorePollution();
  }

  const request = captured[0];
  if (!request) {
    throw new Error('SAP client did not send a fetch request');
  }
  return request;
}

function expectUnpollutedAuthorization(request: CapturedRequest) {
  expect(request.authorization).toBe(LEGITIMATE_AUTHORIZATION);
  expect(request.attackerHeader).toBeNull();
}

describe('axios fetch adapter inherited FormData headers', () => {
  it('keeps orchestration chat completion headers free of inherited getHeaders', async () => {
    const { orchestration } = await loadSapClients();
    const client = new orchestration.OrchestrationClient(
      {
        promptTemplating: {
          model: { name: 'gpt-4o' },
          prompt: { template: [{ role: 'user', content: '{{?text}}' }] },
        },
      },
      { deploymentId: 'example' },
      destination,
    );
    const request = await captureSapFetch(() =>
      client.chatCompletion(
        { messages: [{ role: 'user', content: 'hello' }] },
        clineFetchRequestConfig,
      ),
    );
    expect(request.url).toContain('/inference/deployments/example/');
    expectUnpollutedAuthorization(request);
  });

  it('keeps orchestration chat stream headers free of inherited getHeaders', async () => {
    const { orchestration } = await loadSapClients();
    const client = new orchestration.OrchestrationClient(
      {
        promptTemplating: {
          model: { name: 'gpt-4o' },
          prompt: { template: [{ role: 'user', content: '{{?text}}' }] },
        },
      },
      { deploymentId: 'example' },
      destination,
    );
    const request = await captureSapFetch(() =>
      client.stream(
        { messages: [{ role: 'user', content: 'hello' }] },
        undefined,
        undefined,
        clineFetchRequestConfig,
      ),
    );
    expectUnpollutedAuthorization(request);
  });

  it('keeps orchestration embedding headers free of inherited getHeaders', async () => {
    const { orchestration } = await loadSapClients();
    const client = new orchestration.OrchestrationEmbeddingClient(
      { embeddings: { model: { name: 'text-embedding-3-small' } } },
      { deploymentId: 'example' },
      destination,
    );
    const request = await captureSapFetch(() =>
      client.embed({ input: 'hello' }, clineFetchRequestConfig),
    );
    expectUnpollutedAuthorization(request);
  });

  it('keeps foundation-model chat completion headers free of inherited getHeaders', async () => {
    const { foundation } = await loadSapClients();
    const client = new foundation.AzureOpenAiChatClient(
      { deploymentId: 'example', resourceGroup: 'default' },
      destination,
    );
    const request = await captureSapFetch(() =>
      client.run(
        { messages: [{ role: 'user', content: 'hello' }] },
        clineFetchRequestConfig,
      ),
    );
    expectUnpollutedAuthorization(request);
  });

  it('keeps foundation-model chat stream headers free of inherited getHeaders', async () => {
    const { foundation } = await loadSapClients();
    const client = new foundation.AzureOpenAiChatClient(
      { deploymentId: 'example', resourceGroup: 'default' },
      destination,
    );
    const request = await captureSapFetch(() =>
      client.stream(
        { messages: [{ role: 'user', content: 'hello' }] },
        undefined,
        clineFetchRequestConfig,
      ),
    );
    expectUnpollutedAuthorization(request);
  });

  it('keeps foundation-model embedding headers free of inherited getHeaders', async () => {
    const { foundation } = await loadSapClients();
    const client = new foundation.AzureOpenAiEmbeddingClient(
      { deploymentId: 'example', resourceGroup: 'default' },
      destination,
    );
    const request = await captureSapFetch(() =>
      client.run({ input: 'hello' }, clineFetchRequestConfig),
    );
    expectUnpollutedAuthorization(request);
  });
});
