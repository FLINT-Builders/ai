import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogle } from '@ai-sdk/google';
import { createMoonshotAI } from '@ai-sdk/moonshotai';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { parseJSON } from '@ai-sdk/provider-utils';
import { createXai } from '@ai-sdk/xai';
import { describe, expect, it } from 'vitest';
import { createAnthropic } from '../../../anthropic/dist/index.js';
import { createAgentUIStream } from '../agent/create-agent-ui-stream';
import { ToolLoopAgent } from '../agent/tool-loop-agent';
import { generateText } from '../generate-text/generate-text';
import { streamText } from '../generate-text/stream-text';
import { convertToModelMessages } from './convert-to-model-messages';
import { DirectChatTransport } from './direct-chat-transport';
import type { FileUIPart, UIMessage } from './ui-messages';
import { validateUIMessages } from './validate-ui-messages';

type ClientUIMessage = UIMessage<unknown, never>;

/**
 * Spec for client-supplied provider file references on UI file parts.
 *
 * A chat client can put any provider file id in `FileUIPart.providerReference`
 * and `containerUpload` in `providerMetadata`. Those values are untrusted.
 * `convertToModelMessages` must not forward them to a provider unless the
 * application opts in and supplies the reference that was authorized.
 *
 * `resolveProviderReference` receives the client map and returns the provider
 * reference to send, or `undefined` to withhold it. The value sent to the
 * provider is that return value, not a later read of the client map.
 * `allowContainerUpload` defaults to false; client
 * `providerMetadata.*.containerUpload` is ignored unless it is true.
 */

const PLACEHOLDER_API_KEY = 'test-api-key';

const VICTIM_ANTHROPIC_FILE = 'file_victim_other_user';
const VICTIM_OPENAI_FILE = 'file-victim-other-user';
const VICTIM_GOOGLE_FILE =
  'https://generativelanguage.googleapis.com/v1beta/files/victim-other-user';
const VICTIM_XAI_FILE = 'file-victim-other-user-xai';
const VICTIM_DEEPSEEK_FILE = 'file-victim-other-user-deepseek';
const VICTIM_MOONSHOT_FILE = 'ms://victim-other-user';
const SERVER_ISSUED_ANTHROPIC_FILE = 'file_server_issued_for_caller';
const OWNED_UPLOAD_HANDLE = 'upload-owned-by-caller';

type ProviderReferenceAuthorization = {
  resolveProviderReference?: (
    reference: Record<string, string>,
  ) =>
    | Record<string, string>
    | undefined
    | Promise<Record<string, string> | undefined>;
  allowContainerUpload?: boolean;
};

type RecordedRequest = {
  url: string;
  body: string;
};

