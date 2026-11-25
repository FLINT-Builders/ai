import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FireworksImageModel } from './fireworks-image-model';
import { createFireworks } from './fireworks-provider';

/**
 * These tests are the spec for the Fireworks image model id path injection.
 * They fail while a caller-supplied model id can change the path of an
 * authenticated POST. They pass once that id is rejected before any request
 * is sent, while ordinary Fireworks model ids still generate images.
 *
 * getPollUrlForModel is not exercised: doGenerate only builds the poll URL
 * after an exact match on a built-in async model id, so a caller-supplied id
 * never reaches it.
 */

const PLACEHOLDER_API_KEY = 'test-placeholder-key';
const ACCOUNT_BODY = new TextEncoder().encode(
  'account-control-plane-response-body',
);
const IMAGE_BODY = new TextEncoder().encode('legitimate-image-bytes');

// Paths a model id is allowed to select. Anything else is another endpoint
// on the configured host, including the account control plane.
const allowedImagePath =
  /^\/inference\/v1\/(?:workflows|image_generation)\/accounts\/[A-Za-z0-9_-]+\/models\/[A-Za-z0-9._-]+(?:\/(?:text_to_image|get_result))?$/;

type RecordedRequest = {
  method: string;
  pathname: string;
  search: string;
  authorization: string | undefined;
};

type NodeHttp = {
  createServer: (
    requestListener: (
      request: IncomingMessage,
      response: ServerResponse,
    ) => void,
  ) => Server;
};

const nodeHttp: NodeHttp | undefined = (
  globalThis as {
    process?: { getBuiltinModule?: (name: string) => NodeHttp | undefined };
  }
).process?.getBuiltinModule?.('node:http');

