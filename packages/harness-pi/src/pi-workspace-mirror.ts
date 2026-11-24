import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { shellQuote } from '@ai-sdk/harness/utils';
import type { Experimental_SandboxSession } from '@ai-sdk/provider-utils';

/*
 * Pi runs on the host with its working directory pointed at the local mirror,
 * but the only thing it reads from that directory is its own resource
 * configuration: the `.pi` and `.agents` directories (skills, prompts, themes,
 * extensions) and the root-level agent context files (`AGENTS.md`). The model
 * never reads workspace source through the host — file reads, directory
 * listings, and greps all run as tools against the sandbox. Mirroring the whole
 * sandbox workspace to the host would therefore copy files Pi never looks at,
 * one `readBinaryFile` round-trip per file. For a real project that has been
 * cloned and had its dependencies installed (hundreds of thousands of files
 * under `node_modules`) that makes session startup take hours. The mirror is
 * consequently scoped to exactly the paths Pi's resource loader consults.
 *
 * Within those config directories, symlinks are resolved and their targets
 * copied as real files. `.agents/skills` is frequently a symlink to a `skills`
 * directory living elsewhere in the workspace; a mirrored symlink would dangle
 * because its target falls outside the scoped mirror, so the linked content is
 * walked and copied verbatim instead.
 */
const PI_CONFIG_DIRS = ['.pi', '.agents'] as const;
const PI_CONTEXT_FILENAMES = ['AGENTS.md', 'AGENTS.MD'] as const;

/*
 * The mirror runs on session start and again on every turn, so its cost must
 * not scale with the number of files in scope. Reading one file per
 * `readBinaryFile` call turns a `.agents/skills` tree of a few thousand
 * `SKILL.md` files into a few thousand sequential round trips per turn, which
 * exhausts the request budget of any sandbox whose filesystem calls are network
 * calls: the report behind this code saw `429 Rate limit exceeded` from a
 * MicroVM proxy long before a sync finished. Files are therefore transferred in
 * batches as a single gzipped tar archive per batch, which is one request for a
 * few hundred files instead of one request per file. Sandboxes without `tar`
 * or `gzip` fall back to one `head -c | base64` read per file.
 */
export const ARCHIVE_BATCH_SIZE = 300;
const TAR_BLOCK_SIZE = 512;

/*
 * Everything in the mirrored scope is sandbox-controlled, and the mirror runs
 * in the host process before every turn. A large but highly compressible file
 * (for example a sparse file made with `truncate`) costs the sandbox nothing
 * to produce and only a few kilobytes of gzip to transfer, so the bytes the
 * host accepts must be bounded by these budgets rather than by the transfer
 * size. Pi only loads small text resources from this scope; files over the
 * per-file budget, and the largest files of a batch or sync that would exceed
 * the batch or total budget, are left out of the mirror.
 *
 * Sizes reported by the sandbox listing are only used to plan batches. Every
 * read enforces the planned size on the bytes it actually receives, because
 * the file can change between the listing and the read.
 */
export const MAX_MIRRORED_FILE_BYTES = 1024 * 1024;
export const MAX_ARCHIVE_BATCH_BYTES = 2 * 1024 * 1024;
export const MAX_MIRRORED_TOTAL_BYTES = 32 * 1024 * 1024;

interface RemoteFile {
  relativePath: string;
  sandboxPath: string;
  /** Size reported by the sandbox listing; `undefined` when unparseable. */
  listedSize: number | undefined;
}

interface PlannedFile extends RemoteFile {
  listedSize: number;
}

function normalizeRelativePath(inputPath: string): string {
  const normalized = inputPath.split(path.posix.sep).join(path.sep);
  const relative = path.normalize(normalized);
  if (
    relative === '' ||
    relative === '.' ||
    path.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error(
      `Sandbox workspace mirror received an invalid relative path: ${inputPath}`,
    );
  }
  return relative;
}

