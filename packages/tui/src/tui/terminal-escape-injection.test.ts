import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { TextStreamPart, ToolSet, UIMessageChunk } from 'ai';
import { AgentTUIRunner } from '../agent-tui-runner';
import type { AgentTUIAgent } from '../run-agent-tui';
import {
  TerminalRenderer,
  type TerminalInput,
  type TerminalOutput,
  type TerminalSessionOptions,
} from './terminal-renderer';

/**
 * Untrusted assistant, reasoning, tool, and error text must not reach the
 * terminal as raw C0/C1 controls. These tests fail until that text is
 * sanitized before it is written.
 */

const osc52 = '\u001b]52;c;MARKER\u0007';
const osc8 =
  '\u001b]8;;http://evil.example/hook\u0007visible-link\u001b]8;;\u0007';
const cursorUp = '\u001b[2A';
const clearToStart = '\u001b[1K';
const deviceControl = '\u001bP';
const c1Csi = '\u009b';
const controlsBesideText = `${osc52}\u0000\u0007\u0008\r\u007f${c1Csi}`;

describe('terminal escape injection', () => {
  it('does not write assistant text controls to the terminal', async () => {
    const output = await renderChunks(
      textChunk(`visible-assistant ${controlsBesideText}`),
    );

    expectSafeTerminalText(output.text(), 'visible-assistant');
  });

  it('does not write assistant markdown table cells with controls', async () => {
    const output = await renderChunks(
      textChunk(
        [
          '| visible-table | detail |',
          '| --- | --- |',
          `| ${osc52}cell | ok |`,
        ].join('\n'),
      ),
    );

    expectSafeTerminalText(output.text(), 'visible-table');
  });

  it('does not write reasoning text controls to the terminal', async () => {
    const output = await renderChunks(
      reasoningChunk(`visible-reasoning ${osc8}`),
      { reasoning: 'full' },
    );

    expectSafeTerminalText(output.text(), 'visible-reasoning');
  });

  it('does not write string tool outputs to the terminal', async () => {
    const output = await renderChunks(
      [
        toolInputChunk({
          toolCallId: 'call-output',
          toolName: 'fetch',
          input: { url: 'http://example.test/page' },
        }),
        {
          type: 'tool-output-available',
          toolCallId: 'call-output',
          output: `visible-tool-output ${osc52}`,
        },
      ],
      { tools: 'full' },
    );

    expectSafeTerminalText(output.text(), 'visible-tool-output');
  });

  it('writes string tool output before a later part collapses the tool section', async () => {
    const output = await renderChunks(
      [
        toolInputChunk({
          toolCallId: 'call-collapsed',
          toolName: 'fetch',
          input: { url: 'http://example.test/page' },
        }),
        {
          type: 'tool-output-available',
          toolCallId: 'call-collapsed',
          output: `visible-collapsed-output ${osc52}`,
        },
        ...textChunk('visible-after-tool'),
      ],
      { tools: 'auto-collapsed' },
    );

    expectSafeTerminalText(output.text(), 'visible-after-tool');
    expect(output.text()).not.toContain(osc52);
  });

  it('does not write string tool inputs to the terminal', async () => {
    const output = await renderChunks(
      [
        toolInputChunk({
          toolCallId: 'call-input',
          toolName: 'read',
          input: `visible-tool-input ${cursorUp}`,
        }),
      ],
      { tools: 'full' },
    );

    expectSafeTerminalText(output.text(), 'visible-tool-input');
    expect(output.text()).not.toContain(cursorUp);
  });

  it('does not write tool error text to the terminal', async () => {
    const output = await renderChunks(
      [
        toolInputChunk({
          toolCallId: 'call-error',
          toolName: 'fetch',
          input: { url: 'http://example.test/page' },
        }),
        {
          type: 'tool-output-error',
          toolCallId: 'call-error',
          errorText: `visible-tool-error ${osc52}`,
        },
      ],
      { tools: 'full' },
    );

    expectSafeTerminalText(output.text(), 'visible-tool-error');
  });

  it('does not write tool input error text to the terminal', async () => {
    const output = await renderChunks(
      [
        {
          type: 'tool-input-error',
          toolCallId: 'call-input-error',
          toolName: 'fetch',
          input: '{"raw":true}',
          errorText: `visible-input-error ${clearToStart}`,
        },
      ],
      { tools: 'full' },
    );

    expectSafeTerminalText(output.text(), 'visible-input-error');
    expect(output.text()).not.toContain(clearToStart);
  });

  it('does not write tool denial reasons to the terminal', async () => {
    const output = await renderChunks(
      [
        toolInputChunk({
          toolCallId: 'call-denied',
          toolName: 'shell',
          input: { command: 'date' },
        }),
        {
          type: 'tool-approval-request',
          approvalId: 'approval-1',
          toolCallId: 'call-denied',
        },
        {
          type: 'tool-approval-response',
          approvalId: 'approval-1',
          approved: false,
          reason: `visible-denial ${deviceControl}`,
        },
        { type: 'tool-output-denied', toolCallId: 'call-denied' },
      ],
      { tools: 'full' },
    );

    expectSafeTerminalText(output.text(), 'visible-denial');
    expect(output.text()).not.toContain(deviceControl);
  });

  it('does not write tool titles to the terminal', async () => {
    const output = await renderChunks(
      [
        toolInputChunk({
          toolCallId: 'call-title',
          toolName: 'fetch',
          title: `${osc52}visible-title`,
          input: {},
        }),
      ],
      { tools: 'collapsed' },
    );

    expectSafeTerminalText(output.text(), 'visible-title');
  });

  it('does not write dynamic tool names to the terminal', async () => {
    const output = await renderChunks(
      [
        toolInputChunk({
          toolCallId: 'call-name',
          toolName: `${osc8}visible-tool-name`,
          input: {},
          dynamic: true,
        }),
      ],
      { tools: 'collapsed' },
    );

    expectSafeTerminalText(output.text(), 'visible-tool-name');
  });

  it('does not write stream error text to the terminal', async () => {
    const output = await renderChunks([
      { type: 'error', errorText: `visible-stream-error ${osc52}` },
    ] satisfies UIMessageChunk[]);

    expectSafeTerminalText(output.text(), 'visible-stream-error');
  });

  it('does not write tool titles on the approval prompt', async () => {
    const input = createInput();
    const output = createOutput();
    const renderer = new TerminalRenderer({ input, output });
    const approval = renderer.readToolApproval(
      {
        approvalId: 'approval-1',
        toolCallId: 'call-1',
        toolName: 'shell',
        title: `${osc52}visible-approval`,
        input: { command: 'date' },
        messageId: 'message-1',
        partIndex: 0,
      },
      { title: 'Test' },
    );

    expectSafeTerminalText(output.text(), 'visible-approval');

    input.emit('data', Buffer.from('n'));
    await expect(approval).resolves.toMatchObject({ approved: false });
  });

  it('does not write a local agent tool result string to the terminal', async () => {
    const payload = `visible-runner-tool ${osc52}`;
    const output = await runRunner({
      agent: createAgent([
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'fetch',
          input: { url: 'http://example.test/page' },
        },
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'fetch',
          input: { url: 'http://example.test/page' },
          output: payload,
        },
        {
          type: 'reasoning-delta',
          id: 'reasoning-1',
          text: `visible-runner-reasoning ${osc8}`,
        },
        {
          type: 'tool-call',
          toolCallId: 'call-2',
          toolName: 'fetch',
          input: { url: 'http://example.test/other' },
        },
        {
          type: 'tool-error',
          toolCallId: 'call-2',
          toolName: 'fetch',
          input: { url: 'http://example.test/other' },
          error: new Error(`visible-runner-error ${cursorUp}`),
        },
        { type: 'text-delta', id: 'text-1', text: 'visible-runner-text' },
      ] as TextStreamPart<ToolSet>[]),
    });

    expect(output.text()).toContain('visible-runner-tool');
    expect(output.text()).toContain('visible-runner-reasoning');
    expect(output.text()).toContain('visible-runner-error');
    expect(output.text()).not.toContain(cursorUp);
    expectSafeTerminalText(output.text(), 'visible-runner-tool');
  });

  it('does not write remote transport text to the terminal', async () => {
    const output = await runRunner({
      transportChunks: [
        ...textChunk(`visible-transport ${osc52}${c1Csi}`),
        ...reasoningChunk(`visible-transport-reasoning ${osc8}`),
      ],
    });

    expectSafeTerminalText(output.text(), 'visible-transport');
    expect(output.text()).toContain('visible-transport-reasoning');
  });
});

