import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  RUNTIME_OWNERSHIP_LAYOUT_UNSAFE,
  type RuntimeResourceLayout,
  type RuntimeResourceName,
  resolveRuntimeResourceLayout,
} from '../utils/runtimeResourcePath';

export interface RuntimeOwnership {
  release(): void;
}

interface HeldSidecarLock {
  database: Database;
  path: string;
}

export const RUNTIME_OWNERSHIP_HELD = 'RUNTIME_OWNERSHIP_HELD';
export const RUNTIME_DATABASE_HARDLINK_UNSAFE =
  'RUNTIME_DATABASE_HARDLINK_UNSAFE';
export { RUNTIME_OWNERSHIP_LAYOUT_UNSAFE };

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
  const layout = resolveRuntimeResourceLayout(databaseFile, storageDir);
  assertRuntimeResourceLeavesSafe(layout);
  const ownerToken = randomBytes(24).toString('base64url');
  const held: HeldSidecarLock[] = [];

  try {
    for (const path of layout.ownershipPaths) {
      mkdirSync(dirname(path), { recursive: true });
    }
    assertRuntimeResourceLeavesSafe(layout);

    for (const path of layout.ownershipPaths) {
      assertRuntimeResourceLeavesSafe(layout);
      const database = new Database(path, { create: true });
      try {
        database.exec('PRAGMA busy_timeout = 0');
        const journalMode = database
          .query<{ journal_mode: string }, []>('PRAGMA journal_mode = DELETE')
          .get()?.journal_mode;
        if (journalMode?.toLowerCase() !== 'delete') {
          throw new Error(
            `[${RUNTIME_OWNERSHIP_LAYOUT_UNSAFE}] Ownership sidecar journal mode must be DELETE`
          );
        }
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
            layout.databaseFile,
            layout.storageDir,
            process.pid,
            ownerToken,
            new Date().toISOString()
          );
        held.push({ database, path });
      } catch (error) {
        closeWithoutCommit(database);
        if (isSqliteLockError(error)) {
          throw new Error(
            `[${RUNTIME_OWNERSHIP_HELD}] Runtime resource is already owned: "${path}" for database "${layout.databaseFile}" and storage "${layout.storageDir}"`
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

/** Returns the deterministic, sorted sidecar lock paths for a safe layout. */
export function getRuntimeOwnershipPaths(
  databaseFile: string,
  storageDir: string
): string[] {
  return [
    ...resolveRuntimeResourceLayout(databaseFile, storageDir).ownershipPaths,
  ];
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

function assertDatabaseLeafSafe(databaseFile: string): void {
  if (!existsSync(databaseFile)) return;
  const stats = lstatSync(databaseFile);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw unsafeRuntimeLeafError(
      'database',
      'must be a non-symlink regular file'
    );
  }
  if (stats.nlink > 1) {
    throw new Error(
      `[${RUNTIME_DATABASE_HARDLINK_UNSAFE}] Database file must not have hard-link aliases: "${databaseFile}"`
    );
  }
}

export function assertRuntimeResourceLeavesSafe(
  layout: RuntimeResourceLayout
): void {
  assertDatabaseLeafSafe(layout.databaseFile);
  const identities = new Map<string, RuntimeResourceName>();
  for (const resource of layout.resources) {
    try {
      const stats = lstatSync(resource.path, { bigint: true });
      if (resource.name === 'storage') {
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
          throw unsafeRuntimeLeafError(
            resource.name,
            'must be a non-symlink directory'
          );
        }
      } else if (
        stats.isSymbolicLink() ||
        !stats.isFile() ||
        stats.nlink !== 1n
      ) {
        throw unsafeRuntimeLeafError(
          resource.name,
          'must be a non-symlink, single-link regular file'
        );
      }

      const identity = `${stats.dev}:${stats.ino}`;
      const existingResource = identities.get(identity);
      if (existingResource) {
        throw new Error(
          `[${RUNTIME_OWNERSHIP_LAYOUT_UNSAFE}] Runtime resource filesystem alias: ${existingResource} aliases ${resource.name}`
        );
      }
      identities.set(identity, resource.name);
    } catch (error) {
      if (isMissingPathError(error)) continue;
      if (isRuntimeLayoutError(error)) throw error;
      throw unsafeRuntimeLeafError(
        resource.name,
        'identity could not be verified'
      );
    }
  }
}

function unsafeRuntimeLeafError(
  resource: RuntimeResourceName,
  reason: string
): Error {
  return new Error(
    `[${RUNTIME_OWNERSHIP_LAYOUT_UNSAFE}] Unsafe existing runtime resource leaf: ${resource} ${reason}`
  );
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function isRuntimeLayoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(`[${RUNTIME_OWNERSHIP_LAYOUT_UNSAFE}]`)
  );
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
