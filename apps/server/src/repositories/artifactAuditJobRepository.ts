import type {
  ArtifactAuditJob,
  ArtifactAuditJobListQuery,
  ArtifactAuditJobPage,
} from '@deploykit/shared';
import type { ArtifactAuditCompletionPayload } from '../domain/artifactAuditJobTransitions';

export interface ArtifactAuditAdmissionLimits {
  global: number;
  requester: number;
  project: number;
}

export interface EnqueueArtifactAuditJobInput {
  projectId: string;
  versionId: string;
  requestedBy: string;
  priority: number;
  maxAttempts: number;
  now: string;
  jobId: string;
  engineVersion: number;
  artifactPresent: boolean;
  limits: ArtifactAuditAdmissionLimits;
}

export type EnqueueArtifactAuditJobResult =
  | {
      kind: 'enqueued';
      job: ArtifactAuditJob;
      replacedJobCount: number;
    }
  | { kind: 'reused'; job: ArtifactAuditJob }
  | {
      kind: 'rejected';
      scope: 'global' | 'requester' | 'project';
    }
  | { kind: 'project-not-found' }
  | { kind: 'version-not-found' }
  | { kind: 'artifact-missing' };

/**
 * Expired leases become immediately eligible for recovery. Exponential
 * backoff applies only to executor failures through `FailArtifactAuditJobInput`.
 */
export interface RecoverAndClaimArtifactAuditJobInput {
  workerId: string;
  now: string;
  leaseMs: number;
  engineVersion: number;
}

export interface RecoverAndClaimArtifactAuditJobResult {
  job: ArtifactAuditJob | null;
  recovered: {
    retried: number;
    failed: number;
  };
  stale: number;
}

export interface ScopedArtifactAuditJobKey {
  projectId: string;
  versionId: string;
  jobId: string;
}

export type ScopedArtifactAuditJobResult =
  | { kind: 'found'; job: ArtifactAuditJob }
  | { kind: 'project-not-found' }
  | { kind: 'version-not-found' }
  | { kind: 'job-not-found' };

export interface CancelArtifactAuditJobInput extends ScopedArtifactAuditJobKey {
  now: string;
}

export type CancelArtifactAuditJobResult =
  | { kind: 'found'; job: ArtifactAuditJob; changed: boolean }
  | { kind: 'project-not-found' }
  | { kind: 'version-not-found' }
  | { kind: 'job-not-found' };

export interface HeartbeatArtifactAuditJobInput {
  jobId: string;
  workerId: string;
  now: string;
  leaseMs: number;
}

export interface CompleteArtifactAuditJobInput {
  jobId: string;
  workerId: string;
  now: string;
  currentArtifactChecksum: string;
  engineVersion: number;
  reportId: string;
  historyEventId: string;
  result: ArtifactAuditCompletionPayload;
}

export interface FailArtifactAuditJobInput {
  jobId: string;
  workerId: string;
  now: string;
  retryable: boolean;
  retryBaseDelayMs: number;
  errorCode: string;
  errorMessage: string;
}

export type ArtifactAuditJobLeaseTransitionResult =
  | {
      kind: 'transitioned';
      job: ArtifactAuditJob;
      outcome: 'succeeded' | 'failed' | 'retried';
    }
  | { kind: 'job-not-found' }
  | { kind: 'lease-lost' };

export interface ArtifactAuditQueueHealth {
  queued: number;
  running: number;
  oldestQueuedAt: string | null;
  oldestQueuedAgeSeconds: number;
  terminal: {
    succeeded: number;
    failed: number;
    canceled: number;
  };
}

export interface ListArtifactAuditJobsInput extends ArtifactAuditJobListQuery {
  projectId: string;
  versionId: string;
}

export type ListArtifactAuditJobsResult =
  | { kind: 'page'; page: ArtifactAuditJobPage }
  | { kind: 'project-not-found' }
  | { kind: 'version-not-found' }
  | { kind: 'invalid-cursor' };

export interface PruneTerminalArtifactAuditJobsInput {
  cutoff: string;
  batchSize: number;
  dryRun: boolean;
}

export interface PruneTerminalArtifactAuditJobsResult {
  matched: number;
  removed: number;
}

export interface ArtifactAuditJobRepository {
  enqueue(input: EnqueueArtifactAuditJobInput): EnqueueArtifactAuditJobResult;
  recoverAndClaim(
    input: RecoverAndClaimArtifactAuditJobInput
  ): RecoverAndClaimArtifactAuditJobResult;
  get(input: ScopedArtifactAuditJobKey): ScopedArtifactAuditJobResult;
  cancel(input: CancelArtifactAuditJobInput): CancelArtifactAuditJobResult;
  heartbeat(input: HeartbeatArtifactAuditJobInput): ArtifactAuditJob | null;
  complete(
    input: CompleteArtifactAuditJobInput
  ): ArtifactAuditJobLeaseTransitionResult;
  fail(input: FailArtifactAuditJobInput): ArtifactAuditJobLeaseTransitionResult;
  health(input: { now: string }): ArtifactAuditQueueHealth;
  list(input: ListArtifactAuditJobsInput): ListArtifactAuditJobsResult;
  pruneTerminal(
    input: PruneTerminalArtifactAuditJobsInput
  ): PruneTerminalArtifactAuditJobsResult;
}
