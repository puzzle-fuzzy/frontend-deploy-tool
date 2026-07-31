import {
  type ArtifactAuditContext,
  type ArtifactAuditJob,
  type ArtifactAuditPolicy,
  hasSameArtifactAuditRuleConfig,
} from '@deploykit/shared';

export const ACTIVE_ARTIFACT_AUDIT_JOB_STATUSES = [
  'queued',
  'running',
] as const;

export function isActiveArtifactAuditJob(job: ArtifactAuditJob): boolean {
  return job.status === 'queued' || job.status === 'running';
}

export function hasSameArtifactAuditSnapshot(
  job: ArtifactAuditJob,
  snapshot: {
    artifactChecksum: string;
    engineVersion: number;
    policy: ArtifactAuditPolicy;
    context: ArtifactAuditContext;
  }
): boolean {
  return (
    job.artifactChecksum === snapshot.artifactChecksum &&
    job.engineVersion === snapshot.engineVersion &&
    hasSameArtifactAuditPolicy(job.policy, snapshot.policy) &&
    hasSameArtifactAuditContext(job.context, snapshot.context)
  );
}

export function hasSameArtifactAuditPolicy(
  left: ArtifactAuditPolicy,
  right: ArtifactAuditPolicy
): boolean {
  return hasSameArtifactAuditRuleConfig(left, right);
}

export function hasSameArtifactAuditContext(
  left: ArtifactAuditContext,
  right: ArtifactAuditContext
): boolean {
  return (
    left.spaMode === right.spaMode && left.routingType === right.routingType
  );
}

export function isArtifactAuditLeaseOwned(
  job: ArtifactAuditJob,
  workerId: string,
  now: Date
): boolean {
  return (
    job.status === 'running' &&
    job.lockedBy === workerId &&
    job.lockedUntil !== null &&
    Date.parse(job.lockedUntil) > now.getTime()
  );
}

export function compareArtifactAuditClaimOrder(
  left: ArtifactAuditJob,
  right: ArtifactAuditJob
): number {
  return (
    right.priority - left.priority ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

export function artifactAuditRetryDelayMs(
  baseDelayMs: number,
  attempts: number
): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(baseDelayMs * 2 ** exponent, 15 * 60 * 1000);
}
