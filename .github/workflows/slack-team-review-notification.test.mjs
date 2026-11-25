/**
 * Spec for the Slack review notification workflow.
 *
 * These tests expand each `run` script the way actions/runner v2.338.2 does,
 * then execute it with the same bash invocation the Linux runner uses. They
 * fail while a pull request title can break out of the shell string.
 *
 * Runner pieces mirrored here:
 * - TemplateReader.ParseScalar (expression split, format() rebuild)
 *   src/Sdk/WorkflowParser/ObjectTemplating/TemplateReader.cs
 * - LexicalAnalyzer.ReadStringToken ('' -> ')
 *   src/Sdk/Expressions/Tokens/LexicalAnalyzer.cs
 * - Format.EvaluateCore
 *   src/Sdk/Expressions/Sdk/Functions/Format.cs
 * - ToJson string case via Newtonsoft.Json 13.0.3 JsonConvert.ToString
 *   runner src/Sdk/Expressions/Sdk/Functions/ToJson.cs
 *   Newtonsoft.Json JavaScriptUtils double-quote flags
 * - ScriptHandler Linux default: bash found on PATH, arguments from sh: `-e`
 *   src/Runner.Worker/Handlers/ScriptHandler.cs
 *   src/Runner.Worker/Handlers/ScriptHandlerHelpers.cs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const workflowPath = fileURLToPath(
  new URL('./slack-team-review-notification.yml', import.meta.url),
);

const WEBHOOK_PLACEHOLDER = 'https://example.test/slack-pr-review-request';

function indentOf(line) {
  const match = /^[ ]*/.exec(line);
  return match[0].length;
}

function unquote(value) {
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || !value.endsWith(quote)) {
    return value;
  }
  const body = value.slice(1, -1);
  if (quote === "'") {
    return body.replaceAll("''", "'");
  }
  return body
    .replaceAll('\\n', '\n')
    .replaceAll('\\t', '\t')
    .replaceAll('\\"', '"')
    .replaceAll('\\\\', '\\');
}

function parseFlowSequence(value) {
  const inner = value.slice(1, value.lastIndexOf(']')).trim();
  if (inner === '') {
    return [];
  }
  return inner.split(',').map(part => {
    const trimmed = part.trim();
    if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
      return unquote(trimmed);
    }
    return trimmed;
  });
}

