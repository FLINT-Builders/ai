import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadableStream } from 'node:stream/web';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGoogleVertexAnthropic } from './anthropic/google-vertex-anthropic-provider-node';
import { createGoogleVertexMaas } from './maas/google-vertex-maas-provider-node';
import { createGoogleVertex } from './google-vertex-provider';

// These tests are the spec for the region host injection. They fail while a
// caller-supplied location or Speech-to-Text region can move the request host
// and still carry the provider credential. They pass once every host builder
// rejects that value before any credentialed request is made.
//
// The token below is an obvious placeholder. The auth client is returned by
// google-auth-library as the configured client and is not a Google credential.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.GOOGLE_VERTEX_API_KEY;
delete process.env.GOOGLE_VERTEX_LOCATION;
delete process.env.GOOGLE_VERTEX_PROJECT;

const PLACEHOLDER_TOKEN = 'placeholder-token';

const authClient = {
  async getAccessToken() {
    return { token: PLACEHOLDER_TOKEN };
  },
};

const prompt = [
  {
    role: 'user' as const,
    content: [{ type: 'text' as const, text: 'Hello' }],
  },
];

type Capture = {
  hostname: string;
  authorization: boolean;
  apiKey: boolean;
};

const httpCaptures: Capture[] = [];
const socketCaptures: Capture[] = [];

let server: Server;
let port = 0;
let certificateDirectory: string;

function regionWith(delimiter: '?' | '#' | '\\'): string {
  return `127.0.0.1:${port}${delimiter}`;
}

function googleHost(hostname: string): boolean {
  return hostname === 'googleapis.com' || hostname.endsWith('.googleapis.com');
}

function leaks(records: Capture[]): Capture[] {
  return records.filter(
    record =>
      (record.authorization || record.apiKey) && !googleHost(record.hostname),
  );
}

function vertexSettings(location: string) {
  return {
    project: 'test-project',
    location,
    googleAuthOptions: { authClient: authClient as never },
  };
}

class RecordingSocket {
  readyState = 0;
  bufferedAmount = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  constructor(
    url: string | URL,
    _protocols?: string | string[],
    options?: { headers?: Record<string, string | undefined> },
  ) {
    const headers = options?.headers ?? {};
    socketCaptures.push({
      hostname: new URL(url).hostname,
      authorization:
        headers.Authorization != null || headers.authorization != null,
      apiKey: headers['x-goog-api-key'] != null,
    });
  }

  send(_data: string | Uint8Array | ArrayBuffer) {}

  close() {
    this.readyState = 3;
  }
}

async function expectRejectedWithoutCredentialLeak(
  run: () => Promise<unknown>,
): Promise<void> {
  const httpStart = httpCaptures.length;
  const socketStart = socketCaptures.length;
  let thrown = false;

  try {
    const result = await run();
    const stream = (result as { stream?: { cancel?: () => Promise<void> } })
      ?.stream;
    if (stream?.cancel != null) {
      await stream.cancel();
    }
  } catch {
    thrown = true;
  }

  const sent = [
    ...leaks(httpCaptures.slice(httpStart)),
    ...leaks(socketCaptures.slice(socketStart)),
  ];
  expect(sent).toEqual([]);
  expect(thrown).toBe(true);
}

beforeAll(async () => {
  certificateDirectory = mkdtempSync(join(tmpdir(), 'vertex-region-'));
  const keyPath = join(certificateDirectory, 'key.pem');
  const certPath = join(certificateDirectory, 'cert.pem');
  const generated = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-nodes',
      '-subj',
      '/CN=127.0.0.1',
    ],
    { encoding: 'utf8' },
  );
  if (generated.status !== 0) {
    throw new Error(generated.stderr || 'openssl failed');
  }

  server = createServer(
    {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
    },
    (request, response) => {
      httpCaptures.push({
        hostname: (request.headers.host ?? '').split(':')[0] ?? '',
        authorization: request.headers.authorization != null,
        apiKey: request.headers['x-goog-api-key'] != null,
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    },
  );

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('test server did not bind');
  }
  port = address.port;
});