function recordingFetch() {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const rawBody = init?.body;
    let body = '';
    if (typeof rawBody === 'string') {
      body = rawBody;
    } else if (rawBody instanceof Uint8Array) {
      body = new TextDecoder().decode(rawBody);
    }
    requests.push({ url, body });
    return new Response('{"error":"placeholder-response"}', {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, requests };
}

function settings(fetchImpl: typeof fetch) {
  return { apiKey: PLACEHOLDER_API_KEY, fetch: fetchImpl };
}

async function convertClientUiMessages(
  messages: ClientUIMessage[],
  authorization?: ProviderReferenceAuthorization,
) {
  return convertToModelMessages(
    messages,
    authorization as NonNullable<Parameters<typeof convertToModelMessages>[1]>,
  );
}

async function messagesAsTheChatRouteReceivesThem(messages: ClientUIMessage[]) {
  // The example chat route reads the browser body with req.json().
  return (await parseJSON({
    text: JSON.stringify(messages),
  })) as unknown as ClientUIMessage[];
}

function filePart({
  mediaType,
  providerReference,
  providerMetadata,
  filename,
}: {
  mediaType: string;
  providerReference: Record<string, string>;
  providerMetadata?: FileUIPart['providerMetadata'];
  filename: string;
}): FileUIPart {
  return {
    type: 'file',
    mediaType,
    filename,
    url: `data:${mediaType};base64,QQ==`,
    providerReference,
    ...(providerMetadata != null ? { providerMetadata } : {}),
  };
}

function userChat(
  part: FileUIPart,
  text = 'Quote the attached document.',
): ClientUIMessage[] {
  return [
    {
      id: 'user-1',
      role: 'user',
      parts: [part, { type: 'text', text }],
    },
  ];
}

async function collectSentFileIds(requests: RecordedRequest[]) {
  const ids: string[] = [];
  let containerUpload = false;

  function walk(value: unknown) {
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
      return;
    }
    if (value == null || typeof value !== 'object') {
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.type === 'container_upload') {
      containerUpload = true;
    }
    for (const [key, child] of Object.entries(record)) {
      if (
        (key === 'file_id' ||
          key === 'fileUri' ||
          key === 'uri' ||
          key === 'url') &&
        typeof child === 'string'
      ) {
        ids.push(child);
      }
      walk(child);
    }
  }

  for (const request of requests) {
    if (request.body.length === 0) {
      continue;
    }
    walk(await parseJSON({ text: request.body }));
  }

  return { ids, containerUpload };
}

async function sendThroughGenerateText({
  model,
  messages,
  requests,
  authorization,
}: {
  model: LanguageModelV4;
  messages: ClientUIMessage[];
  requests: RecordedRequest[];
  authorization?: ProviderReferenceAuthorization;
}) {
  try {
    await generateText({
      model,
      messages: await convertClientUiMessages(messages, authorization),
    });
  } catch (error) {
    if (requests.length === 0) {
      throw error;
    }
  }
}

async function expectClientFileNotLoaded({
  createModel,
  messages,
  victimId,
  authorization,
}: {
  createModel: (fetchImpl: typeof fetch) => LanguageModelV4;
  messages: ClientUIMessage[];
  victimId: string;
  authorization?: ProviderReferenceAuthorization;
}) {
  const recorded = recordingFetch();
  await sendThroughGenerateText({
    model: createModel(recorded.fetchImpl),
    messages,
    requests: recorded.requests,
    authorization,
  });
  const sent = await collectSentFileIds(recorded.requests);
  const raw = recorded.requests.map(request => request.body).join('\n');
  expect(sent.ids).not.toContain(victimId);
  expect(raw).not.toContain(victimId);
  return sent;
}

