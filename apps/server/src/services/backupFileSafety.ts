import { type fstatSync, lstatSync } from 'node:fs';

export const BACKUP_DATABASE_SNAPSHOT_UNSAFE =
  'BACKUP_DATABASE_SNAPSHOT_UNSAFE';
export const BACKUP_SOURCE_UNSAFE = 'BACKUP_SOURCE_UNSAFE';

export interface CapturedFileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

export function assertSingleLinkRegularFile(
  path: string,
  stats: ReturnType<typeof fstatSync> & { nlink: bigint },
  unsafeCode: string
): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n) {
    throw new Error(
      `[${unsafeCode}] Backup source must be a single-link regular file: ${path}`
    );
  }
}

export function sameCapturedIdentity(
  left: CapturedFileIdentity,
  right: CapturedFileIdentity
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export function lstatIfPresent(
  path: string
): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

export function pathEntryExistsNoFollow(path: string): boolean {
  return lstatIfPresent(path) !== undefined;
}

export function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as Error & { code?: string }).code === 'ENOENT'
  );
}
