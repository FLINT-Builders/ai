/**
 * Child process for the content-encoding denial-of-service regression.
 *
 * The parent test expects this process to stay alive after the download
 * rejection. Undici 7.29.0 rejects fetch() and then emits an unhandled
 * ResponseContentLengthMismatchError, which terminates the process.
 */
import net from 'node:net';

const HOST = '192.0.3.10';
const ENTRY = process.argv[2];

const responseHeader =
  'HTTP/1.1 200 OK\r\n' +
  'Content-Type: application/octet-stream\r\n' +
  'Content-Encoding: gzip, gzip, gzip, gzip, gzip, gzip\r\n' +
  'Content-Length: 10\r\n' +
  'Connection: close\r\n' +
  '\r\n';

function errorChain(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current != null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const record = current as {
      name?: string;
      code?: string;
      message?: string;
      cause?: unknown;
    };
    const name = record.name ?? 'Error';
    const code = record.code == null ? '' : ` ${String(record.code)}`;
    parts.push(`${name}${code}: ${record.message ?? ''}`);
    current = record.cause;
  }

  return parts.join(' | ');
}

function listen(): Promise<{
  url: string;
  served: () => number;
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    let hits = 0;
    const server = net.createServer(socket => {
      hits += 1;
      socket.write(responseHeader);
      socket.destroy();
    });

    server.once('error', reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (address == null || typeof address === 'string') {
        reject(new Error('Expected a TCP listener'));
        return;
      }

      resolve({
        url: `http://${HOST}:${address.port}/file`,
        served: () => hits,
        close: () =>
          new Promise((done, fail) => {
            server.close(error => {
              if (error) {
                fail(error);
                return;
              }
              done();
            });
          }),
      });
    });
  });
}

async function run(url: string): Promise<void> {
  switch (ENTRY) {
    case 'redirects': {
      const { fetchWithValidatedRedirects } =
        await import('../packages/provider-utils/src/fetch-with-validated-redirects.ts');
      await fetchWithValidatedRedirects({ url });
      return;
    }
    case 'endpoint': {
      const { fetchWithValidatedEndpoint } =
        await import('../packages/provider-utils/src/fetch-with-validated-redirects.ts');
      await fetchWithValidatedEndpoint({ url });
      return;
    }
    case 'download-blob': {
      const { downloadBlob } =
        await import('../packages/provider-utils/src/download-blob.ts');
      await downloadBlob(url);
      return;
    }
    case 'get-from-api': {
      const { getFromApi } =
        await import('../packages/provider-utils/src/get-from-api.ts');
      await getFromApi({
        url,
        validateUrl: true,
        successfulResponseHandler: async ({ response }) => {
          await response.arrayBuffer();
          return null;
        },
        failedResponseHandler: async () => ({
          value: new Error('error response'),
        }),
      });
      return;
    }
    case 'ai-download': {
      const { download } =
        await import('../packages/ai/src/util/download/download.ts');
      await download({ url: new URL(url) });
      return;
    }
    case 'ai-prompt-download': {
      const { convertToLanguageModelPrompt } =
        await import('../packages/ai/src/prompt/convert-to-language-model-prompt.ts');
      await convertToLanguageModelPrompt({
        prompt: {
          instructions: undefined,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  image: new URL(url),
                },
              ],
            },
          ],
        },
        supportedUrls: {},
        download: undefined,
      });
      return;
    }
    case 'ai-prompt-other-media': {
      const { convertToLanguageModelPrompt } =
        await import('../packages/ai/src/prompt/convert-to-language-model-prompt.ts');
      await convertToLanguageModelPrompt({
        prompt: {
          instructions: undefined,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'file',
                  data: new URL(url),
                  mediaType: 'application/pdf',
                },
              ],
            },
          ],
        },
        supportedUrls: {
          'image/*': [/^https?:\/\/.*$/],
        },
        download: undefined,
      });
      return;
    }
    case 'google-tool-result': {
      const { downloadToolResultFiles } =
        await import('../packages/google/src/download-tool-result-files.ts');
      await downloadToolResultFiles(
        [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'call-1',
                toolName: 'attachment',
                output: {
                  type: 'content',
                  value: [
                    {
                      type: 'file',
                      mediaType: 'application/octet-stream',
                      data: { type: 'url', url: new URL(url) },
                    },
                  ],
                },
              },
            ],
          },
        ],
        { abortSignal: undefined, maxBytes: 1024 },
      );
      return;
    }
    case 'mcp-metadata': {
      const { discoverAuthorizationServerMetadata } =
        await import('../packages/mcp/src/tool/oauth.ts');
      const metadata = await discoverAuthorizationServerMetadata(
        new URL(url).origin,
      );
      console.log(`METADATA ${metadata == null ? 'undefined' : 'present'}`);
      return;
    }
    default: {
      throw new Error(`Unknown entry ${ENTRY ?? ''}`);
    }
  }
}

async function main(): Promise<void> {
  const listener = await listen();

  try {
    await run(listener.url);
    console.log('CAUGHT none');
  } catch (error) {
    console.log(`CAUGHT ${errorChain(error)}`);
  }

  await new Promise(resolve => {
    setTimeout(resolve, 750);
  });

  const served = listener.served();
  console.log(`SERVED ${served}`);
  if (served < 1) {
    process.exitCode = 1;
  } else {
    console.log('SURVIVED');
  }

  await listener.close();
}

void main();
