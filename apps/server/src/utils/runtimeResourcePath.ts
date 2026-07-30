import { existsSync, realpathSync } from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

export const DATABASE_STORAGE_OVERLAP = 'DATABASE_STORAGE_OVERLAP';

/**
 * Rejects metadata paths that can be moved or deleted as part of artifact
 * storage restore/reconciliation. Existing symlink ancestors are resolved so
 * path aliases cannot bypass the containment check.
 */
export function assertDatabaseOutsideStorage(
  databaseFile: string,
  storageDir: string
): void {
  const canonicalDatabase = canonicalizeResourcePath(databaseFile);
  const canonicalStorage = canonicalizeResourcePath(storageDir);
  const relativeDatabase = relative(canonicalStorage, canonicalDatabase);
  const isInsideOrEqual =
    relativeDatabase === '' ||
    (!isAbsolute(relativeDatabase) &&
      relativeDatabase !== '..' &&
      !relativeDatabase.startsWith(`..${sep}`));
  if (isInsideOrEqual) {
    throw new Error(
      `[${DATABASE_STORAGE_OVERLAP}] Database must be outside artifact storage`
    );
  }
}

export function canonicalizeResourcePath(path: string): string {
  const absolute = resolve(path);
  let existingAncestor = absolute;
  const missingParts: string[] = [];
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) break;
    missingParts.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  const canonicalAncestor = existsSync(existingAncestor)
    ? realpathSync.native(existingAncestor)
    : existingAncestor;
  return join(canonicalAncestor, ...missingParts);
}
