import { shellQuote } from './shell-quote';

export type VerifiedArchivePlatform =
  | 'linux-x64'
  | 'linux-arm64'
  | 'darwin-x64'
  | 'darwin-arm64';

export type VerifiedArchive = {
  /**
   * HTTPS URL of a gzip-compressed tar archive for one immutable release.
   */
  readonly url: string;
  /**
   * Lowercase hexadecimal SHA-256 digest of the archive. The archive is
   * extracted only when the downloaded bytes match this digest.
   */
  readonly sha256: string;
};

export type VerifiedArchiveInstallCommandOptions = {
  /**
   * Pinned archive for each supported sandbox platform. Installation fails on
   * platforms without an entry.
   */
  readonly archives: Readonly<
    Partial<Record<VerifiedArchivePlatform, VerifiedArchive>>
  >;
  /**
   * Relative directory below `$HOME` that receives the extracted archive.
   */
  readonly installDir: string;
  /**
   * Number of leading path components removed from archive entries.
   */
  readonly stripComponents?: number;
  /**
   * Executables linked into `$HOME/.local/bin`, keyed by command name, with
   * values relative to `installDir`.
   */
  readonly executables: Readonly<Record<string, string>>;
};

const PLATFORM_PATTERNS: Record<VerifiedArchivePlatform, string> = {
  'linux-x64': 'Linux-x86_64|Linux-amd64',
  'linux-arm64': 'Linux-aarch64|Linux-arm64',
  'darwin-x64': 'Darwin-x86_64',
  'darwin-arm64': 'Darwin-arm64|Darwin-aarch64',
};

const SHA256_REGEXP = /^[0-9a-f]{64}$/;
const EXECUTABLE_NAME_REGEXP = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PATH_SEGMENT_REGEXP = /^[A-Za-z0-9._-]+$/;

/**
 * Creates a Bash command that downloads a pinned release archive, verifies its
 * SHA-256 digest against the value supplied here, and only then extracts it.
 * The archive is downloaded once into a private temporary directory, and the
 * verified file is the one that is extracted.
 */
export function createVerifiedArchiveInstallCommand({
  archives,
  installDir,
  stripComponents = 0,
  executables,
}: VerifiedArchiveInstallCommandOptions): string {
  const platforms = (
    Object.keys(PLATFORM_PATTERNS) as VerifiedArchivePlatform[]
  ).filter(platform => archives[platform] != null);
  if (platforms.length === 0) {
    throw new Error('Verified archive install requires at least one archive.');
  }
  for (const platform of platforms) {
    const { url, sha256 } = archives[platform]!;
    if (!url.startsWith('https://')) {
      throw new Error(
        `Verified archive URL for ${platform} must use HTTPS; received ${JSON.stringify(url)}.`,
      );
    }
    if (!SHA256_REGEXP.test(sha256)) {
      throw new Error(
        `Verified archive SHA-256 for ${platform} must be 64 lowercase hexadecimal characters.`,
      );
    }
  }
  validateRelativePath({ name: 'installDir', path: installDir });
  if (!Number.isInteger(stripComponents) || stripComponents < 0) {
    throw new Error(
      'Verified archive stripComponents must be a non-negative integer.',
    );
  }
  const executableEntries = Object.entries(executables);
  if (executableEntries.length === 0) {
    throw new Error(
      'Verified archive install requires at least one executable.',
    );
  }
  for (const [name, path] of executableEntries) {
    if (!EXECUTABLE_NAME_REGEXP.test(name)) {
      throw new Error(
        `Verified archive executable name is invalid: ${JSON.stringify(name)}.`,
      );
    }
    validateRelativePath({ name: `executables.${name}`, path });
  }

  const platformCases = platforms.map(platform => {
    const { url, sha256 } = archives[platform]!;
    return `  ${PLATFORM_PATTERNS[platform]}) archive_url=${shellQuote(url)}; archive_sha256=${shellQuote(sha256)} ;;`;
  });
  const links = executableEntries.map(
    ([name, path]) =>
      `ln -sfn "$install_dir/"${shellQuote(path)} "$HOME/.local/bin/"${shellQuote(name)}`,
  );

  return [
    '(',
    'set -euo pipefail',
    'case "$(uname -s)-$(uname -m)" in',
    ...platformCases,
    `  *) printf 'Unsupported platform: %s\\n' "$(uname -s)-$(uname -m)" >&2; exit 1 ;;`,
    'esac',
    'download_dir="$(mktemp -d)"',
    `trap 'rm -rf "$download_dir"' EXIT`,
    'archive="$download_dir/archive.tar.gz"',
    'if command -v curl >/dev/null 2>&1; then',
    `  curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 -o "$archive" "$archive_url"`,
    'elif command -v wget >/dev/null 2>&1; then',
    '  wget -q --https-only -O "$archive" "$archive_url"',
    'else',
    `  printf 'curl or wget is required\\n' >&2; exit 1`,
    'fi',
    'if command -v sha256sum >/dev/null 2>&1; then',
    `  actual_sha256="$(sha256sum "$archive" | cut -d ' ' -f 1)"`,
    'elif command -v shasum >/dev/null 2>&1; then',
    `  actual_sha256="$(shasum -a 256 "$archive" | cut -d ' ' -f 1)"`,
    'else',
    `  printf 'sha256sum or shasum is required\\n' >&2; exit 1`,
    'fi',
    'if [ "$actual_sha256" != "$archive_sha256" ]; then',
    `  printf 'SHA-256 mismatch for %s: expected %s, received %s\\n' "$archive_url" "$archive_sha256" "$actual_sha256" >&2`,
    '  exit 1',
    'fi',
    'mkdir "$download_dir/extract"',
    `tar${stripComponents > 0 ? ` --strip-components=${stripComponents}` : ''} -xzf "$archive" -C "$download_dir/extract"`,
    `install_dir="$HOME/"${shellQuote(installDir)}`,
    'rm -rf "$install_dir"',
    'mkdir -p "$(dirname "$install_dir")" "$HOME/.local/bin"',
    'mv "$download_dir/extract" "$install_dir"',
    ...links,
    ')',
  ].join('\n');
}

function validateRelativePath({
  name,
  path,
}: {
  name: string;
  path: string;
}): void {
  const segments = path.split('/');
  if (
    segments.some(
      segment =>
        !PATH_SEGMENT_REGEXP.test(segment) ||
        segment === '.' ||
        segment === '..',
    )
  ) {
    throw new Error(
      `Verified archive ${name} must be a relative path without "." or ".." segments; received ${JSON.stringify(path)}.`,
    );
  }
}
