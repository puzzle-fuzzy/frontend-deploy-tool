import { z } from 'zod';

/**
 * Domain types are derived (`z.infer`) from these zod schemas, which are the
 * single source of truth shared by the server and the web. Schemas are pure JS
 * (no Bun/Node), so they type-check under both apps.
 */

export const settingsSchema = z.object({
  spaMode: z.boolean(),
  routingType: z.enum(['hash', 'path']),
});

/**
 * How a version's artifacts entered storage. `unknown` is the migration default
 * for versions written before this field existed.
 */
export const versionSourceTypeSchema = z.enum(['zip', 'folder', 'unknown']);

export const auditProfileSchema = z.enum([
  'demo',
  'production-web',
  'h5-campaign',
  'admin-app',
  'docs',
]);

export const auditStatusSchema = z.enum(['passed', 'warning', 'failed']);
export const auditSeveritySchema = z.enum(['info', 'warning', 'error']);
export const auditCategorySchema = z.enum([
  'metadata',
  'seo',
  'links',
  'images',
  'social',
  'assets',
  'deploy',
]);

export const auditCheckSchema = z.object({
  id: z.string(),
  category: auditCategorySchema,
  severity: auditSeveritySchema,
  title: z.string(),
  message: z.string(),
  location: z.string().optional(),
});

export const auditReportSchema = z.object({
  projectId: z.string(),
  versionId: z.string(),
  profile: auditProfileSchema,
  status: auditStatusSchema,
  score: z.number().int().min(0).max(100),
  checks: z.array(auditCheckSchema),
  createdAt: z.string(),
});

export const versionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  createdAt: z.string(),
  /** Total bytes of the extracted artifacts on disk. `0` when unrecorded. */
  size: z.number().int().nonnegative(),
  /** Number of artifact files stored for this version. `0` when unrecorded. */
  fileCount: z.number().int().nonnegative(),
  /** How the artifacts were uploaded. */
  sourceType: versionSourceTypeSchema,
});

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  versions: z.array(versionSchema),
  /** The single source of truth for which version is live (null = none). */
  activeVersionId: z.string().nullable(),
  settings: settingsSchema,
});

export const historyEventSchema = z.object({
  id: z.string(),
  action: z.enum([
    'project.create',
    'project.delete',
    'version.upload',
    'version.activate',
    'version.delete',
  ]),
  projectId: z.string(),
  projectName: z.string(),
  versionId: z.string(),
  versionName: z.string(),
  timestamp: z.string(),
  /**
   * Structured, action-specific payload for future filtering/analytics (e.g.
   * upload `{ sourceType, size, fileCount }`, activate `{ previousActiveVersionId }`).
   * Omitted on legacy events written before this field existed.
   */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const dataSchema = z.object({
  schemaVersion: z.number(),
  projects: z.array(projectSchema),
  history: z.array(historyEventSchema),
});

/** Input body for creating a project (plain type, used by the service contract). */
export interface CreateProjectInput {
  name: string;
  slug: string;
  description: string;
}

export type Settings = z.infer<typeof settingsSchema>;
export type VersionSourceType = z.infer<typeof versionSourceTypeSchema>;
export type AuditProfile = z.infer<typeof auditProfileSchema>;
export type AuditStatus = z.infer<typeof auditStatusSchema>;
export type AuditSeverity = z.infer<typeof auditSeveritySchema>;
export type AuditCategory = z.infer<typeof auditCategorySchema>;
export type AuditCheck = z.infer<typeof auditCheckSchema>;
export type AuditReport = z.infer<typeof auditReportSchema>;
export type Version = z.infer<typeof versionSchema>;
export type Project = z.infer<typeof projectSchema>;
export type HistoryAction = z.infer<typeof historyEventSchema>['action'];
export type HistoryEvent = z.infer<typeof historyEventSchema>;
export type Data = z.infer<typeof dataSchema>;
