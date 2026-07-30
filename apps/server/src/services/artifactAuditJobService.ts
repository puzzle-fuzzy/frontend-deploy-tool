import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ArtifactAuditJob,
  ArtifactAuditJobPage,
  ArtifactAuditJobStatus,
} from '@deploykit/shared';
import { ApiError, ErrorCode } from '../errors';
import type { ArtifactAuditJobRepository } from '../repositories/artifactAuditJobRepository';
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

export type ArtifactAuditAdmissionScope = 'global' | 'requester' | 'project';

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
  list(
    projectId: string,
    versionId: string,
    query?: { limit?: string; cursor?: string; status?: string }
  ): ArtifactAuditJobPage;
  cancel(
    projectId: string,
    versionId: string,
    jobId: string,
    actorId: string
  ): ArtifactAuditJob;
  recoverAndClaim(
    workerId: string,
    leaseMs: number
  ): ClaimedArtifactAuditJob | null;
  heartbeat(
    jobId: string,
    workerId: string,
    leaseMs: number
  ): ArtifactAuditJob | null;
  complete(
    job: ArtifactAuditJob,
    workerId: string,
    result: ArtifactAuditResult
  ): ArtifactAuditJob;
  fail(jobId: string, workerId: string, error: unknown): ArtifactAuditJob;
  health(): ReturnType<ArtifactAuditJobRepository['health']>;
}

interface ArtifactAuditJobServiceDependencies {
  now?: () => Date;
  createId?: () => string;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  maxActiveJobs?: number;
  maxActiveJobsPerRequester?: number;
  maxActiveJobsPerProject?: number;
  recordOutcome?: (outcome: ArtifactAuditJobOutcome) => void;
  recordLeaseRecovery?: (outcome: 'retried' | 'failed') => void;
  recordAdmissionRejection?: (scope: ArtifactAuditAdmissionScope) => void;
}

export function createArtifactAuditJobService(
  repository: ArtifactAuditJobRepository,
  storageDir: string,
  dependencies: ArtifactAuditJobServiceDependencies = {}
): ArtifactAuditJobService {
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? defaultCreateId;
  const maxAttempts = dependencies.maxAttempts ?? 3;
  const retryBaseDelayMs = dependencies.retryBaseDelayMs ?? 2_000;
  const limits = {
    global: dependencies.maxActiveJobs ?? 100,
    requester: dependencies.maxActiveJobsPerRequester ?? 25,
    project: dependencies.maxActiveJobsPerProject ?? 10,
  };
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error('Artifact audit max attempts must be between 1 and 10');
  }
  if (!Number.isSafeInteger(retryBaseDelayMs) || retryBaseDelayMs < 1) {
    throw new Error('Artifact audit retry delay must be a positive integer');
  }
  for (const [scope, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(
        `Artifact audit ${scope} active limit must be a positive integer`
      );
    }
  }
  if (limits.requester > limits.global || limits.project > limits.global) {
    throw new Error(
      'Artifact audit requester and project limits must not exceed the global limit'
    );
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
      const result = repository.enqueue({
        projectId,
        versionId,
        requestedBy: actorId,
        priority,
        maxAttempts,
        now: now().toISOString(),
        jobId: createId(),
        engineVersion: ARTIFACT_AUDIT_ENGINE_VERSION,
        artifactPresent: existsSync(join(storageDir, projectId, versionId)),
        limits,
      });
      if (result.kind === 'project-not-found') throwProjectNotFound();
      if (result.kind === 'version-not-found') throwVersionNotFound();
      if (result.kind === 'artifact-missing') {
        throw new ApiError(
          ErrorCode.AUDIT_FAILED,
          'Artifact files are missing',
          409
        );
      }
      if (result.kind === 'rejected') {
        dependencies.recordAdmissionRejection?.(result.scope);
        throw new ApiError(
          ErrorCode.AUDIT_QUEUE_FULL,
          `Artifact audit queue ${result.scope} capacity is exhausted`,
          429
        );
      }
      if (result.kind === 'reused') {
        return { job: result.job, reused: true };
      }
      for (let index = 0; index < result.replacedJobCount; index += 1) {
        dependencies.recordOutcome?.('canceled');
      }
      return { job: result.job, reused: false };
    },

    get(projectId, versionId, jobId) {
      const result = repository.get({ projectId, versionId, jobId });
      return requireScopedJob(result);
    },

    list(projectId, versionId, query = {}) {
      const status = parseListStatus(query.status);
      const result = repository.list({
        projectId,
        versionId,
        limit: parseListLimit(query.limit),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(status ? { status } : {}),
      });
      if (result.kind === 'project-not-found') throwProjectNotFound();
      if (result.kind === 'version-not-found') throwVersionNotFound();
      if (result.kind === 'invalid-cursor') {
        throw new ApiError(
          ErrorCode.INVALID_AUDIT_JOB_CURSOR,
          'Invalid artifact audit job cursor',
          400
        );
      }
      return result.page;
    },

    cancel(projectId, versionId, jobId, _actorId) {
      const result = repository.cancel({
        projectId,
        versionId,
        jobId,
        now: now().toISOString(),
      });
      if (result.kind !== 'found') return requireScopedJob(result);
      if (result.changed) dependencies.recordOutcome?.('canceled');
      return result.job;
    },

    recoverAndClaim(workerId, leaseMs) {
      requireLeaseMs(leaseMs);
      const result = repository.recoverAndClaim({
        workerId,
        leaseMs,
        now: now().toISOString(),
        engineVersion: ARTIFACT_AUDIT_ENGINE_VERSION,
        retryBaseDelayMs,
      });
      recordCount(result.recovered.retried, () => {
        dependencies.recordOutcome?.('retried');
        dependencies.recordLeaseRecovery?.('retried');
      });
      recordCount(result.recovered.failed, () => {
        dependencies.recordOutcome?.('failed');
        dependencies.recordLeaseRecovery?.('failed');
      });
      recordCount(result.stale, () => {
        dependencies.recordOutcome?.('canceled');
      });
      return result.job
        ? {
            job: result.job,
            artifactDir: join(
              storageDir,
              result.job.projectId,
              result.job.versionId
            ),
          }
        : null;
    },

    heartbeat(jobId, workerId, leaseMs) {
      requireLeaseMs(leaseMs);
      return repository.heartbeat({
        jobId,
        workerId,
        leaseMs,
        now: now().toISOString(),
      });
    },

    complete(job, workerId, result) {
      const artifactDir = join(storageDir, job.projectId, job.versionId);
      const currentArtifactChecksum = existsSync(artifactDir)
        ? checksumDirectory(artifactDir)
        : '';
      const transition = repository.complete({
        jobId: job.id,
        workerId,
        now: now().toISOString(),
        currentArtifactChecksum,
        engineVersion: ARTIFACT_AUDIT_ENGINE_VERSION,
        reportId: createId(),
        historyEventId: createId(),
        result,
      });
      const completed = requireLeaseTransition(transition);
      dependencies.recordOutcome?.(completed.outcome);
      return completed.job;
    },

    fail(jobId, workerId, error) {
      const transition = repository.fail({
        jobId,
        workerId,
        now: now().toISOString(),
        retryable: isRetryableFailure(error),
        retryBaseDelayMs,
      });
      const failed = requireLeaseTransition(transition);
      dependencies.recordOutcome?.(failed.outcome);
      return failed.job;
    },

    health() {
      return repository.health({ now: now().toISOString() });
    },
  };
}

