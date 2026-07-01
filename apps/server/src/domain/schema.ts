import {
  type Data,
  historyEventSchema,
  type Project,
  settingsSchema,
  versionSourceTypeSchema,
} from '@deploykit/shared';
import { z } from 'zod';
import { DEFAULT_PROJECT_SETTINGS } from './project';

/**
 * The schema version this build reads and writes. Old data files lacking a
 * `schemaVersion` are treated as `0` and upgraded by {@link migrate}.
 *
 * - v1: initial shape (`activeVersionId`, hydrated `settings`).
 * - v2: versions carry upload metadata (`size`, `fileCount`, `sourceType`);
 *   legacy versions default to `0`/`0`/`'unknown'`.
 */
export const CURRENT_SCHEMA_VERSION = 2;

export interface MigrationResult {
  data: Data;
  /** True when an upgrade step actually ran (i.e. the input was below current). */
  migrated: boolean;
}

/**
 * Lenient schema describing any historical on-disk shape (v0 or v1). Tolerates a
 * missing `schemaVersion`, the legacy per-version `active` flag, a missing
 * `activeVersionId`, and missing `settings`/optional text fields. Used only to
 * parse persisted data before normalizing it to the current shape.
 */
const legacyDataSchema = z.object({
  schemaVersion: z.number().optional(),
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
      description: z.string().default(''),
      createdAt: z.string().default(''),
      updatedAt: z.string().default(''),
      versions: z
        .array(
          z.object({
            id: z.string(),
            name: z.string().default(''),
            description: z.string().default(''),
            createdAt: z.string().default(''),
            active: z.boolean().optional(),
            size: z.number().default(0),
            fileCount: z.number().default(0),
            sourceType: versionSourceTypeSchema.default('unknown'),
          })
        )
        .default([]),
      activeVersionId: z.string().nullable().optional(),
      settings: settingsSchema.optional(),
    })
  ),
  history: z.array(historyEventSchema).default([]),
});

export function createEmptyData(): Data {
  return { schemaVersion: CURRENT_SCHEMA_VERSION, projects: [], history: [] };
}

/**
 * Brings an arbitrary parsed payload up to {@link CURRENT_SCHEMA_VERSION} using a
 * lenient zod parse followed by a typed transform. Idempotent, non-mutating, and
 * assertion-free. Backup and persistence are the caller's job.
 */
export function migrate(raw: unknown): MigrationResult {
  const parsed = legacyDataSchema.safeParse(raw);
  if (!parsed.success) return { data: createEmptyData(), migrated: false };

  const input = parsed.data;
  const inputVersion = input.schemaVersion ?? 0;

  const projects: Project[] = input.projects.map((p) => {
    const versions = p.versions.map((v) => ({
      id: v.id,
      name: v.name,
      description: v.description,
      createdAt: v.createdAt,
      size: v.size,
      fileCount: v.fileCount,
      sourceType: v.sourceType,
    }));
    const activeVersionId =
      p.activeVersionId ??
      p.versions.find((v) => v.active === true)?.id ??
      null;
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      description: p.description,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      versions,
      activeVersionId,
      settings: p.settings ?? { ...DEFAULT_PROJECT_SETTINGS },
    };
  });

  const version =
    inputVersion < CURRENT_SCHEMA_VERSION
      ? CURRENT_SCHEMA_VERSION
      : inputVersion;
  return {
    data: { schemaVersion: version, projects, history: input.history },
    migrated: version !== inputVersion,
  };
}