function parseYaml(text) {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  let index = 0;

  function skipBlanksAndComments(minIndent) {
    while (index < lines.length) {
      const line = lines[index];
      if (line.trim() === '') {
        index += 1;
        continue;
      }
      if (indentOf(line) >= minIndent && line.trim().startsWith('#')) {
        index += 1;
        continue;
      }
      break;
    }
  }

  function readBlock(parentIndent, header) {
    const chomp = header.includes('-')
      ? 'strip'
      : header.includes('+')
        ? 'keep'
        : 'clip';
    const content = [];
    let contentIndent = null;
    while (index < lines.length) {
      const line = lines[index];
      if (line.trim() === '') {
        if (contentIndent === null) {
          index += 1;
          continue;
        }
        content.push('');
        index += 1;
        continue;
      }
      const currentIndent = indentOf(line);
      if (currentIndent <= parentIndent) {
        break;
      }
      if (contentIndent === null) {
        contentIndent = currentIndent;
      }
      if (currentIndent < contentIndent) {
        break;
      }
      content.push(line.slice(contentIndent));
      index += 1;
    }
    let joined = content.join('\n');
    if (chomp === 'strip') {
      joined = joined.replace(/\n+$/, '');
    } else if (chomp === 'clip') {
      joined = joined.replace(/\n+$/, '');
      if (content.length > 0) {
        joined += '\n';
      }
    } else {
      joined += '\n';
    }
    return joined;
  }

  function parseNode(minIndent) {
    skipBlanksAndComments(minIndent);
    if (index >= lines.length || indentOf(lines[index]) < minIndent) {
      return null;
    }
    const line = lines[index];
    const currentIndent = indentOf(line);
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      const items = [];
      while (index < lines.length) {
        const candidate = lines[index];
        if (candidate.trim() === '') {
          index += 1;
          continue;
        }
        if (candidate.trim().startsWith('#') && indentOf(candidate) >= currentIndent) {
          index += 1;
          continue;
        }
        if (indentOf(candidate) !== currentIndent || !candidate.trim().startsWith('- ')) {
          break;
        }
        const rest = candidate.trim().slice(2);
        index += 1;
        if (rest === '') {
          items.push(parseNode(currentIndent + 1));
          continue;
        }
        const keyMatch = /^([^:#]+):(.*)$/.exec(rest);
        if (!keyMatch) {
          items.push(parsePlain(rest));
          continue;
        }
        const item = {};
        const key = keyMatch[1].trim();
        item[key] = parseFollowingValue(keyMatch[2], currentIndent);
        while (index < lines.length) {
          const nested = lines[index];
          if (nested.trim() === '' || nested.trim().startsWith('#')) {
            const lookAhead = nextContent(index);
            if (lookAhead === null || lookAhead.indent <= currentIndent) {
              break;
            }
            index += 1;
            continue;
          }
          const nestedIndent = indentOf(nested);
          if (nestedIndent <= currentIndent) {
            break;
          }
          if (nested.trim().startsWith('- ')) {
            break;
          }
          const nestedMatch = /^([^:#]+):(.*)$/.exec(nested.trim());
          if (!nestedMatch) {
            break;
          }
          index += 1;
          item[nestedMatch[1].trim()] = parseFollowingValue(
            nestedMatch[2],
            nestedIndent,
          );
        }
        items.push(item);
      }
      return items;
    }

    const mapping = {};
    while (index < lines.length) {
      skipBlanksAndComments(currentIndent);
      if (index >= lines.length) {
        break;
      }
      const candidate = lines[index];
      if (indentOf(candidate) < currentIndent) {
        break;
      }
      if (indentOf(candidate) > currentIndent) {
        break;
      }
      if (candidate.trim().startsWith('- ')) {
        break;
      }
      const keyMatch = /^([^:#]+):(.*)$/.exec(candidate.trim());
      if (!keyMatch) {
        break;
      }
      index += 1;
      mapping[keyMatch[1].trim()] = parseFollowingValue(
        keyMatch[2],
        currentIndent,
      );
    }
    return mapping;
  }

  function nextContent(from) {
    for (let cursor = from; cursor < lines.length; cursor += 1) {
      if (lines[cursor].trim() === '' || lines[cursor].trim().startsWith('#')) {
        continue;
      }
      return { indent: indentOf(lines[cursor]), index: cursor };
    }
    return null;
  }

  function parseFollowingValue(rawRemainder, keyIndent) {
    const remainder = rawRemainder.trim();
    if (remainder === '|' || remainder.startsWith('|')) {
      return readBlock(keyIndent, remainder);
    }
    if (remainder === '>' || remainder.startsWith('>')) {
      const block = readBlock(keyIndent, remainder);
      return block.replaceAll(/\n(?!\n)/g, ' ').replace(/\n+$/, '\n');
    }
    if (remainder.startsWith('[')) {
      return parseFlowSequence(remainder);
    }
    if (remainder.startsWith('"') || remainder.startsWith("'")) {
      return unquote(remainder);
    }
    if (remainder === '') {
      return parseNode(keyIndent + 1);
    }
    const comment = remainder.indexOf(' #');
    return comment === -1 ? remainder : remainder.slice(0, comment).trim();
  }

  function parsePlain(value) {
    if (value.startsWith('"') || value.startsWith("'")) {
      return unquote(value);
    }
    return value;
  }

  return parseNode(0);
}

const OPEN_EXPRESSION = '${{';
const CLOSE_EXPRESSION = '}}';

function splitExpressions(raw) {
  const segments = [];
  if (!raw.includes(OPEN_EXPRESSION)) {
    return [{ type: 'literal', text: raw }];
  }
  let cursor = 0;
  let next = raw.indexOf(OPEN_EXPRESSION);
  while (cursor < raw.length) {
    if (cursor === next) {
      let inString = false;
      let end = -1;
      let scan = cursor + OPEN_EXPRESSION.length;
      for (; scan < raw.length; scan += 1) {
        const character = raw[scan];
        if (character === "'") {
          inString = !inString;
        } else if (!inString && character === '}' && raw[scan - 1] === '}') {
          end = scan;
          scan += 1;
          break;
        }
      }
      if (end < cursor) {
        throw new Error('Expression not closed');
      }
      const expression = raw
        .slice(cursor + OPEN_EXPRESSION.length, end - CLOSE_EXPRESSION.length + 1)
        .trim();
      segments.push({ type: 'expr', text: expression });
      next = raw.indexOf(OPEN_EXPRESSION, scan);
      cursor = scan;
      if (next === -1) {
        next = raw.length + 1;
      }
    } else if (cursor < next) {
      segments.push({ type: 'literal', text: raw.slice(cursor, next) });
      cursor = next;
    } else {
      segments.push({ type: 'literal', text: raw.slice(cursor) });
      break;
    }
  }
  return segments;
}

function unescapeExpressionString(value) {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "'" && value[index + 1] === "'") {
      result += "'";
      index += 1;
    } else {
      result += character;
    }
  }
  return result;
}

function convertToString(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (Object.is(value, -0)) {
      return '0';
    }
    return String(value);
  }
  return String(value);
}

function applyFormat(format, args) {
  let result = '';
  let index = 0;
  while (index < format.length) {
    const left = format.indexOf('{', index);
    const right = format.indexOf('}', index);
    if (left >= 0 && (right < 0 || right > left)) {
      if (format[left + 1] === '{') {
        result += format.slice(index, left + 1);
        index = left + 2;
        continue;
      }
      const digits = /^(\d+)/.exec(format.slice(left + 1));
      if (!digits || format[left + 1 + digits[1].length] !== '}') {
        throw new Error(`Invalid format string: ${format}`);
      }
      const argIndex = Number(digits[1]);
      if (left > index) {
        result += format.slice(index, left);
      }
      result += convertToString(args[argIndex]);
      index = left + 1 + digits[1].length + 1;
      continue;
    }
    if (right >= 0) {
      if (format[right + 1] === '}') {
        result += format.slice(index, right + 1);
        index = right + 2;
        continue;
      }
      throw new Error(`Invalid format string: ${format}`);
    }
    result += format.slice(index);
    break;
  }
  return result;
}

function hexDigit(nibble) {
  return nibble <= 9
    ? String.fromCharCode(nibble + 48)
    : String.fromCharCode(nibble - 10 + 97);
}

function toCharAsUnicode(character) {
  const code = character.codePointAt(0);
  return `\\u${hexDigit((code >> 12) & 0xf)}${hexDigit((code >> 8) & 0xf)}${hexDigit((code >> 4) & 0xf)}${hexDigit(code & 0xf)}`;
}

/**
 * Newtonsoft.Json 13.0.3 JsonConvert.ToString(string): delimiter '"',
 * StringEscapeHandling.Default. Single quotes are not in the double-quote
 * escape flags, so they are copied through.
 */
function toJsonString(value) {
  let result = '"';
  for (const character of value) {
    const code = character.codePointAt(0);
    if (character === '\t') result += '\\t';
    else if (character === '\n') result += '\\n';
    else if (character === '\r') result += '\\r';
    else if (character === '\f') result += '\\f';
    else if (character === '\b') result += '\\b';
    else if (character === '\\') result += '\\\\';
    else if (character === '"') result += '\\"';
    else if (code < 32 || character === '\u0085' || character === '\u2028' || character === '\u2029') {
      result += toCharAsUnicode(character);
    } else {
      result += character;
    }
  }
  result += '"';
  return result;
}

function toJson(value) {
  if (typeof value === 'string') {
    return toJsonString(value);
  }
  return JSON.stringify(value);
}

function lookup(root, expression) {
  const parts = [];
  let token = '';
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (character === '.') {
      if (token) parts.push(token);
      token = '';
    } else if (character === '[') {
      if (token) parts.push(token);
      token = '';
      const end = expression.indexOf(']', index);
      parts.push(expression.slice(index + 1, end).replaceAll(/['"]/g, ''));
      index = end;
    } else {
      token += character;
    }
  }
  if (token) parts.push(token);
  let current = root;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return '';
    }
    current = current[part];
  }
  return current === undefined ? '' : current;
}

function evaluateExpression(expression, context) {
  const trimmed = expression.trim();
  const toJsonMatch = /^toJson\((.*)\)$/.exec(trimmed);
  if (toJsonMatch) {
    return toJson(evaluateExpression(toJsonMatch[1], context));
  }
  const comparison = /^(.*?)(==|!=)(.*)$/.exec(trimmed);
  if (comparison && !trimmed.startsWith("'")) {
    const left = evaluateExpression(comparison[1], context);
    const right = evaluateExpression(comparison[3], context);
    const equal = convertToString(left) === convertToString(right);
    return comparison[2] === '==' ? equal : !equal;
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  return lookup(context, trimmed);
}

function expandScalar(raw, context) {
  const segments = splitExpressions(raw);
  if (segments.length === 1 && segments[0].type === 'literal') {
    return segments[0].text;
  }
  if (segments.length === 1 && segments[0].type === 'expr') {
    return convertToString(evaluateExpression(segments[0].text, context));
  }
  let format = '';
  const args = [];
  for (const segment of segments) {
    if (segment.type === 'literal') {
      format += segment.text.replaceAll("'", "''").replaceAll('{', '{{').replaceAll('}', '}}');
    } else {
      format += `{${args.length}}`;
      args.push(evaluateExpression(segment.text, context));
    }
  }
  return applyFormat(unescapeExpressionString(format), args);
}

function evaluateCondition(condition, context) {
  if (condition === undefined || condition === null || condition === '') {
    return true;
  }
  let expression = String(condition).trim();
  if (expression.startsWith('${{') && expression.endsWith('}}')) {
    expression = expression.slice(3, -2).trim();
  }
  return Boolean(evaluateExpression(expression, context));
}

function writeCurlMock(directory) {
  const mockPath = path.join(directory, 'curl');
  fs.writeFileSync(
    mockPath,
    `#!/usr/bin/env node
import fs from 'node:fs';
const record = {
  argv: process.argv.slice(2),
  stdin: fs.readFileSync(0, 'utf8'),
};
fs.appendFileSync(process.env.CURL_LOG, JSON.stringify(record) + '\\n');
`,
  );
  fs.chmodSync(mockPath, 0o755);
  return mockPath;
}

function requestBody(record) {
  const args = record.argv;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-d' || arg === '--data' || arg === '--data-raw' || arg === '--data-binary') {
      const value = args[index + 1];
      if (value === '@-' || value === '@') {
        return record.stdin;
      }
      return value;
    }
    for (const flag of ['--data=', '--data-raw=', '--data-binary=']) {
      if (arg.startsWith(flag)) {
        const value = arg.slice(flag.length);
        return value === '@-' ? record.stdin : value;
      }
    }
  }
  return record.stdin;
}

function requestUrl(record) {
  const args = record.argv;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-d' || arg === '--data' || arg === '--data-raw' || arg === '--data-binary' || arg === '-H' || arg === '-X' || arg === '--header' || arg === '--request') {
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      continue;
    }
    return arg;
  }
  return '';
}