async function readCommandOutput(
  sandbox: Experimental_SandboxSession,
  command: string,
): Promise<string> {
  const result = await sandbox.run({ command });
  if (result.exitCode != null && result.exitCode !== 0) {
    throw new Error(
      result.stderr ||
        result.stdout ||
        `Sandbox command failed with exit code ${result.exitCode}`,
    );
  }
  return result.stdout || result.stderr;
}

async function listRemoteWorkspaceEntries(
  sandbox: Experimental_SandboxSession,
  sandboxWorkDir: string,
): Promise<{
  directories: string[];
  files: RemoteFile[];
}> {
  // Enumerate only the `.pi`/`.agents` config subtrees plus the root-level
  // context files — never the rest of the workspace. Use shell glob traversal
  // instead of `find -L`, which is not supported by all sandbox shells.
  // Resolve each scoped root path component explicitly with `readlink`,
  // retaining both the scoped mirror path and the resolved sandbox path. Once
  // a root is resolved, queued descendants use physical parent paths and only
  // need resolution when the descendant itself is a symlink. This avoids
  // relying on shells that can inspect a symlinked directory but cannot
  // traverse paths below it, including when the symlink is an ancestor of the
  // sandbox work directory, without repeatedly resolving every component of
  // deep ordinary paths.
  const scopedPaths = [
    ...PI_CONFIG_DIRS.map(dir => `./${dir}`),
    ...PI_CONTEXT_FILENAMES.map(name => `./${name}`),
  ];
  const listCommand = [
    `pi_config_sources=(${scopedPaths
      .map(scopedPath =>
        shellQuote(path.posix.join(sandboxWorkDir, scopedPath.slice(2))),
      )
      .join(' ')})`,
    `pi_config_relatives=(${scopedPaths
      .map(scopedPath => shellQuote(scopedPath.slice(2)))
      .join(' ')})`,
    `pi_config_ancestors=(${scopedPaths.map(() => "''").join(' ')})`,
    `pi_config_resolve_ancestors=(${scopedPaths.map(() => '1').join(' ')})`,
    'pi_config_index=0',
    'while [ "$pi_config_index" -lt "${#pi_config_sources[@]}" ]; do',
    '  source=${pi_config_sources[$pi_config_index]}',
    '  relative=${pi_config_relatives[$pi_config_index]}',
    '  ancestors=${pi_config_ancestors[$pi_config_index]}',
    '  resolve_ancestors=${pi_config_resolve_ancestors[$pi_config_index]}',
    '  pi_config_index=$((pi_config_index + 1))',
    '  if [ "$resolve_ancestors" = 1 ] || [ -L "$source" ]; then',
    '    pending=$source',
    '    resolved=',
    '    seen_links=',
    '    case "$pending" in',
    '      /*) ;;',
    '      *) pending=$PWD/$pending ;;',
    '    esac',
    '    while [ -n "$pending" ]; do',
    '      pending=${pending#/}',
    '      [ -n "$pending" ] || break',
    '      component=${pending%%/*}',
    '      if [ "$pending" = "$component" ]; then',
    '        pending=',
    '      else',
    '        pending=${pending#*/}',
    '      fi',
    '      case "$component" in',
    '        ""|.) continue ;;',
    '        ..)',
    '          resolved=${resolved%/*}',
    '          continue',
    '          ;;',
    '      esac',
    '      candidate=$resolved/$component',
    '      if [ -L "$candidate" ]; then',
    '        case "$seen_links" in',
    '          *"',
    '"$candidate"',
    '"*)',
    `            printf 'Pi config traversal encountered a symlink cycle at %s\\n' "$candidate" >&2`,
    '            exit 1',
    '            ;;',
    '        esac',
    '        seen_links=$seen_links"',
    '"$candidate"',
    '"',
    '        target=$(readlink "$candidate") || exit $?',
    '        case "$target" in',
    '          /*) pending=$target${pending:+/$pending} ;;',
    '          *) pending=${candidate%/*}/$target${pending:+/$pending} ;;',
    '        esac',
    '        resolved=',
    '      else',
    '        resolved=$candidate',
    '      fi',
    '    done',
    '    if [ -z "$resolved" ]; then',
    `      printf 'Pi config traversal resolved %s to the filesystem root; skipping\\n' "$relative" >&2`,
    '      continue',
    '    fi',
    '    source=$resolved',
    '  fi',
    '  if [ -d "$source" ]; then',
    '    case "$ancestors" in',
    '      *"',
    '"$source"',
    '"*)',
    `        printf 'Pi config traversal encountered a symlink cycle at %s\\n' "$relative" >&2`,
    '        exit 1',
    '        ;;',
    '    esac',
    '    ancestors=$ancestors"',
    '"$source"',
    '"',
    `    printf 'd\\t%s\\n' "$relative"`,
    '    for child in "$source"/* "$source"/.[!.]* "$source"/..?*; do',
    '      if [ -L "$child" ] || [ -d "$child" ] || [ -f "$child" ]; then',
    '        child_name=${child##*/}',
    '        pi_config_sources+=("$child")',
    '        pi_config_relatives+=("$relative/$child_name")',
    '        pi_config_ancestors+=("$ancestors")',
    '        pi_config_resolve_ancestors+=(0)',
    '      fi',
    '    done',
    '  elif [ -f "$source" ]; then',
    '    pi_config_file_relatives+=("$relative")',
    '    pi_config_file_sources+=("$source")',
    '  fi',
    '  true',
    'done',
    // Report sizes with one `stat` per chunk rather than one process per
    // file; fall back to per-file `stat`/`wc` (one line each) when a chunk
    // fails, so every file still gets exactly one size line.
    'pi_config_file_index=0',
    'while [ "$pi_config_file_index" -lt "${#pi_config_file_sources[@]}" ]; do',
    `  pi_config_file_chunk=("\${pi_config_file_sources[@]:$pi_config_file_index:${ARCHIVE_BATCH_SIZE}}")`,
    '  if ! pi_config_file_sizes=$(stat -c %s -- "${pi_config_file_chunk[@]}" 2>/dev/null); then',
    '    pi_config_file_sizes=$(for file in "${pi_config_file_chunk[@]}"; do stat -c %s -- "$file" 2>/dev/null || wc -c < "$file" 2>/dev/null || echo -; done)',
    '  fi',
    '  while IFS= read -r size; do',
    `    printf 'f\\t%s\\t%s\\t%s\\n' "\${pi_config_file_relatives[$pi_config_file_index]}" "$size" "\${pi_config_file_sources[$pi_config_file_index]}"`,
    '    pi_config_file_index=$((pi_config_file_index + 1))',
    '  done <<< "$pi_config_file_sizes"',
    'done',
    'true',
  ].join('\n');

  const output = await readCommandOutput(
    sandbox,
    [`cd ${shellQuote(sandboxWorkDir)}`, listCommand].join(' && '),
  );

  const directories: string[] = [];
  const files: RemoteFile[] = [];

  for (const line of output.split('\n').filter(Boolean)) {
    const [kind, rawPath, rawSize, sandboxPath] = line.split('\t', 4);
    if (!rawPath) continue;

    const relativePath = normalizeRelativePath(rawPath);
    if (kind === 'd') directories.push(relativePath);
    else if (kind === 'f' && sandboxPath) {
      const size = Number(rawSize?.trim());
      files.push({
        relativePath,
        sandboxPath,
        listedSize:
          rawSize?.trim() !== '' && Number.isSafeInteger(size) && size >= 0
            ? size
            : undefined,
      });
    }
  }

  return { directories, files };
}

