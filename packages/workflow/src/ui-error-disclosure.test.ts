import {
  createProviderStreamError,
  parseJsonEventStream,
  zodSchema,
} from '@ai-sdk/provider-utils';
import { createUIMessageStreamResponse, tool, type UIMessageChunk } from 'ai';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import type { ModelCallStreamPart } from './do-stream-step.js';
import { createModelCallToUIChunkTransform } from './to-ui-message-chunk.js';
import { WorkflowAgent } from './workflow-agent.js';

/**
 * Core UI streams default to this text so server error details stay on the
 * server. See `toUIMessageStream` in `packages/ai`.
 */
const GENERIC_ERROR_TEXT = 'An error occurred.';

const providerMessage = 'server-only-provider-message-placeholder';
const upstreamBody = 'server-only-upstream-body-placeholder';
const stringModelError = 'server-only-string-model-error-placeholder';
const toolException = 'server-only-tool-exception-placeholder';
const thrownObjectDetail = 'server-only-thrown-object-placeholder';
const availableToolName = 'server-only-available-tool-placeholder';

const finish = {
  type: 'finish' as const,
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage: {
    inputTokens: {
      total: 1,
      noCache: 1,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 0, text: 0, reasoning: undefined },
  },
};

async function clientSse(
  stream: (writable: WritableStream<ModelCallStreamPart>) => Promise<unknown>,
): Promise<string> {
  const { readable, writable } = new TransformStream<
    ModelCallStreamPart,
    ModelCallStreamPart
  >();
  const response = createUIMessageStreamResponse({
    stream: readable.pipeThrough(createModelCallToUIChunkTransform()),
  });
  const body = response.text();
  await stream(writable);
  return body;
}

function uiChunks(sse: string): UIMessageChunk[] {
  return sse
    .split('\n\n')
    .map(block => block.trim())
    .filter(block => block.startsWith('data: ') && block !== 'data: [DONE]')
    .map(block => JSON.parse(block.slice('data: '.length)) as UIMessageChunk);
}

function errorTexts(chunks: UIMessageChunk[]): string[] {
  return chunks.flatMap(chunk =>
    chunk.type === 'error' ||
    chunk.type === 'tool-output-error' ||
    chunk.type === 'tool-input-error'
      ? [chunk.errorText]
      : [],
  );
}

function expectMasked(chunks: UIMessageChunk[], hidden: string[]) {
  const texts = errorTexts(chunks);
  expect(texts.length).toBeGreaterThan(0);
  expect(texts).toEqual(texts.map(() => GENERIC_ERROR_TEXT));
  const serialized = JSON.stringify(chunks);
  for (const detail of hidden) {
    expect(serialized).not.toContain(detail);
  }
}

