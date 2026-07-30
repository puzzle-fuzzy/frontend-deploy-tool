import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export interface RuntimeOwnership {
  release(): void;
}

interface RuntimeOwnershipRecord {
  version: 1;
  databaseFile: string;
  storageDir: string;
  pid: number;
  ownerToken: string;
  acquiredAt: string;
}

export const RUNTIME_OWNERSHIP_HELD = 'RUNTIME_OWNERSHIP_HELD';
export const RUNTIME_OWNERSHIP_INVALID = 'RUNTIME_OWNERSHIP_INVALID';

/**
 * Acquires the single-host ownership record for a database/storage pair.
 *
 * The record intentionally uses a local PID and therefore does not coordinate
 * multiple hosts sharing a filesystem. DeployKit storage must remain local to
 * the one runtime that owns the paired SQLite database.
 */
export function acquireRuntimeOwnership(
  databaseFile: string,
  storageDir: string
): RuntimeOwnership {
  const pair = normalizeRuntimePair(databaseFile, storageDir);
  mkdirSync(dirname(pair.databaseFile), { recursive: true });
  const ownershipPath = getRuntimeOwnershipPath(
    pair.databaseFile,
    pair.storageDir
  );
  const ownerToken = randomBytes(24).toString('base64url');
  const record: RuntimeOwnershipRecord = {
    version: 1,
    ...pair,
    pid: process.pid,
    ownerToken,
    acquiredAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      writeFileSync(ownershipPath, JSON.stringify(record, null, 2), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      return createOwnershipLease(ownershipPath, ownerToken);
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
    }

    let current: RuntimeOwnershipRecord;
    try {
      current = readOwnershipRecord(ownershipPath);
    } catch (error) {
      if (isFileMissingError(error)) continue;
      throw error;
    }
    if (
      current.databaseFile !== pair.databaseFile ||
      current.storageDir !== pair.storageDir
    ) {
      throw new Error(
        `[${RUNTIME_OWNERSHIP_INVALID}] Ownership record does not match the normalized database/storage pair`
      );
    }
    if (isProcessAlive(current.pid)) {
      throw new Error(
        `[${RUNTIME_OWNERSHIP_HELD}] Runtime ownership is held by live PID ${current.pid} for database "${pair.databaseFile}" and storage "${pair.storageDir}"`
      );
    }

    // Revalidate the observed token immediately before stale removal. The
    // following loop still uses `wx` as the ownership gate, so a racing
    // replacement is observed rather than intentionally overwritten.
    let verified: RuntimeOwnershipRecord;
    try {
      verified = readOwnershipRecord(ownershipPath);
    } catch (error) {
      if (isFileMissingError(error)) continue;
      throw error;
    }
    if (verified.ownerToken !== current.ownerToken) continue;
    if (isProcessAlive(verified.pid)) {
      throw new Error(
        `[${RUNTIME_OWNERSHIP_HELD}] Runtime ownership became live while replacing stale PID ${current.pid}`
      );
    }
    try {
      unlinkSync(ownershipPath);
    } catch (error) {
      if (!isFileMissingError(error)) throw error;
    }
  }

  throw new Error(
    `[${RUNTIME_OWNERSHIP_HELD}] Runtime ownership changed repeatedly while acquiring the lock`
  );
}

export function getRuntimeOwnershipPath(
  databaseFile: string,
  storageDir: string
): string {
  const pair = normalizeRuntimePair(databaseFile, storageDir);
  return `${pair.databaseFile}.runtime-ownership`;
}

function createOwnershipLease(
  ownershipPath: string,
  ownerToken: string
): RuntimeOwnership {
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      let current: RuntimeOwnershipRecord;
      try {
        current = readOwnershipRecord(ownershipPath);
      } catch (error) {
        if (isFileMissingError(error)) return;
        throw error;
      }
      if (current.ownerToken !== ownerToken) return;
      try {
        unlinkSync(ownershipPath);
      } catch (error) {
        if (!isFileMissingError(error)) throw error;
      }
    },
  };
}

function readOwnershipRecord(path: string): RuntimeOwnershipRecord {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (isFileMissingError(error)) throw error;
    throw new Error(
      `[${RUNTIME_OWNERSHIP_INVALID}] Cannot parse runtime ownership record: ${errorMessage(error)}`
    );
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.databaseFile !== 'string' ||
    typeof value.storageDir !== 'string' ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    typeof value.ownerToken !== 'string' ||
    value.ownerToken.length < 16 ||
    typeof value.acquiredAt !== 'string'
  ) {
    throw new Error(
      `[${RUNTIME_OWNERSHIP_INVALID}] Runtime ownership record is malformed`
    );
  }
  return value as unknown as RuntimeOwnershipRecord;
}

function normalizeRuntimePair(databaseFile: string, storageDir: string) {
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      isRecord(error) &&
      typeof error.code === 'string' &&
      error.code === 'ESRCH'
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFileExistsError(error: unknown): boolean {
  return isRecord(error) && error.code === 'EEXIST';
}

function isFileMissingError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
