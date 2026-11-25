import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAmazonBedrockAnthropic } from './anthropic/amazon-bedrock-anthropic-provider';
import { createAmazonBedrock } from './amazon-bedrock-provider';
import { createBedrockMantle } from './mantle/bedrock-mantle-provider';
import { createAnthropicAws } from '../../anthropic-aws/src/anthropic-aws-provider';

/**
 * Security spec: a region string is not a URL. Chat, embedding, image, rerank,
 * Bedrock Anthropic, Mantle, and Claude Platform on AWS calls must not open a
 * connection to a host chosen by `?`, `#`, or `/` inside the region, and must
 * not send the bearer token, SigV4 authorization, session token, or prompt
 * there. Refusing before any socket is opened satisfies the spec.
 *
 * These tests fail while that interpolation is unsanitized.
 */

const PROMPT_MARKER = 'region-host-injection-prompt-marker';
const PLACEHOLDER_BEARER = 'placeholder-bearer-token';
const PLACEHOLDER_ACCESS_KEY_ID = 'placeholder-access-key-id';
const PLACEHOLDER_SECRET_ACCESS_KEY = 'placeholder-secret-access-key';
const PLACEHOLDER_SESSION_TOKEN = 'placeholder-session-token';
const PLACEHOLDER_API_KEY = 'placeholder-api-key';
const PLACEHOLDER_WORKSPACE_ID = 'placeholder-workspace-id';

const CHAT_PROMPT: LanguageModelV4Prompt = [
  { role: 'user', content: [{ type: 'text', text: PROMPT_MARKER }] },
];

const SAFE_HOSTNAME =
  /^(?:bedrock-runtime|bedrock-agent-runtime|bedrock-mantle|aws-external-anthropic)\.[a-z0-9-]+\.(?:amazonaws\.com|amazonaws\.com\.cn|c2s\.ic\.gov|sc2s\.sgov\.gov|cloud\.adc-e\.uk|csp\.hci\.ic\.gov|amazonaws\.eu|api\.aws)$/;

const ENDPOINT_ENV_KEYS = [
  'AWS_REGION',
  'AWS_ENDPOINT_URL',
  'AWS_ENDPOINT_URL_BEDROCK_RUNTIME',
  'AWS_ENDPOINT_URL_BEDROCK_AGENT_RUNTIME',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_AWS_WORKSPACE_ID',
] as const;

type ConnectionAttempt = {
  host?: string;
  servername?: string;
  port?: number;
};

type HttpCapture = {
  hostHeader?: string;
  path?: string;
  hasAuthorization: boolean;
  hasSessionToken: boolean;
  hasApiKey: boolean;
  bodyContainsPrompt: boolean;
};

const connectionAttempts: ConnectionAttempt[] = [];
const httpCaptures: HttpCapture[] = [];

let restoreTlsConnect: (() => void) | undefined;
let serverClose: (() => Promise<void>) | undefined;
const savedEnv = new Map<string, string | undefined>();

const isNodeRuntime = await (async () => {
  if (typeof process === 'undefined' || process.release?.name !== 'node') {
    return false;
  }

  try {
    await import('node:tls');
    await import('node:https');
    await import('node:child_process');
    return true;
  } catch {
    return false;
  }
})();

function hostnameOf(value: string | undefined): string | undefined {
  if (value == null || value.length === 0) {
    return undefined;
  }

  const withoutBrackets = value.startsWith('[')
    ? value.slice(1, value.indexOf(']'))
    : value;
  const colon = withoutBrackets.lastIndexOf(':');
  // Hostnames in this test are DNS names. A colon, when present, is a port.
  if (colon > -1 && /^\d+$/.test(withoutBrackets.slice(colon + 1))) {
    return withoutBrackets.slice(0, colon).toLowerCase();
  }

  return withoutBrackets.toLowerCase();
}