async function upstreamParseError(): Promise<unknown> {
  const stream = parseJsonEventStream({
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${upstreamBody} is not json\n\ndata: [DONE]\n\n`,
          ),
        );
        controller.close();
      },
    }),
    schema: zodSchema(z.object({ ok: z.literal(true) })),
  });
  const { value } = await stream.getReader().read();
  if (value == null || value.success) {
    throw new Error('expected the event parser to reject the upstream chunk');
  }
  return value.error;
}

describe('workflow chat error disclosure', () => {
  it('masks a provider stream error on the documented chat response', async () => {
    const providerError = createProviderStreamError({
      message: providerMessage,
      type: 'server_error',
      data: {
        responseBody: upstreamBody,
        url: 'https://provider.example/internal',
      },
    });
    const sse = await clientSse(writable => {
      const agent = new WorkflowAgent({
        model: new MockLanguageModelV4({
          doStream: async () => ({
            stream: convertArrayToReadableStream([
              { type: 'stream-start' as const, warnings: [] },
              { type: 'error' as const, error: providerError },
              {
                ...finish,
                finishReason: { unified: 'error' as const, raw: 'error' },
              },
            ]),
          }),
        }),
      });
      return agent.stream({
        messages: [{ role: 'user', content: 'provoke a provider failure' }],
        writable,
      });
    });

    expectMasked(uiChunks(sse), [providerMessage, upstreamBody]);
  });

  it('masks an upstream chunk that failed event parsing', async () => {
    const error = await upstreamParseError();
    const sse = await clientSse(writable => {
      const agent = new WorkflowAgent({
        model: new MockLanguageModelV4({
          doStream: async () => ({
            stream: convertArrayToReadableStream([
              { type: 'stream-start' as const, warnings: [] },
              { type: 'text-start' as const, id: 'text-1' },
              { type: 'text-delta' as const, id: 'text-1', delta: 'Hello' },
              { type: 'text-end' as const, id: 'text-1' },
              { type: 'error' as const, error },
              {
                ...finish,
                finishReason: { unified: 'error' as const, raw: 'error' },
              },
            ]),
          }),
        }),
      });
      return agent.stream({
        messages: [{ role: 'user', content: 'provoke a broken stream' }],
        writable,
      });
    });

    const chunks = uiChunks(sse);
    expect(chunks).toContainEqual({
      type: 'text-delta',
      id: 'text-1',
      delta: 'Hello',
    });
    expectMasked(chunks, [upstreamBody]);
  });

  it('masks a string model error', async () => {
    const sse = await clientSse(writable => {
      const agent = new WorkflowAgent({
        model: new MockLanguageModelV4({
          doStream: async () => ({
            stream: convertArrayToReadableStream([
              { type: 'stream-start' as const, warnings: [] },
              { type: 'error' as const, error: stringModelError },
              {
                ...finish,
                finishReason: { unified: 'error' as const, raw: 'error' },
              },
            ]),
          }),
        }),
      });
      return agent.stream({
        messages: [{ role: 'user', content: 'provoke a string failure' }],
        writable,
      });
    });

    expectMasked(uiChunks(sse), [stringModelError]);
  });

  it('masks a server tool exception', async () => {
    let calls = 0;
    const sse = await clientSse(writable => {
      const agent = new WorkflowAgent({
        model: new MockLanguageModelV4({
          doStream: async () => {
            if (calls++ === 0) {
              return {
                stream: convertArrayToReadableStream([
                  { type: 'stream-start' as const, warnings: [] },
                  {
                    type: 'tool-call' as const,
                    toolCallId: 'call-1',
                    toolName: 'loadRecord',
                    input: '{}',
                  },
                  {
                    ...finish,
                    finishReason: {
                      unified: 'tool-calls' as const,
                      raw: 'tool-calls',
                    },
                  },
                ]),
              };
            }
            return {
              stream: convertArrayToReadableStream([
                { type: 'stream-start' as const, warnings: [] },
                { type: 'text-start' as const, id: 'text-1' },
                {
                  type: 'text-delta' as const,
                  id: 'text-1',
                  delta: 'recovered',
                },
                { type: 'text-end' as const, id: 'text-1' },
                finish,
              ]),
            };
          },
        }),
        tools: {
          loadRecord: tool({
            inputSchema: z.object({}),
            execute: async () => {
              throw new Error(toolException);
            },
          }),
        },
      });
      return agent.stream({
        messages: [{ role: 'user', content: 'load the record' }],
        writable,
      });
    });

    const chunks = uiChunks(sse);
    expect(chunks).toContainEqual({
      type: 'text-delta',
      id: 'text-1',
      delta: 'recovered',
    });
    expectMasked(chunks, [toolException]);
  });

  it('masks a thrown tool value that is not an Error', async () => {
    let calls = 0;
    const sse = await clientSse(writable => {
      const agent = new WorkflowAgent({
        model: new MockLanguageModelV4({
          doStream: async () => {
            if (calls++ === 0) {
              return {
                stream: convertArrayToReadableStream([
                  { type: 'stream-start' as const, warnings: [] },
                  {
                    type: 'tool-call' as const,
                    toolCallId: 'call-1',
                    toolName: 'loadRecord',
                    input: '{}',
                  },
                  {
                    ...finish,
                    finishReason: {
                      unified: 'tool-calls' as const,
                      raw: 'tool-calls',
                    },
                  },
                ]),
              };
            }
            return {
              stream: convertArrayToReadableStream([
                { type: 'stream-start' as const, warnings: [] },
                finish,
              ]),
            };
          },
        }),
        tools: {
          loadRecord: tool({
            inputSchema: z.object({}),
            execute: async () => {
              throw { detail: thrownObjectDetail };
            },
          }),
        },
      });
      return agent.stream({
        messages: [{ role: 'user', content: 'load the record' }],
        writable,
      });
    });

    expectMasked(uiChunks(sse), [thrownObjectDetail]);
  });

  it('masks invalid tool-call failures', async () => {
    let calls = 0;
    const sse = await clientSse(writable => {
      const agent = new WorkflowAgent({
        model: new MockLanguageModelV4({
          doStream: async () => {
            if (calls++ === 0) {
              return {
                stream: convertArrayToReadableStream([
                  { type: 'stream-start' as const, warnings: [] },
                  {
                    type: 'tool-call' as const,
                    toolCallId: 'call-1',
                    toolName: 'loadRecord',
                    input: '{"id":1}',
                  },
                  {
                    ...finish,
                    finishReason: {
                      unified: 'tool-calls' as const,
                      raw: 'tool-calls',
                    },
                  },
                ]),
              };
            }
            return {
              stream: convertArrayToReadableStream([
                { type: 'stream-start' as const, warnings: [] },
                finish,
              ]),
            };
          },
        }),
        tools: {
          loadRecord: tool({
            inputSchema: z.object({ id: z.string() }),
            execute: async () => 'ok',
          }),
        },
      });
      return agent.stream({
        messages: [{ role: 'user', content: 'call the tool badly' }],
        writable,
      });
    });

    const chunks = uiChunks(sse);
    const texts = errorTexts(chunks);
    expect(texts).toEqual(texts.map(() => GENERIC_ERROR_TEXT));
    expect(chunks.some(chunk => chunk.type === 'tool-input-error')).toBe(true);
    expect(chunks.some(chunk => chunk.type === 'tool-output-error')).toBe(true);
  });

  it('masks the available-tool list from an unknown tool call', async () => {
    let calls = 0;
    const sse = await clientSse(writable => {
      const agent = new WorkflowAgent({
        model: new MockLanguageModelV4({
          doStream: async () => {
            if (calls++ === 0) {
              return {
                stream: convertArrayToReadableStream([
                  { type: 'stream-start' as const, warnings: [] },
                  {
                    type: 'tool-call' as const,
                    toolCallId: 'call-1',
                    toolName: 'missingTool',
                    input: '{}',
                  },
                  {
                    ...finish,
                    finishReason: {
                      unified: 'tool-calls' as const,
                      raw: 'tool-calls',
                    },
                  },
                ]),
              };
            }
            return {
              stream: convertArrayToReadableStream([
                { type: 'stream-start' as const, warnings: [] },
                finish,
              ]),
            };
          },
        }),
        tools: {
          [availableToolName]: tool({
            inputSchema: z.object({}),
            execute: async () => 'ok',
          }),
        },
      });
      return agent.stream({
        messages: [{ role: 'user', content: 'call a missing tool' }],
        writable,
      });
    });

    expectMasked(uiChunks(sse), [availableToolName]);
  });
});
