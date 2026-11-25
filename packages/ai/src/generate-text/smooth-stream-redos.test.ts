import { convertArrayToReadableStream } from '@ai-sdk/provider-utils/test';
import type { LanguageModelV4Usage } from '@ai-sdk/provider';
import type { ToolSet } from '@ai-sdk/provider-utils';
import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from '../test/mock-language-model-v4';
import { smoothStream } from './smooth-stream';
import { streamText } from './stream-text';
import type { TextStreamPart } from './stream-text-result';

/**
 * Budgets for the default word chunker (`/\S+\s+/`).
 *
 * On this pattern an unbroken buffer does not match. The unanchored exec tries
 * every start index, and at each index the greedy `\S+` runs to the end and
 * backtracks, so one exec is quadratic. `smoothStream` runs that exec on the
 * whole buffer for every text or reasoning delta, so many small deltas are
 * cubic.
 *
 * A linear scan, or a buffer cap that flushes before the regex can grow
 * without bound, finishes these cases well under the budgets. The numbers
 * below are several times a linear pass and far below the quadratic cost.
 */
const DELTA_CHARS = 8;
const INCREMENTAL_CHARS = 6_000;
const SINGLE_CHUNK_CHARS = 48_000;
const MAX_INCREMENTAL_MS = 1_200;
const MAX_SINGLE_CHUNK_MS = 500;

const usage: LanguageModelV4Usage = {
  inputTokens: {
    total: 3,
    noCache: 3,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: 10,
    text: 10,
    reasoning: undefined,
  },
};

function digits(length: number): string {
  const alphabet = '314159265358979323846';
  let out = '';
  while (out.length < length) {
    out += alphabet;
  }
  return out.slice(0, length);
}

function pieces(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    parts.push(text.slice(index, index + size));
  }
  return parts;
}

async function readParts(
  parts: Array<TextStreamPart<ToolSet>>,
): Promise<TextStreamPart<ToolSet>[]> {
  const stream = convertArrayToReadableStream(parts).pipeThrough(
    smoothStream()({ tools: {} }),
  );
  const reader = stream.getReader();
  const emitted: TextStreamPart<ToolSet>[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    emitted.push(value);
  }
  return emitted;
}

function textOf(
  parts: TextStreamPart<ToolSet>[],
  type: 'text-delta' | 'reasoning-delta',
): string {
  return parts
    .filter(part => part.type === type)
    .map(part => part.text)
    .join('');
}

describe('smoothStream word chunking denial of service', () => {
  it('smooths thousands of small unbroken text deltas within a linear budget', async () => {
    const text = digits(INCREMENTAL_CHARS);
    const parts: Array<TextStreamPart<ToolSet>> = [
      { type: 'text-start', id: '1' },
      ...pieces(text, DELTA_CHARS).map(
        (piece): TextStreamPart<ToolSet> => ({
          type: 'text-delta',
          id: '1',
          text: piece,
        }),
      ),
      { type: 'text-end', id: '1' },
    ];

    const started = performance.now();
    const emitted = await readParts(parts);
    const elapsedMs = performance.now() - started;

    expect(textOf(emitted, 'text-delta')).toBe(text);
    expect(elapsedMs).toBeLessThan(MAX_INCREMENTAL_MS);
  }, 30_000);

  it('smooths thousands of small unbroken reasoning deltas within a linear budget', async () => {
    const text = digits(INCREMENTAL_CHARS);
    const parts: Array<TextStreamPart<ToolSet>> = [
      { type: 'reasoning-start', id: 'reasoning-1' },
      ...pieces(text, DELTA_CHARS).map(
        (piece): TextStreamPart<ToolSet> => ({
          type: 'reasoning-delta',
          id: 'reasoning-1',
          text: piece,
        }),
      ),
      { type: 'reasoning-end', id: 'reasoning-1' },
    ];

    const started = performance.now();
    const emitted = await readParts(parts);
    const elapsedMs = performance.now() - started;

    expect(textOf(emitted, 'reasoning-delta')).toBe(text);
    expect(elapsedMs).toBeLessThan(MAX_INCREMENTAL_MS);
  }, 30_000);

  it('scans one large unbroken text delta within a linear budget', async () => {
    const text = digits(SINGLE_CHUNK_CHARS);
    const parts: Array<TextStreamPart<ToolSet>> = [
      { type: 'text-start', id: '1' },
      { type: 'text-delta', id: '1', text },
      { type: 'text-end', id: '1' },
    ];

    const started = performance.now();
    const emitted = await readParts(parts);
    const elapsedMs = performance.now() - started;

    expect(textOf(emitted, 'text-delta')).toBe(text);
    expect(elapsedMs).toBeLessThan(MAX_SINGLE_CHUNK_MS);
  }, 20_000);

  it('streamText delivers unbroken model deltas through the default smoothStream transform within a linear budget', async () => {
    const text = digits(INCREMENTAL_CHARS);
    const result = streamText({
      model: new MockLanguageModelV4({
        doStream: async () => ({
          stream: convertArrayToReadableStream([
            { type: 'text-start', id: '1' },
            ...pieces(text, DELTA_CHARS).map(delta => ({
              type: 'text-delta' as const,
              id: '1',
              delta,
            })),
            { type: 'text-end', id: '1' },
            {
              type: 'finish' as const,
              finishReason: { unified: 'stop' as const, raw: 'stop' },
              usage,
            },
          ]),
        }),
      }),
      prompt: 'Print digits with no spaces.',
      experimental_transform: smoothStream(),
    });

    const started = performance.now();
    const reader = result.textStream.getReader();
    let emitted = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      emitted += value;
    }
    const elapsedMs = performance.now() - started;

    expect(emitted).toBe(text);
    expect(elapsedMs).toBeLessThan(MAX_INCREMENTAL_MS);
  }, 30_000);

  it('streamText delivers unbroken reasoning deltas through the default smoothStream transform within a linear budget', async () => {
    const text = digits(INCREMENTAL_CHARS);
    const result = streamText({
      model: new MockLanguageModelV4({
        doStream: async () => ({
          stream: convertArrayToReadableStream([
            { type: 'reasoning-start', id: 'reasoning-1' },
            ...pieces(text, DELTA_CHARS).map(delta => ({
              type: 'reasoning-delta' as const,
              id: 'reasoning-1',
              delta,
            })),
            { type: 'reasoning-end', id: 'reasoning-1' },
            {
              type: 'finish' as const,
              finishReason: { unified: 'stop' as const, raw: 'stop' },
              usage,
            },
          ]),
        }),
      }),
      prompt: 'Think through a long digit sequence with no spaces.',
      experimental_transform: smoothStream(),
    });

    const started = performance.now();
    const reader = result.fullStream.getReader();
    let emitted = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value.type === 'reasoning-delta') {
        emitted += value.text;
      }
    }
    const elapsedMs = performance.now() - started;

    expect(emitted).toBe(text);
    expect(elapsedMs).toBeLessThan(MAX_INCREMENTAL_MS);
  }, 30_000);

  it('still splits ordinary prose into word chunks', async () => {
    const emitted = await readParts([
      { type: 'text-start', id: '1' },
      { type: 'text-delta', id: '1', text: 'Hello, world. More text ' },
      { type: 'text-end', id: '1' },
    ]);

    expect(
      emitted.filter(part => part.type === 'text-delta').map(part => part.text),
    ).toEqual(['Hello, ', 'world. ', 'More ', 'text ']);
  });
});
