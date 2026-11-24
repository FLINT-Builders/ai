import {
  DefaultResourceLoader,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Many comma-separated brace groups inside one set. The string stays under
 * minimatch's 64KiB pattern limit and still overflows parseCommaParts in
 * brace-expansion 5.0.9 before max or maxLength can apply.
 */
function manyCommaSeparatedBraceGroups(): string {
  const groups = Array.from({ length: 10_000 }, () => '{a}').join(',');
  return `{${groups}}`;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeWorkspace({ settings }: { settings: Record<string, unknown> }): {
  workspace: string;
  agentDir: string;
} {
  const workspace = mkdtempSync(path.join(tmpdir(), 'harness-pi-brace-'));
  roots.push(workspace);
  const agentDir = path.join(workspace, 'agent');
  mkdirSync(path.join(workspace, '.pi', 'skills', 'demo'), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    path.join(workspace, '.pi', 'skills', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: demo skill\n---\n# demo\n',
  );
  writeFileSync(
    path.join(workspace, '.pi', 'settings.json'),
    JSON.stringify(settings),
  );
  return { workspace, agentDir };
}

/**
 * Same construction as createPiSession when agentDir is set: project settings
 * are read from the workspace, then DefaultResourceLoader.reload() resolves
 * them through minimatch.
 */
async function reloadWorkspaceResources(workspace: string, agentDir: string) {
  const settingsManager = SettingsManager.create(workspace, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir,
    settingsManager,
    noExtensions: true,
    noThemes: true,
    noPromptTemplates: true,
  });
  await resourceLoader.reload();
  return resourceLoader;
}

describe('workspace brace patterns passed to minimatch', () => {
  it('loads a discovered skill when an untrusted exclude pattern has many brace groups', async () => {
    const { workspace, agentDir } = writeWorkspace({
      settings: { skills: [`!${manyCommaSeparatedBraceGroups()}`] },
    });

    const resourceLoader = await reloadWorkspaceResources(workspace, agentDir);

    expect(resourceLoader.getSkills().skills.map(skill => skill.name)).toEqual([
      'demo',
    ]);
  });

  it('reloads when an untrusted include pattern has many brace groups', async () => {
    const { workspace, agentDir } = writeWorkspace({
      settings: {
        skills: [
          './skills/demo/SKILL.md',
          `*${manyCommaSeparatedBraceGroups()}`,
        ],
      },
    });

    await expect(
      reloadWorkspaceResources(workspace, agentDir),
    ).resolves.toBeDefined();
  });
});
