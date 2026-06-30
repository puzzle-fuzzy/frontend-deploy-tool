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
import { createEmptyData, migrate } from '../domain/schema';
import type { ProjectRepository } from './projectRepository';

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
  function writeData(data: Data): void {
    mkdirSync(dirname(dataFile), { recursive: true });
    const tempFile = `${dataFile}.tmp`;
    writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tempFile, dataFile);
  }

  return {
    load(): Data {
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
    },

    save: writeData,
  };
}
