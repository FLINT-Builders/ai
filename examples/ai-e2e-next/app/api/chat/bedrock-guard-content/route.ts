import { amazonBedrock } from '@ai-sdk/amazon-bedrock';
import type { JSONObject } from '@ai-sdk/provider';
import {
  convertToModelMessages,
  streamText,
  type ModelMessage,
  type UIMessage,
  type UserContent,
} from 'ai';

export async function POST(req: Request) {
  try {
    const { messages }: { messages: UIMessage[] } = await req.json();

    const modelMessages = await convertToModelMessages(messages);

    const guardedMessages = applyGuardContentToLastUserMessage(modelMessages);

    const result = streamText({
      model: amazonBedrock('anthropic.claude-3-haiku-20240307-v1:0'),
      messages: guardedMessages,
      maxOutputTokens: 500,
      temperature: 0.7,
      providerOptions: {
        bedrock: {
          allowPartGuardContent: true,
          guardrailConfig: {
            guardrailIdentifier:
              process.env.BEDROCK_GUARDRAIL_IDENTIFIER ?? '<guardrail-id>',
            guardrailVersion: process.env.BEDROCK_GUARDRAIL_VERSION ?? 'DRAFT',
            trace: 'enabled' as const,
          },
        },
      },
    });

    return result.toUIMessageStreamResponse();
  } catch (error) {
    console.error('Bedrock API Error:', error);
    return new Response(
      JSON.stringify({
        error: 'Bedrock API failed',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }
}

// Guard content flags decide what the guardrail evaluates, so flags sent by
// the client are removed and only the server marks the latest user message.
function applyGuardContentToLastUserMessage(
  messages: ModelMessage[],
): ModelMessage[] {
  const lastUserIndex = findLastIndex(messages, m => m.role === 'user');

  return messages.map((message, index) => {
    if (message.role !== 'user') return message;

    const content: Exclude<UserContent, string> =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : message.content;

    return {
      ...message,
      content: content.map(part => {
        const { bedrock, amazonBedrock, ...otherProviderOptions } =
          part.providerOptions ?? {};
        const guardContent = index === lastUserIndex && part.type === 'text';

        return {
          ...part,
          providerOptions: {
            ...otherProviderOptions,
            bedrock: {
              ...withoutGuardContent(amazonBedrock),
              ...withoutGuardContent(bedrock),
              ...(guardContent ? { guardContent: true } : {}),
            },
          },
        };
      }),
    };
  });
}

function withoutGuardContent(options: JSONObject | undefined): JSONObject {
  const {
    guardContent: _guardContent,
    guardContentQualifiers: _guardContentQualifiers,
    ...rest
  } = options ?? {};
  return rest;
}

function findLastIndex<T>(
  array: T[],
  predicate: (value: T) => boolean,
): number {
  for (let i = array.length - 1; i >= 0; i--) {
    if (predicate(array[i])) return i;
  }
  return -1;
}
