import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_STAGING_RETENTION_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_RECOVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface StorageGarbageCollectionOptions {
  now?: Date;
  stagingRetentionMs?: number;
  recoveryRetentionMs?: number;
  dryRun?: boolean;
}

export interface StorageGarbageCollectionReport {
  removedStagingEntries: number;
  removedCommittedTrashEntries: number;
  removedOrphanEntries: number;
}

export function collectStorageGarbage(
  storageDir: string,
  options: StorageGarbageCollectionOptions = {}
): StorageGarbageCollectionReport {
  mkdirSync(storageDir, { recursive: true });
  const nowMs = (options.now ?? new Date()).getTime();
  const stagingRetentionMs =
    options.stagingRetentionMs ?? DEFAULT_STAGING_RETENTION_MS;
  const recoveryRetentionMs =
    options.recoveryRetentionMs ?? DEFAULT_RECOVERY_RETENTION_MS;
  const report: StorageGarbageCollectionReport = {
    removedStagingEntries: 0,
    removedCommittedTrashEntries: 0,
    removedOrphanEntries: 0,
  };

  report.removedStagingEntries += removeExpiredChildren(
    join(storageDir, '.staging'),
    nowMs,
    stagingRetentionMs,
    options.dryRun ?? false
  );
  report.removedStagingEntries += removeExpiredRootZips(
    storageDir,
    nowMs,
    stagingRetentionMs,
    options.dryRun ?? false
  );

  const trashRoot = join(storageDir, '.recovery', 'trash');
  for (const entry of listEntries(trashRoot)) {
    const operationPath = join(trashRoot, entry.name);
    const committedMarker = join(operationPath, 'COMMITTED');
    if (
      !entry.isDirectory() ||
      !existsSync(committedMarker) ||
      !isExpired(committedMarker, nowMs, recoveryRetentionMs)
    ) {
      continue;
    }
    report.removedCommittedTrashEntries += 1;
    if (!options.dryRun) {
      rmSync(operationPath, { recursive: true, force: true });
    }
  }

  report.removedOrphanEntries += removeExpiredChildren(
    join(storageDir, '.recovery', 'orphans'),
    nowMs,
    recoveryRetentionMs,
    options.dryRun ?? false
  );

  if (!options.dryRun) {
    removeEmptyDirectory(join(storageDir, '.staging'));
    removeEmptyDirectory(trashRoot);
    removeEmptyDirectory(join(storageDir, '.recovery', 'orphans'));
  }
  return report;
}

function removeExpiredChildren(
  root: string,
  nowMs: number,
  retentionMs: number,
  dryRun: boolean
): number {
  let removed = 0;
  for (const entry of listEntries(root)) {
    const path = join(root, entry.name);
    if (!isExpired(path, nowMs, retentionMs)) continue;
    removed += 1;
    if (!dryRun) rmSync(path, { recursive: true, force: true });
  }
  return removed;
}

function removeExpiredRootZips(
  storageDir: string,
  nowMs: number,
  retentionMs: number,
  dryRun: boolean
): number {
  let removed = 0;
  for (const entry of listEntries(storageDir)) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith('.zip') ||
      !isExpired(join(storageDir, entry.name), nowMs, retentionMs)
    ) {
      continue;
    }
    removed += 1;
    if (!dryRun) rmSync(join(storageDir, entry.name), { force: true });
  }
  return removed;
}

function isExpired(path: string, nowMs: number, retentionMs: number): boolean {
  return statSync(path).mtimeMs <= nowMs - retentionMs;
}

function listEntries(path: string) {
  return existsSync(path) ? readdirSync(path, { withFileTypes: true }) : [];
}

function removeEmptyDirectory(path: string): void {
  if (existsSync(path) && readdirSync(path).length === 0) {
    rmdirSync(path);
  }
}
