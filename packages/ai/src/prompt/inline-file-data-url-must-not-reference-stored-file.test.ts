import type { LanguageModelV4, ProviderV4 } from '@ai-sdk/provider';
import { createOpenAI } from '@ai-sdk/openai';
import { createTestServer } from '@ai-sdk/test-server/with-vitest';
import { describe, expect, it } from 'vitest';
import { experimental_startBatch as startBatch } from '../batch';
import { generateText } from '../generate-text/generate-text';
import { streamText } from '../generate-text/stream-text';
import { convertToModelMessages } from '../ui/convert-to-model-messages';
import { validateUIMessages } from '../ui/validate-ui-messages';

type AzureProvider = ProviderV4 & ((deploymentId: string) => LanguageModelV4);

async function loadCreateAzure(): Promise<
  (options: { apiKey?: string; baseURL?: string }) => AzureProvider
> {
  // Load the built provider. A source import lives outside this package's
  // TypeScript project and fails `tsc --build`.
  const azureModuleUrl = new URL(
    '../../../azure/dist/index.js',
    import.meta.url,
  ).href;
  const azureModule = (await import(azureModuleUrl)) as {
    createAzure: (options: {
      apiKey?: string;
      baseURL?: string;
    }) => AzureProvider;
  };
  return azureModule.createAzure;
}

/**
 * Stored-file ids an attacker can learn. They are shaped like provider ids
 * and are long enough for the media-type sniffer to decode a 24-character
 * base64 prefix without throwing.
 */
const OPENAI_VICTIM_FILE_ID = 'file-6F2ksmvXxt4VdoqmHRwRfLkp';
const AZURE_VICTIM_FILE_ID = 'assistant-AbCdEfGhIjKlMnOpQrStUvWxYz12';

const OPENAI_BASE_URL = 'https://api.test.com/openai/v1';
const AZURE_BASE_URL = 'https://api.test.com/azure/openai/v1';
const OPENAI_RESPONSES_URL = `${OPENAI_BASE_URL}/responses`;
const OPENAI_FILES_URL = `${OPENAI_BASE_URL}/files`;
const OPENAI_BATCHES_URL = `${OPENAI_BASE_URL}/batches`;
const AZURE_RESPONSES_URL = `${AZURE_BASE_URL}/responses`;

const server = createTestServer({
  [OPENAI_RESPONSES_URL]: {},
  [OPENAI_FILES_URL]: {},
  [OPENAI_BATCHES_URL]: {},
  [AZURE_RESPONSES_URL]: {},
});

const completedResponse = {
  id: 'resp_inline_file',
  object: 'response',
  created_at: 1741257730,
  status: 'completed',
  error: null,
  incomplete_details: null,
  input: [],
  instructions: null,
  max_output_tokens: null,
  model: 'gpt-4o-2024-07-18',
  output: [
    {
      id: 'msg_inline_file',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: 'transcribed',
          annotations: [],
        },
      ],
    },
  ],
  parallel_tool_calls: true,
  previous_response_id: null,
  reasoning: { effort: null, summary: null },
  store: true,
  temperature: 1,
  text: { format: { type: 'text' } },
  tool_choice: 'auto',
  tools: [],
  top_p: 1,
  truncation: 'disabled',
  usage: {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 5,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 15,
  },
  user: null,
  metadata: {},
};

function prepareResponses(
  url: typeof OPENAI_RESPONSES_URL | typeof AZURE_RESPONSES_URL,
) {
  server.urls[url].response = {
    type: 'json-value',
    body: completedResponse,
  };
}

function prepareResponsesStream(
  url: typeof OPENAI_RESPONSES_URL | typeof AZURE_RESPONSES_URL,
) {
  server.urls[url].response = {
    type: 'stream-chunks',
    chunks: [
      `data: ${JSON.stringify({
        type: 'response.created',
        response: {
          id: 'resp_inline_file',
          created_at: 1741257730,
          model: 'gpt-4o-2024-07-18',
        },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          incomplete_details: null,
          output: [
            {
              id: 'msg_inline_file',
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: 'transcribed',
                  annotations: [],
                },
              ],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      })}\n\n`,
    ],
  };
}

