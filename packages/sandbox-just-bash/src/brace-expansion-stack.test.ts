import { Sandbox } from 'just-bash';
import { describe, expect, it } from 'vitest';

/**
 * Many comma-separated brace groups, marked as a glob with `*`. The string
 * stays under minimatch's 64KiB pattern limit. `JustBashSandboxSession.run`
 * passes the command to just-bash as `bash -c`.
 */
function lsBracePattern(): string {
  const groups = Array.from({ length: 10_000 }, () => '{a}').join(',');
  return `*{${groups}}`;
}

describe('just-bash ls brace patterns', () => {
  it('returns a normal miss for a pattern with many comma-separated brace groups', async () => {
    const sandbox = await Sandbox.create({ cwd: '/work' });
    const pattern = lsBracePattern().replaceAll("'", `'\\''`);
    const finished = await sandbox.runCommand({
      cmd: 'bash',
      args: ['-c', `ls -- '${pattern}'`],
    });
    const stderr = await finished.stderr();

    expect(finished.exitCode).toBe(2);
    expect(stderr).toContain('No such file or directory');
  });
});