function runWorkflow({ title, requestedTeams, webhookSecret, sideEffectPath }) {
  const workflow = parseYaml(fs.readFileSync(workflowPath, 'utf8'));
  const job = workflow.jobs['notify-slack'];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-review-'));
  const marker = sideEffectPath ?? path.join(directory, 'marker');
  const eventPath = path.join(directory, 'event.json');
  const curlLog = path.join(directory, 'curl.log');
  fs.writeFileSync(curlLog, '');
  writeCurlMock(directory);
  const event = {
    action: 'review_requested',
    pull_request: {
      number: 42,
      title,
      html_url: 'https://github.com/example/ai/pull/42',
      requested_teams: requestedTeams,
    },
    requested_team: requestedTeams[0] ?? null,
  };
  fs.writeFileSync(eventPath, `${JSON.stringify(event)}\n`);
  const context = {
    github: {
      event,
      event_path: eventPath,
    },
    secrets: {
      SLACK_PR_REVIEW_REQUEST_URL: webhookSecret,
    },
    steps: {},
    env: {},
  };
  const results = [];
  let previousSucceeded = true;
  for (const step of job.steps) {
    const hasExplicitIf = step.if !== undefined && step.if !== null && step.if !== '';
    if (!hasExplicitIf && !previousSucceeded) {
      results.push({ name: step.name, skipped: true });
      continue;
    }
    const stepEnv = {};
    for (const [key, value] of Object.entries(step.env ?? {})) {
      stepEnv[key] = expandScalar(String(value), context);
      context.env[key] = stepEnv[key];
    }
    if (hasExplicitIf && !evaluateCondition(step.if, context)) {
      for (const key of Object.keys(step.env ?? {})) {
        delete context.env[key];
      }
      results.push({ name: step.name, skipped: true });
      continue;
    }
    const script = expandScalar(String(step.run), context);
    const outputPath = path.join(directory, `${step.id ?? step.name}.output`);
    fs.writeFileSync(outputPath, '');
    const scriptPath = path.join(directory, `${results.length}.sh`);
    fs.writeFileSync(scriptPath, script);
    const child = spawnSync('bash', ['-e', scriptPath], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputPath,
        CURL_LOG: curlLog,
        ...stepEnv,
      },
      encoding: 'utf8',
    });
    const outputText = fs.readFileSync(outputPath, 'utf8');
    if (step.id) {
      const outputs = {};
      for (const line of outputText.split('\n')) {
        const separator = line.indexOf('=');
        if (separator > 0) {
          outputs[line.slice(0, separator)] = line.slice(separator + 1);
        }
      }
      context.steps[step.id] = { outputs };
    }
    previousSucceeded = child.status === 0;
    results.push({
      name: step.name,
      skipped: false,
      status: child.status,
      stdout: child.stdout,
      stderr: child.stderr,
      script,
    });
    for (const key of Object.keys(step.env ?? {})) {
      delete context.env[key];
    }
  }
  const calls = fs
    .readFileSync(curlLog, 'utf8')
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line));
  return {
    marker,
    markerExists: fs.existsSync(marker),
    markerText: fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '',
    calls,
    results,
    directory,
  };
}

