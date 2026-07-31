import {
  type ArtifactAuditJob,
  artifactAuditJobSchema,
} from '@deploykit/shared';

export interface ArtifactAuditJobRow {
  id: string;
  project_id: string;
  version_id: string;
  requested_by: string;
  status: ArtifactAuditJob['status'];
  priority: number;
  attempts: number;
  max_attempts: number;
  next_run_at: string;
  locked_by: string | null;
  locked_until: string | null;
  artifact_checksum: string;
  engine_version: number;
  policy_json: string;
  context_json: string;
  report_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export const ARTIFACT_AUDIT_JOB_SELECT_COLUMNS = `
  id, project_id, version_id, requested_by, status, priority, attempts,
  max_attempts, next_run_at, locked_by, locked_until, artifact_checksum,
  engine_version, policy_json, context_json, report_id, error_code, error_message,
  created_at, updated_at, started_at, completed_at
`;

export function rowToArtifactAuditJob(
  row: ArtifactAuditJobRow
): ArtifactAuditJob {
  return artifactAuditJobSchema.parse({
    id: row.id,
    projectId: row.project_id,
    versionId: row.version_id,
    requestedBy: row.requested_by,
    status: row.status,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextRunAt: row.next_run_at,
    lockedBy: row.locked_by,
    lockedUntil: row.locked_until,
    artifactChecksum: row.artifact_checksum,
    engineVersion: row.engine_version,
    policy: JSON.parse(row.policy_json) as ArtifactAuditJob['policy'],
    context: JSON.parse(row.context_json) as ArtifactAuditJob['context'],
    reportId: row.report_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  });
}
