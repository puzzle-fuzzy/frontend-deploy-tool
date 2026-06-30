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
import { DEFAULT_PROJECT_SETTINGS } from '../domain/project';
import { CURRENT_SCHEMA_VERSION, migrate } from '../domain/schema';
import type { ProjectRepository } from './projectRepository';

/**
 * JSON-file backed repository. Reads migrate the stored data up to the current
 * schema (backing up first) and hydrate missing project settings with the
 * defaults; a missing/corrupt file yields empty data. Writes are atomic: data
 * is serialized to a sibling temp file and renamed into place (POSIX
 * `rename(2)` is atomic on the same filesystem).
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
      if (!existsSync(dataFile)) return emptyData();
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(dataFile, 'utf-8'));
      } catch {
        return emptyData();
      }

      const { data, migrated } = migrate(raw);
      for (const project of data.projects) {
        if (!project.settings)
          project.settings = { ...DEFAULT_PROJECT_SETTINGS };
      }

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

function emptyData(): Data {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projects: [],
    history: [],
  };
}
