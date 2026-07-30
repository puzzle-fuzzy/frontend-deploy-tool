import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, posix, resolve, win32 } from 'node:path';

export const DATABASE_STORAGE_OVERLAP = 'DATABASE_STORAGE_OVERLAP';
export const RUNTIME_OWNERSHIP_LAYOUT_UNSAFE =
  'RUNTIME_OWNERSHIP_LAYOUT_UNSAFE';

export type RuntimeResourceName =
  | 'database'
  | 'storage'
  | 'database-journal'
  | 'database-wal'
  | 'database-shm'
  | 'database-lock'
  | 'database-lock-journal'
  | 'database-lock-wal'
  | 'database-lock-shm'
  | 'storage-lock'
  | 'storage-lock-journal'
  | 'storage-lock-wal'
  | 'storage-lock-shm';

export interface NamedRuntimeResource {
  name: RuntimeResourceName;
  path: string;
}

export interface RuntimeResourceLayout {
  databaseFile: string;
  storageDir: string;
  databaseJournalFile: string;
  databaseWalFile: string;
  databaseShmFile: string;
  databaseLockFile: string;
  storageLockFile: string;
  ownershipPaths: readonly [string, string];
  resources: readonly NamedRuntimeResource[];
}

interface ResolveRuntimeResourceLayoutOptions {
  platform?: NodeJS.Platform;
}

/**
 * Rejects metadata paths that can be moved or deleted as part of artifact
 * storage restore/reconciliation.
 */
export function assertDatabaseOutsideStorage(
  databaseFile: string,
  storageDir: string
): void {
  resolveRuntimeResourceLayout(databaseFile, storageDir);
}

/**
 * Resolves the database/storage pair once, derives every owned runtime path
 * from that snapshot, and rejects layouts where any resource can mask another.
 */
export function resolveRuntimeResourceLayout(
  databaseFile: string,
  storageDir: string,
  { platform = process.platform }: ResolveRuntimeResourceLayoutOptions = {}
): RuntimeResourceLayout {
  assertConfiguredLeafIsNotSymlink('database', databaseFile);
  assertConfiguredLeafIsNotSymlink('storage', storageDir);
  const canonicalDatabase = canonicalizeResourcePath(databaseFile);
  const canonicalStorage = canonicalizeResourcePath(storageDir);
  if (isPathSameOrDescendant(canonicalDatabase, canonicalStorage, platform)) {
    throw new Error(
      `[${DATABASE_STORAGE_OVERLAP}] Database must be outside artifact storage`
    );
  }

  const databaseLockFile = `${canonicalDatabase}.runtime-lock.sqlite`;
  const storageLockFile = `${canonicalStorage}.runtime-lock.sqlite`;
  const ownershipPaths = [databaseLockFile, storageLockFile].sort() as [
    string,
    string,
  ];
  const resources: readonly NamedRuntimeResource[] = [
    { name: 'database', path: canonicalDatabase },
    { name: 'storage', path: canonicalStorage },
    { name: 'database-journal', path: `${canonicalDatabase}-journal` },
    { name: 'database-wal', path: `${canonicalDatabase}-wal` },
    { name: 'database-shm', path: `${canonicalDatabase}-shm` },
    { name: 'database-lock', path: databaseLockFile },
    {
      name: 'database-lock-journal',
      path: `${databaseLockFile}-journal`,
    },
    { name: 'database-lock-wal', path: `${databaseLockFile}-wal` },
    { name: 'database-lock-shm', path: `${databaseLockFile}-shm` },
    { name: 'storage-lock', path: storageLockFile },
    { name: 'storage-lock-journal', path: `${storageLockFile}-journal` },
    { name: 'storage-lock-wal', path: `${storageLockFile}-wal` },
    { name: 'storage-lock-shm', path: `${storageLockFile}-shm` },
  ];
  const overlap = findRuntimeResourceOverlap(resources, platform);
  if (overlap) {
    throw new Error(
      `[${RUNTIME_OWNERSHIP_LAYOUT_UNSAFE}] Runtime resource layout collision: ${overlap[0]} overlaps ${overlap[1]}`
    );
  }

  return {
    databaseFile: canonicalDatabase,
    storageDir: canonicalStorage,
    databaseJournalFile: `${canonicalDatabase}-journal`,
    databaseWalFile: `${canonicalDatabase}-wal`,
    databaseShmFile: `${canonicalDatabase}-shm`,
    databaseLockFile,
    storageLockFile,
    ownershipPaths,
    resources,
  };
}

function assertConfiguredLeafIsNotSymlink(
  resource: 'database' | 'storage',
  path: string
): void {
  try {
    if (lstatSync(resolve(path)).isSymbolicLink()) {
      throw new Error(
        `[${RUNTIME_OWNERSHIP_LAYOUT_UNSAFE}] Unsafe ${resource} leaf: symbolic links are not supported`
      );
    }
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return;
    }
    if (
      error instanceof Error &&
      error.message.includes(`[${RUNTIME_OWNERSHIP_LAYOUT_UNSAFE}]`)
    ) {
      throw error;
    }
    throw new Error(
      `[${RUNTIME_OWNERSHIP_LAYOUT_UNSAFE}] ${resource} leaf identity could not be verified`
    );
  }
}

/**
 * Canonicalizes every existing path prefix and preserves the missing suffix for
 * later I/O. Comparison, including conservative case folding, is separate.
 */
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

export function findRuntimeResourceOverlap(
  resources: readonly NamedRuntimeResource[],
  platform: NodeJS.Platform = process.platform
): readonly [RuntimeResourceName, RuntimeResourceName] | undefined {
  for (let leftIndex = 0; leftIndex < resources.length; leftIndex += 1) {
    const left = resources[leftIndex];
    if (!left) continue;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < resources.length;
      rightIndex += 1
    ) {
      const right = resources[rightIndex];
      if (!right) continue;
      if (
        isPathSameOrDescendant(left.path, right.path, platform) ||
        isPathSameOrDescendant(right.path, left.path, platform)
      ) {
        return [left.name, right.name];
      }
    }
  }
  return undefined;
}

function isPathSameOrDescendant(
  candidate: string,
  ancestor: string,
  platform: NodeJS.Platform
): boolean {
  const pathApi = platform === 'win32' ? win32 : posix;
  const comparisonCandidate = pathComparisonKey(candidate, platform);
  const comparisonAncestor = pathComparisonKey(ancestor, platform);
  const relativeCandidate = pathApi.relative(
    comparisonAncestor,
    comparisonCandidate
  );
  return (
    relativeCandidate === '' ||
    (!pathApi.isAbsolute(relativeCandidate) &&
      relativeCandidate !== '..' &&
      !relativeCandidate.startsWith(`..${pathApi.sep}`))
  );
}

function pathComparisonKey(path: string, platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return path.normalize('NFD').toLowerCase();
  }
  return platform === 'win32' ? path.toLowerCase() : path;
}