function expectSafeTerminalText(written: string, visibleMarker: string) {
  expect(written).toContain(visibleMarker);
  expect(rawControlViolations(written)).toEqual([]);
}

function rawControlViolations(written: string): string[] {
  const violations: string[] = [];

  for (let index = 0; index < written.length; ) {
    const codePoint = written.codePointAt(index);

    if (codePoint == null) {
      break;
    }

    if (codePoint === 0x1b) {
      const next = written[index + 1];
      if (next !== '[') {
        violations.push(
          `ESC followed by ${JSON.stringify(next ?? '')} at ${index}`,
        );
      }
      index += 1;
      continue;
    }

    if (
      codePoint < 0x20 ||
      codePoint === 0x7f ||
      (codePoint >= 0x80 && codePoint <= 0x9f)
    ) {
      if (codePoint !== 0x09 && codePoint !== 0x0a) {
        violations.push(
          `U+${codePoint.toString(16).padStart(4, '0')} at ${index}`,
        );
      }
    }

    index += codePoint > 0xffff ? 2 : 1;
  }

  return violations;
}

function textChunk(text: string): UIMessageChunk[] {
  return [
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: text },
    { type: 'text-end', id: 'text-1' },
  ];
}

function reasoningChunk(text: string): UIMessageChunk[] {
  return [
    { type: 'reasoning-start', id: 'reasoning-1' },
    { type: 'reasoning-delta', id: 'reasoning-1', delta: text },
    { type: 'reasoning-end', id: 'reasoning-1' },
  ];
}

