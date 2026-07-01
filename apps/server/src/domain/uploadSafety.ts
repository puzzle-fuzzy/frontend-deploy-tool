/**
 * Pure deny-list check for upload entries. Returns a short reason string when
 * `relativePath` is dangerous, or `null` when it is safe. `relativePath` uses
 * the form already produced by `extractZip` (zip entry names) and
 * `writeFolderFiles` (normalized `webkitRelativePath`): POSIX separators, no
 * leading separator.
 *
 * Matching is segment- and basename-based (not a naive substring) so filenames
 * like `greenhouse.js` or `env-config.js` are not false-positive'd. It is
 * case-sensitive in v1 (build outputs are conventionally lowercase).
 *
 * OS junk (`.DS_Store`, `__MACOSX`, `._*`) is intentionally NOT handled here —
 * `isSystemMetadata` in artifactService owns that. This predicate is concerned
 * only with content that must never be deployed (secrets, VCS, dependencies).
 */

export const BLOCKED_FILE_RULES = {
  /** Any path segment equal to one of these blocks the upload. */
  vcsDirs: ['.git', '.svn', '.hg'],
  depDirs: ['node_modules'],
  /** Matched as an exact basename, or any basename starting with this + `.`. */
  envFile: '.env',
  /** Matched as a basename suffix. */
  keyExtensions: ['.pem', '.key'],
  /** Matched as an exact basename. */
  sshKeys: ['id_rsa', 'id_rsa.pub'],
};

/** @returns a short reason string when `relativePath` is blocked, else `null`. */
export function matchBlockedPath(relativePath: string): string | null {
  const segments = relativePath.split('/');
  const basename = segments.at(-1) ?? '';

  for (const segment of segments) {
    if (BLOCKED_FILE_RULES.vcsDirs.includes(segment)) {
      return 'VCS directory';
    }
    if (BLOCKED_FILE_RULES.depDirs.includes(segment)) {
      return 'dependency directory';
    }
  }

  if (
    basename === BLOCKED_FILE_RULES.envFile ||
    basename.startsWith(`${BLOCKED_FILE_RULES.envFile}.`)
  ) {
    return 'secrets/env file';
  }
  if (BLOCKED_FILE_RULES.keyExtensions.some((ext) => basename.endsWith(ext))) {
    return 'private key file';
  }
  if (BLOCKED_FILE_RULES.sshKeys.includes(basename)) {
    return 'SSH key file';
  }

  return null;
}
