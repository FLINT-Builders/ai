import { APICallError } from '@ai-sdk/provider';
import { createTestServer } from '@ai-sdk/test-server/with-vitest';
import { generateSpeech } from '../../ai/src/generate-speech/generate-speech';
import { describe, expect, it } from 'vitest';
import { createElevenLabs } from './elevenlabs-provider';

const apiKeyPlaceholder = 'test-api-key';
const leakedAudio = new Uint8Array([9, 8, 7, 6, 5]);
const leakedErrorBody =
  '{"error":{"message":"sensitive-upstream-body","code":401}}';

const provider = createElevenLabs({ apiKey: apiKeyPlaceholder });
const model = provider.speech('eleven_multilingual_v2');
const speechModel = provider.speechModel('eleven_multilingual_v2');

const server = createTestServer({
  'https://api.elevenlabs.io/*': {},
});

/**
 * Voices that the URL parser folds into a different path, query, or fragment
 * when they are concatenated into `/v1/text-to-speech/${voice}`.
 */
const unsafeVoices = [
  '../../v1/user',
  '%2e%2e/%2e%2e/v1/user',
  '..\\..\\v1\\user',
  '%2e%2e',
  '.',
  'voice/../other',
  'a/b',
  'good-voice?enable_logging=false',
  '?output_format=pcm_16000',
  'good-voice#fragment',
];

function recordedCalls() {
  return server.calls.map(call => ({
    url: call.requestUrl,
    apiKeyHeader: call.requestHeaders['xi-api-key'],
  }));
}

function responseBodyOf(error: unknown): string | undefined {
  if (APICallError.isInstance(error)) {
    return error.responseBody;
  }

  if (
    error instanceof Error &&
    error.cause != null &&
    APICallError.isInstance(error.cause)
  ) {
    return error.cause.responseBody;
  }

  return undefined;
}

function returnedLeakedAudio(value: unknown): boolean {
  if (value == null || typeof value !== 'object' || !('audio' in value)) {
    return false;
  }

  const audio = value.audio;
  const bytes =
    audio instanceof Uint8Array
      ? audio
      : audio != null &&
          typeof audio === 'object' &&
          'uint8Array' in audio &&
          audio.uint8Array instanceof Uint8Array
        ? audio.uint8Array
        : undefined;

  return (
    bytes != null &&
    bytes.length === leakedAudio.length &&
    bytes.every((byte, index) => byte === leakedAudio[index])
  );
}

async function expectNoCredentialedRequest(
  invoke: () => Promise<unknown>,
): Promise<void> {
  let returned: unknown;
  let thrown: unknown;

  try {
    returned = await invoke();
  } catch (error) {
    thrown = error;
  }

  expect({
    calls: recordedCalls(),
    returnedLeakedAudio: returnedLeakedAudio(returned),
    errorResponseBody: responseBodyOf(thrown),
  }).toEqual({
    calls: [],
    returnedLeakedAudio: false,
    errorResponseBody: undefined,
  });
  expect(thrown).toBeInstanceOf(Error);
  expect(returned).toBeUndefined();
}

describe('ElevenLabs speech voice path', () => {
  it('sends a single-segment voice id with the API key header', async () => {
    server.urls['https://api.elevenlabs.io/*'].response = {
      type: 'binary',
      headers: { 'content-type': 'audio/mpeg' },
      body: Buffer.from(leakedAudio),
    };

    const result = await model.doGenerate({
      text: 'Hello',
      voice: 'test-voice-id',
    });

    expect(recordedCalls()).toEqual([
      {
        url: 'https://api.elevenlabs.io/v1/text-to-speech/test-voice-id?output_format=mp3_44100_128',
        apiKeyHeader: apiKeyPlaceholder,
      },
    ]);
    expect(result.audio).toEqual(leakedAudio);
  });

  describe('doGenerate rejects an unsafe voice before any request', () => {
    it.each(unsafeVoices)('voice %j', async voice => {
      server.urls['https://api.elevenlabs.io/*'].response = {
        type: 'binary',
        headers: { 'content-type': 'audio/mpeg' },
        body: Buffer.from(leakedAudio),
      };

      await expectNoCredentialedRequest(() =>
        model.doGenerate({
          text: 'Hello',
          voice,
        }),
      );
    });

    it.each(unsafeVoices)(
      'does not surface an error body for voice %j',
      async voice => {
        server.urls['https://api.elevenlabs.io/*'].response = {
          type: 'error',
          status: 401,
          headers: { 'content-type': 'application/json' },
          body: leakedErrorBody,
        };

        await expectNoCredentialedRequest(() =>
          model.doGenerate({
            text: 'Hello',
            voice,
          }),
        );
      },
    );
  });

  it('speechModel rejects a dot-segment voice before any request', async () => {
    server.urls['https://api.elevenlabs.io/*'].response = {
      type: 'binary',
      headers: { 'content-type': 'audio/mpeg' },
      body: Buffer.from(leakedAudio),
    };

    await expectNoCredentialedRequest(() =>
      speechModel.doGenerate({
        text: 'Hello',
        voice: '../../v1/user',
      }),
    );
  });

  describe('generateSpeech rejects an unsafe voice before any request', () => {
    it.each(unsafeVoices)('voice %j', async voice => {
      server.urls['https://api.elevenlabs.io/*'].response = {
        type: 'binary',
        headers: { 'content-type': 'audio/mpeg' },
        body: Buffer.from(leakedAudio),
      };

      await expectNoCredentialedRequest(() =>
        generateSpeech({
          model,
          text: 'Hello',
          voice,
          maxRetries: 0,
        }),
      );
    });

    it.each(unsafeVoices)(
      'does not surface an error body for voice %j',
      async voice => {
        server.urls['https://api.elevenlabs.io/*'].response = {
          type: 'error',
          status: 401,
          headers: { 'content-type': 'application/json' },
          body: leakedErrorBody,
        };

        await expectNoCredentialedRequest(() =>
          generateSpeech({
            model,
            text: 'Hello',
            voice,
            maxRetries: 0,
          }),
        );
      },
    );
  });

  it('generateSpeech still requests a safe voice id', async () => {
    server.urls['https://api.elevenlabs.io/*'].response = {
      type: 'binary',
      headers: { 'content-type': 'audio/mpeg' },
      body: Buffer.from(leakedAudio),
    };

    const result = await generateSpeech({
      model,
      text: 'Hello',
      voice: 'test-voice-id',
      maxRetries: 0,
    });

    expect(recordedCalls()).toEqual([
      {
        url: 'https://api.elevenlabs.io/v1/text-to-speech/test-voice-id?output_format=mp3_44100_128',
        apiKeyHeader: apiKeyPlaceholder,
      },
    ]);
    expect(result.audio.uint8Array).toEqual(leakedAudio);
  });
});
