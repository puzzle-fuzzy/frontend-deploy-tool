import { lstatSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

const STORAGE_CONTROL_PATHS = [
  '.staging',
  '.recovery',
  join('.recovery', 'trash'),
  join('.recovery', 'conflicts'),
  join('.recovery', 'orphans'),
] as const;

/**
 * Rejects every DeployKit-owned control directory when it or an existing
 * ancestor below storage is a symlink. Call this before a reconciliation pass
 * so one unsafe control path freezes the whole destructive pass.
 */
export function assertStorageControlPathsAreSafe(storageDir: string): void {
  for (const controlPath of STORAGE_CONTROL_PATHS) {
    const target = join(storageDir, controlPath);
    assertStoragePathHasNoSymlinkAncestors(storageDir, target);
    const stats = tryLstat(target);
    if (stats && !stats.isDirectory()) {
      throw new Error('Storage control paths must be directories');
    }
  }
}

/**
 * Confines a target to storage and rejects symlinks in every existing path
 * component. A regular final file is allowed; non-directory ancestors are not.
 */
export function assertStoragePathHasNoSymlinkAncestors(
  storageDir: string,
  target: string
): void {
  const relativeTarget = relative(storageDir, target);
  if (relativeTarget === '') return;
  if (
    isAbsolute(relativeTarget) ||
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${sep}`)
  ) {
    throw new Error('Storage path must remain inside the storage root');
  }

  let current = storageDir;
  for (const component of relativeTarget.split(/[\\/]/)) {
    current = join(current, component);
    const stats = tryLstat(current);
    if (!stats) break;
    if (stats.isSymbolicLink()) {
      throw new Error(
        'Storage paths and ancestors must not contain symbolic links'
      );
    }
    if (!stats.isDirectory() && current !== target) {
      throw new Error('Storage path ancestors must be directories');
    }
  }
}

function tryLstat(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
}
