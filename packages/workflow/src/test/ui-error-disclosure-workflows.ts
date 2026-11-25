import { FatalError, getWritable } from 'workflow';
import { z } from 'zod/v4';
import { mockSequenceModel } from '../providers/mock.js';
import { WorkflowAgent } from '../workflow-agent.js';

export const durableModelErrorDetail =
  'server-only-durable-model-message-placeholder';
export const durableToolErrorDetail =
  'server-only-durable-tool-exception-placeholder';

async function throwToolError(): Promise<string> {
  'use step';
  throw new FatalError(durableToolErrorDetail);
}

export async function discloseDurableModelError() {
  'use workflow';
  const agent = new WorkflowAgent({
    model: mockSequenceModel([
      { type: 'error', error: new Error(durableModelErrorDetail) },
    ]),
  });
  await agent.stream({
    messages: [{ role: 'user', content: 'provoke a model failure' }],
    writable: getWritable(),
  });
}

export async function discloseDurableToolError() {
  'use workflow';
  const agent = new WorkflowAgent({
    model: mockSequenceModel([
      { type: 'tool-call', toolName: 'loadRecord', input: '{}' },
      { type: 'text', text: 'recovered' },
    ]),
    tools: {
      loadRecord: {
        description: 'Load a record',
        inputSchema: z.object({}),
        execute: throwToolError,
      },
    },
  });
  await agent.stream({
    messages: [{ role: 'user', content: 'load the record' }],
    writable: getWritable(),
  });
}