afterAll(async () => {
  if (server.listening) {
    await new Promise<void>(resolve => {
      server.close(() => resolve());
    });
  }
  rmSync(certificateDirectory, { recursive: true, force: true });
});

describe('caller-supplied Vertex location', () => {
  it('rejects a question mark in the chat location before sending the bearer token', async () => {
    const provider = createGoogleVertex(vertexSettings(regionWith('?')));

    await expectRejectedWithoutCredentialLeak(() =>
      provider('gemini-2.5-flash').doGenerate({ prompt }),
    );
  });

  it('rejects a hash in the chat location before sending the bearer token', async () => {
    const provider = createGoogleVertex(vertexSettings(regionWith('#')));

    await expectRejectedWithoutCredentialLeak(() =>
      provider('gemini-2.5-flash').doGenerate({ prompt }),
    );
  });

  it('rejects a backslash in the chat location before sending the bearer token', async () => {
    const provider = createGoogleVertex(vertexSettings(regionWith('\\')));

    await expectRejectedWithoutCredentialLeak(() =>
      provider('gemini-2.5-flash').doGenerate({ prompt }),
    );
  });

  it('rejects a question mark in a tuned-endpoint location before sending the bearer token', async () => {
    const provider = createGoogleVertex(vertexSettings(regionWith('?')));

    await expectRejectedWithoutCredentialLeak(() =>
      provider('endpoints/123').doGenerate({ prompt }),
    );
  });

  it('rejects a question mark in the interactions location before sending the bearer token', async () => {
    const provider = createGoogleVertex(vertexSettings(regionWith('?')));

    await expectRejectedWithoutCredentialLeak(() =>
      provider.interactions('gemini-omni-flash-preview').doGenerate({ prompt }),
    );
  });

  it('rejects a question mark in the embedding location before sending the bearer token', async () => {
    const provider = createGoogleVertex(vertexSettings(regionWith('?')));

    await expectRejectedWithoutCredentialLeak(() =>
      provider.embeddingModel('gemini-embedding-2').doEmbed({
        values: ['hello'],
      }),
    );
  });

  it('rejects a question mark in the predict embedding location before sending the bearer token', async () => {
    const provider = createGoogleVertex(vertexSettings(regionWith('?')));

    await expectRejectedWithoutCredentialLeak(() =>
      provider.embeddingModel('text-embedding-004').doEmbed({
        values: ['hello'],
      }),
    );
  });

  it('rejects a question mark in the image location before sending the bearer token', async () => {
    const provider = createGoogleVertex(vertexSettings(regionWith('?')));

    await expectRejectedWithoutCredentialLeak(() =>
      provider.imageModel('gemini-2.5-flash-image').doGenerate({
        prompt: 'a red square',
        n: 1,
      }),
    );
  });

  it('rejects a question mark in the speech location before sending the bearer token', async () => {
    const provider = createGoogleVertex(vertexSettings(regionWith('?')));

    await expectRejectedWithoutCredentialLeak(() =>
      provider.speechModel('gemini-2.5-flash-tts').doGenerate({
        text: 'hello',
      }),
    );
  });

  it('rejects a question mark in the video location before sending the bearer token', async () => {
    const provider = createGoogleVertex(vertexSettings(regionWith('?')));

    await expectRejectedWithoutCredentialLeak(() =>
      provider.videoModel('veo-2.0-generate-001').doStart!({
        prompt: 'a red square',
        n: 1,
      }),
    );
  });

  it('rejects a question mark in the Gemini transcription location before sending the bearer token', async () => {
    const provider = createGoogleVertex(vertexSettings(regionWith('?')));

    await expectRejectedWithoutCredentialLeak(() =>
      provider.transcription('gemini-3.5-transcribe').doGenerate({
        audio: new Uint8Array([1, 2, 3, 4]),
        mediaType: 'audio/wav',
      }),
    );
  });

  it('rejects a question mark in the live transcription location before opening a credentialed socket', async () => {
    const provider = createGoogleVertex({
      ...vertexSettings(regionWith('?')),
      webSocket: RecordingSocket,
    });

    await expectRejectedWithoutCredentialLeak(() =>
      provider.transcription('gemini-3.5-transcribe-live').doStream!({
        audio: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        inputAudioFormat: { type: 'audio/pcm', rate: 16000 },
      }),
    );
  });

  it('still requests a normal region on the Google host', async () => {
    const calls: string[] = [];
    const provider = createGoogleVertex({
      ...vertexSettings('us-central1'),
      fetch: async (url, init) => {
        calls.push(String(url));
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBe(
          `Bearer ${PLACEHOLDER_TOKEN}`,
        );
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: { parts: [{ text: 'ok' }], role: 'model' },
                finishReason: 'STOP',
                index: 0,
              },
            ],
            usageMetadata: {
              promptTokenCount: 1,
              candidatesTokenCount: 1,
              totalTokenCount: 2,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    await provider('gemini-2.5-flash').doGenerate({ prompt });

    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]).hostname).toBe(
      'us-central1-aiplatform.googleapis.com',
    );
  });
});