function notificationBody(calls) {
  assert.equal(calls.length, 1);
  const body = requestBody(calls[0]);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    assert.fail(`notification body is not JSON: ${body}\n${error}`);
  }
  return { body: parsed, url: requestUrl(calls[0]) };
}

test('toJson leaves a single quote inside the JSON string', () => {
  assert.equal(toJsonString("it's"), `"it's"`);
  assert.equal(toJsonString('say "hi"'), '"say \\"hi\\""');
  assert.equal(toJsonString('a\\b'), '"a\\\\b"');
  assert.equal(toJsonString('line1\nline2'), '"line1\\nline2"');
});

test('benign title is delivered as JSON when the ai-sdk team is requested', () => {
  const title = 'Release notes (safe) "quoted" $(not-a-breakout)';
  const run = runWorkflow({
    title,
    requestedTeams: [{ slug: 'ai-sdk', name: 'AI SDK' }],
    webhookSecret: WEBHOOK_PLACEHOLDER,
  });
  assert.equal(run.markerExists, false);
  const notification = notificationBody(run.calls);
  assert.equal(notification.url, WEBHOOK_PLACEHOLDER);
  assert.equal(notification.body.title, title);
  assert.equal(notification.body.channel_id, 'C050WU03V3N');
  assert.equal(String(notification.body.number), '42');
  assert.equal(notification.body.url, 'https://github.com/example/ai/pull/42');
});

