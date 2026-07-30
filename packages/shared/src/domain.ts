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

export const artifactAuditEnforcementSchema = z.enum(['advisory', 'blocking']);

export const artifactAuditPolicySchema = z
  .object({
    enforcement: artifactAuditEnforcementSchema,
    maxTotalBytes: z
      .number()
      .int()
      .positive()
      .max(10 * 1024 * 1024 * 1024),
    maxFileBytes: z
      .number()
      .int()
      .positive()
      .max(2 * 1024 * 1024 * 1024),
    maxFileCount: z.number().int().positive().max(100_000),
  })
  .strict()
  .refine((policy) => policy.maxFileBytes <= policy.maxTotalBytes, {
    path: ['maxFileBytes'],
    message: 'maxFileBytes cannot exceed maxTotalBytes',
  });

export const DEFAULT_ARTIFACT_AUDIT_POLICY = {
  enforcement: 'advisory',
  maxTotalBytes: 50 * 1024 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
  maxFileCount: 1_000,
} as const;

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

/** Automation permissions are explicit and deliberately narrower than user roles. */
export const apiTokenScopeSchema = z.enum(['preview:upload']);

/** Redacted project API-token metadata safe to return over management APIs. */
export const apiTokenMetadataSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    prefix: z.string(),
    scopes: z.array(apiTokenScopeSchema),
    createdAt: z.string(),
    createdBy: z.string(),
    expiresAt: z.string(),
    lastUsedAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
    replacedByTokenId: z.string().nullable(),
  })
  .strict();

export const apiTokenSecurityEventActionSchema = z.enum([
  'api_token.create',
  'api_token.rotate',
  'api_token.revoke',
  'api_token.authentication_failed',
]);

export const apiTokenSecurityReasonSchema = z.enum([
  'digest_mismatch',
  'expired',
  'revoked',
  'project_mismatch',
  'scope_missing',
  'hash_version_unsupported',
]);

/** Durable security evidence. It never includes a bearer value or digest. */
export const apiTokenSecurityEventSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    projectName: z.string(),
    tokenId: z.string().nullable(),
    tokenPrefix: z.string().nullable(),
    action: apiTokenSecurityEventActionSchema,
    outcome: z.enum(['succeeded', 'denied']),
    actorId: z.string().nullable(),
    reason: apiTokenSecurityReasonSchema.nullable(),
    occurredAt: z.string(),
  })
  .strict();

/**
 * How a version's artifacts entered storage. `unknown` is the migration default
 * for versions written before this field existed.
 */
export const versionSourceTypeSchema = z.enum(['zip', 'folder', 'unknown']);
export const versionStatusSchema = z.enum([
  'preview',
  'production',
  'archived',
  'failed',
]);
export const integrityStatusSchema = z.enum([
  'unknown',
  'verified',
  'missing',
  'corrupted',
]);

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
  /** Lifecycle state used for filtering, badges, and release semantics. */
  status: versionStatusSchema,
  /** Set when the version was last promoted to production. */
  publishedAt: z.string().nullable(),
  /** User id that last promoted this version to production. */
  publishedBy: z.string().nullable(),
  /** sha256 digest of the extracted artifact tree. */
  checksum: z.string(),
  /** Last explicit artifact integrity result. */
  integrityStatus: integrityStatusSchema,
  /** ISO timestamp of the last explicit integrity inspection. */
  integrityCheckedAt: z.string().nullable(),
});

export const projectMemberSchema = z.object({
  userId: z.string(),
  role: z.enum(['owner', 'member']),
  invitedAt: z.string(),
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
  auditPolicy: artifactAuditPolicySchema,
  createdBy: z.string(),
  members: z.array(projectMemberSchema).default([]),
});

export const artifactAuditStatusSchema = z.enum([
  'passed',
  'warning',
  'failed',
]);
export const artifactAuditSeveritySchema = z.enum(['info', 'warning', 'error']);
export const artifactAuditCategorySchema = z.enum(['structure', 'seo', 'size']);

export const artifactAuditCheckSchema = z.object({
  id: z.string(),
  category: artifactAuditCategorySchema,
  severity: artifactAuditSeveritySchema,
  passed: z.boolean(),
  message: z.string(),
  actual: z.union([z.string(), z.number(), z.boolean()]).optional(),
  expected: z.string().optional(),
});

export const artifactAuditFileSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
});

export const artifactAuditExtensionSchema = z.object({
  extension: z.string(),
  bytes: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
});

export const artifactAuditSummarySchema = z.object({
  totalBytes: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  largestFiles: z.array(artifactAuditFileSchema),
  extensions: z.array(artifactAuditExtensionSchema),
});

