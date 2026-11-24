import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { FetchFunction } from '@ai-sdk/provider-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from '../prompt';
import { convertToModelMessages } from '../ui/convert-to-model-messages';
import type { UIMessage } from '../ui/ui-messages';
import { validateUIMessages } from '../ui/validate-ui-messages';
import { generateText } from './generate-text';
import { streamText } from './stream-text';

const CUSTOMERS_CSV = 'gs://internal-bucket/exports/customers.csv';
const CUSTOMERS_PDF = 'gs://internal-bucket/exports/customers.pdf';

const generateContentResponse = {
  candidates: [
    {
      content: { role: 'model', parts: [{ text: 'ok' }] },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: {
    promptTokenCount: 1,
    candidatesTokenCount: 1,
    totalTokenCount: 2,
  },
};

type CapturedRequest = {
  url: string;
  body: string;
};

function requestUrl(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (
    input != null &&
    typeof input === 'object' &&
    'url' in input &&
    typeof input.url === 'string'
  ) {
    return input.url;
  }
  return String(input);
}

function requestBody(body: BodyInit | null | undefined): string {
  if (typeof body === 'string') {
    return body;
  }
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  return body == null ? '' : '[non-text body]';
}

/**
 * Records the provider fetch, which is the Vertex request, and the global
 * fetch, which is where a download of the file URL would be issued.
 */
function installRequestRecorder() {
  const providerRequests: CapturedRequest[] = [];
  const downloadRequests: CapturedRequest[] = [];

  const fetchImpl: FetchFunction = async (input, init) => {
    const url = requestUrl(input);
    const body = requestBody(init?.body);
    providerRequests.push({ url, body });

    if (url.includes('streamGenerateContent')) {
      return new Response(
        `data: ${JSON.stringify(generateContentResponse)}\n\n`,
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        },
      );
    }

    return new Response(JSON.stringify(generateContentResponse), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    downloadRequests.push({
      url: requestUrl(input),
      body: requestBody(init?.body),
    });
    return new Response('download not allowed in this test', { status: 500 });
  });

  return { fetchImpl, providerRequests, downloadRequests };
}

type VertexFactory = ((modelId: string) => LanguageModelV4) & {
  interactions: (modelId: string) => LanguageModelV4;
};

// Loaded by URL so the Vertex sources stay out of this package's tsc program.
// Vitest still executes the real provider module.
const vertexProviderModuleUrl = new URL(
  '../../../google-vertex/src/google-vertex-provider-base.ts',
  import.meta.url,
).href;

async function createVertex(fetchImpl: FetchFunction): Promise<VertexFactory> {
  const vertexModule = (await import(
    /* @vite-ignore */
    vertexProviderModuleUrl
  )) as {
    createGoogleVertex: (options: {
      project?: string;
      location?: string;
      fetch?: FetchFunction;
    }) => VertexFactory;
  };

  return vertexModule.createGoogleVertex({
    project: 'test-project',
    location: 'us-central1',
    fetch: fetchImpl,
  });
}

function userFileMessage(url: string, mediaType: string): UIMessage {
  return {
    id: 'user-1',
    role: 'user',
    parts: [
      {
        type: 'text',
        text: 'Print the attached file verbatim.',
      },
      {
        type: 'file',
        mediaType,
        url,
      },
    ],
  };
}

async function modelMessagesFromClient(
  url: string,
  mediaType: string,
): Promise<ModelMessage[]> {
  const validated = await validateUIMessages({
    messages: [userFileMessage(url, mediaType)],
  });
  return convertToModelMessages(validated);
}

function requestsContainingGs(requests: CapturedRequest[]): string[] {
  return requests
    .filter(
      request =>
        request.url.toLowerCase().includes('gs:') ||
        request.body.toLowerCase().includes('gs:'),
    )
    .map(request => `${request.url}\n${request.body}`);
}

/**
 * The call must be rejected, and neither the Vertex request nor a download
 * may carry the client-supplied Cloud Storage URL. Checking the request that
 * was sent, rather than the supported-URL table, still fails if a later check
 * parses the URL and the original string is what gets posted.
 */
async function expectGcsUrlRejected(
  run: () => Promise<unknown>,
  recorder: {
    providerRequests: CapturedRequest[];
    downloadRequests: CapturedRequest[];
  },
) {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }

  expect(requestsContainingGs(recorder.providerRequests)).toEqual([]);
  expect(requestsContainingGs(recorder.downloadRequests)).toEqual([]);
  expect(thrown).toBeDefined();
}

