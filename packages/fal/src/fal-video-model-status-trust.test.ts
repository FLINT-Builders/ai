import type { JSONValue } from '@ai-sdk/provider';
import {
  DownloadError,
  validateDownloadUrl,
  type FetchFunction,
} from '@ai-sdk/provider-utils';
import { describe, expect, it } from 'vitest';
import { createFal } from './fal-provider';

/**
 * Placeholder only. This is not a real fal credential.
 * A status check must not attach it to any host other than the queue origin.
 */
const PLACEHOLDER_API_KEY = 'placeholder-fal-key';

const QUEUE_ORIGIN = 'https://queue.fal.run';

const INTERNAL_BODY_MARKER = 'internal-body-marker';

type RecordedRequest = {
  url: string;
  headers: Headers;
};

function requestUrl(input: Parameters<FetchFunction>[0]): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function videoResponse(): Response {
  return new Response(
    JSON.stringify({
      video: {
        url: 'https://fal.media/files/video-output.mp4',
        content_type: 'video/mp4',
      },
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}

function internalResponse(): Response {
  // Shape accepted by the fal error handler, whose message is returned to the
  // caller. A blocked request must not surface this body.
  return new Response(
    JSON.stringify({
      error: { message: INTERNAL_BODY_MARKER, code: 1 },
    }),
    {
      status: 500,
      headers: { 'content-type': 'application/json' },
    },
  );
}

function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location },
  });
}

function leakedHeaderNames(request: RecordedRequest): string[] {
  const names: string[] = [];
  if (request.url.includes(PLACEHOLDER_API_KEY)) {
    names.push('url');
  }
  request.headers.forEach((value, name) => {
    if (value.includes(PLACEHOLDER_API_KEY)) {
      names.push(name);
    }
  });
  return names;
}

function carriesPlaceholder(request: RecordedRequest): boolean {
  return leakedHeaderNames(request).length > 0;
}

function isPrivateRequest(url: string): boolean {
  try {
    validateDownloadUrl(url);
    return false;
  } catch (error) {
    return DownloadError.isInstance(error);
  }
}

function visibleText(value: unknown): string {
  if (value instanceof Error) {
    const withBody = value as Error & {
      responseBody?: unknown;
      data?: unknown;
      cause?: unknown;
    };
    return JSON.stringify({
      name: withBody.name,
      message: withBody.message,
      responseBody: withBody.responseBody,
      data: withBody.data,
      cause:
        withBody.cause instanceof Error
          ? { name: withBody.cause.name, message: withBody.cause.message }
          : withBody.cause,
    });
  }
  return JSON.stringify(value);
}

async function invokeStatus({
  operation,
  onRequest,
}: {
  operation: JSONValue;
  onRequest: (url: string) => Response | Promise<Response>;
}): Promise<{
  requests: RecordedRequest[];
  visible: string;
}> {
  const requests: RecordedRequest[] = [];
  const fetch: FetchFunction = async (input, init) => {
    const url = requestUrl(input);
    requests.push({
      url,
      headers: new Headers(init?.headers),
    });
    return await onRequest(url);
  };

  const model = createFal({
    apiKey: PLACEHOLDER_API_KEY,
    fetch,
  }).video('luma-dream-machine');

  if (model.doStatus == null) {
    throw new Error('fal video model does not implement doStatus');
  }

  let result: unknown;
  let error: unknown;
  try {
    result = await model.doStatus({ operation });
  } catch (caught) {
    error = caught;
  }

  return {
    requests,
    visible: `${visibleText(result)}\n${visibleText(error)}`,
  };
}

describe('fal video status trust', () => {
  it.each([
    {
      name: 'attacker origin on both operation urls',
      operation: {
        responseUrl: 'https://attacker.example/status',
        submitUrl: 'https://attacker.example/',
      },
    },
    {
      name: 'host that only shares a queue.fal.run prefix',
      operation: {
        responseUrl: 'https://queue.fal.run.attacker.example/status',
        submitUrl: 'https://queue.fal.run.attacker.example/',
      },
    },
    {
      name: 'userinfo that makes a prefix check see the queue host',
      operation: {
        responseUrl: 'https://queue.fal.run@attacker.example/status',
        submitUrl: 'https://attacker.example/',
      },
    },
    {
      name: 'response url only, with submit url omitted',
      operation: {
        responseUrl: 'https://attacker.example/status',
      },
    },
  ])('does not send the fal api key for $name', async ({ operation }) => {
    const { requests } = await invokeStatus({
      operation,
      onRequest: () => videoResponse(),
    });

    expect(requests.flatMap(leakedHeaderNames)).toEqual([]);
  });

  it('sends the fal api key to the queue origin when submitUrl points elsewhere', async () => {
    const { requests } = await invokeStatus({
      operation: {
        responseUrl:
          'https://queue.fal.run/fal-ai/luma-dream-machine/requests/job-1',
        submitUrl: 'https://attacker.example/',
      },
      onRequest: () => videoResponse(),
    });

    expect(requests.map(request => new URL(request.url).origin)).toEqual([
      QUEUE_ORIGIN,
    ]);
    expect(requests.every(carriesPlaceholder)).toBe(true);
  });

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1/',
    'http://0.0.0.0/',
    'http://10.1.2.3/latest',
    'http://192.168.1.1/',
    'http://172.16.0.5/',
    'http://localhost/latest/meta-data/',
    'http://[::1]/',
    'http://[::ffff:169.254.169.254]/latest/meta-data/',
    'http://[fc00::1]/',
    'http://[fe80::1]/',
    'https://queue.fal.run@169.254.169.254/latest/meta-data/',
  ])(
    'does not request %s when the operation names that origin',
    async target => {
      const { requests, visible } = await invokeStatus({
        operation: {
          responseUrl: target,
          submitUrl: new URL(target).origin,
        },
        onRequest: () => internalResponse(),
      });

      expect(
        requests
          .filter(request => isPrivateRequest(request.url))
          .map(request => request.url),
      ).toEqual([]);
      expect(requests.flatMap(leakedHeaderNames)).toEqual([]);
      expect(visible).not.toContain(INTERNAL_BODY_MARKER);
    },
  );

  it('does not follow an operation redirect onto a link-local address', async () => {
    const metadataUrl = 'http://169.254.169.254/latest/meta-data/';
    const { requests, visible } = await invokeStatus({
      operation: {
        responseUrl: 'https://attacker.example/redirect',
        submitUrl: new URL(metadataUrl).origin,
      },
      onRequest: url => {
        if (isPrivateRequest(url)) {
          return internalResponse();
        }
        return redirectResponse(metadataUrl);
      },
    });

    expect(
      requests
        .filter(request => isPrivateRequest(request.url))
        .map(request => request.url),
    ).toEqual([]);
    expect(requests.flatMap(leakedHeaderNames)).toEqual([]);
    expect(visible).not.toContain(INTERNAL_BODY_MARKER);
  });

  it('does not keep the fal api key on a same-origin redirect supplied by the operation', async () => {
    const { requests } = await invokeStatus({
      operation: {
        responseUrl: 'https://attacker.example/start',
        submitUrl: 'https://attacker.example/',
      },
      onRequest: url => {
        if (url === 'https://attacker.example/start') {
          return redirectResponse('https://attacker.example/next');
        }
        return videoResponse();
      },
    });

    expect(requests.flatMap(leakedHeaderNames)).toEqual([]);
  });
});