function toolInputChunk(options: {
  toolCallId: string;
  toolName: string;
  input: unknown;
  title?: string;
  dynamic?: boolean;
}): UIMessageChunk {
  return {
    type: 'tool-input-available',
    toolCallId: options.toolCallId,
    toolName: options.toolName,
    input: options.input,
    ...(options.title != null ? { title: options.title } : {}),
    ...(options.dynamic ? { dynamic: true as const } : {}),
  };
}

async function renderChunks(
  chunks: UIMessageChunk[],
  options?: TerminalSessionOptions,
) {
  const input = createInput();
  const output = createOutput();
  const renderer = new TerminalRenderer({ input, output });

  await renderer.renderStream(
    {
      uiMessageStream: (async function* () {
        yield {
          type: 'start',
          messageId: 'message-1',
        } satisfies UIMessageChunk;
        yield* chunks;
        yield { type: 'finish' } satisfies UIMessageChunk;
      })(),
    },
    {
      title: 'Test',
      waitForExit: false,
      tools: 'full',
      reasoning: 'full',
      ...options,
    },
  );

  return output;
}

async function runRunner(options: {
  agent?: AgentTUIAgent;
  transportChunks?: UIMessageChunk[];
}) {
  const input = createInput();
  const output = createOutput();
  const runner = new AgentTUIRunner({
    ...(options.agent
      ? { agent: options.agent }
      : {
          transport: {
            async sendMessages() {
              return new ReadableStream<UIMessageChunk>({
                start(controller) {
                  controller.enqueue({
                    type: 'start',
                    messageId: 'message-1',
                  });
                  for (const chunk of options.transportChunks ?? []) {
                    controller.enqueue(chunk);
                  }
                  controller.enqueue({ type: 'finish' });
                  controller.close();
                },
              });
            },
            async reconnectToStream() {
              return null;
            },
          },
        }),
    title: 'Test',
    tools: 'full',
    reasoning: 'full',
    screen: output,
    userInput: input,
  });
  const running = runner.run();

  input.emit('data', Buffer.from('show'));
  input.emit('data', Buffer.from('\r'));

  try {
    await waitForText(output, 'visible-');
  } finally {
    input.emit('data', Buffer.from('\u001b'));
    await running;
  }

  return output;
}

function createAgent(parts: TextStreamPart<ToolSet>[]): AgentTUIAgent {
  return {
    version: 'agent-v1',
    id: undefined,
    tools: {},
    generate() {
      throw new Error('Expected no generate call.');
    },
    async stream() {
      return {
        fullStream: (async function* () {
          yield* parts;
        })(),
      } as Awaited<ReturnType<AgentTUIAgent['stream']>>;
    },
  };
}

async function waitForText(output: TestOutput, text: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (output.text().includes(text)) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 0));
  }

  expect(output.text()).toContain(text);
}

type TestInput = TerminalInput & EventEmitter;

type TestOutput = TerminalOutput &
  EventEmitter & {
    chunks: string[];
    text: () => string;
  };

function createInput() {
  const input = new EventEmitter() as TestInput;
  input.isTTY = false;
  input.resume = () => input;
  input.pause = () => input;
  return input;
}

function createOutput() {
  const chunks: string[] = [];
  const output = new EventEmitter() as TestOutput;
  output.columns = 120;
  output.rows = 40;
  output.chunks = chunks;
  output.write = (chunk: string | Uint8Array) => {
    chunks.push(
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
    );
    return true;
  };
  output.text = () => chunks.join('');
  return output;
}
