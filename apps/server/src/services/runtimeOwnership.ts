import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export interface RuntimeOwnership {
  release(): void;
}

interface RuntimePair {
  databaseFile: string;
  storageDir: string;
}

interface HeldSidecarLock {
  database: Database;
  path: string;
}

export const RUNTIME_OWNERSHIP_HELD = 'RUNTIME_OWNERSHIP_HELD';

/**
 * Acquires kernel-released SQLite transaction locks for both resources.
 *
 * Diagnostics are written inside the held transactions, but correctness comes
 * only from SQLite's open transaction locks. Process death or connection close
 * releases them without PID reuse or compare-delete races.
 */
export function acquireRuntimeOwnership(
  databaseFile: string,
  storageDir: string
): RuntimeOwnership {
  const pair = normalizeRuntimePair(databaseFile, storageDir);
  const ownerToken = randomBytes(24).toString('base64url');
  const lockPaths = getRuntimeOwnershipPaths(
    pair.databaseFile,
    pair.storageDir
  );
  const held: HeldSidecarLock[] = [];

  try {
    for (const path of lockPaths) {
      mkdirSync(dirname(path), { recursive: true });
      const database = new Database(path, { create: true });
      try {
        database.exec('PRAGMA busy_timeout = 0');
        database.exec('BEGIN EXCLUSIVE');
        database.exec(`
          CREATE TABLE IF NOT EXISTS runtime_ownership_diagnostics (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            database_file TEXT NOT NULL,
            storage_dir TEXT NOT NULL,
            pid INTEGER NOT NULL,
            owner_token TEXT NOT NULL,
            acquired_at TEXT NOT NULL
          )
        `);
        database
          .query(
            `INSERT INTO runtime_ownership_diagnostics (
               singleton,
               database_file,
               storage_dir,
               pid,
               owner_token,
               acquired_at
             ) VALUES (1, ?, ?, ?, ?, ?)
             ON CONFLICT(singleton) DO UPDATE SET
               database_file = excluded.database_file,
               storage_dir = excluded.storage_dir,
               pid = excluded.pid,
               owner_token = excluded.owner_token,
               acquired_at = excluded.acquired_at`
          )
          .run(
            pair.databaseFile,
            pair.storageDir,
            process.pid,
            ownerToken,
            new Date().toISOString()
          );
        held.push({ database, path });
      } catch (error) {
        closeWithoutCommit(database);
        if (isSqliteLockError(error)) {
          throw new Error(
            `[${RUNTIME_OWNERSHIP_HELD}] Runtime resource is already owned: "${path}" for database "${pair.databaseFile}" and storage "${pair.storageDir}"`
          );
        }
        throw error;
      }
    }
  } catch (error) {
    try {
      releaseSidecarLocks(held, false);
    } catch {
      // Preserve the stable acquisition diagnostic. Closing each connection
      // above already attempted the kernel lock release.
    }
    throw error;
  }

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      releaseSidecarLocks(held, true);
    },
  };
}

/** Returns the deterministic, sorted, de-duplicated sidecar lock paths. */
export function getRuntimeOwnershipPaths(
  databaseFile: string,
  storageDir: string
): string[] {
  const pair = normalizeRuntimePair(databaseFile, storageDir);
  return [
    `${pair.databaseFile}.runtime-lock.sqlite`,
    `${pair.storageDir}.runtime-lock.sqlite`,
  ]
    .filter((path, index, paths) => paths.indexOf(path) === index)
    .sort();
}

function releaseSidecarLocks(
  held: HeldSidecarLock[],
  commitDiagnostics: boolean
): void {
  let firstError: unknown;
  for (const lock of [...held].reverse()) {
    try {
      lock.database.exec(commitDiagnostics ? 'COMMIT' : 'ROLLBACK');
    } catch (error) {
      firstError ??= error;
      try {
        lock.database.exec('ROLLBACK');
      } catch {
        // Closing the connection below is the final kernel lock release.
      }
    } finally {
      try {
        lock.database.close();
      } catch (error) {
        firstError ??= error;
      }
    }
  }
  held.length = 0;
  if (firstError) throw firstError;
}

function closeWithoutCommit(database: Database): void {
  try {
    database.exec('ROLLBACK');
  } catch {
    // BEGIN may not have succeeded.
  }
  try {
    database.close();
  } catch {
    // Preserve the acquisition error that explains why ownership failed.
  }
}

function normalizeRuntimePair(
  databaseFile: string,
  storageDir: string
): RuntimePair {
  return {
    databaseFile: canonicalizePath(databaseFile),
    storageDir: canonicalizePath(storageDir),
  };
}

function canonicalizePath(path: string): string {
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

function isSqliteLockError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; errno?: unknown };
  return (
    candidate.code === 'SQLITE_BUSY' ||
    candidate.code === 'SQLITE_LOCKED' ||
    candidate.errno === 5 ||
    candidate.errno === 6
  );
}
