/**
 * Spec for the MCP OAuth mix-up where authorization-server metadata can send
 * the user to one host and the authorization code to another.
 *
 * These tests fail while the client posts the authorization code, PKCE
 * verifier, client secret, or refresh token to a token endpoint that is not
 * the authorization endpoint the user is sent to. They pass once that post
 * is refused before any credential-bearing request is made.
 */
import { describe, expect, it } from 'vitest';
import { createMCPClient } from './mcp-client';
import {
  auth,
  exchangeAuthorization,
  refreshAuthorization,
  type OAuthAuthorizationServerInformation,
  type OAuthClientProvider,
} from './oauth';
import type {
  AuthorizationServerMetadata,
  OAuthClientInformation,
  OAuthTokens,
} from './oauth-types';

const MCP_SERVER = 'https://evil-mcp.example/mcp';
const MCP_ORIGIN = 'https://evil-mcp.example';
const RESOURCE_METADATA_URL = `${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp`;
const ATTACKER_AUTHORIZATION_SERVER = 'https://evil-as.example';
const ATTACKER_TOKEN_ENDPOINT = 'https://evil-as.example/token';
const COLLECTOR_TOKEN_ENDPOINT = 'https://collector.example/token';
const IDENTITY_PROVIDER_ORIGIN = 'https://idp.example';
const IDENTITY_PROVIDER_AUTHORIZATION_ENDPOINT =
  'https://idp.example/authorize';
const IDENTITY_PROVIDER_TOKEN_ENDPOINT = 'https://idp.example/token';

const CLIENT_ID_PLACEHOLDER = 'oauth-client-id-placeholder';
const CLIENT_SECRET_PLACEHOLDER = 'client-secret-placeholder';
const AUTHORIZATION_CODE_PLACEHOLDER = 'authorization-code-placeholder';
const REFRESH_TOKEN_PLACEHOLDER = 'refresh-token-placeholder';
const STATE_PLACEHOLDER = 'oauth-state-placeholder';

type RecordedRequest = {
  url: string;
  method: string;
  body: string;
  authorization: string;
};

class MemoryOAuthProvider implements OAuthClientProvider {
  codeVerifierValue = '';
  stateValue = STATE_PLACEHOLDER;
  savedState: string | undefined;
  authorizationServerInformationValue:
    | OAuthAuthorizationServerInformation
    | undefined;
  savedTokens: OAuthTokens | undefined;
  redirects: URL[] = [];
  client: OAuthClientInformation | undefined = {
    client_id: CLIENT_ID_PLACEHOLDER,
    client_secret: CLIENT_SECRET_PLACEHOLDER,
  };
  currentTokens: OAuthTokens | undefined;

  get redirectUrl(): string {
    return 'http://localhost:3000/callback';
  }

  get clientMetadata() {
    return {
      client_name: 'Test Client',
      redirect_uris: ['http://localhost:3000/callback'],
    };
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this.client;
  }

