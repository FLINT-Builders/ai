import { InvalidArgumentError } from '@ai-sdk/provider';

// Every allowed character is literal in a URL path segment, so a matching
// value needs no percent-encoding and cannot form a path delimiter, query,
// fragment, percent-escape, or `.`/`..` segment.
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

const MODEL_COLLECTIONS = ['models', 'tunedModels', 'endpoints'];

function isSafePathSegment(value: unknown): value is string {
  return typeof value === 'string' && SAFE_PATH_SEGMENT.test(value);
}

function splitPath(value: unknown): string[] {
  return typeof value === 'string' ? value.split('/') : [];
}

function invalidPath({
  argument,
  value,
  expected,
}: {
  argument: string;
  value: unknown;
  expected: string;
}): InvalidArgumentError {
  return new InvalidArgumentError({
    argument,
    message:
      `Invalid ${argument} ${JSON.stringify(value)}: expected ${expected}. ` +
      `Each segment may contain only letters, digits, '.', '_', '-', or '@' ` +
      `and must start with a letter or digit.`,
  });
}

/**
 * Returns `value` for use as a single URL path segment, or throws when it
 * could change the path, query, or fragment of the URL it is placed in.
 */
export function getSafePathSegment({
  argument,
  value,
}: {
  argument: string;
  value: string;
}): string {
  if (!isSafePathSegment(value)) {
    throw invalidPath({ argument, value, expected: 'a single path segment' });
  }

  return value;
}

/**
 * Returns the request path for a model id: `<id>`, `models/<id>`,
 * `tunedModels/<id>`, or `endpoints/<id>`.
 */
export function getModelResourcePath(modelId: string): string {
  const parts = splitPath(modelId);

  if (parts.length === 1 && isSafePathSegment(parts[0])) {
    return `models/${parts[0]}`;
  }

  if (
    parts.length === 2 &&
    MODEL_COLLECTIONS.includes(parts[0]) &&
    isSafePathSegment(parts[1])
  ) {
    return `${parts[0]}/${parts[1]}`;
  }

  throw invalidPath({
    argument: 'modelId',
    value: modelId,
    expected: `"<id>" or "<collection>/<id>" where collection is one of ${MODEL_COLLECTIONS.join(', ')}`,
  });
}

/**
 * Returns the request path for a long-running operation name:
 * `operations/<id>` or `models/<model>/operations/<id>`.
 */
export function getOperationResourcePath(operationName: string): string {
  const parts = splitPath(operationName);

  if (
    parts.length === 2 &&
    parts[0] === 'operations' &&
    isSafePathSegment(parts[1])
  ) {
    return `operations/${parts[1]}`;
  }

  if (
    parts.length === 4 &&
    parts[0] === 'models' &&
    isSafePathSegment(parts[1]) &&
    parts[2] === 'operations' &&
    isSafePathSegment(parts[3])
  ) {
    return `models/${parts[1]}/operations/${parts[3]}`;
  }

  throw invalidPath({
    argument: 'operationName',
    value: operationName,
    expected: '"operations/<id>" or "models/<model>/operations/<id>"',
  });
}

/**
 * Returns the request path for a batch name: `batches/<id>`.
 */
export function getBatchResourcePath(batchId: string): string {
  const parts = splitPath(batchId);

  if (
    parts.length === 2 &&
    parts[0] === 'batches' &&
    isSafePathSegment(parts[1])
  ) {
    return `batches/${parts[1]}`;
  }

  throw invalidPath({
    argument: 'batchId',
    value: batchId,
    expected: '"batches/<id>"',
  });
}
