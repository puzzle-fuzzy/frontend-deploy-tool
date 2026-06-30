import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { Data } from '@deploykit/shared';
import { DEFAULT_PROJECT_SETTINGS } from '../domain/project';
import type { ProjectRepository } from './projectRepository';

/**
 * JSON-file backed repository. Reads hydrate missing project settings with the
 * defaults and tolerate a missing/corrupt file. Writes are atomic: data is
 * serialized to a sibling temp file and renamed into place (POSIX `rename(2)`
 * is atomic on the same filesystem).
 */
export function createJsonProjectRepository(
  dataFile: string
): ProjectRepository {
  return {
    load(): Data {
      if (!existsSync(dataFile)) return { projects: [], history: [] };
      try {
        const raw = JSON.parse(readFileSync(dataFile, 'utf-8'));
        for (const project of raw.projects ?? []) {
          if (!project.settings)
            project.settings = { ...DEFAULT_PROJECT_SETTINGS };
        }
        return {
          projects: raw.projects ?? [],
          history: raw.history ?? [],
        };
      } catch {
        return { projects: [], history: [] };
      }
    },

    save(data: Data): void {
      mkdirSync(dirname(dataFile), { recursive: true });
      const tempFile = `${dataFile}.tmp`;
      writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf-8');
      renameSync(tempFile, dataFile);
    },
  };
}