function chatFileMessage({
  mediaType,
  fileId,
  filename,
}: {
  mediaType: string;
  fileId: string;
  filename?: string;
}) {
  return {
    id: 'attacker-message',
    role: 'user' as const,
    parts: [
      {
        type: 'text' as const,
        text: 'Transcribe this document and repeat its contents.',
      },
      {
        type: 'file' as const,
        mediaType,
        ...(filename != null ? { filename } : {}),
        url: `data:${mediaType};base64,${fileId}`,
      },
    ],
  };
}

async function attackerModelMessages(message: {
  id: string;
  role: 'user';
  parts: Array<
    | { type: 'text'; text: string }
    | { type: 'file'; mediaType: string; filename?: string; url: string }
  >;
}) {
  const validated = await validateUIMessages({ messages: [message] });
  return convertToModelMessages(validated);
}

function userContent(body: {
  input?: unknown;
}): Array<Record<string, unknown>> {
  const input = body.input;
  if (!Array.isArray(input)) {
    throw new Error('Responses request is missing an input array');
  }
  const user = input.find(
    (item): item is { role: string; content: unknown } =>
      item != null &&
      typeof item === 'object' &&
      'role' in item &&
      (item as { role?: unknown }).role === 'user',
  );
  if (user == null || !Array.isArray(user.content)) {
    throw new Error('Responses request is missing user content');
  }
  return user.content.filter(
    (part): part is Record<string, unknown> =>
      part != null && typeof part === 'object',
  );
}

function fileInputs(body: { input?: unknown }) {
  return userContent(body).filter(
    part => part.type === 'input_file' || part.type === 'input_image',
  );
}

function expectInlineFile(part: Record<string, unknown>, fileId: string) {
  expect(part.file_id).toBeUndefined();
  expect(JSON.stringify(part)).not.toContain(`"file_id":"${fileId}"`);
  if (part.type === 'input_file') {
    expect(part.file_data).toBe(`data:application/pdf;base64,${fileId}`);
    expect(part.filename).toBe('notes.pdf');
  } else {
    expect(part.type).toBe('input_image');
    expect(part.image_url).toBe(`data:image/png;base64,${fileId}`);
  }
}