describe('client provider file references in chat messages', () => {
  it('does not send a forged Anthropic file id or container upload from the example chat route', async () => {
    const recorded = recordingFetch();
    const messages = await messagesAsTheChatRouteReceivesThem(
      userChat(
        filePart({
          mediaType: 'application/pdf',
          filename: 'victim.pdf',
          providerReference: { anthropic: VICTIM_ANTHROPIC_FILE },
          providerMetadata: { anthropic: { containerUpload: true } },
        }),
      ),
    );

    // examples/ai-e2e-next/app/api/chat/upload-file/route.ts
    const result = streamText({
      model: createAnthropic(settings(recorded.fetchImpl))(
        'claude-3-haiku-20240307',
      ),
      messages: await convertToModelMessages(messages),
    });
    try {
      await result.consumeStream();
    } catch (error) {
      if (recorded.requests.length === 0) {
        throw error;
      }
    }

    const sent = await collectSentFileIds(recorded.requests);
    expect(sent.containerUpload).toBe(false);
    expect(sent.ids).not.toContain(VICTIM_ANTHROPIC_FILE);
    expect(
      recorded.requests.map(request => request.body).join('\n'),
    ).not.toContain(VICTIM_ANTHROPIC_FILE);
  });

  it('does not send a forged Anthropic file id after validateUIMessages accepts the part', async () => {
    const messages = await validateUIMessages<ClientUIMessage>({
      messages: await messagesAsTheChatRouteReceivesThem(
        userChat(
          filePart({
            mediaType: 'application/pdf',
            filename: 'victim.pdf',
            providerReference: { anthropic: VICTIM_ANTHROPIC_FILE },
            providerMetadata: { anthropic: { containerUpload: true } },
          }),
        ),
      ),
    });

    const sent = await expectClientFileNotLoaded({
      createModel: fetchImpl =>
        createAnthropic(settings(fetchImpl))('claude-3-haiku-20240307'),
      messages,
      victimId: VICTIM_ANTHROPIC_FILE,
    });
    expect(sent.containerUpload).toBe(false);
  });

  it('does not send a forged Anthropic image file id', async () => {
    await expectClientFileNotLoaded({
      createModel: fetchImpl =>
        createAnthropic(settings(fetchImpl))('claude-3-haiku-20240307'),
      messages: userChat(
        filePart({
          mediaType: 'image/png',
          filename: 'victim.png',
          providerReference: { anthropic: VICTIM_ANTHROPIC_FILE },
        }),
      ),
      victimId: VICTIM_ANTHROPIC_FILE,
    });
  });

  it.each(['application/pdf', 'image/png'] as const)(
    'does not send a forged OpenAI Responses file id for %s',
    async mediaType => {
      await expectClientFileNotLoaded({
        createModel: fetchImpl =>
          createOpenAI(settings(fetchImpl)).responses('gpt-4o'),
        messages: userChat(
          filePart({
            mediaType,
            filename: 'victim',
            providerReference: { openai: VICTIM_OPENAI_FILE },
          }),
        ),
        victimId: VICTIM_OPENAI_FILE,
      });
    },
  );

  it('does not send a forged OpenAI Chat file id', async () => {
    await expectClientFileNotLoaded({
      createModel: fetchImpl =>
        createOpenAI(settings(fetchImpl)).chat('gpt-4o'),
      messages: userChat(
        filePart({
          mediaType: 'application/pdf',
          filename: 'victim.pdf',
          providerReference: { openai: VICTIM_OPENAI_FILE },
        }),
      ),
      victimId: VICTIM_OPENAI_FILE,
    });
  });

  it('does not send a forged Google file uri from a user file part', async () => {
    await expectClientFileNotLoaded({
      createModel: fetchImpl =>
        createGoogle(settings(fetchImpl))('gemini-2.5-flash'),
      messages: userChat(
        filePart({
          mediaType: 'application/pdf',
          filename: 'victim.pdf',
          providerReference: { google: VICTIM_GOOGLE_FILE },
        }),
      ),
      victimId: VICTIM_GOOGLE_FILE,
    });
  });

  it('does not send a forged Google file uri from an assistant file part', async () => {
    const assistantMessages: ClientUIMessage[] = [
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Continue.' }],
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [
          filePart({
            mediaType: 'application/pdf',
            filename: 'victim.pdf',
            providerReference: { google: VICTIM_GOOGLE_FILE },
          }),
        ],
      },
    ];
    await expectClientFileNotLoaded({
      createModel: fetchImpl =>
        createGoogle(settings(fetchImpl))('gemini-2.5-flash'),
      messages: assistantMessages,
      victimId: VICTIM_GOOGLE_FILE,
    });
  });

  it('does not send a forged Google Interactions file uri', async () => {
    await expectClientFileNotLoaded({
      createModel: fetchImpl =>
        createGoogle(settings(fetchImpl)).interactions('gemini-2.5-flash'),
      messages: userChat(
        filePart({
          mediaType: 'image/png',
          filename: 'victim.png',
          providerReference: { google: VICTIM_GOOGLE_FILE },
        }),
      ),
      victimId: VICTIM_GOOGLE_FILE,
    });
  });

  it('does not send a forged xAI file id', async () => {
    await expectClientFileNotLoaded({
      createModel: fetchImpl =>
        createXai(settings(fetchImpl))('grok-4-fast-non-reasoning'),
      messages: userChat(
        filePart({
          mediaType: 'application/pdf',
          filename: 'victim.pdf',
          providerReference: { xai: VICTIM_XAI_FILE },
        }),
      ),
      victimId: VICTIM_XAI_FILE,
    });
  });

  it('does not send a forged DeepSeek image file id', async () => {
    await expectClientFileNotLoaded({
      createModel: fetchImpl =>
        createDeepSeek(settings(fetchImpl))('deepseek-v4-flash'),
      messages: userChat(
        filePart({
          mediaType: 'image/png',
          filename: 'victim.png',
          providerReference: { deepseek: VICTIM_DEEPSEEK_FILE },
        }),
      ),
      victimId: VICTIM_DEEPSEEK_FILE,
    });
  });

  it('does not send a forged Moonshot file url', async () => {
    await expectClientFileNotLoaded({
      createModel: fetchImpl =>
        createMoonshotAI(settings(fetchImpl))('moonshot-v1-8k'),
      messages: userChat(
        filePart({
          mediaType: 'image/png',
          filename: 'victim.png',
          providerReference: { moonshotai: VICTIM_MOONSHOT_FILE },
        }),
      ),
      victimId: VICTIM_MOONSHOT_FILE,
    });
  });

  it('sends the reference returned by resolveProviderReference, not the client file id or a later read of the client map', async () => {
    const messages = await validateUIMessages<ClientUIMessage>({
      messages: userChat(
        filePart({
          mediaType: 'application/pdf',
          filename: 'owned.pdf',
          providerReference: {
            handle: OWNED_UPLOAD_HANDLE,
            anthropic: 'file_checked',
          },
          providerMetadata: { anthropic: { containerUpload: true } },
        }),
      ),
    });

    const sent = await expectClientFileNotLoaded({
      createModel: fetchImpl =>
        createAnthropic(settings(fetchImpl))('claude-3-haiku-20240307'),
      messages,
      victimId: 'file_victim_swapped_after_check',
      authorization: {
        async resolveProviderReference(reference) {
          const handle = reference.handle;
          // The client map remains mutable after the ownership check.
          reference.anthropic = 'file_victim_swapped_after_check';
          if (handle === OWNED_UPLOAD_HANDLE) {
            return { anthropic: SERVER_ISSUED_ANTHROPIC_FILE };
          }
          return undefined;
        },
      },
    });

    expect(sent.ids).toContain(SERVER_ISSUED_ANTHROPIC_FILE);
    expect(sent.ids).not.toContain('file_checked');
    expect(sent.containerUpload).toBe(false);
  });

  it('drops a client file id when resolveProviderReference does not return one', async () => {
    const messages = await validateUIMessages<ClientUIMessage>({
      messages: userChat(
        filePart({
          mediaType: 'application/pdf',
          filename: 'victim.pdf',
          providerReference: {
            handle: 'upload-not-owned',
            anthropic: VICTIM_ANTHROPIC_FILE,
          },
        }),
      ),
    });

    const sent = await expectClientFileNotLoaded({
      createModel: fetchImpl =>
        createAnthropic(settings(fetchImpl))('claude-3-haiku-20240307'),
      messages,
      victimId: VICTIM_ANTHROPIC_FILE,
      authorization: {
        resolveProviderReference(reference) {
          if (reference.handle === OWNED_UPLOAD_HANDLE) {
            return { anthropic: SERVER_ISSUED_ANTHROPIC_FILE };
          }
          return undefined;
        },
      },
    });
    expect(sent.ids).not.toContain(SERVER_ISSUED_ANTHROPIC_FILE);
  });

  it('sends container_upload only when allowContainerUpload is set and the file id came from resolveProviderReference', async () => {
    const messages = await validateUIMessages<ClientUIMessage>({
      messages: userChat(
        filePart({
          mediaType: 'text/plain',
          filename: 'owned.txt',
          providerReference: { anthropic: VICTIM_ANTHROPIC_FILE },
          providerMetadata: { anthropic: { containerUpload: true } },
        }),
      ),
    });

    const sent = await expectClientFileNotLoaded({
      createModel: fetchImpl =>
        createAnthropic(settings(fetchImpl))('claude-3-haiku-20240307'),
      messages,
      victimId: VICTIM_ANTHROPIC_FILE,
      authorization: {
        allowContainerUpload: true,
        resolveProviderReference() {
          return { anthropic: SERVER_ISSUED_ANTHROPIC_FILE };
        },
      },
    });
    expect(sent.ids).toContain(SERVER_ISSUED_ANTHROPIC_FILE);
    expect(sent.containerUpload).toBe(true);
  });

  it('does not let DirectChatTransport forward a client file id', async () => {
    const messages = await messagesAsTheChatRouteReceivesThem(
      userChat(
        filePart({
          mediaType: 'application/pdf',
          filename: 'victim.pdf',
          providerReference: { anthropic: VICTIM_ANTHROPIC_FILE },
          providerMetadata: { anthropic: { containerUpload: true } },
        }),
      ),
    );

    const direct = recordingFetch();
    const directStream = await new DirectChatTransport({
      agent: new ToolLoopAgent({
        model: createAnthropic(settings(direct.fetchImpl))(
          'claude-3-haiku-20240307',
        ),
      }),
    }).sendMessages({
      chatId: 'chat-1',
      messageId: undefined,
      trigger: 'submit-message',
      messages,
      abortSignal: undefined,
    });
    try {
      const reader = directStream.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) {
          break;
        }
      }
    } catch (error) {
      if (direct.requests.length === 0) {
        throw error;
      }
    }
    const directSent = await collectSentFileIds(direct.requests);
    expect(directSent.containerUpload).toBe(false);
    expect(directSent.ids).not.toContain(VICTIM_ANTHROPIC_FILE);
  });

  it('does not let createAgentUIStream forward a client file id', async () => {
    const messages = await messagesAsTheChatRouteReceivesThem(
      userChat(
        filePart({
          mediaType: 'application/pdf',
          filename: 'victim.pdf',
          providerReference: { anthropic: VICTIM_ANTHROPIC_FILE },
          providerMetadata: { anthropic: { containerUpload: true } },
        }),
      ),
    );
    const agentFetch = recordingFetch();
    const agentStream = await createAgentUIStream({
      agent: new ToolLoopAgent({
        model: createAnthropic(settings(agentFetch.fetchImpl))(
          'claude-3-haiku-20240307',
        ),
      }),
      uiMessages: messages,
    });
    try {
      for await (const _chunk of agentStream) {
        // Drain until the provider request has been built.
      }
    } catch (error) {
      if (agentFetch.requests.length === 0) {
        throw error;
      }
    }
    const agentSent = await collectSentFileIds(agentFetch.requests);
    expect(agentSent.ids).not.toContain(VICTIM_ANTHROPIC_FILE);
    expect(agentSent.containerUpload).toBe(false);
  });

  it('still sends a provider reference that the server placed on a model message', async () => {
    const recorded = recordingFetch();
    try {
      await generateText({
        model: createAnthropic(settings(recorded.fetchImpl))(
          'claude-3-haiku-20240307',
        ),
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'file',
                mediaType: 'application/pdf',
                filename: 'server.pdf',
                data: {
                  type: 'reference',
                  reference: { anthropic: SERVER_ISSUED_ANTHROPIC_FILE },
                },
              },
              { type: 'text', text: 'Summarize the server-side upload.' },
            ],
          },
        ],
      });
    } catch (error) {
      if (recorded.requests.length === 0) {
        throw error;
      }
    }
    const sent = await collectSentFileIds(recorded.requests);
    expect(sent.ids).toContain(SERVER_ISSUED_ANTHROPIC_FILE);
  });
});
