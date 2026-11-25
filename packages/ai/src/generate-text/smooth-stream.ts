import { delay as originalDelay, type ToolSet } from '@ai-sdk/provider-utils';
import {
  InvalidArgumentError,
  type SharedV4ProviderMetadata,
} from '@ai-sdk/provider';
import type { TextStreamPart } from './stream-text-result';

const WHITESPACE = /\s/g;
const NON_WHITESPACE = /\S/g;
const NEWLINE = /\n/g;
const NON_NEWLINE = /[^\n]/g;

function indexOfPattern(pattern: RegExp, text: string, from: number): number {
  pattern.lastIndex = from;
  return pattern.exec(text)?.index ?? -1;
}

/**
 * Finds the first chunk in the buffer.
 *
 * `unscanned` is the suffix of `buffer` that was appended since the previous
 * scan (or the whole buffer after a chunk was found or `reset` was called).
 * Returns the length of the first chunk in `buffer`, or `undefined`.
 */
type ChunkScanner = {
  scan(buffer: string, unscanned: string): number | undefined;
  reset(): void;
};

/**
 * Equivalent to the first match of `/\S+\s+/` (including any text before it),
 * but resumes where the previous scan stopped so that each buffered character
 * is only scanned once, regardless of how the text is split into deltas.
 */
function createWordScanner(): ChunkScanner {
  // Until a chunk is found, the scanned text is whitespace followed by
  // non-whitespace. Tracks whether the non-whitespace part has started.
  let inWord = false;

  return {
    scan(buffer, unscanned) {
      let index = 0;

      if (!inWord) {
        index = indexOfPattern(NON_WHITESPACE, unscanned, 0);
        if (index === -1) {
          return undefined;
        }
        inWord = true;
      }

      const whitespaceStart = indexOfPattern(WHITESPACE, unscanned, index);
      if (whitespaceStart === -1) {
        return undefined;
      }

      const whitespaceEnd = indexOfPattern(
        NON_WHITESPACE,
        unscanned,
        whitespaceStart,
      );

      inWord = false;

      return (
        buffer.length -
        unscanned.length +
        (whitespaceEnd === -1 ? unscanned.length : whitespaceEnd)
      );
    },
    reset() {
      inWord = false;
    },
  };
}

/**
 * Equivalent to the first match of `/\n+/` (including any text before it),
 * scanning only text that has not been scanned before.
 */
function createLineScanner(): ChunkScanner {
  return {
    scan(buffer, unscanned) {
      const newlineStart = indexOfPattern(NEWLINE, unscanned, 0);
      if (newlineStart === -1) {
        return undefined;
      }

      const newlineEnd = indexOfPattern(NON_NEWLINE, unscanned, newlineStart);

      return (
        buffer.length -
        unscanned.length +
        (newlineEnd === -1 ? unscanned.length : newlineEnd)
      );
    },
    reset() {},
  };
}

// Browsers heavily throttle timers in hidden documents (e.g. background tabs),
// which would stall the smoothing delay and, through backpressure, the entire
// stream. Smoothing has no visual purpose there, so the delay is skipped.
function isDocumentHidden(): boolean {
  return (
    typeof document !== 'undefined' && document.visibilityState === 'hidden'
  );
}

/**
 * Detects the first chunk in a buffer.
 *
 * @param buffer - The buffer to detect the first chunk in.
 *
 * @returns The first detected chunk, or `undefined` if no chunk was detected.
 */
export type ChunkDetector = (buffer: string) => string | undefined | null;

