import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ArtifactAuditJob,
  ArtifactAuditReport,
  Data,
  Project,
  Version,
} from '@deploykit/shared';
import {
  artifactAuditRetryDelayMs,
  compareArtifactAuditClaimOrder,
  hasSameArtifactAuditPolicy,
  hasSameArtifactAuditSnapshot,
  isActiveArtifactAuditJob,
  isArtifactAuditLeaseOwned,
} from '../domain/artifactAuditJob';
import { appendHistoryEvent } from '../domain/history';
import { ApiError, ErrorCode } from '../errors';
import type { ProjectRepository } from '../repositories/projectRepository';
import { createId as defaultCreateId } from '../utils/id';
import {
  ARTIFACT_AUDIT_ENGINE_VERSION,
  type ArtifactAuditResult,
} from './artifactAuditEngine';
import { checksumDirectory } from './artifactService';

export type ArtifactAuditJobOutcome =
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'retried';

export interface ClaimedArtifactAuditJob {
  job: ArtifactAuditJob;
  artifactDir: string;
}

export interface ArtifactAuditJobService {
  enqueue(
    projectId: string,
    versionId: string,
    actorId: string,
    options?: { priority?: number }
  ): { job: ArtifactAuditJob; reused: boolean };
  get(projectId: string, versionId: string, jobId: string): ArtifactAuditJob;
  cancel(
    projectId: string,
    versionId: string,
    jobId: string,
    actorId: string
  ): ArtifactAuditJob;
  claim(workerId: string, leaseMs: number): ClaimedArtifactAuditJob | null;
  heartbeat(
    jobId: string,
    workerId: string,
    leaseMs: number
  ): ArtifactAuditJob | null;
  complete(
    jobId: string,
    workerId: string,
    result: ArtifactAuditResult
  ): ArtifactAuditJob;
  fail(jobId: string, workerId: string, error: unknown): ArtifactAuditJob;
  sweepExpired(): number;
  countActive(): { queued: number; running: number };
}

interface ArtifactAuditJobServiceDependencies {
  now?: () => Date;
  createId?: () => string;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  recordOutcome?: (outcome: ArtifactAuditJobOutcome) => void;
}

