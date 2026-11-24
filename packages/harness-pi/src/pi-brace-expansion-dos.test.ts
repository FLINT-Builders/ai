import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

const CHILD_SOURCE = `
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

const depth = 5000;
function singleSetPattern(n) {
  return '{'.repeat(n) + 'a,b' + '}'.repeat(n);
}
function commaMemberPattern(n) {
  let body = 'a,b';
  for (let i = 0; i < n; i++) body = 'a,{' + body + '}';
  return '{' + body + '}';
}

const mode = process.env.BRACE_CASE;
const nested =
  mode === 'exclude-comma' || mode === 'include-comma'
    ? commaMemberPattern(depth)
    : singleSetPattern(depth);
const skills =
  mode === 'include-single' || mode === 'include-comma'
    ? ['skills/demo/SKILL.md', nested + '*']
    : ['!' + nested];

const root = await mkdtemp(path.join(tmpdir(), 'pi-brace-'));
const work = path.join(root, 'work');
const agent = path.join(root, 'agent');
await mkdir(path.join(work, '.pi', 'skills', 'demo'), { recursive: true });
await mkdir(agent, { recursive: true });
await writeFile(
  path.join(work, '.pi', 'skills', 'demo', 'SKILL.md'),
  '---\\nname: demo\\ndescription: demo\\n---\\n',
);
await writeFile(
  path.join(work, '.pi', 'settings.json'),
  JSON.stringify({ skills }),
);

const settingsManager = SettingsManager.create(work, agent);
const loader = new DefaultResourceLoader({
  cwd: work,
  agentDir: agent,
  settingsManager,
  noExtensions: true,
  noThemes: true,
  noPromptTemplates: true,
});
await loader.reload();

if (mode === 'exclude-single' || mode === 'exclude-comma') {
  const names = loader.getSkills().skills.map(skill => skill.name);
  if (!names.includes('demo')) {
    console.error('expected demo skill to stay enabled, got ' + names.join(','));
    process.exit(2);
  }
}
console.log('reloaded');
`;

function runResourceLoad(mode: string): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', CHILD_SOURCE],
      {
        cwd: PACKAGE_ROOT,
        env: { ...process.env, BRACE_CASE: mode },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

describe('nested brace patterns from a workspace', () => {
  it('does not crash resource loading on a single-set exclude', async () => {
    const result = await runResourceLoad('exclude-single');
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('reloaded');
  }, 60_000);

  it('does not crash resource loading on a comma-member exclude', async () => {
    const result = await runResourceLoad('exclude-comma');
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('reloaded');
  }, 60_000);

  it('does not crash resource loading on a single-set include', async () => {
    const result = await runResourceLoad('include-single');
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('reloaded');
  }, 60_000);

  it('does not crash resource loading on a comma-member include', async () => {
    const result = await runResourceLoad('include-comma');
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('reloaded');
  }, 60_000);
});