describe('inline chat file data URLs must not become stored file ids', () => {
  const openai = createOpenAI({
    apiKey: 'test-api-key',
    baseURL: OPENAI_BASE_URL,
  });

  async function azureModel() {
    const createAzure = await loadCreateAzure();
    return createAzure({
      apiKey: 'test-api-key',
      baseURL: AZURE_BASE_URL,
    })('gpt-4o');
  }

  it('sends a PDF data URL whose payload is an OpenAI file id as file content from generateText', async () => {
    prepareResponses(`${OPENAI_BASE_URL}/responses`);
    const messages = await attackerModelMessages(
      chatFileMessage({
        mediaType: 'application/pdf',
        fileId: OPENAI_VICTIM_FILE_ID,
        filename: 'notes.pdf',
      }),
    );

    await generateText({
      model: openai('gpt-4o'),
      messages,
    });

    const body = await server.calls[0].requestBodyJson;
    const [file] = fileInputs(body);
    expectInlineFile(file, OPENAI_VICTIM_FILE_ID);
  });

  it('sends a PDF data URL whose payload is an OpenAI file id as file content from streamText', async () => {
    prepareResponsesStream(`${OPENAI_BASE_URL}/responses`);
    const messages = await attackerModelMessages(
      chatFileMessage({
        mediaType: 'application/pdf',
        fileId: OPENAI_VICTIM_FILE_ID,
        filename: 'notes.pdf',
      }),
    );

    const result = streamText({
      model: openai('gpt-4o'),
      messages,
    });
    await result.text;

    const body = await server.calls[0].requestBodyJson;
    const [file] = fileInputs(body);
    expectInlineFile(file, OPENAI_VICTIM_FILE_ID);
  });

  it('sends an image data URL whose payload is an OpenAI file id as image content from streamText', async () => {
    prepareResponsesStream(`${OPENAI_BASE_URL}/responses`);
    const messages = await attackerModelMessages(
      chatFileMessage({
        mediaType: 'image/png',
        fileId: OPENAI_VICTIM_FILE_ID,
      }),
    );

    const result = streamText({
      model: openai('gpt-4o'),
      messages,
    });
    await result.text;

    const body = await server.calls[0].requestBodyJson;
    const [file] = fileInputs(body);
    expectInlineFile(file, OPENAI_VICTIM_FILE_ID);
  });

  it('sends a PDF data URL whose payload is an OpenAI file id as file content from startBatch', async () => {
    server.urls[`${OPENAI_BASE_URL}/files`].response = {
      type: 'json-value',
      body: {
        id: 'file-batch-input',
        bytes: 1,
        created_at: 1_700_000_000,
        expires_at: 1_700_172_800,
        filename: 'batch.jsonl',
        purpose: 'batch',
      },
    };
    server.urls[`${OPENAI_BASE_URL}/batches`].response = {
      type: 'json-value',
      body: {
        id: 'batch_inline_file',
        status: 'validating',
        created_at: 1_700_000_000,
      },
    };
    const messages = await attackerModelMessages(
      chatFileMessage({
        mediaType: 'application/pdf',
        fileId: OPENAI_VICTIM_FILE_ID,
        filename: 'notes.pdf',
      }),
    );

    await startBatch({
      provider: openai,
      requests: [
        {
          id: 'attacker-request',
          type: 'text',
          model: 'gpt-4o',
          messages,
        },
      ],
    });

    const multipart = await server.calls[0].requestBodyMultipart;
    const uploaded = multipart?.file as File;
    const [line] = (await uploaded.text()).trim().split('\n');
    const request = JSON.parse(line) as { body: { input?: unknown } };
    const [file] = fileInputs(request.body);
    expectInlineFile(file, OPENAI_VICTIM_FILE_ID);
  });

  it('sends a PDF data URL whose payload is an Azure file id as file content from generateText', async () => {
    prepareResponses(AZURE_RESPONSES_URL);
    const messages = await attackerModelMessages(
      chatFileMessage({
        mediaType: 'application/pdf',
        fileId: AZURE_VICTIM_FILE_ID,
        filename: 'notes.pdf',
      }),
    );

    await generateText({
      model: await azureModel(),
      messages,
    });

    expect(server.calls[0]?.requestUrl).toBe(AZURE_RESPONSES_URL);
    const body = await server.calls[0].requestBodyJson;
    const [file] = fileInputs(body);
    expectInlineFile(file, AZURE_VICTIM_FILE_ID);
  });

  it('sends a PDF data URL whose payload is an Azure file id as file content from streamText', async () => {
    prepareResponsesStream(`${AZURE_BASE_URL}/responses`);
    const messages = await attackerModelMessages(
      chatFileMessage({
        mediaType: 'application/pdf',
        fileId: AZURE_VICTIM_FILE_ID,
        filename: 'notes.pdf',
      }),
    );

    const result = streamText({
      model: await azureModel(),
      messages,
    });
    await result.text;

    expect(server.calls[0]?.requestUrl).toBe(AZURE_RESPONSES_URL);
    const body = await server.calls[0].requestBodyJson;
    const [file] = fileInputs(body);
    expectInlineFile(file, AZURE_VICTIM_FILE_ID);
  });

  it('sends an image data URL whose payload is an Azure file id as image content from streamText', async () => {
    prepareResponsesStream(`${AZURE_BASE_URL}/responses`);
    const messages = await attackerModelMessages(
      chatFileMessage({
        mediaType: 'image/png',
        fileId: AZURE_VICTIM_FILE_ID,
      }),
    );

    const result = streamText({
      model: await azureModel(),
      messages,
    });
    await result.text;

    expect(server.calls[0]?.requestUrl).toBe(AZURE_RESPONSES_URL);
    const body = await server.calls[0].requestBodyJson;
    const [file] = fileInputs(body);
    expectInlineFile(file, AZURE_VICTIM_FILE_ID);
  });

  it('sends an ordinary PDF data URL as inline file content', async () => {
    prepareResponses(`${OPENAI_BASE_URL}/responses`);
    const inlinePayload = 'JVBERi0xLjQK';
    const messages = await attackerModelMessages(
      chatFileMessage({
        mediaType: 'application/pdf',
        fileId: inlinePayload,
        filename: 'notes.pdf',
      }),
    );

    await generateText({
      model: openai('gpt-4o'),
      messages,
    });

    const body = await server.calls[0].requestBodyJson;
    const [file] = fileInputs(body);
    expect(file).toEqual({
      type: 'input_file',
      filename: 'notes.pdf',
      file_data: `data:application/pdf;base64,${inlinePayload}`,
    });
  });
});