function isSafeHostname(hostname: string | undefined): boolean {
  return hostname != null && SAFE_HOSTNAME.test(hostname);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function unsafeConnections(): ConnectionAttempt[] {
  return connectionAttempts.filter(attempt => {
    const host = hostnameOf(attempt.host) ?? hostnameOf(attempt.servername);
    return (
      host != null &&
      host !== '127.0.0.1' &&
      host !== 'localhost' &&
      !isSafeHostname(host)
    );
  });
}

function unsafeResponses(): HttpCapture[] {
  return httpCaptures.filter(
    capture => !isSafeHostname(hostnameOf(capture.hostHeader)),
  );
}

function describeLeak(): unknown {
  return {
    connections: unsafeConnections().map(attempt => ({
      host: attempt.host,
      servername: attempt.servername,
      port: attempt.port,
    })),
    responses: unsafeResponses().map(capture => ({
      host: capture.hostHeader,
      path: capture.path,
      hasAuthorization: capture.hasAuthorization,
      hasSessionToken: capture.hasSessionToken,
      hasApiKey: capture.hasApiKey,
      bodyContainsPrompt: capture.bodyContainsPrompt,
    })),
  };
}

async function exercise(run: () => Promise<unknown>): Promise<void> {
  connectionAttempts.length = 0;
  httpCaptures.length = 0;

  try {
    const result = await run();
    const stream = (result as { stream?: { cancel?: () => Promise<void> } })
      ?.stream;
    await stream?.cancel?.();
  } catch {
    // A refusal, or a response the model cannot parse, is fine.
    // A socket to the region-selected host is not.
  }
}

function expectNoCredentialLeak(): void {
  expect(
    describeLeak(),
    'region must not select a non-AWS request host',
  ).toEqual({
    connections: [],
    responses: [],
  });
}

function clearEndpointEnv(): void {
  for (const key of ENDPOINT_ENV_KEYS) {
    delete process.env[key];
  }
}

describe.skipIf(!isNodeRuntime)(
  'Amazon Bedrock region is not a request host',
  () => {
    beforeAll(async () => {
      for (const key of ENDPOINT_ENV_KEYS) {
        savedEnv.set(key, process.env[key]);
      }
      clearEndpointEnv();

      const { default: tls } = await import('node:tls');
      const { default: https } = await import('node:https');
      const { execFileSync } = await import('node:child_process');
      const { mkdtempSync, readFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');

      const directory = mkdtempSync(join(tmpdir(), 'bedrock-region-host-'));
      const keyPath = join(directory, 'key.pem');
      const certPath = join(directory, 'cert.pem');
      execFileSync('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '1',
        '-nodes',
        '-subj',
        '/CN=localhost',
      ]);

      const server = https.createServer(
        {
          key: readFileSync(keyPath),
          cert: readFileSync(certPath),
        },
        (request, response) => {
          const chunks: Buffer[] = [];
          request.on('data', chunk => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          request.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            httpCaptures.push({
              hostHeader: headerValue(request.headers.host),
              path: request.url,
              hasAuthorization:
                headerValue(request.headers.authorization) != null,
              hasSessionToken:
                headerValue(request.headers['x-amz-security-token']) != null,
              hasApiKey: headerValue(request.headers['x-api-key']) != null,
              bodyContainsPrompt: body.includes(PROMPT_MARKER),
            });
            response.writeHead(200, {
              'content-type': 'application/json',
              connection: 'close',
            });
            response.end('{}');
          });
        },
      );

      await new Promise<void>(resolve => {
        server.listen(0, '127.0.0.1', () => resolve());
      });
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      const originalConnect = tls.connect;
      const patchedConnect: typeof tls.connect = function patched(
        this: unknown,
        ...args: Parameters<typeof tls.connect>
      ) {
        const options = args[0];
        if (typeof options === 'object' && options != null) {
          connectionAttempts.push({
            host: typeof options.host === 'string' ? options.host : undefined,
            servername:
              typeof options.servername === 'string'
                ? options.servername
                : undefined,
            port: typeof options.port === 'number' ? options.port : undefined,
          });
          args[0] = {
            ...options,
            host: '127.0.0.1',
            port,
            servername: 'localhost',
            rejectUnauthorized: false,
          };
        }

        return originalConnect.apply(this, args);
      };
      tls.connect = patchedConnect;
      restoreTlsConnect = () => {
        tls.connect = originalConnect;
      };

      serverClose = () =>
        new Promise(resolve => {
          server.close(() => resolve());
        });
    });

    afterAll(async () => {
      restoreTlsConnect?.();
      await serverClose?.();
      for (const [key, value] of savedEnv) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });

    it('keeps a normal region on the AWS hostname and sends the prompt', async () => {
      await exercise(async () => {
        const provider = createAmazonBedrock({
          region: 'us-east-1',
          apiKey: PLACEHOLDER_BEARER,
        });
        await provider
          .languageModel('anthropic.claude-3-haiku-20240307-v1:0')
          .doGenerate({ prompt: CHAT_PROMPT });
      });

      expectNoCredentialLeak();
      expect(connectionAttempts.map(attempt => attempt.host)).toContain(
        'bedrock-runtime.us-east-1.amazonaws.com',
      );
      expect(httpCaptures).toEqual([
        expect.objectContaining({
          hostHeader: 'bedrock-runtime.us-east-1.amazonaws.com',
          hasAuthorization: true,
          bodyContainsPrompt: true,
        }),
      ]);
    });

    it.each([
      ['question mark', 'attacker.example?'],
      ['hash', 'attacker.example#'],
      ['slash', 'attacker.example/'],
    ])(
      'does not send a bearer chat generate request through a region %s',
      async (_label, region) => {
        await exercise(async () => {
          const provider = createAmazonBedrock({
            region,
            apiKey: PLACEHOLDER_BEARER,
          });
          await provider
            .languageModel('anthropic.claude-3-haiku-20240307-v1:0')
            .doGenerate({ prompt: CHAT_PROMPT });
        });

        expectNoCredentialLeak();
      },
    );

    it('does not send a bearer chat stream through a region hash', async () => {
      await exercise(async () => {
        const provider = createAmazonBedrock({
          region: 'attacker.example#',
          apiKey: PLACEHOLDER_BEARER,
        });
        return provider
          .languageModel('anthropic.claude-3-haiku-20240307-v1:0')
          .doStream({ prompt: CHAT_PROMPT });
      });

      expectNoCredentialLeak();
    });

    it('does not send a bearer embedding request through a region question mark', async () => {
      await exercise(async () => {
        const provider = createAmazonBedrock({
          region: 'attacker.example?',
          apiKey: PLACEHOLDER_BEARER,
        });
        await provider.embeddingModel('amazon.titan-embed-text-v2:0').doEmbed({
          values: [PROMPT_MARKER],
        });
      });

      expectNoCredentialLeak();
    });

    it('does not send a bearer image request through a region hash', async () => {
      await exercise(async () => {
        const provider = createAmazonBedrock({
          region: 'attacker.example#',
          apiKey: PLACEHOLDER_BEARER,
        });
        await provider.imageModel('amazon.nova-canvas-v1:0').doGenerate({
          prompt: PROMPT_MARKER,
          n: 1,
          size: undefined,
          aspectRatio: undefined,
          seed: undefined,
          files: undefined,
          mask: undefined,
          providerOptions: {},
        });
      });

      expectNoCredentialLeak();
    });

    it('does not send a bearer rerank request through a region question mark', async () => {
      await exercise(async () => {
        const provider = createAmazonBedrock({
          region: 'attacker.example?',
          apiKey: PLACEHOLDER_BEARER,
        });
        await provider.rerankingModel('cohere.rerank-v3-5:0').doRerank({
          documents: { type: 'text', values: [PROMPT_MARKER] },
          query: PROMPT_MARKER,
          topN: 1,
        });
      });

      expectNoCredentialLeak();
    });

    it('does not send SigV4 access key id or session token through a region question mark', async () => {
      await exercise(async () => {
        const provider = createAmazonBedrock({
          region: 'attacker.example?',
          accessKeyId: PLACEHOLDER_ACCESS_KEY_ID,
          secretAccessKey: PLACEHOLDER_SECRET_ACCESS_KEY,
          sessionToken: PLACEHOLDER_SESSION_TOKEN,
        });
        await provider
          .languageModel('anthropic.claude-3-haiku-20240307-v1:0')
          .doGenerate({ prompt: CHAT_PROMPT });
      });

      expectNoCredentialLeak();
    });

    it('does not send a bearer request when AWS_REGION contains a question mark', async () => {
      process.env.AWS_REGION = 'attacker.example?';

      try {
        await exercise(async () => {
          const provider = createAmazonBedrock({
            apiKey: PLACEHOLDER_BEARER,
          });
          await provider
            .languageModel('anthropic.claude-3-haiku-20240307-v1:0')
            .doGenerate({ prompt: CHAT_PROMPT });
        });

        expectNoCredentialLeak();
      } finally {
        delete process.env.AWS_REGION;
      }
    });

    it('does not use a region read that happens after an earlier safe read', async () => {
      const realEnv = process.env;
      let reads = 0;
      process.env = new Proxy(realEnv, {
        get(target, property, receiver) {
          if (property === 'AWS_REGION') {
            reads += 1;
            return reads === 1 ? 'us-east-1' : 'attacker.example?';
          }

          return Reflect.get(target, property, receiver);
        },
      });

      try {
        await exercise(async () => {
          const provider = createAmazonBedrock({
            apiKey: PLACEHOLDER_BEARER,
          });
          await provider
            .languageModel('anthropic.claude-3-haiku-20240307-v1:0')
            .doGenerate({ prompt: CHAT_PROMPT });
        });

        expectNoCredentialLeak();
      } finally {
        process.env = realEnv;
      }
    });

    it('does not send a Bedrock Anthropic bearer request through a region question mark', async () => {
      await exercise(async () => {
        const provider = createAmazonBedrockAnthropic({
          region: 'attacker.example?',
          apiKey: PLACEHOLDER_BEARER,
        });
        await provider
          .languageModel('anthropic.claude-3-5-sonnet-20241022-v2:0')
          .doGenerate({ prompt: CHAT_PROMPT });
      });

      expectNoCredentialLeak();
    });

    it('does not stream a Bedrock Anthropic bearer request through a region hash', async () => {
      await exercise(async () => {
        const provider = createAmazonBedrockAnthropic({
          region: 'attacker.example#',
          apiKey: PLACEHOLDER_BEARER,
        });
        return provider
          .languageModel('anthropic.claude-3-5-sonnet-20241022-v2:0')
          .doStream({ prompt: CHAT_PROMPT });
      });

      expectNoCredentialLeak();
    });

    it('does not send a Mantle chat bearer request through a region hash', async () => {
      await exercise(async () => {
        const provider = createBedrockMantle({
          region: 'attacker.example#',
          apiKey: PLACEHOLDER_BEARER,
        });
        await provider.languageModel('openai.gpt-oss-20b').doGenerate({
          prompt: CHAT_PROMPT,
        });
      });

      expectNoCredentialLeak();
    });

    it('does not send a Mantle responses bearer request through a region slash', async () => {
      await exercise(async () => {
        const provider = createBedrockMantle({
          region: 'attacker.example/',
          apiKey: PLACEHOLDER_BEARER,
        });
        await provider.responses('openai.gpt-oss-20b').doGenerate({
          prompt: CHAT_PROMPT,
        });
      });

      expectNoCredentialLeak();
    });

    it('does not stream a Mantle chat bearer request through a region question mark', async () => {
      await exercise(async () => {
        const provider = createBedrockMantle({
          region: 'attacker.example?',
          apiKey: PLACEHOLDER_BEARER,
        });
        return provider.languageModel('openai.gpt-oss-20b').doStream({
          prompt: CHAT_PROMPT,
        });
      });

      expectNoCredentialLeak();
    });

    it('does not send a Claude Platform on AWS bearer request through a region question mark', async () => {
      await exercise(async () => {
        const provider = createAnthropicAws({
          region: 'attacker.example?',
          apiKey: PLACEHOLDER_API_KEY,
          workspaceId: PLACEHOLDER_WORKSPACE_ID,
        });
        await provider.languageModel('claude-3-haiku-20240307').doGenerate({
          prompt: CHAT_PROMPT,
        });
      });

      expectNoCredentialLeak();
    });

    it('does not upload a Claude Platform on AWS file through a region hash', async () => {
      await exercise(async () => {
        const provider = createAnthropicAws({
          region: 'attacker.example#',
          apiKey: PLACEHOLDER_API_KEY,
          workspaceId: PLACEHOLDER_WORKSPACE_ID,
        });
        await provider.files().uploadFile({
          data: { type: 'text', text: PROMPT_MARKER },
          mediaType: 'text/plain',
          filename: 'note.txt',
        });
      });

      expectNoCredentialLeak();
    });

    it('does not upload a Claude Platform on AWS skill through a region slash', async () => {
      await exercise(async () => {
        const provider = createAnthropicAws({
          region: 'attacker.example/',
          apiKey: PLACEHOLDER_API_KEY,
          workspaceId: PLACEHOLDER_WORKSPACE_ID,
        });
        await provider.skills().uploadSkill({
          displayTitle: PROMPT_MARKER,
          files: [
            {
              path: 'skill.md',
              data: { type: 'text', text: PROMPT_MARKER },
            },
          ],
        });
      });

      expectNoCredentialLeak();
    });
  },
);
