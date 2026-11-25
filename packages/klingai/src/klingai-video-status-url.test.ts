import { describe, expect, it } from 'vitest';
import { KlingAIVideoModel } from './klingai-video-model';

const BASE_URL = 'https://api-singapore.klingai.com';
const API_TOKEN = 'test-api-token';
const TASK_ID = 'task-1';
const ALLOWED_PATH = `/v1/videos/text2video/${encodeURIComponent(TASK_ID)}`;

type CapturedRequest = {
  url: string;
  authorization: string | null;
};

function createModel(requests: CapturedRequest[]) {
  return new KlingAIVideoModel('kling-v1-t2v', {
    provider: 'klingai.video',
    baseURL: BASE_URL,
    headers: () => ({ Authorization: `Bearer ${API_TOKEN}` }),
    fetch: async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      requests.push({
        url,
        authorization:
          init?.headers == null
            ? null
            : new Headers(init.headers).get('authorization'),
      });
      return Response.json({ code: 0, data: { task_status: 'submitted' } });
    },
  });
}

describe('KlingAI video status path', () => {
  it('does not request a caller-supplied endpoint path with the api token', async () => {
    const requests: CapturedRequest[] = [];
    const model = createModel(requests);

    await model
      .doStatus({
        operation: { taskId: TASK_ID, endpointPath: '/v1/account' },
      })
      .catch(() => undefined);

    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).pathname).toBe(ALLOWED_PATH);
    expect(requests[0].authorization).toBe(`Bearer ${API_TOKEN}`);
    expect(requests[0].url).not.toContain('/account');
  });

  it('keeps a task id with a slash inside one encoded path segment', async () => {
    const requests: CapturedRequest[] = [];
    const model = createModel(requests);
    const taskId = '../secret';

    await model
      .doStatus({
        operation: {
          taskId,
          endpointPath: '/v1/videos/text2video',
        },
      })
      .catch(() => undefined);

    expect(requests).toHaveLength(1);
    const parsed = new URL(requests[0].url);
    expect(parsed.pathname).toBe(
      `/v1/videos/text2video/${encodeURIComponent(taskId)}`,
    );
    expect(parsed.pathname).not.toBe('/v1/secret');
    expect(requests[0].authorization).toBe(`Bearer ${API_TOKEN}`);
  });

  it('uses the model endpoint and the first task id when operation fields change between reads', async () => {
    const requests: CapturedRequest[] = [];
    const model = createModel(requests);
    const taskId = '../secret';
    let taskReads = 0;
    const operation = {
      get taskId() {
        taskReads += 1;
        return taskReads === 1 ? taskId : '../../account';
      },
      get endpointPath() {
        return '/v1/account';
      },
    };

    await model.doStatus({ operation }).catch(() => undefined);

    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).pathname).toBe(
      `/v1/videos/text2video/${encodeURIComponent(taskId)}`,
    );
    expect(requests[0].url).not.toContain('/account');
  });
});