function readTarString(header: Buffer, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

/**
 * Extract the regular files from a ustar archive, keyed by member name.
 * Supports the `prefix` field, GNU long-name (`L`) entries, and pax (`x`)
 * `path` records, which is how the common tar implementations spell a member
 * path longer than 100 characters.
 */
function parseTarFiles(archive: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let overrideName: string | undefined;
  let offset = 0;

  while (offset + TAR_BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every(byte => byte === 0)) break;

    const size = Number.parseInt(
      readTarString(header, 124, 12).trim() || '0',
      8,
    );
    const typeFlag = String.fromCharCode(header[156] as number);
    const dataStart = offset + TAR_BLOCK_SIZE;
    const data = archive.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;

    if (typeFlag === 'L') {
      overrideName = readTarString(data, 0, data.length);
      continue;
    }
    if (typeFlag === 'x' || typeFlag === 'X') {
      const pathRecord = data
        .toString('utf8')
        .split('\n')
        .map(record => /^\d+ path=(.*)$/.exec(record)?.[1])
        .find(value => value != null);
      if (pathRecord != null) overrideName = pathRecord;
      continue;
    }

    if (typeFlag === '0' || typeFlag === '\0') {
      const name = readTarString(header, 0, 100);
      const prefix = readTarString(header, 345, 155);
      files.set(
        overrideName ?? (prefix === '' ? name : `${prefix}/${name}`),
        Buffer.from(data),
      );
    }
    overrideName = undefined;
  }

  return files;
}

