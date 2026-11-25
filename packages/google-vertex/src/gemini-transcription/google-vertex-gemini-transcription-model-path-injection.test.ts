import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { WebSocketConstructor } from '@ai-sdk/provider-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { GoogleVertexGeminiTranscriptionModel } from './google-vertex-gemini-transcription-model';
import { createGoogleVertex } from '../google-vertex-provider-base';

/**
 * Spec for the transcription model id.
 *
 * A model id is one path segment. Unary generateContent must place only the
 * encoded segment under `models/`, and a live session must send only that
 * segment in the model resource. These tests fail while a model id can
 * retarget either call. They pass when an unsafe id is rejected before any
 * credentialed request or socket, and a normal id still reaches its own model.
 *
 * `createGoogleVertex` here is the base provider the public factory calls
 * after it has resolved the bearer token into `Authorization`. The public
 * wrapper does not change the model id.
 */

const PLACEHOLDER_AUTHORIZATION = 'Bearer placeholder-token';
const PROJECT = 'test-project';
const LOCATION = 'us-central1';
const PUBLISHER_PATH = `/v1beta1/projects/${PROJECT}/locations/${LOCATION}/publishers/google`;
const SAFE_MODEL_ID = 'gemini-3.5-transcribe';
const SAFE_LIVE_MODEL_ID = 'gemini-3.5-transcribe-live';

const CANONICAL_GENERATE_PATH = `${PUBLISHER_PATH}/models/${encodeURIComponent(SAFE_MODEL_ID)}:generateContent`;
const CANONICAL_LIVE_RESOURCE = `projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${SAFE_LIVE_MODEL_ID}`;
const LIVE_SOCKET_URL =
  'wss://us-central1-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent';

/** Leaves the configured project and selects another project's model. */
const TRAVERSAL_MODEL_ID =
  'gemini' +
  '/..'.repeat(9) +
  '/v1/projects/other-project/locations/europe-west4/publishers/google/models/gemini-2.5-pro';

/** Same traversal, with `-live` so the streaming entry point accepts it. */
const TRAVERSAL_LIVE_MODEL_ID =
  'gemini' +
  '/..'.repeat(9) +
  '/v1/projects/other-project/locations/europe-west4/publishers/google/models/gemini-2.5-flash-live';

type CapturedRequest = {
  method: string;
  url: string;
  authorization: string | null;
};

class RecordingWebSocket {
  static instances: RecordingWebSocket[] = [];

  sent: string[] = [];
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  constructor(
    readonly url: string | URL,
    readonly protocols?: string | string[],
    readonly options?: { headers?: Record<string, string | undefined> },
  ) {
    RecordingWebSocket.instances.push(this);
  }

  send(data: string | Uint8Array | ArrayBuffer) {
    this.sent.push(typeof data === 'string' ? data : '[binary]');
  }

  close() {
    this.readyState = 3;
  }

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
}

const recordingWebSocket =
  RecordingWebSocket as unknown as WebSocketConstructor;

function authorizationOf(
  headers: Record<string, string | undefined> | undefined,
): string | null {
  if (headers == null) return null;
  return headers.Authorization ?? headers.authorization ?? null;
}

function observedSockets() {
  return RecordingWebSocket.instances.map(socket => ({
    url: String(socket.url),
    authorization: authorizationOf(socket.options?.headers),
    sent: socket.sent,
  }));
}

function providerFor(baseURL: string) {
  return createGoogleVertex({
    project: PROJECT,
    location: LOCATION,
    baseURL,
    headers: { Authorization: PLACEHOLDER_AUTHORIZATION },
    webSocket: recordingWebSocket,
  });
}

function modelFor(modelId: string, baseURL: string) {
  return new GoogleVertexGeminiTranscriptionModel(modelId, {
    provider: 'google.vertex.transcription',
    baseURL,
    headers: { Authorization: PLACEHOLDER_AUTHORIZATION },
    webSocket: recordingWebSocket,
    project: PROJECT,
    location: LOCATION,
  });
}