export const artifactAuditReportSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  versionId: z.string(),
  artifactChecksum: z.string(),
  status: artifactAuditStatusSchema,
  score: z.number().int().min(0).max(100),
  createdAt: z.string(),
  createdBy: z.string(),
  engineVersion: z.number().int().positive(),
  policy: artifactAuditPolicySchema,
  summary: artifactAuditSummarySchema,
  checks: z.array(artifactAuditCheckSchema),
});

export const artifactAuditJobStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
]);

export const artifactAuditJobSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    versionId: z.string(),
    requestedBy: z.string(),
    status: artifactAuditJobStatusSchema,
    priority: z.number().int().min(0).max(100),
    attempts: z.number().int().nonnegative(),
    maxAttempts: z.number().int().positive().max(10),
    nextRunAt: z.string(),
    lockedBy: z.string().nullable(),
    lockedUntil: z.string().nullable(),
    artifactChecksum: z.string(),
    engineVersion: z.number().int().positive(),
    policy: artifactAuditPolicySchema,
    reportId: z.string().nullable(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
  })
  .strict()
  .refine((job) => job.attempts <= job.maxAttempts, {
    path: ['attempts'],
    message: 'attempts cannot exceed maxAttempts',
  });

export const historyEventSchema = z.object({
  id: z.string(),
  action: z.enum([
    'project.create',
    'project.update',
    'project.update_settings',
    'project.delete',
    'version.upload',
    'version.publish',
    'version.activate',
    'version.rollback',
    'version.delete',
    'version.reconcile',
    'version.audit',
    'project.update_audit_policy',
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

export const historyPageSchema = z.object({
  items: z.array(historyEventSchema),
  nextCursor: z.string().nullable(),
});

export const dataSchema = z.object({
  schemaVersion: z.number(),
  projects: z.array(projectSchema),
  users: z.array(userSchema),
  history: z.array(historyEventSchema),
  artifactAudits: z.array(artifactAuditReportSchema),
  artifactAuditJobs: z.array(artifactAuditJobSchema),
});

/** Input body for creating a project (plain type, used by the service contract). */
export interface CreateProjectInput {
  name: string;
  slug: string;
  description: string;
}

export type ProjectMember = z.infer<typeof projectMemberSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type ArtifactAuditEnforcement = z.infer<
  typeof artifactAuditEnforcementSchema
>;
export type ArtifactAuditPolicy = z.infer<typeof artifactAuditPolicySchema>;
export type ArtifactAuditStatus = z.infer<typeof artifactAuditStatusSchema>;
export type ArtifactAuditSeverity = z.infer<typeof artifactAuditSeveritySchema>;
export type ArtifactAuditCategory = z.infer<typeof artifactAuditCategorySchema>;
export type ArtifactAuditCheck = z.infer<typeof artifactAuditCheckSchema>;
export type ArtifactAuditFile = z.infer<typeof artifactAuditFileSchema>;
export type ArtifactAuditExtension = z.infer<
  typeof artifactAuditExtensionSchema
>;
export type ArtifactAuditSummary = z.infer<typeof artifactAuditSummarySchema>;
export type ArtifactAuditReport = z.infer<typeof artifactAuditReportSchema>;
export type ArtifactAuditJobStatus = z.infer<
  typeof artifactAuditJobStatusSchema
>;
export type ArtifactAuditJob = z.infer<typeof artifactAuditJobSchema>;
export interface ArtifactAuditJobListQuery {
  limit?: number;
  cursor?: string;
  status?: ArtifactAuditJobStatus;
}
export interface ArtifactAuditJobPage {
  items: ArtifactAuditJob[];
  nextCursor: string | null;
}
export type Role = z.infer<typeof roleSchema>;
export type User = z.infer<typeof userSchema>;
export type SafeUser = z.infer<typeof safeUserSchema>;
export type ApiTokenScope = z.infer<typeof apiTokenScopeSchema>;
export type ApiTokenMetadata = z.infer<typeof apiTokenMetadataSchema>;
export type ApiTokenSecurityEventAction = z.infer<
  typeof apiTokenSecurityEventActionSchema
>;
export type ApiTokenSecurityReason = z.infer<
  typeof apiTokenSecurityReasonSchema
>;
export type ApiTokenSecurityEvent = z.infer<typeof apiTokenSecurityEventSchema>;
export type VersionSourceType = z.infer<typeof versionSourceTypeSchema>;
export type VersionStatus = z.infer<typeof versionStatusSchema>;
export type IntegrityStatus = z.infer<typeof integrityStatusSchema>;
export type Version = z.infer<typeof versionSchema>;
export type Project = z.infer<typeof projectSchema>;
export type HistoryAction = z.infer<typeof historyEventSchema>['action'];
export type HistoryEvent = z.infer<typeof historyEventSchema>;
export type HistoryPage = z.infer<typeof historyPageSchema>;
export interface HistoryPageQuery {
  limit?: number;
  cursor?: string;
}
export type Data = z.infer<typeof dataSchema>;