function createChunkDetector(
  chunking: RegExp | ChunkDetector | Intl.Segmenter,
): ChunkDetector {
  let detectChunk: ChunkDetector;

  // Check if chunking is an Intl.Segmenter (duck-typing for segment method)
  if (
    chunking != null &&
    typeof chunking === 'object' &&
    'segment' in chunking &&
    typeof chunking.segment === 'function'
  ) {
    const segmenter = chunking as Intl.Segmenter;
    detectChunk = (buffer: string) => {
      if (buffer.length === 0) return null;
      const iterator = segmenter.segment(buffer)[Symbol.iterator]();
      const first = iterator.next().value;
      return first?.segment || null;
    };
  } else if (typeof chunking === 'function') {
    detectChunk = buffer => {
      const match = chunking(buffer);

      if (match == null) {
        return null;
      }

      if (!match.length) {
        throw new Error(`Chunking function must return a non-empty string.`);
      }

      if (!buffer.startsWith(match)) {
        throw new Error(
          `Chunking function must return a match that is a prefix of the buffer. Received: "${match}" expected to start with "${buffer}"`,
        );
      }

      return match;
    };
  } else if (chunking instanceof RegExp) {
    const chunkingRegex = chunking;

    detectChunk = buffer => {
      const lastIndex = chunkingRegex.lastIndex;
      chunkingRegex.lastIndex = 0;

      let match: RegExpExecArray | null;
      try {
        match = chunkingRegex.exec(buffer);
      } finally {
        chunkingRegex.lastIndex = lastIndex;
      }

      if (!match) {
        return null;
      }

      if (!match[0].length) {
        throw new Error(`Chunking RegExp must not match an empty string.`);
      }

      return buffer.slice(0, match.index) + match[0];
    };
  } else {
    throw new InvalidArgumentError({
      argument: 'chunking',
      message: `Chunking must be "word", "line", a RegExp, an Intl.Segmenter, or a ChunkDetector function. Received: ${chunking}`,
    });
  }

  return detectChunk;
}

/**
 * Smooths text and reasoning streaming output.
 *
 * @param delayInMs - The delay in milliseconds between each chunk. Defaults to 10ms. Can be set to `null` to skip the delay. The delay is skipped while the document is hidden (e.g. browser background tabs), where timer throttling would otherwise stall the stream.
 * @param chunking - Controls how the text is chunked for streaming. Use "word" to stream word by word (default), "line" to stream line by line, provide a custom RegExp pattern that does not match the empty string for custom chunking, provide an Intl.Segmenter for locale-aware word segmentation (recommended for CJK languages), or provide a custom ChunkDetector function. Custom RegExp patterns and ChunkDetector functions are applied to the entire buffered text whenever a delta arrives, so they should run in linear time.
 *
 * @returns A transform stream that smooths text streaming output.
 */
export function smoothStream<TOOLS extends ToolSet>({
  delayInMs = 10,
  chunking = 'word',
  _internal: { delay = originalDelay } = {},
}: {
  delayInMs?: number | null;
  chunking?: 'word' | 'line' | RegExp | ChunkDetector | Intl.Segmenter;
  /**
   * Internal. For test use only. May change without notice.
   */
  _internal?: {
    delay?: (delayInMs: number | null) => Promise<void>;
  };
} = {}): (options: {
  tools: TOOLS;
}) => TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>> {
  let createScanner: () => ChunkScanner;

  if (chunking === 'word') {
    createScanner = createWordScanner;
  } else if (chunking === 'line') {
    createScanner = createLineScanner;
  } else {
    const detectChunk = createChunkDetector(chunking);
    createScanner = () => ({
      scan: buffer => detectChunk(buffer)?.length,
      reset() {},
    });
  }

  return () => {
    const scanner = createScanner();
    let buffer = '';
    let id = '';
    let type: 'text-delta' | 'reasoning-delta' | undefined = undefined;
    let providerMetadata: SharedV4ProviderMetadata | undefined = undefined;

    function flushBuffer(
      controller: TransformStreamDefaultController<TextStreamPart<TOOLS>>,
    ) {
      if (
        type !== undefined &&
        (buffer.length > 0 || providerMetadata != null)
      ) {
        controller.enqueue({
          type,
          text: buffer,
          id,
          ...(providerMetadata != null ? { providerMetadata } : {}),
        });
        buffer = '';
        providerMetadata = undefined;
        scanner.reset();
      }
    }

    return new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
      async transform(chunk, controller) {
        // Handle non-smoothable chunks: flush buffer and pass through
        if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') {
          flushBuffer(controller);
          controller.enqueue(chunk);
          return;
        }

        // Flush buffer when type or id changes
        if (
          (chunk.type !== type || chunk.id !== id) &&
          (buffer.length > 0 || providerMetadata != null)
        ) {
          flushBuffer(controller);
        }

        buffer += chunk.text;
        id = chunk.id;
        type = chunk.type;

        // Preserve providerMetadata (e.g., Anthropic thinking signatures)
        if (chunk.providerMetadata != null) {
          providerMetadata = chunk.providerMetadata;
        }

        let unscanned = chunk.text;
        let chunkLength;

        while ((chunkLength = scanner.scan(buffer, unscanned)) != null) {
          controller.enqueue({ type, text: buffer.slice(0, chunkLength), id });
          buffer = buffer.slice(chunkLength);
          unscanned = buffer;

          await delay(isDocumentHidden() ? null : delayInMs);
        }
      },
    });
  };
}
