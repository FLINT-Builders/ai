import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DefaultResourceLoader,
  SettingsManager,
  type Skill,
} from '@earendil-works/pi-coding-agent';
import type { Experimental_SandboxSession } from '@ai-sdk/provider-utils';
import { createJustBashSandbox } from '@ai-sdk/sandbox-just-bash';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPiPathMapper } from './pi-paths';
import { createPiRemoteOps } from './pi-remote-ops';
import { syncHostWorkspaceFromSandbox } from './pi-workspace-mirror';
import { PiWorkspaceVfs } from './pi-workspace-vfs';

const sandboxWorkDir = '/sandbox/pi-escape-work';
const outsideDir = '/sandbox/private';
const readableSkillRoot = '/sandbox/home/.agents/skills';

const agentsMarker = 'MARKER_AGENTS_CONTEXT';
const agentsMdMarker = 'MARKER_AGENTS_MD_CONTEXT';
const systemMarker = 'MARKER_SYSTEM_PROMPT';
const appendMarker = 'MARKER_APPEND_PROMPT';
const skillDescriptionMarker = 'MARKER_AGENTS_SKILL_DESCRIPTION';
const skillBodyMarker = 'MARKER_AGENTS_SKILL_BODY';
const piSkillDescriptionMarker = 'MARKER_PI_SKILL_DESCRIPTION';
const piSkillBodyMarker = 'MARKER_PI_SKILL_BODY';
const dirSkillDescriptionMarker = 'MARKER_DIR_SKILL_DESCRIPTION';
const dirSkillBodyMarker = 'MARKER_DIR_SKILL_BODY';
const piTreeSystemMarker = 'MARKER_PI_TREE_SYSTEM';
const agentsTreeSkillDescriptionMarker = 'MARKER_TREE_SKILL_DESCRIPTION';
const agentsTreeSkillBodyMarker = 'MARKER_TREE_SKILL_BODY';
const outsideRaceMarker = 'MARKER_OUTSIDE_RACE';
const insideRaceMarker = 'MARKER_INSIDE_RACE';

const escapedMarkers = [
  agentsMarker,
  agentsMdMarker,
  systemMarker,
  appendMarker,
  skillDescriptionMarker,
  skillBodyMarker,
  piSkillDescriptionMarker,
  piSkillBodyMarker,
  dirSkillDescriptionMarker,
  dirSkillBodyMarker,
  piTreeSystemMarker,
  agentsTreeSkillDescriptionMarker,
  agentsTreeSkillBodyMarker,
  outsideRaceMarker,
];

let hostWorkDir: string;
const mounted: PiWorkspaceVfs[] = [];

beforeEach(() => {
  hostWorkDir = mkdtempSync(path.join(tmpdir(), 'pi-symlink-escape-'));
});

afterEach(() => {
  for (const vfs of mounted.splice(0)) {
    vfs.unmount();
  }
  rmSync(hostWorkDir, { recursive: true, force: true });
});

function skillFile(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

function isInsidePosixPath(parent: string, candidate: string): boolean {
  const relative = path.posix.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.posix.isAbsolute(relative))
  );
}

