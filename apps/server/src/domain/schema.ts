import {
  artifactAuditJobSchema,
  artifactAuditPolicySchema,
  artifactAuditReportSchema,
  type Data,
  dataSchema,
  historyEventSchema,
  integrityStatusSchema,
  type Project,
  settingsSchema,
  userSchema,
  versionSourceTypeSchema,
  versionStatusSchema,
} from '@deploykit/shared';
import { z } from 'zod';
import {
  DEFAULT_PROJECT_AUDIT_POLICY,
  DEFAULT_PROJECT_SETTINGS,
} from './project';
import { syncProductionStatus } from './version';

/**
 * The schema version this build reads and writes. Old data files lacking a
 * `schemaVersion` are treated as `0` and upgraded by {@link migrate}.
 *
 * - v1: initial shape (`activeVersionId`, hydrated `settings`).
 * - v2: versions carry upload metadata (`size`, `fileCount`, `sourceType`);
 *   legacy versions default to `0`/`0`/`'unknown'`.
 * - v3: history events carry `actorId` (legacy → `'system'`); top-level `users`
 *   (absent before auth → `[]`, then seeded by the app).
 * - v4: versions carry release metadata (`status`, `publishedAt`,
 *   `publishedBy`, `checksum`); status is derived from `activeVersionId`.
 * - v5: projects carry explicit membership and creator ownership metadata.
 * - v6: versions persist explicit artifact integrity status and check time.
 * - v7: projects carry artifact-audit policy and current per-version reports.
 * - v8: durable artifact-audit jobs carry snapshots, leases, and outcomes.
 * - v9: audit policies carry asset budgets and jobs/reports snapshot context.
 */
export const CURRENT_SCHEMA_VERSION = 9;

export interface MigrationResult {
  data: Data;
  /** True when an upgrade step actually ran (i.e. the input was below current). */
  migrated: boolean;
}

/**
 * Lenient schema describing any historical on-disk shape (v0–v3). Tolerates a
 * missing `schemaVersion`, the legacy per-version `active` flag, a missing
 * `activeVersionId`, missing `settings`/optional text fields, a missing
 * `users` table, and history events lacking `actorId`. Used only to parse
 * persisted data before normalizing it to the current shape.
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
            status: versionStatusSchema.optional(),
            publishedAt: z.string().nullable().optional(),
            publishedBy: z.string().nullable().optional(),
            checksum: z.string().default(''),
            integrityStatus: integrityStatusSchema.default('unknown'),
            integrityCheckedAt: z.string().nullable().default(null),
          })
        )
        .default([]),
      activeVersionId: z.string().nullable().optional(),
      settings: settingsSchema.optional(),
      auditPolicy: artifactAuditPolicySchema.optional(),
      createdBy: z.string().optional(),
      members: z
        .array(
          z.object({
            userId: z.string(),
            role: z.enum(['owner', 'member']),
            invitedAt: z.string(),
          })
        )
        .optional(),
    })
  ),
  users: z.array(userSchema).default([]),
  history: z
    .array(historyEventSchema.extend({ actorId: z.string().default('system') }))
    .default([]),
  artifactAudits: z
    .array(
      artifactAuditReportSchema.extend({
        engineVersion: z.number().int().positive().default(1),
        policy: artifactAuditPolicySchema.default({
          ...DEFAULT_PROJECT_AUDIT_POLICY,
        }),
      })
    )
    .default([]),
  artifactAuditJobs: z.array(artifactAuditJobSchema).default([]),
});

export function createEmptyData(): Data {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projects: [],
    users: [],
    history: [],
    artifactAudits: [],
    artifactAuditJobs: [],
  };
}

/**
 * Brings an arbitrary parsed payload up to {@link CURRENT_SCHEMA_VERSION} using a
 * lenient zod parse followed by a typed transform. Idempotent, non-mutating, and
 * assertion-free. Backup and persistence are the caller's job.
 */
export function migrate(raw: unknown): MigrationResult {
  const declaredVersion =
    typeof raw === 'object' &&
    raw !== null &&
    'schemaVersion' in raw &&
    typeof raw.schemaVersion === 'number'
      ? raw.schemaVersion
      : undefined;

  if (
    declaredVersion !== undefined &&
    (!Number.isInteger(declaredVersion) ||
      declaredVersion < 0 ||
      declaredVersion > CURRENT_SCHEMA_VERSION)
  ) {
    throw new Error(`Unsupported document schema version ${declaredVersion}`);
  }

  if (declaredVersion === CURRENT_SCHEMA_VERSION) {
    const current = dataSchema.safeParse(raw);
    if (!current.success) {
      throw new Error(
        `Document schema v${CURRENT_SCHEMA_VERSION} failed validation`
      );
    }
    return { data: current.data, migrated: false };
  }

  const parsed = legacyDataSchema.safeParse(raw);
  if (!parsed.success) {
    const schemaLabel =
      declaredVersion === undefined
        ? 'Document schema migration'
        : `Document schema v${declaredVersion} migration`;
    throw new Error(`${schemaLabel} failed validation`);
  }

  const input = parsed.data;
  const inputVersion = input.schemaVersion ?? 0;

  const firstAdminId =
    input.users.find((u) => u.role === 'admin')?.id ?? 'system';

  const projects: Project[] = input.projects.map((p) => {
    const activeVersionId =
      p.activeVersionId ??
      p.versions.find((v) => v.active === true)?.id ??
      null;
    const versions = syncProductionStatus(
      p.versions.map((v) => ({
        id: v.id,
        name: v.name,
        description: v.description,
        createdAt: v.createdAt,
        size: v.size,
        fileCount: v.fileCount,
        sourceType: v.sourceType,
        status: v.status ?? 'preview',
        publishedAt: v.publishedAt ?? null,
        publishedBy: v.publishedBy ?? null,
        checksum: v.checksum,
        integrityStatus: v.integrityStatus,
        integrityCheckedAt: v.integrityCheckedAt,
      })),
      activeVersionId
    );
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
      auditPolicy: p.auditPolicy ?? { ...DEFAULT_PROJECT_AUDIT_POLICY },
      createdBy: (p as { createdBy?: string }).createdBy ?? firstAdminId,
      members: (
        p as {
          members?: Array<{
            userId: string;
            role: 'owner' | 'member';
            invitedAt: string;
          }>;
        }
      ).members ?? [
        {
          userId: firstAdminId,
          role: 'owner',
          invitedAt: p.createdAt || new Date().toISOString(),
        },
      ],
    };
  });

  const version =
    inputVersion < CURRENT_SCHEMA_VERSION
      ? CURRENT_SCHEMA_VERSION
      : inputVersion;
  return {
    data: {
      schemaVersion: version,
      projects,
      users: input.users,
      history: input.history,
      artifactAudits: input.artifactAudits.filter((report) =>
        projects.some(
          (project) =>
            project.id === report.projectId &&
            project.versions.some((version) => version.id === report.versionId)
        )
      ),
      artifactAuditJobs: input.artifactAuditJobs.filter((job) =>
        projects.some(
          (project) =>
            project.id === job.projectId &&
            project.versions.some((version) => version.id === job.versionId)
        )
      ),
    },
    migrated: version !== inputVersion,
  };
}
