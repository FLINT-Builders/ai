import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import type { FetchFunction } from '@ai-sdk/provider-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createAmazonBedrock } from '../amazon-bedrock-provider';
import { createAmazonBedrockAnthropic } from '../anthropic/amazon-bedrock-anthropic-provider';
import { createBedrockMantle } from './bedrock-mantle-provider';

const PROMPT_MARKER = 'prompt-marker-for-region-host-test';
const PLACEHOLDER_BEARER = 'placeholder-bearer-token';
const PLACEHOLDER_ACCESS_KEY_ID = 'placeholder-access-key-id';
const PLACEHOLDER_SECRET_ACCESS_KEY = 'placeholder-secret-access-key';
const PLACEHOLDER_SESSION_TOKEN = 'placeholder-session-token';

const LANGUAGE_PROMPT: LanguageModelV4Prompt = [
  {
    role: 'user',
    content: [{ type: 'text', text: PROMPT_MARKER }],
  },
];

type CapturedRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

/**
 * A credentialed request may only be issued to the hostname produced from a
 * single DNS-label region. These tests fail while a `?` or `#` in the region
 * selects a different host and the prompt plus credentials are still sent.
 */
function assertCredentialedRequestsStayOnServiceHost(
  captured: CapturedRequest[],
  serviceHost: RegExp,
) {
  for (const request of captured) {
    const { hostname } = new URL(request.url);
    const credentialed =
      request.headers.authorization != null ||
      request.headers['x-amz-security-token'] != null;
    const carriesPrompt = request.body.includes(PROMPT_MARKER);

    if (credentialed || carriesPrompt) {
      expect(hostname).toMatch(serviceHost);
    }
  }
}

function recordingFetch(captured: CapturedRequest[]): FetchFunction {
  return async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const headers = new Headers(init?.headers);
    const headerRecord: Record<string, string> = {};
    headers.forEach((value, key) => {
      headerRecord[key] = value;
    });

    let body = '';
    if (typeof init?.body === 'string') {
      body = init.body;
    } else if (init?.body instanceof Uint8Array) {
      body = new TextDecoder().decode(init.body);
    } else if (init?.body instanceof ArrayBuffer) {
      body = new TextDecoder().decode(new Uint8Array(init.body));
    }

    captured.push({ url, headers: headerRecord, body });

    return new Response(
      JSON.stringify({ message: 'region host test stopped the request' }),
      {
        status: 400,
        headers: { 'content-type': 'application/json' },
      },
    );
  };
}

async function settle(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch {
    // The request is issued before response parsing. A refusal that happens
    // first leaves the capture empty, which is the safe outcome.
  }
}

const mantleHost = /^bedrock-mantle\.[a-z0-9-]+\.api\.aws$/;
const runtimeHost = /^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/;
const agentRuntimeHost = /^bedrock-agent-runtime\.[a-z0-9-]+\.amazonaws\.com$/;

