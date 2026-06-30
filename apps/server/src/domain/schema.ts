import type { Data, HistoryEvent, Project } from '@deploykit/shared';

/**
 * The schema version this build reads and writes. Old data files lacking a
 * `schemaVersion` are treated as `0` and upgraded by {@link migrate}.
 */
export const CURRENT_SCHEMA_VERSION = 1;

export interface MigrationResult {
  data: Data;
  /** True when an upgrade step actually ran (i.e. the input was below current). */
  migrated: boolean;
}

type RawVersion = { id?: unknown; active?: unknown } & Record<string, unknown>;
type RawProject = {
  versions?: RawVersion[];
  activeVersionId?: unknown;
} & Record<string, unknown>;

/**
 * Brings an arbitrary parsed payload up to {@link CURRENT_SCHEMA_VERSION}.
 * Idempotent and non-mutating: data already current passes through unchanged,
 * and the input object is never modified. Each `version < N` step upgrades
 * exactly one schema version, so future migrations just append a step. Backup
 * and persistence are the caller's job.
 */
export function migrate(raw: unknown): MigrationResult {
  const input = (raw ?? {}) as {
    schemaVersion?: unknown;
    projects?: unknown;
    history?: unknown;
  };
  const inputVersion =
    typeof input.schemaVersion === 'number' ? input.schemaVersion : 0;

  const rawProjects = (
    Array.isArray(input.projects) ? input.projects : []
  ) as RawProject[];
  const history = (
    Array.isArray(input.history) ? input.history : []
  ) as HistoryEvent[];

  let version = inputVersion;
  let projects: Project[];

  // v0 -> v1: derive `project.activeVersionId` from the per-version `active`
  // flag, then strip that flag from every version. Builds fresh objects so the
  // input is left untouched and re-running on partially-migrated data is safe.
  if (version < 1) {
    projects = rawProjects.map((project) => {
      const versions = Array.isArray(project.versions) ? project.versions : [];
      const activeId = versions.find((v) => v.active === true)?.id ?? null;
      const cleanVersions = versions.map((v) => {
        const clone = { ...v };
        delete clone.active;
        return clone;
      });
      return {
        ...project,
        activeVersionId: project.activeVersionId ?? activeId,
        versions: cleanVersions,
      };
    }) as unknown as Project[];
    version = 1;
  } else {
    projects = rawProjects as unknown as Project[];
  }

  return {
    data: { schemaVersion: version, projects, history },
    migrated: version !== inputVersion,
  };
}
