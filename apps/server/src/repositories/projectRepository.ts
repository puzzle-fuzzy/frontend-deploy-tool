import type { Data } from '@deploykit/shared';

/** Persistence interface for the project/version metadata store. */
export interface ProjectRepository {
  load(): Data;
  save(data: Data): void;
}