export function createArtifactAuditJobService(
  repo: ProjectRepository,
  storageDir: string,
  dependencies: ArtifactAuditJobServiceDependencies = {}
): ArtifactAuditJobService {
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? defaultCreateId;
  const maxAttempts = dependencies.maxAttempts ?? 3;
  const retryBaseDelayMs = dependencies.retryBaseDelayMs ?? 2_000;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error('Artifact audit max attempts must be between 1 and 10');
  }
  if (!Number.isSafeInteger(retryBaseDelayMs) || retryBaseDelayMs < 1) {
    throw new Error('Artifact audit retry delay must be a positive integer');
  }

  return {
    enqueue(projectId, versionId, actorId, options = {}) {
      const priority = options.priority ?? 0;
      if (!Number.isInteger(priority) || priority < 0 || priority > 100) {
        throw new ApiError(
          ErrorCode.INVALID_REQUEST,
          'Artifact audit priority must be between 0 and 100',
          400
        );
      }
      const timestamp = now().toISOString();
      const result = repo.mutate((data) => {
        const { project, version } = requireProjectVersion(
          data,
          projectId,
          versionId
        );
        const artifactDir = join(storageDir, projectId, versionId);
        if (!existsSync(artifactDir)) {
          throw new ApiError(
            ErrorCode.AUDIT_FAILED,
            'Artifact files are missing',
            409
          );
        }
        const snapshot = {
          artifactChecksum: version.checksum,
          engineVersion: ARTIFACT_AUDIT_ENGINE_VERSION,
          policy: structuredClone(project.auditPolicy),
        };
        const activeJobs = data.artifactAuditJobs.filter(
          (job) =>
            job.projectId === projectId &&
            job.versionId === versionId &&
            isActiveArtifactAuditJob(job)
        );
        const duplicate = activeJobs.find((job) =>
          hasSameArtifactAuditSnapshot(job, snapshot)
        );
        if (duplicate) {
          return { job: duplicate, reused: true, canceled: 0 };
        }

        for (const active of activeJobs) {
          cancelJob(
            active,
            timestamp,
            ErrorCode.AUDIT_REQUIRED,
            'Artifact or audit policy changed before the job started'
          );
        }
        const job: ArtifactAuditJob = {
          id: createId(),
          projectId,
          versionId,
          requestedBy: actorId,
          status: 'queued',
          priority,
          attempts: 0,
          maxAttempts,
          nextRunAt: timestamp,
          lockedBy: null,
          lockedUntil: null,
          ...snapshot,
          reportId: null,
          errorCode: null,
          errorMessage: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          startedAt: null,
          completedAt: null,
        };
        data.artifactAuditJobs.push(job);
        return {
          job,
          reused: false,
          canceled: activeJobs.length,
        };
      });
      for (let index = 0; index < result.canceled; index += 1) {
        dependencies.recordOutcome?.('canceled');
      }
      return { job: result.job, reused: result.reused };
    },

    get(projectId, versionId, jobId) {
      const data = repo.load();
      requireProjectVersion(data, projectId, versionId);
      const job = data.artifactAuditJobs.find(
        (candidate) =>
          candidate.id === jobId &&
          candidate.projectId === projectId &&
          candidate.versionId === versionId
      );
      if (!job) {
        throw new ApiError(
          ErrorCode.AUDIT_JOB_NOT_FOUND,
          'Artifact audit job not found',
          404
        );
      }
      return job;
    },

    cancel(projectId, versionId, jobId, _actorId) {
      const timestamp = now().toISOString();
      const { job, changed } = repo.mutate((data) => {
        requireProjectVersion(data, projectId, versionId);
        const current = data.artifactAuditJobs.find(
          (candidate) =>
            candidate.id === jobId &&
            candidate.projectId === projectId &&
            candidate.versionId === versionId
        );
        if (!current) {
          throw new ApiError(
            ErrorCode.AUDIT_JOB_NOT_FOUND,
            'Artifact audit job not found',
            404
          );
        }
        if (!isActiveArtifactAuditJob(current)) {
          return { job: current, changed: false };
        }
        cancelJob(current, timestamp, null, null);
        return { job: current, changed: true };
      });
      if (changed) dependencies.recordOutcome?.('canceled');
      return job;
    },

    claim(workerId, leaseMs) {
      requireLeaseMs(leaseMs);
      const currentTime = now();
      const timestamp = currentTime.toISOString();
      const result = repo.mutate((data) => {
        let canceled = 0;
        const candidates = data.artifactAuditJobs
          .filter(
            (job) =>
              job.status === 'queued' &&
              Date.parse(job.nextRunAt) <= currentTime.getTime()
          )
          .sort(compareArtifactAuditClaimOrder);
        for (const job of candidates) {
          const project = data.projects.find(
            (candidate) => candidate.id === job.projectId
          );
          const version = project?.versions.find(
            (candidate) => candidate.id === job.versionId
          );
          if (
            !project ||
            !version ||
            !hasSameArtifactAuditSnapshot(job, {
              artifactChecksum: version.checksum,
              engineVersion: ARTIFACT_AUDIT_ENGINE_VERSION,
              policy: project.auditPolicy,
            })
          ) {
            cancelJob(
              job,
              timestamp,
              ErrorCode.AUDIT_REQUIRED,
              'Artifact or audit policy changed before the job was claimed'
            );
            canceled += 1;
            continue;
          }
          job.status = 'running';
          job.attempts += 1;
          job.lockedBy = workerId;
          job.lockedUntil = new Date(
            currentTime.getTime() + leaseMs
          ).toISOString();
          job.updatedAt = timestamp;
          job.startedAt ??= timestamp;
          job.errorCode = null;
          job.errorMessage = null;
          return {
            claimed: {
              job,
              artifactDir: join(storageDir, job.projectId, job.versionId),
            },
            canceled,
          };
        }
        return { claimed: null, canceled };
      });
      for (let index = 0; index < result.canceled; index += 1) {
        dependencies.recordOutcome?.('canceled');
      }
      return result.claimed;
    },

    heartbeat(jobId, workerId, leaseMs) {
      requireLeaseMs(leaseMs);
      const currentTime = now();
      return repo.mutate((data) => {
        const job = data.artifactAuditJobs.find(
          (candidate) => candidate.id === jobId
        );
        if (!job || !isArtifactAuditLeaseOwned(job, workerId, currentTime)) {
          return null;
        }
        job.lockedUntil = new Date(
          currentTime.getTime() + leaseMs
        ).toISOString();
        job.updatedAt = currentTime.toISOString();
        return job;
      });
    },

    complete(jobId, workerId, result) {
      const currentTime = now();
      const snapshot = repo
        .load()
        .artifactAuditJobs.find((candidate) => candidate.id === jobId);
      if (!snapshot) {
        throw new ApiError(
          ErrorCode.AUDIT_JOB_NOT_FOUND,
          'Artifact audit job not found',
          404
        );
      }
      const artifactDir = join(
        storageDir,
        snapshot.projectId,
        snapshot.versionId
      );
      const currentChecksum = existsSync(artifactDir)
        ? checksumDirectory(artifactDir)
        : '';
      const completion = repo.mutate((data) => {
        const job = requireOwnedJob(data, jobId, workerId, currentTime);
        const project = data.projects.find(
          (candidate) => candidate.id === job.projectId
        );
        const version = project?.versions.find(
          (candidate) => candidate.id === job.versionId
        );
        if (
          !project ||
          !version ||
          currentChecksum !== job.artifactChecksum ||
          result.artifactChecksum !== job.artifactChecksum ||
          version.checksum !== job.artifactChecksum ||
          job.engineVersion !== ARTIFACT_AUDIT_ENGINE_VERSION ||
          !hasSameArtifactAuditPolicy(project.auditPolicy, job.policy)
        ) {
          failJobTerminal(
            job,
            currentTime.toISOString(),
            ErrorCode.AUDIT_REQUIRED,
            'Artifact or audit policy changed while the job was running'
          );
          return { job, outcome: 'failed' as const };
        }

        const report = createReport(job, result, currentTime, createId);
        const replacedReportIds = new Set(
          data.artifactAudits
            .filter((candidate) => candidate.versionId === job.versionId)
            .map((candidate) => candidate.id)
        );
        for (const previousJob of data.artifactAuditJobs) {
          if (
            previousJob.id !== job.id &&
            previousJob.reportId &&
            replacedReportIds.has(previousJob.reportId)
          ) {
            previousJob.reportId = null;
          }
        }
        data.artifactAudits = data.artifactAudits.filter(
          (candidate) => candidate.versionId !== job.versionId
        );
        data.artifactAudits.push(report);
        appendArtifactAuditHistory(data, project, version, job, report);
        succeedJob(job, report.id, currentTime.toISOString());
        return { job, outcome: 'succeeded' as const };
      });
      dependencies.recordOutcome?.(completion.outcome);
      return completion.job;
    },

    fail(jobId, workerId, error) {
      const currentTime = now();
      const timestamp = currentTime.toISOString();
      const retryable = isRetryableFailure(error);
      const result = repo.mutate((data) => {
        const job = requireOwnedJob(data, jobId, workerId, currentTime);
        job.errorCode = ErrorCode.AUDIT_JOB_FAILED;
        job.errorMessage = 'Artifact audit worker failed';
        job.lockedBy = null;
        job.lockedUntil = null;
        job.updatedAt = timestamp;
        if (retryable && job.attempts < job.maxAttempts) {
          job.status = 'queued';
          job.nextRunAt = new Date(
            currentTime.getTime() +
              artifactAuditRetryDelayMs(retryBaseDelayMs, job.attempts)
          ).toISOString();
          return { job, outcome: 'retried' as const };
        }
        job.status = 'failed';
        job.completedAt = timestamp;
        return { job, outcome: 'failed' as const };
      });
      dependencies.recordOutcome?.(result.outcome);
      return result.job;
    },

    sweepExpired() {
      const currentTime = now();
      const timestamp = currentTime.toISOString();
      const outcomes = repo.mutate((data) => {
        const nextOutcomes: ArtifactAuditJobOutcome[] = [];
        for (const job of data.artifactAuditJobs) {
          if (
            job.status !== 'running' ||
            !job.lockedUntil ||
            Date.parse(job.lockedUntil) > currentTime.getTime()
          ) {
            continue;
          }
          job.lockedBy = null;
          job.lockedUntil = null;
          job.errorCode = ErrorCode.AUDIT_JOB_FAILED;
          job.errorMessage = 'Artifact audit worker lease expired';
          job.updatedAt = timestamp;
          if (job.attempts < job.maxAttempts) {
            job.status = 'queued';
            job.nextRunAt = timestamp;
            nextOutcomes.push('retried');
          } else {
            job.status = 'failed';
            job.completedAt = timestamp;
            nextOutcomes.push('failed');
          }
        }
        return nextOutcomes;
      });
      for (const outcome of outcomes) dependencies.recordOutcome?.(outcome);
      return outcomes.length;
    },

    countActive() {
      const counts = { queued: 0, running: 0 };
      for (const job of repo.load().artifactAuditJobs) {
        if (job.status === 'queued') counts.queued += 1;
        if (job.status === 'running') counts.running += 1;
      }
      return counts;
    },
  };
}

