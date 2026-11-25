import { createUIMessageStreamResponse, type UIMessageChunk } from 'ai';
import { describe, expect, it } from 'vitest';
import { start } from 'workflow/api';
import {
  discloseDurableModelError,
  discloseDurableToolError,
  durableModelErrorDetail,
  durableToolErrorDetail,
} from './test/ui-error-disclosure-workflows.js';
import { createModelCallToUIChunkTransform } from './to-ui-message-chunk.js';

const GENERIC_ERROR_TEXT = 'An error occurred.';

function uiChunks(sse: string): UIMessageChunk[] {
  return sse
    .split('\n\n')
    .map(block => block.trim())
    .filter(block => block.startsWith('data: ') && block !== 'data: [DONE]')
    .map(block => JSON.parse(block.slice('data: '.length)) as UIMessageChunk);
}

async function chatBody(
  workflow: typeof discloseDurableModelError,
): Promise<string> {
  const run = await start(workflow, []);
  const body = createUIMessageStreamResponse({
    stream: run.readable.pipeThrough(createModelCallToUIChunkTransform()),
  }).text();
  await run.returnValue;
  return body;
}

describe('durable workflow chat error disclosure', () => {
  it('masks a model error after the durable stream round trip', async () => {
    const chunks = uiChunks(await chatBody(discloseDurableModelError));
    const errors = chunks.filter(chunk => chunk.type === 'error');

    expect(errors).toEqual([{ type: 'error', errorText: GENERIC_ERROR_TEXT }]);
    expect(JSON.stringify(chunks)).not.toContain(durableModelErrorDetail);
  });

  it('masks a thrown server tool error after the durable stream round trip', async () => {
    const chunks = uiChunks(await chatBody(discloseDurableToolError));
    const toolErrors = chunks.filter(
      chunk => chunk.type === 'tool-output-error',
    );

    expect(toolErrors.length).toBeGreaterThan(0);
    expect(toolErrors).toEqual(
      toolErrors.map(() => ({
        type: 'tool-output-error',
        toolCallId: 'call-1',
        errorText: GENERIC_ERROR_TEXT,
      })),
    );
    expect(JSON.stringify(chunks)).not.toContain(durableToolErrorDetail);
  });
});
