import {
  UnsupportedFunctionalityError,
  type LanguageModelV4Prompt,
  type SharedV4ProviderMetadata,
} from '@ai-sdk/provider';
import type { OpenAICompatibleChatPrompt } from './openai-compatible-api-types';
import {
  convertBase64ToUint8Array,
  convertToBase64,
  getTopLevelMediaType,
  resolveFullMediaType,
} from '@ai-sdk/provider-utils';

// Provider options can originate from untrusted clients (e.g. UI message
// metadata), so they must never define a message's role or turn structure.
const RESERVED_MESSAGE_KEYS = new Set([
  'role',
  'content',
  'tool_calls',
  'tool_call_id',
  'function_call',
]);

function getOpenAIMetadata(message: {
  providerOptions?: SharedV4ProviderMetadata;
}) {
  const metadata = message?.providerOptions?.openaiCompatible;
  if (metadata == null) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !RESERVED_MESSAGE_KEYS.has(key)),
  );
}

function getAudioFormat(mediaType: string): 'wav' | 'mp3' | null {
  switch (mediaType) {
    case 'audio/wav':
      return 'wav';
    case 'audio/mp3':
    case 'audio/mpeg':
      return 'mp3';
    default:
      return null;
  }
}

export function convertToOpenAICompatibleChatMessages(
  prompt: LanguageModelV4Prompt,
  { providerOptionsKey = 'google' }: { providerOptionsKey?: string } = {},
): OpenAICompatibleChatPrompt {
  const messages: OpenAICompatibleChatPrompt = [];
  for (const { role, content, ...message } of prompt) {
    const metadata = getOpenAIMetadata({ ...message });
    switch (role) {
      case 'system': {
        messages.push({ ...metadata, role: 'system', content });
        break;
      }

      case 'user': {
        if (content.length === 1 && content[0].type === 'text') {
          messages.push({
            ...getOpenAIMetadata(content[0]),
            role: 'user',
            content: content[0].text,
          });
          break;
        }

        messages.push({
          ...metadata,
          role: 'user',
          content: content.map(part => {
            const partMetadata = getOpenAIMetadata(part);
            switch (part.type) {
              case 'text': {
                return { ...partMetadata, type: 'text', text: part.text };
              }
              case 'file': {
                switch (part.data.type) {
                  case 'reference': {
                    throw new UnsupportedFunctionalityError({
                      functionality: 'file parts with provider references',
                    });
                  }
                  case 'text': {
                    throw new UnsupportedFunctionalityError({
                      functionality: 'text file parts',
                    });
                  }
                  case 'url':
                  case 'data': {
                    const topLevel = getTopLevelMediaType(part.mediaType);

                    if (topLevel === 'image') {
                      return {
                        ...partMetadata,
                        type: 'image_url',
                        image_url: {
                          url:
                            part.data.type === 'url'
                              ? part.data.url.toString()
                              : `data:${resolveFullMediaType({ part })};base64,${convertToBase64(part.data.data)}`,
                        },
                      };
                    }

                    if (topLevel === 'video') {
                      return {
                        ...partMetadata,
                        type: 'video_url',
                        video_url: {
                          url:
                            part.data.type === 'url'
                              ? part.data.url.toString()
                              : `data:${resolveFullMediaType({ part })};base64,${convertToBase64(part.data.data)}`,
                        },
                      };
                    }

                    if (topLevel === 'audio') {
                      if (part.data.type === 'url') {
                        throw new UnsupportedFunctionalityError({
                          functionality: 'audio file parts with URLs',
                        });
                      }

                      const fullMediaType = resolveFullMediaType({ part });
                      const format = getAudioFormat(fullMediaType);
                      if (format === null) {
                        throw new UnsupportedFunctionalityError({
                          functionality: `audio media type ${fullMediaType}`,
                        });
                      }

                      return {
                        ...partMetadata,
                        type: 'input_audio',
                        input_audio: {
                          data: convertToBase64(part.data.data),
                          format,
                        },
                      };
                    }

                    if (topLevel === 'application') {
                      if (part.data.type === 'url') {
                        throw new UnsupportedFunctionalityError({
                          functionality: 'PDF file parts with URLs',
                        });
                      }

                      const fullMediaType = resolveFullMediaType({ part });
                      if (fullMediaType !== 'application/pdf') {
                        throw new UnsupportedFunctionalityError({
                          functionality: `file part media type ${fullMediaType}`,
                        });
                      }

                      return {
                        ...partMetadata,
                        type: 'file',
                        file: {
                          filename: part.filename ?? 'document.pdf',
                          file_data: `data:application/pdf;base64,${convertToBase64(part.data.data)}`,
                        },
                      };
                    }

                    if (topLevel === 'text') {
                      const textContent =
                        part.data.type === 'url'
                          ? part.data.url.toString()
                          : typeof part.data.data === 'string'
                            ? new TextDecoder().decode(
                                convertBase64ToUint8Array(part.data.data),
                              )
                            : new TextDecoder().decode(part.data.data);

                      return {
                        ...partMetadata,
                        type: 'text',
                        text: textContent,
                      };
                    }

                    throw new UnsupportedFunctionalityError({
                      functionality: `file part media type ${part.mediaType}`,
                    });
                  }
                }
              }
            }
          }),
        });

        break;
      }

      case 'assistant': {
        let text = '';
        let reasoning = '';
        const toolCalls: Array<{
          id: string;
          type: 'function';
          function: { name: string; arguments: string };
          extra_content?: {
            google?: {
              thought_signature?: string;
            };
          };
        }> = [];

        for (const part of content) {
          const partMetadata = getOpenAIMetadata(part);
          switch (part.type) {
            case 'text': {
              text += part.text;
              break;
            }
            case 'reasoning': {
              reasoning += part.text;
              break;
            }
            case 'tool-call': {
              // TODO: thoughtSignature should be abstracted once we add support for other providers
              const thoughtSignature =
                part.providerOptions?.[providerOptionsKey]?.thoughtSignature ??
                part.providerOptions?.google?.thoughtSignature;
              toolCalls.push({
                ...partMetadata,
                id: part.toolCallId,
                type: 'function',
                function: {
                  name: part.toolName,
                  arguments: JSON.stringify(part.input),
                },
                // Include extra_content for Google Gemini thought signatures
                ...(thoughtSignature
                  ? {
                      extra_content: {
                        google: {
                          thought_signature: String(thoughtSignature),
                        },
                      },
                    }
                  : {}),
              });
              break;
            }
          }
        }

        messages.push({
          ...metadata,
          role: 'assistant',
          content: toolCalls.length > 0 ? text || null : text,
          ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        });

        break;
      }

      case 'tool': {
        for (const toolResponse of content) {
          if (toolResponse.type === 'tool-approval-response') {
            continue;
          }

          const output = toolResponse.output;

          let contentValue: string;
          switch (output.type) {
            case 'text':
            case 'error-text':
              contentValue = output.value;
              break;
            case 'execution-denied':
              contentValue = output.reason ?? 'Tool call execution denied.';
              break;
            case 'content':
            case 'json':
            case 'error-json':
              contentValue = JSON.stringify(output.value);
              break;
          }

          const toolResponseMetadata = getOpenAIMetadata(toolResponse);
          messages.push({
            ...toolResponseMetadata,
            role: 'tool',
            tool_call_id: toolResponse.toolCallId,
            content: contentValue,
          });
        }
        break;
      }

      default: {
        const _exhaustiveCheck: never = role;
        throw new Error(`Unsupported role: ${_exhaustiveCheck}`);
      }
    }
  }

  return messages;
}