function roundUpToTarBlock(bytes: number): number {
  return Math.ceil(bytes / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
}

/**
 * Upper bound on the tar bytes a member adds beyond its content: the header,
 * the content padding, and one extended header (GNU long name or pax records)
 * carrying the member name.
 */
function tarMemberOverheadBytes(member: string): number {
  return (
    3 * TAR_BLOCK_SIZE +
    roundUpToTarBlock(Buffer.byteLength(member, 'utf8') + TAR_BLOCK_SIZE)
  );
}

/** End-of-archive blocks plus padding up to tar's default 10240-byte record. */
const TAR_ARCHIVE_TRAILER_BYTES = 22 * TAR_BLOCK_SIZE;

function maxBase64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/**
 * Decode base64 command output, refusing anything that would decode to more
 * than `maxBytes`. `base64` wraps lines, so whitespace is allowed for.
 */
function decodeBoundedBase64(
  output: string,
  maxBytes: number,
): Buffer | undefined {
  const maxEncoded = maxBase64Length(maxBytes);
  if (output.length > maxEncoded + Math.ceil(maxEncoded / 64) + 16) {
    return undefined;
  }
  const encoded = output.replace(/\s+/g, '');
  if (encoded.length > maxEncoded) return undefined;
  const decoded = Buffer.from(encoded, 'base64');
  return decoded.length > maxBytes ? undefined : decoded;
}

/**
 * Transfer a batch of sandbox files with a single command. Returns the decoded
 * contents keyed by the requested sandbox path, leaving out anything the
 * sandbox could not archive (no `tar`/`gzip`/`base64`, a file that vanished
 * mid-sync, or a file that no longer matches its listed size) so the caller
 * can fall back to a per-file read.
 */
async function readSandboxFilesAsArchive(
  sandbox: Experimental_SandboxSession,
  files: PlannedFile[],
): Promise<Map<string, Buffer>> {
  // Archive relative to `/` so member names are the requested absolute paths
  // without their leading slash, wherever the files live: the traversal
  // resolves symlinks, so these paths can point outside the workspace.
  const members = files.map(file => file.sandboxPath.replace(/^\/+/, ''));
  const maxTarBytes =
    files.reduce((total, file) => total + file.listedSize, 0) +
    members.reduce(
      (total, member) => total + tarMemberOverheadBytes(member),
      0,
    ) +
    TAR_ARCHIVE_TRAILER_BYTES;
  // Deflate never expands its input by more than a fraction of a percent plus
  // a fixed header, so a well-formed archive within `maxTarBytes` always fits.
  const maxGzipBytes = maxTarBytes + Math.ceil(maxTarBytes / 100) + 1024;
  const command = `tar -C / -czf - -- ${members
    .map(shellQuote)
    .join(' ')} 2>/dev/null | head -c ${maxGzipBytes + 1} | base64`;

  let result: { exitCode: number; stdout: string };
  try {
    result = await sandbox.run({ command });
  } catch {
    return new Map();
  }
  if (result.exitCode != null && result.exitCode !== 0) return new Map();

  const compressed = decodeBoundedBase64(result.stdout, maxGzipBytes);
  if (compressed == null || compressed.length === 0) return new Map();

  let entries: Map<string, Buffer>;
  try {
    entries = parseTarFiles(
      gunzipSync(compressed, { maxOutputLength: maxTarBytes }),
    );
  } catch {
    return new Map();
  }

  const contents = new Map<string, Buffer>();
  for (const [index, member] of members.entries()) {
    const file = files[index] as PlannedFile;
    const content = entries.get(member);
    if (content != null && content.length <= file.listedSize) {
      contents.set(file.sandboxPath, content);
    }
  }
  return contents;
}

/**
 * Read one sandbox file, accepting at most `maxBytes`. Returns `'oversized'`
 * when the file holds more than that, which the sandbox reveals by sending one
 * byte past the limit.
 */
async function readSandboxFileBounded(
  sandbox: Experimental_SandboxSession,
  sandboxPath: string,
  maxBytes: number,
): Promise<Buffer | 'missing' | 'oversized'> {
  const quotedPath = shellQuote(sandboxPath);
  const result = await sandbox.run({
    command: `[ -f ${quotedPath} ] || exit 3; head -c ${maxBytes + 1} ${quotedPath} | base64`,
  });
  if (result.exitCode === 3) return 'missing';
  if (result.exitCode != null && result.exitCode !== 0) {
    throw new Error(
      `Sandbox workspace mirror could not read ${sandboxPath}: ${(
        result.stderr || `exit code ${result.exitCode}`
      ).slice(0, 500)}`,
    );
  }
  return decodeBoundedBase64(result.stdout, maxBytes) ?? 'oversized';
}

/**
 * Split the listed files into archive batches of at most `ARCHIVE_BATCH_SIZE`
 * files and `MAX_ARCHIVE_BATCH_BYTES` listed bytes, within
 * `MAX_MIRRORED_TOTAL_BYTES` overall. Within a batch the smallest files are
 * admitted first, so oversized assets are what gets left out rather than the
 * small resource files Pi actually loads.
 */
function planArchiveBatches(files: RemoteFile[]): PlannedFile[][] {
  const batches: PlannedFile[][] = [];
  let totalBytes = 0;

  for (let offset = 0; offset < files.length; offset += ARCHIVE_BATCH_SIZE) {
    const candidates = files
      .slice(offset, offset + ARCHIVE_BATCH_SIZE)
      .filter(
        (file): file is PlannedFile =>
          file.listedSize != null &&
          file.listedSize <= MAX_MIRRORED_FILE_BYTES &&
          file.sandboxPath.startsWith('/'),
      )
      .sort((left, right) => left.listedSize - right.listedSize);

    const batch: PlannedFile[] = [];
    let batchBytes = 0;
    for (const file of candidates) {
      if (
        batchBytes + file.listedSize > MAX_ARCHIVE_BATCH_BYTES ||
        totalBytes + file.listedSize > MAX_MIRRORED_TOTAL_BYTES
      ) {
        break;
      }
      batch.push(file);
      batchBytes += file.listedSize;
      totalBytes += file.listedSize;
    }
    if (batch.length > 0) batches.push(batch);
  }

  return batches;
}

async function pathKind(
  target: string,
): Promise<'file' | 'directory' | undefined> {
  try {
    const stats = await stat(target);
    if (stats.isDirectory()) return 'directory';
    if (stats.isFile()) return 'file';
    return undefined;
  } catch {
    return undefined;
  }
}

async function collectHostSubtree(
  rootDir: string,
  currentDir: string,
  directories: string[],
  files: string[],
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, absolutePath);
    if (entry.isDirectory()) {
      directories.push(relativePath);
      await collectHostSubtree(rootDir, absolutePath, directories, files);
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
}

/**
 * Enumerate the locally-mirrored entries that fall within Pi's scope: the
 * `.pi`/`.agents` config subtrees and the root-level context files. Anything
 * else on the local side (it should not normally exist) is intentionally
 * ignored so the reconcile below neither copies nor deletes it.
 */
async function collectHostScopedEntries(
  rootDir: string,
): Promise<{ directories: string[]; files: string[] }> {
  const directories: string[] = [];
  const files: string[] = [];

  for (const dir of PI_CONFIG_DIRS) {
    const configDir = path.join(rootDir, dir);
    if ((await pathKind(configDir)) === 'directory') {
      directories.push(dir);
      await collectHostSubtree(rootDir, configDir, directories, files);
    }
  }

  for (const name of PI_CONTEXT_FILENAMES) {
    if ((await pathKind(path.join(rootDir, name))) === 'file') {
      files.push(name);
    }
  }

  return { directories, files };
}

function buildRequiredDirectories(
  remoteDirectories: string[],
  remoteFiles: Array<{ relativePath: string }>,
): Set<string> {
  const directories = new Set<string>();
  for (const directory of remoteDirectories) {
    directories.add(normalizeRelativePath(directory));
  }
  for (const file of remoteFiles) {
    let current = path.dirname(normalizeRelativePath(file.relativePath));
    while (current !== '.' && current !== path.sep && current.length > 0) {
      directories.add(current);
      current = path.dirname(current);
    }
  }
  return directories;
}

export async function syncHostWorkspaceFromSandbox(args: {
  sandbox: Experimental_SandboxSession;
  sandboxWorkDir: string;
  hostWorkDir: string;
}): Promise<void> {
  const { sandbox, sandboxWorkDir, hostWorkDir } = args;
  const remoteEntries = await listRemoteWorkspaceEntries(
    sandbox,
    sandboxWorkDir,
  );
  const hostEntries = await collectHostScopedEntries(hostWorkDir);
  const batches = planArchiveBatches(remoteEntries.files);
  const remoteFiles = new Set(
    batches.flatMap(batch => batch.map(file => file.relativePath)),
  );
  const requiredDirectories = buildRequiredDirectories(
    remoteEntries.directories,
    remoteEntries.files,
  );

  for (const relativePath of hostEntries.files) {
    if (!remoteFiles.has(relativePath)) {
      await rm(path.join(hostWorkDir, relativePath), { force: true });
    }
  }

  const removableDirectories = [...hostEntries.directories]
    .filter(p => !requiredDirectories.has(p))
    .sort((a, b) => b.length - a.length);
  for (const relativePath of removableDirectories) {
    await rm(path.join(hostWorkDir, relativePath), {
      recursive: true,
      force: true,
    });
  }

  for (const relativePath of [...requiredDirectories].sort(
    (a, b) => a.length - b.length,
  )) {
    await mkdir(path.join(hostWorkDir, relativePath), { recursive: true });
  }

  for (const batch of batches) {
    const archived = await readSandboxFilesAsArchive(sandbox, batch);

    for (const { relativePath, sandboxPath, listedSize } of batch) {
      const hostPath = path.join(hostWorkDir, relativePath);
      let content = archived.get(sandboxPath);
      if (content == null) {
        const read = await readSandboxFileBounded(
          sandbox,
          sandboxPath,
          listedSize,
        );
        if (read === 'missing') {
          throw new Error(
            `Sandbox workspace file disappeared during mirror sync: ${sandboxPath}`,
          );
        }
        if (read === 'oversized') {
          await rm(hostPath, { force: true });
          continue;
        }
        content = read;
      }

      let shouldWrite = true;
      try {
        shouldWrite =
          (await stat(hostPath)).size !== content.length ||
          !(await readFile(hostPath)).equals(content);
      } catch {
        shouldWrite = true;
      }

      if (shouldWrite) {
        await mkdir(path.dirname(hostPath), { recursive: true });
        await writeFile(hostPath, content);
      }
    }
  }
}

export async function writeHostWorkspaceFile(
  hostWorkDir: string,
  relativePath: string,
  content: Buffer,
): Promise<void> {
  const normalizedPath = normalizeRelativePath(relativePath);
  const hostPath = path.join(hostWorkDir, normalizedPath);
  await mkdir(path.dirname(hostPath), { recursive: true });
  await writeFile(hostPath, content);
}