describe('caller-supplied Speech-to-Text region', () => {
  function transcriptionModel() {
    return createGoogleVertex(vertexSettings('us-central1')).transcription(
      'chirp_3',
    );
  }

  const audio = new Uint8Array([1, 2, 3, 4]);

  it('rejects a question mark in googleVertex.region before sending the bearer token', async () => {
    await expectRejectedWithoutCredentialLeak(() =>
      transcriptionModel().doGenerate({
        audio,
        mediaType: 'audio/wav',
        providerOptions: {
          googleVertex: { region: regionWith('?') },
        },
      }),
    );
  });

  it('rejects a hash in vertex.region before sending the bearer token', async () => {
    await expectRejectedWithoutCredentialLeak(() =>
      transcriptionModel().doGenerate({
        audio,
        mediaType: 'audio/wav',
        providerOptions: {
          vertex: { region: regionWith('#') },
        },
      }),
    );
  });

  it('rejects a backslash in google.region before sending the bearer token', async () => {
    await expectRejectedWithoutCredentialLeak(() =>
      transcriptionModel().doGenerate({
        audio,
        mediaType: 'audio/wav',
        providerOptions: {
          google: { region: regionWith('\\') },
        },
      }),
    );
  });

  it('rejects a question mark in the provider location used as the Speech-to-Text default', async () => {
    const model = createGoogleVertex(
      vertexSettings(regionWith('?')),
    ).transcription('chirp_3');

    await expectRejectedWithoutCredentialLeak(() =>
      model.doGenerate({
        audio,
        mediaType: 'audio/wav',
      }),
    );
  });
});

describe('caller-supplied Anthropic and MaaS locations', () => {
  it('rejects a hash in the Anthropic location before sending the bearer token', async () => {
    const provider = createGoogleVertexAnthropic({
      project: 'test-project',
      location: regionWith('#'),
      googleAuthOptions: { authClient: authClient as never },
    });

    await expectRejectedWithoutCredentialLeak(() =>
      provider('claude-sonnet-4').doGenerate({ prompt }),
    );
  });

  it('rejects a backslash in the MaaS location before sending the bearer token', async () => {
    const provider = createGoogleVertexMaas({
      project: 'test-project',
      location: regionWith('\\'),
      googleAuthOptions: { authClient: authClient as never },
    });

    await expectRejectedWithoutCredentialLeak(() =>
      provider('meta/llama-4-scout-17b-16e-instruct-maas').doGenerate({
        prompt,
      }),
    );
  });

  it('rejects a question mark in the MaaS location before sending the bearer token', async () => {
    const provider = createGoogleVertexMaas({
      project: 'test-project',
      location: regionWith('?'),
      googleAuthOptions: { authClient: authClient as never },
    });

    await expectRejectedWithoutCredentialLeak(() =>
      provider('meta/llama-4-scout-17b-16e-instruct-maas').doGenerate({
        prompt,
      }),
    );
  });
});