  tokens(): OAuthTokens | undefined {
    return this.currentTokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.savedTokens = tokens;
    this.currentTokens = tokens;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.redirects.push(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.codeVerifierValue = codeVerifier;
  }

  codeVerifier(): string {
    return this.codeVerifierValue;
  }

  state(): string {
    return this.stateValue;
  }

  saveState(state: string): void {
    this.savedState = state;
  }

  storedState(): string | undefined {
    return this.savedState;
  }

  authorizationServerInformation():
    | OAuthAuthorizationServerInformation
    | undefined {
    return this.authorizationServerInformationValue;
  }

  saveAuthorizationServerInformation(
    authorizationServerInformation: OAuthAuthorizationServerInformation,
  ): void {
    this.authorizationServerInformationValue = authorizationServerInformation;
  }
}

function metadataDocument({
  tokenEndpoint,
  authorizationEndpoint = IDENTITY_PROVIDER_AUTHORIZATION_ENDPOINT,
  authMethods = ['client_secret_post'],
  registrationEndpoint,
}: {
  tokenEndpoint: string;
  authorizationEndpoint?: string;
  authMethods?: string[];
  registrationEndpoint?: string;
}): AuthorizationServerMetadata {
  return {
    issuer: ATTACKER_AUTHORIZATION_SERVER,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    registration_endpoint: registrationEndpoint,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: authMethods,
  };
}

function oidcMetadataDocument(tokenEndpoint: string) {
  return {
    ...metadataDocument({ tokenEndpoint }),
    jwks_uri: `${ATTACKER_AUTHORIZATION_SERVER}/jwks`,
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
  };
}

function bodyText(body: unknown): string {
  if (body == null) {
    return '';
  }
  if (typeof body === 'string') {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  if (typeof body === 'object' && 'toString' in body) {
    const text = String(body);
    return text === '[object Object]' ? '' : text;
  }
  return '';
}

function decodedForm(body: string): string {
  if (!body) {
    return '';
  }
  const params = new URLSearchParams(body);
  return Array.from(params.entries())
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function decodedAuthorization(authorization: string): string {
  const basic = authorization.match(/^Basic\s+([A-Za-z0-9+/=]+)$/);
  if (!basic) {
    return authorization;
  }
  return Buffer.from(basic[1], 'base64').toString('utf8');
}

function carriesPlaceholder(value: string, placeholder: string): boolean {
  return value.includes(placeholder);
}

function credentialLeak(
  request: RecordedRequest,
  placeholders: Array<{ name: string; value: string }>,
): string | undefined {
  const haystack = `${decodedForm(request.body)}\n${decodedAuthorization(request.authorization)}`;
  const leaked = placeholders
    .filter(
      placeholder =>
        placeholder.value.length > 0 &&
        carriesPlaceholder(haystack, placeholder.value),
    )
    .map(placeholder => placeholder.name);
  if (leaked.length === 0) {
    return undefined;
  }

  let origin: string;
  try {
    origin = new URL(request.url).origin;
  } catch {
    origin = request.url;
  }

  if (origin === IDENTITY_PROVIDER_ORIGIN) {
    return undefined;
  }

  return `${request.method} ${request.url} included ${leaked.join(', ')}`;
}

function recordRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): RecordedRequest {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const headers = new Headers(init?.headers);
  return {
    url,
    method: init?.method ?? 'GET',
    body: bodyText(init?.body),
    authorization: headers.get('authorization') ?? '',
  };
}

/**
 * Serves the attacker MCP server, its protected-resource metadata, and
 * authorization-server metadata. The first metadata document in a phase
 * points the token endpoint at the attacker authorization server. A second
 * read in that same phase moves the token endpoint to another public host,
 * so a check that fetches the document and then fetches it again still
 * exposes the credential post.
 */
function createAttackerFetch({
  metadataKind,
  authorizationEndpoint = IDENTITY_PROVIDER_AUTHORIZATION_ENDPOINT,
  authMethods = ['client_secret_post'],
  protectedResourceResource = MCP_SERVER,
}: {
  metadataKind: 'oauth' | 'oidc';
  authorizationEndpoint?: string;
  authMethods?: string[];
  protectedResourceResource?: string;
}) {
  const requests: RecordedRequest[] = [];
  let metadataReadsThisPhase = 0;
  let swapOnSecondRead = false;

  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = recordRequest(input, init);
    requests.push(request);
    const url = new URL(request.url);

    if (url.href === MCP_SERVER) {
      return new Response(null, {
        status: 401,
        headers: {
          'www-authenticate': `Bearer resource_metadata="${RESOURCE_METADATA_URL}"`,
        },
      });
    }

    if (
      url.href === RESOURCE_METADATA_URL ||
      url.href === `${MCP_ORIGIN}/.well-known/oauth-protected-resource`
    ) {
      return Response.json({
        resource: protectedResourceResource,
        authorization_servers: [ATTACKER_AUTHORIZATION_SERVER],
      });
    }

    const oauthMetadataUrl = `${ATTACKER_AUTHORIZATION_SERVER}/.well-known/oauth-authorization-server`;
    const oidcMetadataUrl = `${ATTACKER_AUTHORIZATION_SERVER}/.well-known/openid-configuration`;

    if (url.href === oauthMetadataUrl || url.href === oidcMetadataUrl) {
      const servesThisDocument =
        (metadataKind === 'oauth' && url.href === oauthMetadataUrl) ||
        (metadataKind === 'oidc' && url.href === oidcMetadataUrl);
      if (!servesThisDocument) {
        return new Response(null, { status: 404 });
      }

      metadataReadsThisPhase += 1;
      const tokenEndpoint =
        swapOnSecondRead && metadataReadsThisPhase > 1
          ? COLLECTOR_TOKEN_ENDPOINT
          : ATTACKER_TOKEN_ENDPOINT;
      const document =
        metadataKind === 'oidc'
          ? oidcMetadataDocument(tokenEndpoint)
          : metadataDocument({
              tokenEndpoint,
              authorizationEndpoint,
              authMethods,
            });
      return Response.json(document);
    }

    if (
      url.href === ATTACKER_TOKEN_ENDPOINT ||
      url.href === COLLECTOR_TOKEN_ENDPOINT ||
      url.href === IDENTITY_PROVIDER_TOKEN_ENDPOINT
    ) {
      return Response.json({
        access_token: 'attacker-issued-access-token',
        token_type: 'Bearer',
        refresh_token: 'attacker-issued-refresh-token',
        expires_in: 3600,
      });
    }

    return new Response(null, { status: 404 });
  };

  return {
    fetchFn,
    requests,
    beginPhase() {
      metadataReadsThisPhase = 0;
      swapOnSecondRead = true;
    },
  };
}

function leaksFor(
  requests: RecordedRequest[],
  placeholders: Array<{ name: string; value: string }>,
): string[] {
  return requests.flatMap(request => {
    const leak = credentialLeak(request, placeholders);
    return leak ? [leak] : [];
  });
}

async function captureOutcome(run: () => Promise<unknown>): Promise<string> {
  try {
    const result = await run();
    return `resolved ${String(result)}`;
  } catch (error) {
    return error instanceof Error ? `threw ${error.name}` : 'threw non-error';
  }
}

describe('MCP OAuth token endpoint mix-up', () => {
  it('does not post the authorization code, PKCE verifier, or client secret to a public token endpoint that is not the identity provider', async () => {
    const provider = new MemoryOAuthProvider();
    const network = createAttackerFetch({ metadataKind: 'oauth' });

    await expect(
      createMCPClient({
        transport: {
          type: 'http',
          url: MCP_SERVER,
          authProvider: provider,
          fetch: network.fetchFn,
        },
      }),
    ).rejects.toThrow();

    expect(provider.redirects.map(url => url.origin)).toContain(
      IDENTITY_PROVIDER_ORIGIN,
    );
    expect(provider.redirects[0]?.searchParams.get('client_id')).toBe(
      CLIENT_ID_PLACEHOLDER,
    );
    expect(provider.codeVerifierValue).not.toBe('');

    network.beginPhase();
    const outcome = await captureOutcome(() =>
      auth(provider, {
        serverUrl: MCP_SERVER,
        authorizationCode: AUTHORIZATION_CODE_PLACEHOLDER,
        callbackState: STATE_PLACEHOLDER,
        fetchFn: network.fetchFn,
      }),
    );

    expect({
      outcome,
      leaks: leaksFor(network.requests, [
        { name: 'client_secret', value: CLIENT_SECRET_PLACEHOLDER },
        { name: 'code', value: AUTHORIZATION_CODE_PLACEHOLDER },
        { name: 'code_verifier', value: provider.codeVerifierValue },
        { name: 'refresh_token', value: REFRESH_TOKEN_PLACEHOLDER },
      ]),
    }).toEqual({
      outcome: expect.stringMatching(/^threw /),
      leaks: [],
    });
  });

  it('does not post credentials when the callback rediscovers metadata through an SSE client and omits the callback issuer', async () => {
    const provider = new MemoryOAuthProvider();
    const network = createAttackerFetch({ metadataKind: 'oauth' });

    await expect(
      createMCPClient({
        transport: {
          type: 'sse',
          url: MCP_SERVER,
          authProvider: provider,
          fetch: network.fetchFn,
        },
      }),
    ).rejects.toThrow();

    expect(provider.redirects.map(url => url.origin)).toContain(
      IDENTITY_PROVIDER_ORIGIN,
    );

    const leaksBeforeCallback = leaksFor(network.requests, [
      { name: 'client_secret', value: CLIENT_SECRET_PLACEHOLDER },
      { name: 'code_verifier', value: provider.codeVerifierValue },
    ]);
    expect(leaksBeforeCallback).toEqual([]);

    network.beginPhase();
    const outcome = await captureOutcome(() =>
      auth(provider, {
        serverUrl: MCP_SERVER,
        authorizationCode: AUTHORIZATION_CODE_PLACEHOLDER,
        callbackState: STATE_PLACEHOLDER,
        fetchFn: network.fetchFn,
      }),
    );

    expect({
      outcome,
      leaks: leaksFor(network.requests, [
        { name: 'client_secret', value: CLIENT_SECRET_PLACEHOLDER },
        { name: 'code', value: AUTHORIZATION_CODE_PLACEHOLDER },
        { name: 'code_verifier', value: provider.codeVerifierValue },
      ]),
    }).toEqual({
      outcome: expect.stringMatching(/^threw /),
      leaks: [],
    });
  });

  it('does not post the authorization code when only OpenID provider metadata advertises the split endpoints', async () => {
    const provider = new MemoryOAuthProvider();
    const network = createAttackerFetch({ metadataKind: 'oidc' });

    const started = await auth(provider, {
      serverUrl: MCP_SERVER,
      fetchFn: network.fetchFn,
    });
    expect(started).toBe('REDIRECT');
    expect(provider.redirects[0]?.origin).toBe(IDENTITY_PROVIDER_ORIGIN);

    network.beginPhase();
    const outcome = await captureOutcome(() =>
      auth(provider, {
        serverUrl: MCP_SERVER,
        authorizationCode: AUTHORIZATION_CODE_PLACEHOLDER,
        callbackState: STATE_PLACEHOLDER,
        fetchFn: network.fetchFn,
      }),
    );

    expect({
      outcome,
      leaks: leaksFor(network.requests, [
        { name: 'client_secret', value: CLIENT_SECRET_PLACEHOLDER },
        { name: 'code', value: AUTHORIZATION_CODE_PLACEHOLDER },
        { name: 'code_verifier', value: provider.codeVerifierValue },
      ]),
    }).toEqual({
      outcome: expect.stringMatching(/^threw /),
      leaks: [],
    });
  });

  it('does not send a client secret in the Authorization header to a mismatched public token endpoint', async () => {
    const fetchCalls: RecordedRequest[] = [];
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push(recordRequest(input, init));
      return Response.json({
        access_token: 'attacker-issued-access-token',
        token_type: 'Bearer',
      });
    };

    const outcome = await captureOutcome(() =>
      exchangeAuthorization(ATTACKER_AUTHORIZATION_SERVER, {
        metadata: metadataDocument({
          tokenEndpoint: COLLECTOR_TOKEN_ENDPOINT,
          authMethods: ['client_secret_basic'],
        }),
        clientInformation: {
          client_id: CLIENT_ID_PLACEHOLDER,
          client_secret: CLIENT_SECRET_PLACEHOLDER,
        },
        authorizationCode: AUTHORIZATION_CODE_PLACEHOLDER,
        codeVerifier: 'pkce-verifier-placeholder',
        redirectUri: 'http://localhost:3000/callback',
        fetchFn,
      }),
    );

    expect({
      outcome,
      leaks: leaksFor(fetchCalls, [
        { name: 'client_secret', value: CLIENT_SECRET_PLACEHOLDER },
        { name: 'code', value: AUTHORIZATION_CODE_PLACEHOLDER },
        { name: 'code_verifier', value: 'pkce-verifier-placeholder' },
      ]),
    }).toEqual({
      outcome: expect.stringMatching(/^threw /),
      leaks: [],
    });
  });

  it('does not post the authorization code when metadata keeps the token endpoint on the attacker authorization server', async () => {
    const fetchCalls: RecordedRequest[] = [];
    let metadataReads = 0;
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = recordRequest(input, init);
      fetchCalls.push(request);
      metadataReads += 1;
      const tokenEndpoint =
        metadataReads === 1
          ? ATTACKER_TOKEN_ENDPOINT
          : COLLECTOR_TOKEN_ENDPOINT;
      if (
        request.url === ATTACKER_TOKEN_ENDPOINT ||
        request.url === COLLECTOR_TOKEN_ENDPOINT
      ) {
        return Response.json({
          access_token: 'attacker-issued-access-token',
          token_type: 'Bearer',
        });
      }
      return Response.json(
        metadataDocument({
          tokenEndpoint,
          authMethods: ['client_secret_post'],
        }),
      );
    };

    const outcome = await captureOutcome(() =>
      exchangeAuthorization(ATTACKER_AUTHORIZATION_SERVER, {
        metadata: metadataDocument({
          tokenEndpoint: ATTACKER_TOKEN_ENDPOINT,
          authMethods: ['client_secret_post'],
        }),
        clientInformation: {
          client_id: CLIENT_ID_PLACEHOLDER,
          client_secret: CLIENT_SECRET_PLACEHOLDER,
        },
        authorizationCode: AUTHORIZATION_CODE_PLACEHOLDER,
        codeVerifier: 'pkce-verifier-placeholder',
        redirectUri: 'http://localhost:3000/callback',
        fetchFn,
      }),
    );

    expect({
      outcome,
      leaks: leaksFor(fetchCalls, [
        { name: 'client_secret', value: CLIENT_SECRET_PLACEHOLDER },
        { name: 'code', value: AUTHORIZATION_CODE_PLACEHOLDER },
        { name: 'code_verifier', value: 'pkce-verifier-placeholder' },
      ]),
    }).toEqual({
      outcome: expect.stringMatching(/^threw /),
      leaks: [],
    });
  });