test('pull request title cannot execute a command when the ai-sdk team is requested', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-title-'));
  const marker = path.join(directory, 'marker');
  const title = `notes'$(printenv SLACK_PR_REVIEW_REQUEST_URL > ${marker})'end`;
  const run = runWorkflow({
    title,
    requestedTeams: [{ slug: 'ai-sdk', name: 'AI SDK' }],
    webhookSecret: WEBHOOK_PLACEHOLDER,
    sideEffectPath: marker,
  });
  assert.equal(
    run.markerExists,
    false,
    'title reached the shell and wrote the step environment',
  );
  const notification = notificationBody(run.calls);
  assert.equal(notification.url, WEBHOOK_PLACEHOLDER);
  assert.equal(notification.body.title, title);
});

test('a title that only contains a single quote is still sent as data', () => {
  const title = "it's a title";
  const run = runWorkflow({
    title,
    requestedTeams: [{ slug: 'ai-sdk', name: 'AI SDK' }],
    webhookSecret: WEBHOOK_PLACEHOLDER,
  });
  assert.equal(run.markerExists, false);
  const notify = run.results.find(step => step.name === 'Send Slack notification');
  assert.equal(notify?.skipped, false);
  const notification = notificationBody(run.calls);
  assert.equal(notification.body.title, title);
  assert.equal(notification.url, WEBHOOK_PLACEHOLDER);
});

test('the same title cannot execute a command when the webhook secret is empty', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-fork-'));
  const marker = path.join(directory, 'marker');
  const title = `fork'$(touch ${marker})'title`;
  const run = runWorkflow({
    title,
    requestedTeams: [{ slug: 'ai-sdk', name: 'AI SDK' }],
    webhookSecret: '',
    sideEffectPath: marker,
  });
  assert.equal(run.markerExists, false, 'title reached the shell on a fork-style run');
  const notification = notificationBody(run.calls);
  assert.equal(notification.url, '');
  assert.equal(notification.body.title, title);
});

test('notification does not run when the ai-sdk team was not requested', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-other-team-'));
  const marker = path.join(directory, 'marker');
  const title = `other'$(touch ${marker})'title`;
  const run = runWorkflow({
    title,
    requestedTeams: [{ slug: 'docs', name: 'Docs' }],
    webhookSecret: WEBHOOK_PLACEHOLDER,
    sideEffectPath: marker,
  });
  assert.equal(run.markerExists, false);
  assert.equal(run.calls.length, 0);
});

test('newline, backslash, and command substitution stay inside the title field', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-mix-'));
  const marker = path.join(directory, 'marker');
  const title = `line1\nline2 \\ '$(touch ${marker})' "end"`;
  const run = runWorkflow({
    title,
    requestedTeams: [{ slug: 'ai-sdk', name: 'AI SDK' }],
    webhookSecret: WEBHOOK_PLACEHOLDER,
    sideEffectPath: marker,
  });
  assert.equal(run.markerExists, false);
  const notification = notificationBody(run.calls);
  assert.equal(notification.body.title, title);
});
