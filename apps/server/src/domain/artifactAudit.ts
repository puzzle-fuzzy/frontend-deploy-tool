import type {
  ArtifactAuditPolicy,
  Data,
  Project,
  Version,
} from '@deploykit/shared';
import { ApiError, ErrorCode } from '../errors';
import { ARTIFACT_AUDIT_ENGINE_VERSION } from '../services/artifactAuditEngine';

/** Enforces the opt-in project release gate against the current version report. */
export function assertArtifactAuditAllowsRelease(
  data: Data,
  project: Project,
  version: Version
): void {
  if (project.auditPolicy.enforcement !== 'blocking') return;

  const report = data.artifactAudits.find(
    (candidate) =>
      candidate.projectId === project.id && candidate.versionId === version.id
  );
  if (!report) {
    throw new ApiError(
      ErrorCode.AUDIT_REQUIRED,
      'Run an artifact audit before releasing this version',
      409
    );
  }
  if (
    report.engineVersion !== ARTIFACT_AUDIT_ENGINE_VERSION ||
    !hasSameAuditBudgets(report.policy, project.auditPolicy)
  ) {
    throw new ApiError(
      ErrorCode.AUDIT_REQUIRED,
      'The artifact audit is stale for the current audit policy',
      409
    );
  }
  if (report.status === 'failed') {
    throw new ApiError(
      ErrorCode.AUDIT_BLOCKED,
      'The current artifact audit contains blocking findings',
      409
    );
  }
  if (report.artifactChecksum !== version.checksum) {
    throw new ApiError(
      ErrorCode.AUDIT_REQUIRED,
      'The artifact changed after its current audit',
      409
    );
  }
}

export function hasSameAuditBudgets(
  left: ArtifactAuditPolicy,
  right: ArtifactAuditPolicy
): boolean {
  return (
    left.maxTotalBytes === right.maxTotalBytes &&
    left.maxFileBytes === right.maxFileBytes &&
    left.maxFileCount === right.maxFileCount
  );
}
