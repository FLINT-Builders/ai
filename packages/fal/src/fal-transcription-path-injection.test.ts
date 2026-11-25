import { describe, expect, it } from 'vitest';
import { createFal } from './fal-provider';

/**
 * Placeholder credential. The value is not a real fal key; the assertion is
 * that this header is attached to whatever URL the model id produces.
 */
const placeholderApiKey = 'test-api-key';

const queueOrigin = 'https://queue.fal.run';

/**
 * Model ids from the reported attack, plus the parsers that collapse them
 * onto another path: dot segments, percent-encoded dots, backslash, query,
 * and fragment.
 */
const injectedModelIds = [
  'whisper/../other',
  'whisper/%2e%2e/other',
  'whisper\\../other',
  'whisper/requests/other-id',
  '../../other',
  'whisper/requests/victim-id?',
  'whisper/requests/victim-id#',
];

type RecordedCall = {
  method: string;
  url: string;
  authorization: string | null;
};

function createRecordingFetch(records: RecordedCall[]) {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    // Same constructor global fetch uses before it sends pathname + search.
    const request = new Request(input, init);
    records.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.get('authorization'),
    });

    const body =
      request.method === 'GET'
        ? { text: 'ok', chunks: [], inferred_languages: ['en'] }
        : {
            request_id: 'job-1',
            response_url: `${queueOrigin}/fal-ai/whisper/requests/job-1`,
          };

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  return fetch;
}

/**
 * A credentialed queue URL is safe when the model id is one path segment
 * under /fal-ai/ and cannot add a query, fragment, or further segments.
 * encodeURIComponent is the single-segment form; an allowlist refuses
 * instead of calling fetch.
 */
function isSafeQueueUrl(url: string, modelId: string): boolean {
  const parsed = new URL(url);
  if (parsed.origin !== queueOrigin) return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  if (parsed.search !== '' || parsed.hash !== '') return false;

  const segments = parsed.pathname.split('/').filter(segment => segment !== '');
  if (segments[0] !== 'fal-ai') return false;
  if (segments[1] !== encodeURIComponent(modelId)) return false;
  if (segments.length === 2) return true;
  return (
    segments.length === 4 &&
    segments[2] === 'requests' &&
    segments[3] === 'job-1'
  );
}

async function runCall(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

describe('fal transcription model id path injection', () => {
  for (const modelId of injectedModelIds) {
    it(`does not attach the fal key to a queue path chosen by model id ${JSON.stringify(modelId)}`, async () => {
      const records: RecordedCall[] = [];
      const model = createFal({
        apiKey: placeholderApiKey,
        fetch: createRecordingFetch(records),
      }).transcription(modelId);

      const threw = await runCall(() =>
        model.doGenerate({
          audio: new Uint8Array([1, 2, 3]),
          mediaType: 'audio/wav',
        }),
      );

      const observed = records.map(record => ({
        method: record.method,
        url: record.url,
        authorization: record.authorization,
        safe: isSafeQueueUrl(record.url, modelId),
      }));

      if (threw) {
        // Refusing after a request has already been sent is still the bug.
        expect(observed).toEqual([]);
        return;
      }

      expect(observed).toEqual([
        {
          method: 'POST',
          url: `${queueOrigin}/fal-ai/${encodeURIComponent(modelId)}`,
          authorization: `Key ${placeholderApiKey}`,
          safe: true,
        },
        {
          method: 'GET',
          url: `${queueOrigin}/fal-ai/${encodeURIComponent(modelId)}/requests/job-1`,
          authorization: `Key ${placeholderApiKey}`,
          safe: true,
        },
      ]);
    });
  }

  it('still submits and polls whisper on a single queue path', async () => {
    const records: RecordedCall[] = [];
    const model = createFal({
      apiKey: placeholderApiKey,
      fetch: createRecordingFetch(records),
    }).transcription('whisper');

    const result = await model.doGenerate({
      audio: new Uint8Array([1, 2, 3]),
      mediaType: 'audio/wav',
    });

    expect(result.text).toBe('ok');
    expect(records.map(record => record.url)).toEqual([
      `${queueOrigin}/fal-ai/whisper`,
      `${queueOrigin}/fal-ai/whisper/requests/job-1`,
    ]);
    expect(records.map(record => record.authorization)).toEqual([
      `Key ${placeholderApiKey}`,
      `Key ${placeholderApiKey}`,
    ]);
  });

  it('still submits and polls wizper on a single queue path', async () => {
    const records: RecordedCall[] = [];
    const model = createFal({
      apiKey: placeholderApiKey,
      fetch: createRecordingFetch(records),
    }).transcription('wizper');

    await model.doGenerate({
      audio: new Uint8Array([1, 2, 3]),
      mediaType: 'audio/wav',
    });

    expect(records.map(record => record.url)).toEqual([
      `${queueOrigin}/fal-ai/wizper`,
      `${queueOrigin}/fal-ai/wizper/requests/job-1`,
    ]);
  });
});

describe('fal video queue submit model id path injection', () => {
  for (const modelId of injectedModelIds) {
    it(`does not attach the fal key to a queue submit path chosen by model id ${JSON.stringify(modelId)}`, async () => {
      const records: RecordedCall[] = [];
      const model = createFal({
        apiKey: placeholderApiKey,
        fetch: createRecordingFetch(records),
      }).video(modelId);

      const threw = await runCall(() =>
        model.doStart!({
          prompt: 'a lighthouse',
          n: 1,
          aspectRatio: undefined,
          resolution: undefined,
          duration: undefined,
          fps: undefined,
          seed: undefined,
          image: undefined,
          frameImages: undefined,
          inputReferences: undefined,
          generateAudio: undefined,
          providerOptions: {},
        }),
      );

      const observed = records.map(record => ({
        method: record.method,
        url: record.url,
        authorization: record.authorization,
        safe: isSafeQueueUrl(record.url, modelId),
      }));

      if (threw) {
        expect(observed).toEqual([]);
        return;
      }

      expect(observed).toEqual([
        {
          method: 'POST',
          url: `${queueOrigin}/fal-ai/${encodeURIComponent(modelId)}`,
          authorization: `Key ${placeholderApiKey}`,
          safe: true,
        },
      ]);
    });
  }

  it('still submits luma-dream-machine on a single queue path', async () => {
    const records: RecordedCall[] = [];
    const model = createFal({
      apiKey: placeholderApiKey,
      fetch: createRecordingFetch(records),
    }).video('luma-dream-machine');

    const result = await model.doStart!({
      prompt: 'a lighthouse',
      n: 1,
      aspectRatio: undefined,
      resolution: undefined,
      duration: undefined,
      fps: undefined,
      seed: undefined,
      image: undefined,
      frameImages: undefined,
      inputReferences: undefined,
      generateAudio: undefined,
      providerOptions: {},
    });

    expect(result.operation).toMatchObject({
      submitUrl: `${queueOrigin}/fal-ai/luma-dream-machine`,
    });
    expect(records.map(record => record.url)).toEqual([
      `${queueOrigin}/fal-ai/luma-dream-machine`,
    ]);
    expect(records[0]?.authorization).toBe(`Key ${placeholderApiKey}`);
  });
});