function requireProjectVersion(
  data: Data,
  projectId: string,
  versionId: string
): { project: Project; version: Version } {
  const project = data.projects.find((candidate) => candidate.id === projectId);
  if (!project) {
    throw new ApiError(ErrorCode.PROJECT_NOT_FOUND, 'Project not found', 404);
  }
  const version = project.versions.find(
    (candidate) => candidate.id === versionId
  );
  if (!version) {
    throw new ApiError(ErrorCode.VERSION_NOT_FOUND, 'Version not found', 404);
  }
  return { project, version };
}

function requireOwnedJob(
  data: Data,
  jobId: string,
  workerId: string,
  now: Date
): ArtifactAuditJob {
  const job = data.artifactAuditJobs.find(
    (candidate) => candidate.id === jobId
  );
  if (!job) {
    throw new ApiError(
      ErrorCode.AUDIT_JOB_NOT_FOUND,
      'Artifact audit job not found',
      404
    );
  }
  if (!isArtifactAuditLeaseOwned(job, workerId, now)) {
    throw new ApiError(
      ErrorCode.AUDIT_JOB_CONFLICT,
      'Artifact audit job lease is no longer owned by this worker',
      409
    );
  }
  return job;
}

function createReport(
  job: ArtifactAuditJob,
  result: ArtifactAuditResult,
  now: Date,
  createId: () => string
): ArtifactAuditReport {
  return {
    id: createId(),
    projectId: job.projectId,
    versionId: job.versionId,
    artifactChecksum: result.artifactChecksum,
    status: result.status,
    score: result.score,
    createdAt: now.toISOString(),
    createdBy: job.requestedBy,
    engineVersion: job.engineVersion,
    policy: structuredClone(job.policy),
    summary: result.summary,
    checks: result.checks,
  };
}