function isWithinDirectory(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

/**
 * Same predicate `createPiSession` uses to keep discovered skills. Paths under
 * the session workspace or the host mirror are kept.
 */
function isKeptWorkspaceSkill(skill: Skill): boolean {
  return (
    isWithinDirectory(sandboxWorkDir, skill.filePath) ||
    isWithinDirectory(hostWorkDir, skill.filePath)
  );
}

async function createSandbox(): Promise<{
  sandbox: Experimental_SandboxSession;
  destroy: () => Promise<void>;
}> {
  const session = await createJustBashSandbox({
    cwd: sandboxWorkDir,
  }).createSession();
  return {
    sandbox: session.restricted(),
    destroy: () => session.destroy(),
  };
}

async function syncAllowingRefusal(
  sandbox: Experimental_SandboxSession,
): Promise<void> {
  try {
    await syncHostWorkspaceFromSandbox({
      sandbox,
      sandboxWorkDir,
      hostWorkDir,
    });
  } catch {
    // Refusing the sync is acceptable when no escaped bytes were written.
  }
}

async function escapedMirrorViolations(markers: string[]): Promise<string[]> {
  const violations: string[] = [];
  if (!existsSync(hostWorkDir)) return violations;

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const hostPath = path.join(directory, entry.name);
      const relativePath = path
        .relative(hostWorkDir, hostPath)
        .split(path.sep)
        .join('/');
      if (entry.isSymbolicLink()) {
        const target = await readlink(hostPath);
        const sandboxLinkPath = path.posix.join(sandboxWorkDir, relativePath);
        const resolved = target.startsWith('/')
          ? path.posix.normalize(target)
          : path.posix.normalize(
              path.posix.join(path.posix.dirname(sandboxLinkPath), target),
            );
        if (!isInsidePosixPath(sandboxWorkDir, resolved)) {
          violations.push(`symlink ${relativePath} -> ${resolved}`);
        }
        continue;
      }
      if (entry.isDirectory()) {
        await walk(hostPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const text = await readFile(hostPath, 'utf8');
      for (const marker of markers) {
        if (text.includes(marker)) {
          violations.push(`file ${relativePath} contains ${marker}`);
        }
      }
    }
  }

  await walk(hostWorkDir);
  return violations;
}

async function loadMirroredContext(): Promise<{
  agentsText: string;
  systemPrompt: string;
  appendPrompt: string;
  skillText: string;
}> {
  const previousHome = process.env.HOME;
  const homeDir = mkdtempSync(path.join(tmpdir(), 'pi-symlink-home-'));
  const agentDir = mkdtempSync(path.join(tmpdir(), 'pi-symlink-agent-'));
  process.env.HOME = homeDir;
  const vfs = new PiWorkspaceVfs();
  mounted.push(vfs);
  vfs.mount(hostWorkDir, sandboxWorkDir);

  try {
    const resourceLoader = new DefaultResourceLoader({
      cwd: sandboxWorkDir,
      agentDir,
      settingsManager: SettingsManager.inMemory(),
      noExtensions: true,
      noThemes: true,
      noPromptTemplates: true,
      skillsOverride: base => ({
        ...base,
        skills: base.skills.filter(isKeptWorkspaceSkill),
      }),
    });
    await resourceLoader.reload();

    const agentsText = resourceLoader
      .getAgentsFiles()
      .agentsFiles.map(file => `${file.path}\n${file.content}`)
      .join('\n');
    const skills = resourceLoader
      .getSkills()
      .skills.filter(isKeptWorkspaceSkill);
    const skillText = skills
      .map(skill => {
        let body = '';
        try {
          body = readFileSync(skill.filePath, 'utf8');
        } catch {
          body = '';
        }
        return `${skill.filePath}\n${skill.description}\n${body}`;
      })
      .join('\n');

    return {
      agentsText,
      systemPrompt: resourceLoader.getSystemPrompt() ?? '',
      appendPrompt: resourceLoader.getAppendSystemPrompt().join('\n'),
      skillText,
    };
  } finally {
    process.env.HOME = previousHome;
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
}

function withoutTar(
  sandbox: Experimental_SandboxSession,
): Experimental_SandboxSession {
  return new Proxy(sandbox, {
    get(target, property, receiver) {
      if (property === 'run') {
        return async (args: { command: string }) => {
          if (args.command.startsWith('tar ')) {
            return { exitCode: 127, stdout: '', stderr: 'tar: not found\n' };
          }
          return target.run(args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function retargetAfterListing(
  sandbox: Experimental_SandboxSession,
  retarget: () => Promise<void>,
): Experimental_SandboxSession {
  let listed = false;
  return new Proxy(sandbox, {
    get(target, property, receiver) {
      if (property === 'run') {
        return async (args: { command: string }) => {
          if (!listed && !args.command.startsWith('tar ')) {
            const result = await target.run(args);
            listed = true;
            await retarget();
            return result;
          }
          await retarget();
          return target.run(args);
        };
      }
      if (property === 'readBinaryFile') {
        return async (args: { path: string }) => {
          await retarget();
          return target.readBinaryFile(args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function writeOutsideTree(
  sandbox: Experimental_SandboxSession,
): Promise<void> {
  await sandbox.run({
    command: [
      `mkdir -p ${outsideDir}/linked-skill/demo`,
      `mkdir -p ${outsideDir}/pi-tree/skills/demo`,
      `mkdir -p ${outsideDir}/agents-tree/skills/demo`,
      `mkdir -p ${sandboxWorkDir}/.pi/skills/escaped`,
      `mkdir -p ${sandboxWorkDir}/.agents/skills/leaked`,
    ].join(' && '),
  });

  await sandbox.writeTextFile({
    path: `${outsideDir}/agents-context.txt`,
    content: `${agentsMarker}\n`,
  });
  await sandbox.writeTextFile({
    path: `${outsideDir}/agents-md-context.txt`,
    content: `${agentsMdMarker}\n`,
  });
  await sandbox.writeTextFile({
    path: `${outsideDir}/system-prompt.txt`,
    content: `${systemMarker}\n`,
  });
  await sandbox.writeTextFile({
    path: `${outsideDir}/append-system.txt`,
    content: `${appendMarker}\n`,
  });
  await sandbox.writeTextFile({
    path: `${outsideDir}/skill.md`,
    content: skillFile(
      'leaked-agents',
      skillDescriptionMarker,
      skillBodyMarker,
    ),
  });
  await sandbox.writeTextFile({
    path: `${outsideDir}/pi-skill.md`,
    content: skillFile(
      'leaked-pi',
      piSkillDescriptionMarker,
      piSkillBodyMarker,
    ),
  });
  await sandbox.writeTextFile({
    path: `${outsideDir}/linked-skill/demo/SKILL.md`,
    content: skillFile(
      'leaked-dir',
      dirSkillDescriptionMarker,
      dirSkillBodyMarker,
    ),
  });
  await sandbox.writeTextFile({
    path: `${outsideDir}/pi-tree/SYSTEM.md`,
    content: `${piTreeSystemMarker}\n`,
  });
  await sandbox.writeTextFile({
    path: `${outsideDir}/pi-tree/skills/demo/SKILL.md`,
    content: skillFile(
      'leaked-pi-tree',
      piTreeSystemMarker,
      piTreeSystemMarker,
    ),
  });
  await sandbox.writeTextFile({
    path: `${outsideDir}/agents-tree/skills/demo/SKILL.md`,
    content: skillFile(
      'leaked-agents-tree',
      agentsTreeSkillDescriptionMarker,
      agentsTreeSkillBodyMarker,
    ),
  });

  const linkResult = await sandbox.run({
    command: [
      `ln -s ${outsideDir}/agents-context.txt ${sandboxWorkDir}/AGENTS.md`,
      `ln -s ../private/agents-md-context.txt ${sandboxWorkDir}/AGENTS.MD`,
      `ln -s ${outsideDir}/system-prompt.txt ${sandboxWorkDir}/.pi/SYSTEM.md`,
      `ln -s ../../private/append-system.txt ${sandboxWorkDir}/.pi/APPEND_SYSTEM.md`,
      `ln -s ${outsideDir}/skill.md ${sandboxWorkDir}/.agents/skills/leaked/SKILL.md`,
      `ln -s ${outsideDir}/pi-skill.md ${sandboxWorkDir}/.pi/skills/escaped/SKILL.md`,
      `ln -s ${outsideDir}/linked-skill ${sandboxWorkDir}/.agents/skills/from-outside`,
    ].join(' && '),
    workingDirectory: sandboxWorkDir,
  });
  expect(linkResult.exitCode).toBe(0);
}

async function writeOutsideConfigRoots(
  sandbox: Experimental_SandboxSession,
): Promise<void> {
  await sandbox.run({
    command: [
      `mkdir -p ${outsideDir}/pi-tree/skills/demo`,
      `mkdir -p ${outsideDir}/agents-tree/skills/demo`,
      `mkdir -p ${sandboxWorkDir}`,
    ].join(' && '),
  });
  await sandbox.writeTextFile({
    path: `${outsideDir}/pi-tree/SYSTEM.md`,
    content: `${piTreeSystemMarker}\n`,
  });
  await sandbox.writeTextFile({
    path: `${outsideDir}/pi-tree/APPEND_SYSTEM.md`,
    content: `${appendMarker}\n`,
  });
  await sandbox.writeTextFile({
    path: `${outsideDir}/pi-tree/skills/demo/SKILL.md`,
    content: skillFile(
      'leaked-pi-tree',
      piSkillDescriptionMarker,
      piSkillBodyMarker,
    ),
  });
  await sandbox.writeTextFile({
    path: `${outsideDir}/agents-tree/skills/demo/SKILL.md`,
    content: skillFile(
      'leaked-agents-tree',
      agentsTreeSkillDescriptionMarker,
      agentsTreeSkillBodyMarker,
    ),
  });
  await sandbox.writeTextFile({
    path: `${outsideDir}/agents-context.txt`,
    content: `${agentsMarker}\n`,
  });
  const linkResult = await sandbox.run({
    command: [
      `ln -s ${outsideDir}/pi-tree ${sandboxWorkDir}/.pi`,
      `ln -s ../private/agents-tree ${sandboxWorkDir}/.agents`,
      `ln -s ${outsideDir}/agents-context.txt ${sandboxWorkDir}/AGENTS.md`,
    ].join(' && '),
    workingDirectory: sandboxWorkDir,
  });
  expect(linkResult.exitCode).toBe(0);
}

async function expectNoEscapedDisclosure(
  sandbox: Experimental_SandboxSession,
  markers: string[],
): Promise<void> {
  await syncAllowingRefusal(sandbox);
  const violations = await escapedMirrorViolations(markers);
  const loaded = await loadMirroredContext();
  for (const marker of markers) {
    if (loaded.agentsText.includes(marker)) {
      violations.push(`context file contains ${marker}`);
    }
    if (loaded.systemPrompt.includes(marker)) {
      violations.push(`system prompt contains ${marker}`);
    }
    if (loaded.appendPrompt.includes(marker)) {
      violations.push(`append system prompt contains ${marker}`);
    }
    if (loaded.skillText.includes(marker)) {
      violations.push(`skill text contains ${marker}`);
    }
  }
  expect(violations).toEqual([]);
}

describe('sandbox symlink escape into the Pi workspace mirror', () => {
  it('does not copy file or directory symlink targets outside the workspace', async () => {
    const { sandbox, destroy } = await createSandbox();
    try {
      await writeOutsideTree(sandbox);
      await expectNoEscapedDisclosure(sandbox, [
        agentsMarker,
        agentsMdMarker,
        systemMarker,
        appendMarker,
        skillDescriptionMarker,
        skillBodyMarker,
        piSkillDescriptionMarker,
        piSkillBodyMarker,
        dirSkillDescriptionMarker,
        dirSkillBodyMarker,
      ]);
    } finally {
      await destroy();
    }
  }, 30_000);

  it('does not copy escaped symlink targets when tar is unavailable', async () => {
    const { sandbox, destroy } = await createSandbox();
    try {
      await writeOutsideTree(sandbox);
      await expectNoEscapedDisclosure(withoutTar(sandbox), [
        agentsMarker,
        agentsMdMarker,
        systemMarker,
        appendMarker,
        skillDescriptionMarker,
        skillBodyMarker,
        piSkillDescriptionMarker,
        piSkillBodyMarker,
        dirSkillDescriptionMarker,
        dirSkillBodyMarker,
      ]);
    } finally {
      await destroy();
    }
  }, 30_000);

  it('does not copy config directories that are symlinks to outside trees', async () => {
    const { sandbox, destroy } = await createSandbox();
    try {
      await writeOutsideConfigRoots(sandbox);
      await expectNoEscapedDisclosure(sandbox, [
        agentsMarker,
        appendMarker,
        piTreeSystemMarker,
        piSkillDescriptionMarker,
        piSkillBodyMarker,
        agentsTreeSkillDescriptionMarker,
        agentsTreeSkillBodyMarker,
      ]);
    } finally {
      await destroy();
    }
  }, 30_000);

  it('does not follow a symlink that moves outside the workspace after listing', async () => {
    const { sandbox, destroy } = await createSandbox();
    try {
      await sandbox.run({
        command: [
          `mkdir -p ${sandboxWorkDir}/.agents/skills/race`,
          `mkdir -p ${sandboxWorkDir}/.pi`,
          `mkdir -p ${outsideDir}`,
        ].join(' && '),
      });
      await sandbox.writeTextFile({
        path: `${sandboxWorkDir}/.agents/skills/race/real.md`,
        content: skillFile('inside-race', 'inside skill', insideRaceMarker),
      });
      await sandbox.writeTextFile({
        path: `${sandboxWorkDir}/inside-agents.md`,
        content: `${insideRaceMarker}\n`,
      });
      await sandbox.writeTextFile({
        path: `${outsideDir}/outside-skill.md`,
        content: skillFile(
          'outside-race',
          outsideRaceMarker,
          outsideRaceMarker,
        ),
      });
      await sandbox.writeTextFile({
        path: `${outsideDir}/outside-agents.md`,
        content: `${outsideRaceMarker}\n`,
      });
      const linkResult = await sandbox.run({
        command: [
          `ln -s real.md ${sandboxWorkDir}/.agents/skills/race/SKILL.md`,
          `ln -s inside-agents.md ${sandboxWorkDir}/AGENTS.md`,
        ].join(' && '),
        workingDirectory: sandboxWorkDir,
      });
      expect(linkResult.exitCode).toBe(0);

      let retargeted = false;
      const retarget = async () => {
        if (retargeted) return;
        retargeted = true;
        const result = await sandbox.run({
          command: [
            `ln -sfn ${outsideDir}/outside-skill.md ${sandboxWorkDir}/.agents/skills/race/SKILL.md`,
            `ln -sfn ${outsideDir}/outside-agents.md ${sandboxWorkDir}/AGENTS.md`,
          ].join(' && '),
        });
        expect(result.exitCode).toBe(0);
      };

      await expectNoEscapedDisclosure(retargetAfterListing(sandbox, retarget), [
        outsideRaceMarker,
      ]);
      expect(retargeted).toBe(true);
    } finally {
      await destroy();
    }
  }, 30_000);

  it('does not follow a retargeted symlink through the per-file read fallback', async () => {
    const { sandbox, destroy } = await createSandbox();
    try {
      await sandbox.run({
        command: `mkdir -p ${sandboxWorkDir}/.pi ${outsideDir}`,
      });
      await sandbox.writeTextFile({
        path: `${sandboxWorkDir}/inside-system.md`,
        content: `${insideRaceMarker}\n`,
      });
      await sandbox.writeTextFile({
        path: `${outsideDir}/outside-system.md`,
        content: `${outsideRaceMarker}\n`,
      });
      const linkResult = await sandbox.run({
        command: `ln -s inside-system.md ${sandboxWorkDir}/.pi/SYSTEM.md`,
        workingDirectory: sandboxWorkDir,
      });
      expect(linkResult.exitCode).toBe(0);

      let retargeted = false;
      const retarget = async () => {
        if (retargeted) return;
        retargeted = true;
        const result = await sandbox.run({
          command: `ln -sfn ${outsideDir}/outside-system.md ${sandboxWorkDir}/.pi/SYSTEM.md`,
        });
        expect(result.exitCode).toBe(0);
      };

      await expectNoEscapedDisclosure(
        withoutTar(retargetAfterListing(sandbox, retarget)),
        [outsideRaceMarker],
      );
      expect(retargeted).toBe(true);
    } finally {
      await destroy();
    }
  }, 30_000);

  it('does not load an AGENTS.MD symlink target as project context', async () => {
    const { sandbox, destroy } = await createSandbox();
    try {
      await sandbox.run({
        command: `mkdir -p ${sandboxWorkDir} ${outsideDir}`,
      });
      await sandbox.writeTextFile({
        path: `${outsideDir}/agents-md-only.txt`,
        content: `${agentsMdMarker}\n`,
      });
      const linkResult = await sandbox.run({
        command: `ln -s ${outsideDir}/agents-md-only.txt ${sandboxWorkDir}/AGENTS.MD`,
      });
      expect(linkResult.exitCode).toBe(0);
      await expectNoEscapedDisclosure(sandbox, [agentsMdMarker]);
    } finally {
      await destroy();
    }
  }, 30_000);

  it('rejects the same outside targets from read, list, and grep without reading them', async () => {
    const { sandbox, destroy } = await createSandbox();
    const reads: string[] = [];
    const commands: string[] = [];
    const recording = new Proxy(sandbox, {
      get(target, property, receiver) {
        if (property === 'run') {
          return async (args: { command: string }) => {
            commands.push(args.command);
            return target.run(args);
          };
        }
        if (property === 'readBinaryFile') {
          return async (args: { path: string }) => {
            reads.push(args.path);
            return target.readBinaryFile(args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    try {
      await writeOutsideTree(sandbox);
      const ops = createPiRemoteOps({
        sandbox: recording,
        paths: createPiPathMapper({
          hostWorkDir,
          sandboxWorkDir,
          readableRoots: [{ sandboxDir: readableSkillRoot }],
        }),
      });

      await expect(
        ops.readBuffer('.agents/skills/leaked/SKILL.md'),
      ).rejects.toThrow(/escapes the readable roots/);
      await expect(
        ops.listDirectory('.agents/skills/from-outside'),
      ).rejects.toThrow(/escapes the readable roots/);
      await expect(
        ops.grepFiles(skillBodyMarker, {
          path: '.pi/skills/escaped/SKILL.md',
        }),
      ).rejects.toThrow(/escapes the readable roots/);

      expect(reads).toEqual([]);
      expect(commands.some(command => command.includes(skillBodyMarker))).toBe(
        false,
      );
      expect(commands.some(command => command.includes(`${outsideDir}/`))).toBe(
        false,
      );
    } finally {
      await destroy();
    }
  }, 30_000);
});