describe.runIf(nodeHttp != null)(
  'Fireworks image model id path injection',
  () => {
    const http = nodeHttp as NodeHttp;
    let baseURL = '';
    let server: Server;
    const requests: RecordedRequest[] = [];

    beforeAll(async () => {
      server = http.createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(chunk as Buffer);
        }
        void Buffer.concat(chunks);

        const host = request.headers.host ?? '127.0.0.1';
        const url = new URL(request.url ?? '/', `http://${host}`);
        const authorization = request.headers.authorization;
        requests.push({
          method: request.method ?? '',
          pathname: url.pathname,
          search: url.search,
          authorization: Array.isArray(authorization)
            ? authorization[0]
            : authorization,
        });

        if (allowedImagePath.test(url.pathname)) {
          response.writeHead(200, {
            'content-type': 'application/octet-stream',
          });
          response.end(IMAGE_BODY);
          return;
        }

        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(ACCOUNT_BODY);
      });

      await new Promise<void>(resolve => {
        server.listen(0, '127.0.0.1', () => resolve());
      });
      const address = server.address();
      if (address == null || typeof address === 'string') {
        throw new Error('test server did not bind to a port');
      }
      baseURL = `http://127.0.0.1:${address.port}/inference/v1`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    });

    async function generateWith(
      modelId: string,
      entry: 'image' | 'imageModel',
    ) {
      requests.length = 0;
      const provider = createFireworks({
        apiKey: PLACEHOLDER_API_KEY,
        baseURL,
        fetch: globalThis.fetch,
      });
      const model = provider[entry](modelId) as FireworksImageModel;
      try {
        const result = await model.doGenerate({
          prompt: 'a red square',
          n: 1,
          size: undefined,
          aspectRatio: undefined,
          seed: undefined,
          files: undefined,
          mask: undefined,
          providerOptions: {},
        });
        return { status: 'fulfilled' as const, images: result.images };
      } catch (error) {
        return { status: 'rejected' as const, error };
      }
    }

    function isAccountBody(image: Uint8Array | string): boolean {
      const bytes =
        typeof image === 'string' ? Buffer.from(image) : Buffer.from(image);
      return bytes.equals(Buffer.from(ACCOUNT_BODY));
    }

    function expectNoEscapedRequest(outcome: {
      status: 'fulfilled' | 'rejected';
      images?: Array<Uint8Array | string>;
    }) {
      const escaped = requests.filter(
        request => !allowedImagePath.test(request.pathname),
      );
      const returnedAccountBody =
        outcome.images?.some(image => isAccountBody(image)) ?? false;
      expect({
        escaped,
        status: outcome.status,
        returnedAccountBody,
      }).toEqual({
        escaped: [],
        status: 'rejected',
        returnedAccountBody: false,
      });
    }

    it.each([
      ['image', '../../../v1/accounts/acct/endpoint?'],
      ['imageModel', '../../../v1/accounts/acct/endpoint?'],
      ['image', '../../v1/accounts/acct/endpoint?'],
      ['image', '%2e%2e/%2e%2e/%2e%2e/v1/accounts/acct/endpoint?'],
      ['image', '..\\..\\..\\v1\\accounts\\acct\\endpoint?'],
      [
        'image',
        'accounts/acct/models/name/../../../../../../../v1/accounts/acct/endpoint?',
      ],
    ] as const)(
      'rejects %s model id %j before an authenticated request leaves the image API',
      async (entry, modelId) => {
        const outcome = await generateWith(modelId, entry);
        expectNoEscapedRequest(outcome);
      },
    );

    it('does not request the default Fireworks host with a rewritten model id', async () => {
      const captured: Array<{
        href: string;
        pathname: string;
        search: string;
        authorization: string | null;
      }> = [];
      const provider = createFireworks({
        apiKey: PLACEHOLDER_API_KEY,
        fetch: async (input, init) => {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;
          // Same parser Node fetch uses before it writes pathname + search.
          const parsed = new URL(url);
          const headers = new Headers(init?.headers);
          captured.push({
            href: parsed.href,
            pathname: parsed.pathname,
            search: parsed.search,
            authorization: headers.get('authorization'),
          });
          return new Response(ACCOUNT_BODY, { status: 200 });
        },
      });

      const outcome = await provider
        .image('../../../v1/accounts/acct/endpoint?')
        .doGenerate({
          prompt: 'a red square',
          n: 1,
          size: undefined,
          aspectRatio: undefined,
          seed: undefined,
          files: undefined,
          mask: undefined,
          providerOptions: {},
        })
        .then(
          result => ({ status: 'fulfilled' as const, images: result.images }),
          () => ({ status: 'rejected' as const, images: [] }),
        );

      const returnedAccountBody = outcome.images.some(image =>
        isAccountBody(image),
      );
      expect({
        captured,
        status: outcome.status,
        returnedAccountBody,
      }).toEqual({
        captured: [],
        status: 'rejected',
        returnedAccountBody: false,
      });
    });

    it('still generates with a custom model id that is a single accounts/models path', async () => {
      const outcome = await generateWith(
        'accounts/my-org/models/my-model',
        'image',
      );
      expect(outcome.status).toBe('fulfilled');
      if (outcome.status === 'fulfilled') {
        expect(Buffer.from(outcome.images[0])).toEqual(Buffer.from(IMAGE_BODY));
      }
      expect(requests.map(request => request.pathname)).toEqual([
        '/inference/v1/workflows/accounts/my-org/models/my-model/text_to_image',
      ]);
      expect(requests[0]?.authorization).toBe(`Bearer ${PLACEHOLDER_API_KEY}`);
      expect(requests[0]?.method).toBe('POST');
    });

    it('still generates with a built-in image_generation model id', async () => {
      const outcome = await generateWith(
        'accounts/fireworks/models/playground-v2-5-1024px-aesthetic',
        'imageModel',
      );
      expect(outcome.status).toBe('fulfilled');
      if (outcome.status === 'fulfilled') {
        expect(Buffer.from(outcome.images[0])).toEqual(Buffer.from(IMAGE_BODY));
      }
      expect(requests.map(request => request.pathname)).toEqual([
        '/inference/v1/image_generation/accounts/fireworks/models/playground-v2-5-1024px-aesthetic',
      ]);
    });
  },
);
