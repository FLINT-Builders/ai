import { lstat, realpath, stat } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

/*
 * Native Claude Code tools that write to a single file named in their input.
 * `allow-edits` auto-approves these only when that file stays inside the
 * session working directory: everything outside it (the harness bootstrap
 * with the bridge script and its node_modules, bridge state, the home
 * directory) is code or configuration the host or the CLI executes later.
 */
const FILE_EDIT_PATH_INPUTS: Readonly<Record<string, string>> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

/*
 * Paths inside the working directory that Claude Code itself treats as
 * sensitive and escalates to `canUseTool` even under `acceptEdits`, because
 * they configure hooks, MCP server commands, git hooks, or shell startup and
 * therefore run commands without a shell approval. Mirrors the lists in the
 * pinned `@anthropic-ai/claude-code` CLI; compared case-insensitively.
 */
const PROTECTED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  '.git',
  '.vscode',
  '.idea',
  '.claude',
  '.husky',
  '.cargo',
  '.devcontainer',
  '.yarn',
  '.mvn',
]);

const PROTECTED_FILE_NAMES: ReadonlySet<string> = new Set([
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.zshenv',
  '.zlogin',
  '.zlogout',
  '.bash_login',
  '.bash_aliases',
  '.bash_logout',
  '.envrc',
  '.ripgreprc',
  '.mcp.json',
  '.claude.json',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.pnp.cjs',
  '.pnp.loader.mjs',
  '.pnpmfile.cjs',
  'bunfig.toml',
  '.bunfig.toml',
  '.bazelrc',
  '.bazelversion',
  '.bazeliskrc',
  '.pre-commit-config.yaml',
  'lefthook.yml',
  '.lefthook.yml',
  'lefthook.yaml',
  '.lefthook.yaml',
  'gradle-wrapper.properties',
  'maven-wrapper.properties',
  '.devcontainer.json',
  'pyrightconfig.json',
]);

/**
 * Decide whether a native tool call may be auto-approved under `allow-edits`
 * without asking the host.
 *
 * Returns the input to run the tool with, or `undefined` when the call needs
 * host approval. For file edit tools the returned input names the file by its
 * resolved location inside the working directory, so the CLI writes the file
 * that was checked rather than re-resolving a symlink chain.
 */
export async function scopeAutoApprovedEdit({
  toolName,
  toolInput,
  workdir,
}: {
  toolName: string;
  toolInput: Record<string, unknown>;
  workdir: string;
}): Promise<Record<string, unknown> | undefined> {
  const pathKey = FILE_EDIT_PATH_INPUTS[toolName];
  if (pathKey == null) return toolInput;

  const requestedPath = toolInput[pathKey];
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
    return undefined;
  }
  // `~` is expanded by the CLI, not by `path.resolve`, and `..` after a
  // symlinked segment resolves differently on disk than lexically.
  if (
    requestedPath.startsWith('~') ||
    requestedPath.split(/[\\/]/).includes('..')
  ) {
    return undefined;
  }

  try {
    const root = await realpath(workdir);
    const target = await resolveExistingTarget(resolve(workdir, requestedPath));
    if (target == null) return undefined;

    const relativeTarget = relative(root, target);
    if (
      relativeTarget === '' ||
      relativeTarget === '..' ||
      relativeTarget.startsWith(`..${sep}`) ||
      isAbsolute(relativeTarget)
    ) {
      return undefined;
    }

    const segments = relativeTarget.split(sep).map(s => s.toLowerCase());
    if (
      segments.some(segment => PROTECTED_DIRECTORY_NAMES.has(segment)) ||
      PROTECTED_FILE_NAMES.has(segments[segments.length - 1]) ||
      segments.some(
        (segment, index) =>
          segment === '.config' && segments[index + 1] === 'git',
      )
    ) {
      return undefined;
    }

    const scopedPath = join(workdir, relativeTarget);
    return scopedPath === requestedPath
      ? toolInput
      : { ...toolInput, [pathKey]: scopedPath };
  } catch {
    return undefined;
  }
}

/*
 * Resolve every symlink on the way to `path`. A file that does not exist yet
 * resolves through its deepest existing ancestor. Returns `undefined` when the
 * location cannot be pinned down: a dangling symlink (writing through it
 * creates its target wherever it points) or a regular file with more than one
 * hard link (writing it changes the other names too).
 */
async function resolveExistingTarget(
  path: string,
): Promise<string | undefined> {
  const missingTail: string[] = [];
  let current = path;
  for (;;) {
    try {
      const resolved = await realpath(current);
      if (missingTail.length === 0) {
        const stats = await stat(resolved);
        if (stats.isFile() && stats.nlink > 1) return undefined;
      }
      return join(resolved, ...missingTail.reverse());
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      if (await pathEntryExists(current)) return undefined;
      const parent = dirname(current);
      if (parent === current) throw error;
      missingTail.push(basename(current));
      current = parent;
    }
  }
}

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error != null &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}
