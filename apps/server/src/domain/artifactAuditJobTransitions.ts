import type {
  ArtifactAuditJob,
  ArtifactAuditReport,
  HistoryEvent,
} from '@deploykit/shared';
import { artifactAuditRetryDelayMs } from './artifactAuditJob';

export type ArtifactAuditCompletionPayload = Pick<
  ArtifactAuditReport,
  'artifactChecksum' | 'status' | 'score' | 'summary' | 'checks'
>;

export interface ArtifactAuditFailureDecision {
  status: 'queued' | 'failed';
  outcome: 'retried' | 'failed';
  nextRunAt: string;
  completedAt: string | null;
}

export function decideArtifactAuditFailure(
  job: ArtifactAuditJob,
  input: {
    now: string;
    retryable: boolean;
    retryBaseDelayMs: number;
  }
): ArtifactAuditFailureDecision {
  if (input.retryable && job.attempts < job.maxAttempts) {
    return {
      status: 'queued',
      outcome: 'retried',
      nextRunAt: new Date(
        Date.parse(input.now) +
          artifactAuditRetryDelayMs(input.retryBaseDelayMs, job.attempts)
      ).toISOString(),
      completedAt: null,
    };
  }
  return {
    status: 'failed',
    outcome: 'failed',
    nextRunAt: job.nextRunAt,
    completedAt: input.now,
  };
}

export function applyArtifactAuditCancel(
  job: ArtifactAuditJob,
  now: string,
  errorCode: string | null = null,
  errorMessage: string | null = null
): void {
  job.status = 'canceled';
  job.lockedBy = null;
  job.lockedUntil = null;
  job.errorCode = errorCode;
  job.errorMessage = errorMessage;
  job.updatedAt = now;
  job.completedAt = now;
}

export function applyArtifactAuditClaim(
  job: ArtifactAuditJob,
  input: { now: string; workerId: string; leaseMs: number }
): void {
  job.status = 'running';
  job.attempts += 1;
  job.lockedBy = input.workerId;
  job.lockedUntil = new Date(
    Date.parse(input.now) + input.leaseMs
  ).toISOString();
  job.updatedAt = input.now;
  job.startedAt ??= input.now;
  job.errorCode = null;
  job.errorMessage = null;
}

export function applyArtifactAuditFailure(
  job: ArtifactAuditJob,
  decision: ArtifactAuditFailureDecision,
  now: string,
  errorMessage = 'Artifact audit worker failed'
): void {
  job.status = decision.status;
  job.nextRunAt = decision.nextRunAt;
  job.lockedBy = null;
  job.lockedUntil = null;
  job.errorCode = 'AUDIT_JOB_FAILED';
  job.errorMessage = errorMessage;
  job.updatedAt = now;
  job.completedAt = decision.completedAt;
}

export function applyArtifactAuditTerminalFailure(
  job: ArtifactAuditJob,
  now: string,
  errorCode: string,
  errorMessage: string
): void {
  job.status = 'failed';
  job.lockedBy = null;
  job.lockedUntil = null;
  job.errorCode = errorCode;
  job.errorMessage = errorMessage;
  job.updatedAt = now;
  job.completedAt = now;
}

export function applyArtifactAuditSuccess(
  job: ArtifactAuditJob,
  reportId: string,
  now: string
): void {
  job.status = 'succeeded';
  job.reportId = reportId;
  job.lockedBy = null;
  job.lockedUntil = null;
  job.errorCode = null;
  job.errorMessage = null;
  job.updatedAt = now;
  job.completedAt = now;
}

export function createArtifactAuditCompletionRecords(input: {
  job: ArtifactAuditJob;
  result: ArtifactAuditCompletionPayload;
  now: string;
  reportId: string;
  historyEventId: string;
  projectName: string;
  versionName: string;
}): { report: ArtifactAuditReport; history: HistoryEvent } {
  const { job, result } = input;
  const report: ArtifactAuditReport = {
    id: input.reportId,
    projectId: job.projectId,
    versionId: job.versionId,
    artifactChecksum: result.artifactChecksum,
    status: result.status,
    score: result.score,
    createdAt: input.now,
    createdBy: job.requestedBy,
    engineVersion: job.engineVersion,
    policy: structuredClone(job.policy),
    summary: structuredClone(result.summary),
    checks: structuredClone(result.checks),
  };
  const warningCount = report.checks.filter(
    (check) => !check.passed && check.severity === 'warning'
  ).length;
  const errorCount = report.checks.filter(
    (check) => !check.passed && check.severity === 'error'
  ).length;
  return {
    report,
    history: {
      id: input.historyEventId,
      action: 'version.audit',
      projectId: job.projectId,
      projectName: input.projectName,
      versionId: job.versionId,
      versionName: input.versionName,
      timestamp: input.now,
      actorId: job.requestedBy,
      metadata: {
        reportId: report.id,
        status: report.status,
        score: report.score,
        warningCount,
        errorCount,
        totalBytes: report.summary.totalBytes,
        fileCount: report.summary.fileCount,
        artifactChecksum: report.artifactChecksum,
        engineVersion: report.engineVersion,
        jobId: job.id,
      },
    },
  };
}