describe('bedrock region host credential routing', () => {
  const previousRegion = process.env.AWS_REGION;
  const previousBearer = process.env.AWS_BEARER_TOKEN_BEDROCK;
  const previousAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const previousSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const previousSessionToken = process.env.AWS_SESSION_TOKEN;
  const previousEndpoint = process.env.AWS_ENDPOINT_URL;
  const previousRuntimeEndpoint = process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME;
  const previousAgentEndpoint =
    process.env.AWS_ENDPOINT_URL_BEDROCK_AGENT_RUNTIME;

  afterEach(() => {
    restoreEnv('AWS_REGION', previousRegion);
    restoreEnv('AWS_BEARER_TOKEN_BEDROCK', previousBearer);
    restoreEnv('AWS_ACCESS_KEY_ID', previousAccessKeyId);
    restoreEnv('AWS_SECRET_ACCESS_KEY', previousSecretAccessKey);
    restoreEnv('AWS_SESSION_TOKEN', previousSessionToken);
    restoreEnv('AWS_ENDPOINT_URL', previousEndpoint);
    restoreEnv('AWS_ENDPOINT_URL_BEDROCK_RUNTIME', previousRuntimeEndpoint);
    restoreEnv('AWS_ENDPOINT_URL_BEDROCK_AGENT_RUNTIME', previousAgentEndpoint);
  });

  describe('mantle chat and responses', () => {
    it('sends a normal region to the Mantle API host', async () => {
      const captured: CapturedRequest[] = [];
      const provider = createBedrockMantle({
        region: 'us-east-1',
        apiKey: PLACEHOLDER_BEARER,
        fetch: recordingFetch(captured),
      });

      await settle(() =>
        provider.chat('openai.gpt-oss-20b').doGenerate({
          prompt: LANGUAGE_PROMPT,
        }),
      );

      expect(captured.length).toBeGreaterThan(0);
      expect(new URL(captured[0].url).hostname).toBe(
        'bedrock-mantle.us-east-1.api.aws',
      );
      expect(captured[0].body).toContain(PROMPT_MARKER);
      expect(captured[0].headers.authorization).toContain(PLACEHOLDER_BEARER);
    });

    for (const terminator of ['?', '#']) {
      it(`does not send the bearer token or prompt when the chat region ends with ${terminator}`, async () => {
        const captured: CapturedRequest[] = [];
        const provider = createBedrockMantle({
          region: `attacker.example${terminator}`,
          apiKey: PLACEHOLDER_BEARER,
          fetch: recordingFetch(captured),
        });

        await settle(() =>
          provider.chat('openai.gpt-oss-20b').doGenerate({
            prompt: LANGUAGE_PROMPT,
          }),
        );

        assertCredentialedRequestsStayOnServiceHost(captured, mantleHost);
      });

      it(`does not send the bearer token or prompt when the responses region ends with ${terminator}`, async () => {
        const captured: CapturedRequest[] = [];
        const provider = createBedrockMantle({
          region: `attacker.example${terminator}`,
          apiKey: PLACEHOLDER_BEARER,
          fetch: recordingFetch(captured),
        });

        await settle(() =>
          provider.responses('openai.gpt-oss-20b').doGenerate({
            prompt: LANGUAGE_PROMPT,
          }),
        );

        assertCredentialedRequestsStayOnServiceHost(captured, mantleHost);
      });

      it(`does not send the bearer token or prompt when streaming chat and the region ends with ${terminator}`, async () => {
        const captured: CapturedRequest[] = [];
        const provider = createBedrockMantle({
          region: `attacker.example${terminator}`,
          apiKey: PLACEHOLDER_BEARER,
          fetch: recordingFetch(captured),
        });

        await settle(() =>
          provider.chat('openai.gpt-oss-20b').doStream({
            prompt: LANGUAGE_PROMPT,
          }),
        );

        assertCredentialedRequestsStayOnServiceHost(captured, mantleHost);
      });

      it(`does not send the bearer token or prompt when streaming responses and the region ends with ${terminator}`, async () => {
        const captured: CapturedRequest[] = [];
        const provider = createBedrockMantle({
          region: `attacker.example${terminator}`,
          apiKey: PLACEHOLDER_BEARER,
          fetch: recordingFetch(captured),
        });

        await settle(() =>
          provider.responses('openai.gpt-oss-20b').doStream({
            prompt: LANGUAGE_PROMPT,
          }),
        );

        assertCredentialedRequestsStayOnServiceHost(captured, mantleHost);
      });

      it(`does not send the SigV4 access key id or session token when the chat region ends with ${terminator}`, async () => {
        const captured: CapturedRequest[] = [];
        delete process.env.AWS_BEARER_TOKEN_BEDROCK;
        const provider = createBedrockMantle({
          region: `attacker.example${terminator}`,
          accessKeyId: PLACEHOLDER_ACCESS_KEY_ID,
          secretAccessKey: PLACEHOLDER_SECRET_ACCESS_KEY,
          sessionToken: PLACEHOLDER_SESSION_TOKEN,
          fetch: recordingFetch(captured),
        });

        await settle(() =>
          provider.chat('openai.gpt-oss-20b').doGenerate({
            prompt: LANGUAGE_PROMPT,
          }),
        );

        assertCredentialedRequestsStayOnServiceHost(captured, mantleHost);
        for (const request of captured) {
          if (request.headers.authorization != null) {
            expect(request.headers.authorization).toContain(
              PLACEHOLDER_ACCESS_KEY_ID,
            );
          }
          if (request.headers['x-amz-security-token'] != null) {
            expect(request.headers['x-amz-security-token']).toBe(
              PLACEHOLDER_SESSION_TOKEN,
            );
          }
        }
      });
    }

    it('does not send credentials when AWS_REGION ends with a query delimiter', async () => {
      const captured: CapturedRequest[] = [];
      process.env.AWS_REGION = 'attacker.example?';
      delete process.env.AWS_BEARER_TOKEN_BEDROCK;
      const provider = createBedrockMantle({
        apiKey: PLACEHOLDER_BEARER,
        fetch: recordingFetch(captured),
      });

      await settle(() =>
        provider('openai.gpt-oss-20b').doGenerate({
          prompt: LANGUAGE_PROMPT,
        }),
      );

      assertCredentialedRequestsStayOnServiceHost(captured, mantleHost);
    });
  });

  describe('bedrock runtime and agent runtime', () => {
    for (const terminator of ['?', '#']) {
      it(`does not send the bearer token when the converse region ends with ${terminator}`, async () => {
        const captured: CapturedRequest[] = [];
        const provider = createAmazonBedrock({
          region: `attacker.example${terminator}`,
          apiKey: PLACEHOLDER_BEARER,
          fetch: recordingFetch(captured),
        });

        await settle(() =>
          provider.languageModel('amazon.nova-micro-v1:0').doGenerate({
            prompt: LANGUAGE_PROMPT,
          }),
        );

        assertCredentialedRequestsStayOnServiceHost(captured, runtimeHost);
      });

      it(`does not send the bearer token when streaming converse and the region ends with ${terminator}`, async () => {
        const captured: CapturedRequest[] = [];
        const provider = createAmazonBedrock({
          region: `attacker.example${terminator}`,
          apiKey: PLACEHOLDER_BEARER,
          fetch: recordingFetch(captured),
        });

        await settle(() =>
          provider.languageModel('amazon.nova-micro-v1:0').doStream({
            prompt: LANGUAGE_PROMPT,
          }),
        );

        assertCredentialedRequestsStayOnServiceHost(captured, runtimeHost);
      });

      it(`does not send the bearer token when the embedding region ends with ${terminator}`, async () => {
        const captured: CapturedRequest[] = [];
        const provider = createAmazonBedrock({
          region: `attacker.example${terminator}`,
          apiKey: PLACEHOLDER_BEARER,
          fetch: recordingFetch(captured),
        });

        await settle(() =>
          provider
            .embeddingModel('amazon.titan-embed-text-v2:0')
            .doEmbed({ values: [PROMPT_MARKER] }),
        );

        assertCredentialedRequestsStayOnServiceHost(captured, runtimeHost);
      });

      it(`does not send the bearer token when the image region ends with ${terminator}`, async () => {
        const captured: CapturedRequest[] = [];
        const provider = createAmazonBedrock({
          region: `attacker.example${terminator}`,
          apiKey: PLACEHOLDER_BEARER,
          fetch: recordingFetch(captured),
        });

        await settle(() =>
          provider.imageModel('amazon.titan-image-generator-v2:0').doGenerate({
            prompt: PROMPT_MARKER,
            n: 1,
            size: '1024x1024',
            aspectRatio: undefined,
            seed: undefined,
            files: undefined,
            mask: undefined,
          }),
        );

        assertCredentialedRequestsStayOnServiceHost(captured, runtimeHost);
      });

      it(`does not send the bearer token when the rerank region ends with ${terminator}`, async () => {
        const captured: CapturedRequest[] = [];
        const provider = createAmazonBedrock({
          region: `attacker.example${terminator}`,
          apiKey: PLACEHOLDER_BEARER,
          fetch: recordingFetch(captured),
        });

        await settle(() =>
          provider.rerankingModel('cohere.rerank-v3-5:0').doRerank({
            documents: { type: 'text', values: ['document'] },
            query: PROMPT_MARKER,
            topN: 1,
          }),
        );

        assertCredentialedRequestsStayOnServiceHost(captured, agentRuntimeHost);
      });

      it(`does not send the bearer token when the Anthropic Bedrock region ends with ${terminator}`, async () => {
        const captured: CapturedRequest[] = [];
        const provider = createAmazonBedrockAnthropic({
          region: `attacker.example${terminator}`,
          apiKey: PLACEHOLDER_BEARER,
          fetch: recordingFetch(captured),
        });

        await settle(() =>
          provider('anthropic.claude-3-haiku-20240307-v1:0').doGenerate({
            prompt: LANGUAGE_PROMPT,
          }),
        );

        assertCredentialedRequestsStayOnServiceHost(captured, runtimeHost);
      });

      it(`does not send the bearer token when streaming Anthropic Bedrock and the region ends with ${terminator}`, async () => {
        const captured: CapturedRequest[] = [];
        const provider = createAmazonBedrockAnthropic({
          region: `attacker.example${terminator}`,
          apiKey: PLACEHOLDER_BEARER,
          fetch: recordingFetch(captured),
        });

        await settle(() =>
          provider('anthropic.claude-3-haiku-20240307-v1:0').doStream({
            prompt: LANGUAGE_PROMPT,
          }),
        );

        assertCredentialedRequestsStayOnServiceHost(captured, runtimeHost);
      });

      it(`does not send SigV4 material when the converse region ends with ${terminator}`, async () => {
        const captured: CapturedRequest[] = [];
        delete process.env.AWS_BEARER_TOKEN_BEDROCK;
        const provider = createAmazonBedrock({
          region: `attacker.example${terminator}`,
          accessKeyId: PLACEHOLDER_ACCESS_KEY_ID,
          secretAccessKey: PLACEHOLDER_SECRET_ACCESS_KEY,
          sessionToken: PLACEHOLDER_SESSION_TOKEN,
          fetch: recordingFetch(captured),
        });

        await settle(() =>
          provider.languageModel('amazon.nova-micro-v1:0').doGenerate({
            prompt: LANGUAGE_PROMPT,
          }),
        );

        assertCredentialedRequestsStayOnServiceHost(captured, runtimeHost);
      });
    }
  });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