function requireScopedJob(
  result: ReturnType<ArtifactAuditJobRepository['get']>
): ArtifactAuditJob {
  if (result.kind === 'project-not-found') throwProjectNotFound();
  if (result.kind === 'version-not-found') throwVersionNotFound();
  if (result.kind === 'job-not-found') {
    throw new ApiError(
      ErrorCode.AUDIT_JOB_NOT_FOUND,
      'Artifact audit job not found',
      404
    );
  }
  return result.job;
}

function requireLeaseTransition(
  result:
    | ReturnType<ArtifactAuditJobRepository['complete']>
    | ReturnType<ArtifactAuditJobRepository['fail']>
): Extract<
  ReturnType<ArtifactAuditJobRepository['complete']>,
  { kind: 'transitioned' }
> {
  if (result.kind === 'job-not-found') {
    throw new ApiError(
      ErrorCode.AUDIT_JOB_NOT_FOUND,
      'Artifact audit job not found',
      404
    );
  }
  if (result.kind === 'lease-lost') {
    throw new ApiError(
      ErrorCode.AUDIT_JOB_CONFLICT,
      'Artifact audit job lease is no longer owned by this worker',
      409
    );
  }
  return result;
}

function throwProjectNotFound(): never {
  throw new ApiError(ErrorCode.PROJECT_NOT_FOUND, 'Project not found', 404);
}

function throwVersionNotFound(): never {
  throw new ApiError(ErrorCode.VERSION_NOT_FOUND, 'Version not found', 404);
}

function requireLeaseMs(leaseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
    throw new Error('Artifact audit lease must be a positive integer');
  }
}

function isRetryableFailure(error: unknown): boolean {
  return !(
    error &&
    typeof error === 'object' &&
    'retryable' in error &&
    error.retryable === false
  );
}

function recordCount(count: number, record: () => void): void {
  for (let index = 0; index < count; index += 1) record();
}

function parseListLimit(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 50;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return 50;
  return Math.min(parsed, 200);
}

function parseListStatus(
  value: string | undefined
): ArtifactAuditJobStatus | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  if (
    value === 'queued' ||
    value === 'running' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'canceled'
  ) {
    return value;
  }
  throw new ApiError(
    ErrorCode.INVALID_REQUEST,
    'Invalid artifact audit job status',
    400
  );
}