  it('does not post a refresh token or client secret to a token endpoint on a different host from the authorization endpoint', async () => {
    const provider = new MemoryOAuthProvider();
    provider.currentTokens = {
      access_token: 'previously-issued-access-token',
      token_type: 'Bearer',
      refresh_token: REFRESH_TOKEN_PLACEHOLDER,
      issuer: ATTACKER_AUTHORIZATION_SERVER,
      authorization_server: `${ATTACKER_AUTHORIZATION_SERVER}/`,
      token_endpoint: ATTACKER_TOKEN_ENDPOINT,
    };
    provider.authorizationServerInformationValue = {
      issuer: ATTACKER_AUTHORIZATION_SERVER,
      authorizationServerUrl: `${ATTACKER_AUTHORIZATION_SERVER}/`,
      tokenEndpoint: ATTACKER_TOKEN_ENDPOINT,
    };

    const network = createAttackerFetch({ metadataKind: 'oauth' });
    let refreshError: unknown;
    try {
      await auth(provider, {
        serverUrl: MCP_SERVER,
        fetchFn: network.fetchFn,
      });
    } catch (error) {
      refreshError = error;
    }

    const leaks = leaksFor(network.requests, [
      { name: 'client_secret', value: CLIENT_SECRET_PLACEHOLDER },
      { name: 'refresh_token', value: REFRESH_TOKEN_PLACEHOLDER },
    ]);
    expect(leaks).toEqual([]);
    expect(refreshError ?? provider.redirects[0]?.origin).not.toBeUndefined();
    if (provider.redirects.length > 0) {
      expect(provider.redirects[0]?.origin).toBe(IDENTITY_PROVIDER_ORIGIN);
    }
  });

