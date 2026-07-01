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

/** Global role governing what a user may do. */
export const roleSchema = z.enum(['admin', 'developer', 'viewer']);

/** A user account, including the hashed password (server-side only). */
export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  passwordHash: z.string(),
  role: roleSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * The user shape exposed over the API (`/api/me`, login response). Never
 * includes `passwordHash`.
 */
export const safeUserSchema = userSchema.omit({ passwordHash: true });

/**
 * How a version's artifacts entered storage. `unknown` is the migration default
 * for versions written before this field existed.
 */
export const versionSourceTypeSchema = z.enum(['zip', 'folder', 'unknown']);

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
   * Id of the user who triggered the event. Legacy events (pre-auth) are
   * backfilled with `'system'` during migration.
   */
  actorId: z.string(),
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
  users: z.array(userSchema),
  history: z.array(historyEventSchema),
});

/** Input body for creating a project (plain type, used by the service contract). */
export interface CreateProjectInput {
  name: string;
  slug: string;
  description: string;
}

export type Settings = z.infer<typeof settingsSchema>;
export type Role = z.infer<typeof roleSchema>;
export type User = z.infer<typeof userSchema>;
export type SafeUser = z.infer<typeof safeUserSchema>;
export type VersionSourceType = z.infer<typeof versionSourceTypeSchema>;
export type Version = z.infer<typeof versionSchema>;
export type Project = z.infer<typeof projectSchema>;
export type HistoryAction = z.infer<typeof historyEventSchema>['action'];
export type HistoryEvent = z.infer<typeof historyEventSchema>;
export type Data = z.infer<typeof dataSchema>;
