import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { Data } from '@deploykit/shared';
import { paginateHistory } from '../domain/history';
import { createEmptyData, migrate } from '../domain/schema';
import type {
  CommitVersionUploadInput,
  ProjectRepository,
} from './projectRepository';

/**
 * JSON-file backed repository. Reads migrate the stored data up to the current
 * schema (which also hydrates missing project settings) and tolerate a
 * missing/corrupt file. Writes are atomic: data is serialized to a sibling temp
 * file and renamed into place (POSIX `rename(2)` is atomic on the same
 * filesystem).
 */
export function createJsonProjectRepository(
  dataFile: string
): ProjectRepository {
  const idempotencyRecords = new Map<
    string,
    {
      requestDigest: string;
      version: { id: string; name: string };
      expiresAt: string;
    }
  >();

  function writeData(data: Data): void {
    mkdirSync(dirname(dataFile), { recursive: true });
    const tempFile = `${dataFile}.tmp`;
    writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tempFile, dataFile);
  }

  function loadData(): Data {
    if (!existsSync(dataFile)) return createEmptyData();
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(dataFile, 'utf-8'));
    } catch {
      return createEmptyData();
    }

    const { data, migrated } = migrate(raw);

    // Persist the upgraded shape once so later loads skip migration. Back up
    // the pre-migration file first so the change is always reversible.
    if (migrated) {
      try {
        copyFileSync(dataFile, `${dataFile}.bak`);
      } catch {
        // Best-effort backup; migration still proceeds.
      }
      writeData(data);
    }

    return data;
  }

  return {
    load: loadData,

    save: writeData,

    mutate<T>(operation: (data: Data) => T): T {
      const data = loadData();
      const result = operation(data);
      writeData(data);
      return result;
    },

    commitVersionUpload(input, operation) {
      pruneExpiredIdempotencyRecords(idempotencyRecords, input.committedAt);
      const key = idempotencyRecordKey(input);
      const existing = idempotencyRecords.get(key);
      if (existing) {
        return existing.requestDigest === input.requestDigest
          ? { outcome: 'replayed' as const, version: { ...existing.version } }
          : { outcome: 'conflict' as const };
      }

      const data = loadData();
      operation(data);
      writeData(data);
      idempotencyRecords.set(key, {
        requestDigest: input.requestDigest,
        version: { ...input.version },
        expiresAt: input.expiresAt,
      });
      return { outcome: 'created', version: { ...input.version } };
    },

    listHistoryPage({ projectIds, limit, cursor }) {
      const history = loadData().history;
      const visibleHistory =
        projectIds === null
          ? history
          : history.filter((event) => projectIds.includes(event.projectId));
      return paginateHistory(visibleHistory, limit, cursor);
    },
  };
}

function idempotencyRecordKey(input: CommitVersionUploadInput): string {
  return `${input.projectId}\0${input.tokenId}\0${input.idempotencyKey}`;
}

function pruneExpiredIdempotencyRecords(
  records: Map<string, { expiresAt: string }>,
  committedAt: string
): void {
  for (const [key, record] of records) {
    if (record.expiresAt <= committedAt) records.delete(key);
  }
}