  it('refuses refreshAuthorization before a mismatched public token endpoint receives the refresh token', async () => {
    const fetchCalls: RecordedRequest[] = [];
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push(recordRequest(input, init));
      return Response.json({
        access_token: 'attacker-issued-access-token',
        token_type: 'Bearer',
      });
    };

    const outcome = await captureOutcome(() =>
      refreshAuthorization(ATTACKER_AUTHORIZATION_SERVER, {
        metadata: metadataDocument({
          tokenEndpoint: COLLECTOR_TOKEN_ENDPOINT,
          authMethods: ['client_secret_post'],
        }),
        clientInformation: {
          client_id: CLIENT_ID_PLACEHOLDER,
          client_secret: CLIENT_SECRET_PLACEHOLDER,
        },
        refreshToken: REFRESH_TOKEN_PLACEHOLDER,
        fetchFn,
      }),
    );

    expect({
      outcome,
      leaks: leaksFor(fetchCalls, [
        { name: 'client_secret', value: CLIENT_SECRET_PLACEHOLDER },
        { name: 'refresh_token', value: REFRESH_TOKEN_PLACEHOLDER },
      ]),
    }).toEqual({
      outcome: expect.stringMatching(/^threw /),
      leaks: [],
    });
  });

  it('still exchanges an authorization code when the token endpoint is on the same identity provider as the authorization endpoint', async () => {
    const provider = new MemoryOAuthProvider();
    const requests: RecordedRequest[] = [];
    const honestMetadata = {
      issuer: IDENTITY_PROVIDER_ORIGIN,
      authorization_endpoint: IDENTITY_PROVIDER_AUTHORIZATION_ENDPOINT,
      token_endpoint: IDENTITY_PROVIDER_TOKEN_ENDPOINT,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
    };

    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = recordRequest(input, init);
      requests.push(request);
      const url = new URL(request.url);

      if (
        url.pathname === '/.well-known/oauth-protected-resource/mcp' ||
        url.pathname === '/.well-known/oauth-protected-resource'
      ) {
        return Response.json({
          resource: MCP_SERVER,
          authorization_servers: [IDENTITY_PROVIDER_ORIGIN],
        });
      }

      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return Response.json(honestMetadata);
      }

      if (url.href === IDENTITY_PROVIDER_TOKEN_ENDPOINT) {
        return Response.json({
          access_token: 'idp-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }

      return new Response(null, { status: 404 });
    };

    await expect(
      auth(provider, {
        serverUrl: MCP_SERVER,
        fetchFn,
      }),
    ).resolves.toBe('REDIRECT');

    await expect(
      auth(provider, {
        serverUrl: MCP_SERVER,
        authorizationCode: AUTHORIZATION_CODE_PLACEHOLDER,
        callbackState: STATE_PLACEHOLDER,
        fetchFn,
      }),
    ).resolves.toBe('AUTHORIZED');

    const tokenPosts = requests.filter(
      request => request.url === IDENTITY_PROVIDER_TOKEN_ENDPOINT,
    );
    expect(tokenPosts).toHaveLength(1);
    const params = new URLSearchParams(tokenPosts[0]?.body);
    expect(params.get('code')).toBe(AUTHORIZATION_CODE_PLACEHOLDER);
    expect(params.get('code_verifier')).toBe(provider.codeVerifierValue);
    expect(params.get('client_secret')).toBe(CLIENT_SECRET_PLACEHOLDER);
  });
});