function appendArtifactAuditHistory(
  data: Data,
  project: Project,
  version: Version,
  job: ArtifactAuditJob,
  report: ArtifactAuditReport
): void {
  const warningCount = report.checks.filter(
    (check) => !check.passed && check.severity === 'warning'
  ).length;
  const errorCount = report.checks.filter(
    (check) => !check.passed && check.severity === 'error'
  ).length;
  appendHistoryEvent(data, 'version.audit', project, job.requestedBy, version, {
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
  });
}

function succeedJob(
  job: ArtifactAuditJob,
  reportId: string,
  timestamp: string
): void {
  job.status = 'succeeded';
  job.reportId = reportId;
  job.lockedBy = null;
  job.lockedUntil = null;
  job.errorCode = null;
  job.errorMessage = null;
  job.updatedAt = timestamp;
  job.completedAt = timestamp;
}

function failJobTerminal(
  job: ArtifactAuditJob,
  timestamp: string,
  errorCode: string,
  errorMessage: string
): void {
  job.status = 'failed';
  job.lockedBy = null;
  job.lockedUntil = null;
  job.errorCode = errorCode;
  job.errorMessage = errorMessage;
  job.updatedAt = timestamp;
  job.completedAt = timestamp;
}

function cancelJob(
  job: ArtifactAuditJob,
  timestamp: string,
  errorCode: string | null,
  errorMessage: string | null
): void {
  job.status = 'canceled';
  job.lockedBy = null;
  job.lockedUntil = null;
  job.errorCode = errorCode;
  job.errorMessage = errorMessage;
  job.updatedAt = timestamp;
  job.completedAt = timestamp;
}

function requireLeaseMs(leaseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
    throw new Error('Artifact audit lease must be a positive integer');
  }
}

function isRetryableFailure(error: unknown): boolean {
  if (
    error &&
    typeof error === 'object' &&
    'retryable' in error &&
    error.retryable === false
  ) {
    return false;
  }
  return true;
}