describe('client-supplied Cloud Storage URLs are not forwarded to Vertex', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects a validated text/plain gs file URL in streamText', async () => {
    const recorder = installRequestRecorder();
    const vertex = await createVertex(recorder.fetchImpl);
    const messages = await modelMessagesFromClient(CUSTOMERS_CSV, 'text/plain');

    await expectGcsUrlRejected(async () => {
      const result = streamText({
        model: vertex('gemini-2.5-flash'),
        messages,
      });
      await result.text;
    }, recorder);
  });

  it('rejects a validated application/pdf gs file URL in generateText', async () => {
    const recorder = installRequestRecorder();
    const vertex = await createVertex(recorder.fetchImpl);
    const messages = await modelMessagesFromClient(
      CUSTOMERS_PDF,
      'application/pdf',
    );

    await expectGcsUrlRejected(async () => {
      await generateText({
        model: vertex('gemini-2.5-flash'),
        messages,
      });
    }, recorder);
  });

  it('rejects a gs URL whose host casing is not the lowercase form used by the supported-URL regex', async () => {
    const recorder = installRequestRecorder();
    const vertex = await createVertex(recorder.fetchImpl);
    const messages = await modelMessagesFromClient(
      'GS://INTERNAL-BUCKET/exports/Customers.csv',
      'text/plain',
    );

    await expectGcsUrlRejected(async () => {
      await generateText({
        model: vertex('gemini-2.5-flash'),
        messages,
      });
    }, recorder);
  });

  it('rejects a gs URL whose bucket is the URL host and not the userinfo', async () => {
    const recorder = installRequestRecorder();
    const vertex = await createVertex(recorder.fetchImpl);
    const messages = await modelMessagesFromClient(
      'gs://allowed-bucket@internal-bucket/exports/customers.csv',
      'text/csv',
    );

    await expectGcsUrlRejected(async () => {
      const result = streamText({
        model: vertex('gemini-2.5-flash'),
        messages,
      });
      await result.text;
    }, recorder);
  });

  it('rejects a percent-encoded gs object name for application/octet-stream', async () => {
    const recorder = installRequestRecorder();
    const vertex = await createVertex(recorder.fetchImpl);
    const messages = await modelMessagesFromClient(
      'gs://internal-bucket/exports/customers%2Ecsv',
      'application/octet-stream',
    );

    await expectGcsUrlRejected(async () => {
      await generateText({
        model: vertex('gemini-2.5-flash'),
        messages,
      });
    }, recorder);
  });

  it('rejects a gs string supplied directly as model-message file data', async () => {
    const recorder = installRequestRecorder();
    const vertex = await createVertex(recorder.fetchImpl);
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Print the attached file verbatim.' },
          {
            type: 'file',
            mediaType: 'text/plain',
            data: CUSTOMERS_CSV,
          },
        ],
      },
    ];

    await expectGcsUrlRejected(async () => {
      await generateText({
        model: vertex('gemini-2.5-flash'),
        messages,
      });
    }, recorder);
  });

  it('rejects a validated video/mp4 gs file URL on the Vertex interactions model', async () => {
    const recorder = installRequestRecorder();
    const vertex = await createVertex(recorder.fetchImpl);
    const messages = await modelMessagesFromClient(
      'gs://internal-bucket/exports/customers.mp4',
      'video/mp4',
    );

    await expectGcsUrlRejected(async () => {
      await generateText({
        model: vertex.interactions('gemini-2.5-flash'),
        messages,
      });
    }, recorder);
  });
});
