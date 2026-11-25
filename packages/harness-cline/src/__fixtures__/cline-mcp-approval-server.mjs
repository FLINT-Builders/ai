/**
 * Newline-delimited stdio MCP server used by the approval tests.
 *
 * The request and response shape matches the stdio client in
 * @cline/core 0.0.79 (`zU` in dist/index.js): one JSON-RPC object per line,
 * numeric ids, `result` on success, and `tools/list` / `tools/call` methods.
 * `tools/call` is appended to the log file before the response is written.
 */
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const logPath = process.argv[2];
if (logPath == null || logPath.length === 0) {
  process.stderr.write('missing invocation log path\n');
  process.exit(1);
}

const tools = [
  {
    name: 'create_issue',
    description: 'Create an issue in the tracker.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_issue',
    description: 'Delete an issue from the tracker.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_message',
    description: 'Send a message.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
];

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result });
}

function fail(id, message) {
  writeMessage({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message },
  });
}

const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (typeof message.id !== 'number') return;

  if (message.method === 'initialize') {
    const requested = message.params?.protocolVersion;
    respond(message.id, {
      protocolVersion:
        typeof requested === 'string' ? requested : '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'tracker', version: '0.0.0' },
    });
    return;
  }

  if (message.method === 'tools/list') {
    respond(message.id, { tools });
    return;
  }

  if (message.method === 'tools/call') {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    appendFileSync(
      logPath,
      `${JSON.stringify({ tool: name, arguments: args })}\n`,
    );
    respond(message.id, {
      content: [{ type: 'text', text: 'ok' }],
    });
    return;
  }

  fail(message.id, `unexpected method ${String(message.method)}`);
});
