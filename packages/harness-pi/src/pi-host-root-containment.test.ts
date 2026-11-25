import { HarnessAgent } from '@ai-sdk/harness/agent';
import { createJustBashSandbox } from '@ai-sdk/sandbox-just-bash';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPi } from './pi-harness';
import { createPiSession, type CreatePiSessionInput } from './pi-session';

/**
 * Spec for the Pi host-root path traversal.
 *
 * These tests fail while a caller-supplied session id of `.`, `..`, or the
 * empty string can resolve the per-session host directory to the shared
 * `ai-sdk-harness` or `ai-sdk-harness/pi` folder. Stop, destroy, idle detach,
 * and suspend then recursively delete that directory. They pass when those
 * operations keep every other session's host state, and when creating the
 * session does not write outside one direct child of `ai-sdk-harness/pi`.
 */

const HARNESS_BASE = path.join(tmpdir(), 'ai-sdk-harness');
const PI_BASE = path.join(HARNESS_BASE, 'pi');
const TEST_TIMEOUT_MS = 180_000;

const ESCAPING_SESSION_IDS = ['.', '..', ''] as const;

type SessionFinish = 'destroy' | 'stop' | 'detach' | 'suspend';

const plantedPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    plantedPaths
      .splice(0)
      .map(plantedPath => rm(plantedPath, { recursive: true, force: true })),
  );
});

describe.sequential('Pi host root stays inside the per-session directory', () => {
  for (const sessionId of ESCAPING_SESSION_IDS) {
    for (const finish of ['destroy', 'stop', 'detach', 'suspend'] as const) {
      it(
        `session id ${JSON.stringify(sessionId)} ${finish} does not delete other Pi host state`,
        async () => {
          await expectOtherHostStateSurvives(async () => {
            const session = await createPiSession(
              await piSessionInput(sessionId),
            );
            await finishPiSession(session, finish);
          });
        },
        TEST_TIMEOUT_MS,
      );
    }
  }

  it(
    'HarnessAgent forwards a dot-dot chat id through just-bash createSession into host cleanup',
    async () => {
      await expectOtherHostStateSurvives(async () => {
        const agent = new HarnessAgent({
          harness: createPi({ auth: {} }),
          sandbox: createJustBashSandbox(),
        });
        const session = await agent.createSession({ sessionId: '..' });
        await session.destroy();
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'HarnessAgent forwards a dot-dot chat id when the caller supplies the sandbox',
    async () => {
      await expectOtherHostStateSurvives(async () => {
        const sandboxSession = await createJustBashSandbox().createSession();
        const agent = new HarnessAgent({
          harness: createPi({ auth: {} }),
        });
        const session = await agent.createSession({
          sessionId: '..',
          sandboxSession,
        });
        await session.destroy();
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a normal session id still cleans up only its own host directory',
    async () => {
      const sessionId = `safe-${randomUUID()}`;
      const operationError = await expectOtherHostStateSurvives(async () => {
        const session = await createPiSession(await piSessionInput(sessionId));
        await session.doDestroy();
      });
      expect(operationError).toBeUndefined();
      expect((await readdir(PI_BASE)).includes(sessionId)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});

async function expectOtherHostStateSurvives(
  operation: () => Promise<void>,
): Promise<unknown> {
  const victimId = `victim-${randomUUID()}`;
  const victimJournal = path.join(PI_BASE, victimId, 'sessions', 'journal.txt');
  const journalText = `live-journal-${randomUUID()}`;
  const outsideMarker = path.join(
    HARNESS_BASE,
    `outside-pi-${randomUUID()}.txt`,
  );
  const outsideText = `outside-${randomUUID()}`;
  plantedPaths.push(path.join(PI_BASE, victimId), outsideMarker);

  await mkdir(path.dirname(victimJournal), { recursive: true });
  await writeFile(victimJournal, journalText);
  await writeFile(outsideMarker, outsideText);
  const harnessChildrenBefore = await readdir(HARNESS_BASE);
  const piChildrenBefore = await readdir(PI_BASE);

  let operationError: unknown;
  try {
    await operation();
  } catch (error) {
    operationError = error;
  }

  let harnessChildrenAfter: string[];
  let piChildrenAfter: string[];
  try {
    harnessChildrenAfter = await readdir(HARNESS_BASE);
    piChildrenAfter = await readdir(PI_BASE);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Shared Pi host directory was removed while cleaning session state: ${detail}.${formatOperationError(operationError)}`,
      { cause: error },
    );
  }

  expect(await readFile(victimJournal, 'utf8')).toBe(journalText);
  expect(await readFile(outsideMarker, 'utf8')).toBe(outsideText);
  expect(removedNames(harnessChildrenBefore, harnessChildrenAfter)).toEqual([]);
  expect(removedNames(piChildrenBefore, piChildrenAfter)).toEqual([]);
  expect(addedNames(harnessChildrenBefore, harnessChildrenAfter)).toEqual([]);

  const addedPiChildren = addedNames(piChildrenBefore, piChildrenAfter);
  expect(addedPiChildren.length).toBeLessThanOrEqual(1);
  const addedChild = addedPiChildren[0];
  if (addedChild != null) {
    expect(addedChild).not.toBe('.');
    expect(addedChild).not.toBe('..');
    expect(addedChild.includes(path.sep)).toBe(false);
    const addedPath = path.join(PI_BASE, addedChild);
    const relativePath = path.relative(PI_BASE, path.resolve(addedPath));
    expect(relativePath).toBe(addedChild);
    expect(relativePath.startsWith('..')).toBe(false);
    expect(path.isAbsolute(relativePath)).toBe(false);
  }

  return operationError;
}

async function piSessionInput(
  sessionId: string,
): Promise<CreatePiSessionInput> {
  const sandboxSession = await createJustBashSandbox().createSession();
  const sessionWorkDir = path.posix.join(
    sandboxSession.defaultWorkingDirectory,
    `work-${randomUUID()}`,
  );
  const created = await sandboxSession.run({
    command: 'mkdir -p -- "$WORK_DIR"',
    env: { WORK_DIR: sessionWorkDir },
  });
  if (created.exitCode !== 0) {
    throw new Error(
      `Failed to create sandbox work directory (exit ${created.exitCode}): ${created.stderr || created.stdout}`,
    );
  }

  return {
    sessionId,
    sandboxSession,
    sessionWorkDir,
    settings: { auth: {} },
    clientApp: 'ai-sdk/harness-pi/host-root-containment-test',
    isResume: false,
  };
}

async function finishPiSession(
  session: Awaited<ReturnType<typeof createPiSession>>,
  finish: SessionFinish,
): Promise<void> {
  switch (finish) {
    case 'destroy':
      await session.doDestroy();
      return;
    case 'stop':
      await session.doStop();
      return;
    case 'detach':
      await session.doDetach();
      return;
    case 'suspend':
      await session.doSuspendTurn();
      return;
  }
}

function addedNames(
  before: readonly string[],
  after: readonly string[],
): string[] {
  const existing = new Set(before);
  return after.filter(name => !existing.has(name)).sort();
}

function removedNames(
  before: readonly string[],
  after: readonly string[],
): string[] {
  const remaining = new Set(after);
  return before.filter(name => !remaining.has(name)).sort();
}

function formatOperationError(error: unknown): string {
  if (error == null) return '';
  if (error instanceof Error) {
    return ` Operation error: ${error.name}: ${error.message}`;
  }
  return ` Operation error: ${String(error)}`;
}