async function listen(): Promise<{
  baseURL: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization ?? null,
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        }),
      );
    });
  });

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('local server did not bind a TCP port');
  }

  return {
    baseURL: `http://127.0.0.1:${address.port}${PUBLISHER_PATH}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        let settled = false;
        server.close(error => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

async function generate(
  modelId: string,
  baseURL: string,
  via: 'provider' | 'class',
) {
  const model =
    via === 'provider'
      ? providerFor(baseURL).transcription(modelId)
      : modelFor(modelId, baseURL);
  return model.doGenerate({
    audio: new Uint8Array([1, 2, 3, 4]),
    mediaType: 'audio/wav',
  });
}

async function openLive(
  modelId: string,
  baseURL: string,
  via: 'provider' | 'class',
) {
  const model =
    via === 'provider'
      ? providerFor(baseURL).transcription(modelId)
      : modelFor(modelId, baseURL);
  if (model.doStream == null) {
    throw new Error('transcription model does not implement doStream');
  }
  const result = await model.doStream({
    audio: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    inputAudioFormat: { type: 'audio/pcm', rate: 16000 },
  });
  for (const socket of RecordingWebSocket.instances) {
    socket.open();
  }
  await new Promise(resolve => setTimeout(resolve, 0));
  await result.stream.cancel();
  return result;
}

describe('Vertex Gemini transcription model id path', () => {
  let server: Awaited<ReturnType<typeof listen>> | undefined;

  afterEach(async () => {
    RecordingWebSocket.instances = [];
    if (server != null) {
      await server.close();
      server = undefined;
    }
  });

  async function start() {
    RecordingWebSocket.instances = [];
    server = await listen();
    return server;
  }

  it('keeps a single-segment model id on its generateContent path with the bearer token', async () => {
    const { baseURL, requests } = await start();

    const result = await generate(SAFE_MODEL_ID, baseURL, 'provider');

    expect(result.text).toBe('ok');
    expect(requests).toEqual([
      {
        method: 'POST',
        url: CANONICAL_GENERATE_PATH,
        authorization: PLACEHOLDER_AUTHORIZATION,
      },
    ]);
  });

  it.each([
    {
      name: 'dot segments that resolve outside the configured project',
      modelId: TRAVERSAL_MODEL_ID,
    },
    {
      name: 'percent-encoded dot segments',
      modelId:
        'gemini/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/other-model',
    },
    {
      name: 'uppercase percent-encoded dot segments',
      modelId:
        'gemini/%2E%2E/%2E%2E/%2E%2E/%2E%2E/%2E%2E/%2E%2E/%2E%2E/%2E%2E/other-model',
    },
    {
      name: 'backslash separators',
      modelId: 'gemini' + '\\..'.repeat(8) + '\\other-model',
    },
    {
      name: 'an extra path segment',
      modelId: 'gemini/other-model',
    },
    {
      name: 'a colon that changes the RPC method suffix',
      modelId: 'gemini-3.5-transcribe:predict',
    },
    {
      name: 'a fragment that drops the method suffix',
      modelId: 'gemini-3.5-transcribe#fragment',
    },
  ])(
    'does not issue a credentialed generateContent request for a model id with $name',
    async ({ modelId }) => {
      const { baseURL, requests } = await start();

      let error: unknown;
      try {
        await generate(modelId, baseURL, 'provider');
      } catch (caught) {
        error = caught;
      }

      expect(requests).toEqual([]);
      expect(error).toBeTruthy();
    },
  );

  it('does not issue a credentialed generateContent request when the model class is given a traversal id', async () => {
    const { baseURL, requests } = await start();
    const modelId =
      '../'.repeat(8) +
      'v1/projects/other-project/locations/europe-west4/publishers/google/models/gemini-2.5-pro';

    let error: unknown;
    try {
      await generate(modelId, baseURL, 'class');
    } catch (caught) {
      error = caught;
    }

    expect(requests).toEqual([]);
    expect(error).toBeTruthy();
  });

  it('sends a live model id as a single resource segment on the authenticated socket', async () => {
    const { baseURL } = await start();

    await openLive(SAFE_LIVE_MODEL_ID, baseURL, 'provider');

    expect(observedSockets()).toEqual([
      {
        url: LIVE_SOCKET_URL,
        authorization: PLACEHOLDER_AUTHORIZATION,
        sent: [
          JSON.stringify({
            setup: {
              model: CANONICAL_LIVE_RESOURCE,
              inputAudioTranscription: {},
            },
          }),
        ],
      },
    ]);
  });

  it.each([
    {
      name: 'dot segments',
      modelId: TRAVERSAL_LIVE_MODEL_ID,
    },
    {
      name: 'percent-encoded dot segments',
      modelId: 'gemini/%2e%2e/%2e%2e/%2e%2e/%2e%2e/other-live',
    },
    {
      name: 'backslash separators',
      modelId: 'gemini\\..\\..\\..\\..\\other-live',
    },
    {
      name: 'an extra path segment',
      modelId: 'gemini/other-model-live',
    },
  ])(
    'does not open an authenticated live session for a model id with $name',
    async ({ modelId }) => {
      const { baseURL } = await start();

      let error: unknown;
      try {
        await openLive(modelId, baseURL, 'provider');
      } catch (caught) {
        error = caught;
      }

      expect(observedSockets()).toEqual([]);
      expect(error).toBeTruthy();
    },
  );

  it('does not open an authenticated live session when the model class is given a traversal id', async () => {
    const { baseURL } = await start();
    const modelId =
      '../'.repeat(4) + 'publishers/google/models/gemini-3.5-transcribe-live';

    let error: unknown;
    try {
      await openLive(modelId, baseURL, 'class');
    } catch (caught) {
      error = caught;
    }

    expect(observedSockets()).toEqual([]);
    expect(error).toBeTruthy();
  });
});
