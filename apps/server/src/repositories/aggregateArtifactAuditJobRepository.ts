import type {
  ArtifactAuditJob,
  Data,
  Project,
  Version,
} from '@deploykit/shared';
import {
  compareArtifactAuditClaimOrder,
  hasSameArtifactAuditContext,
  hasSameArtifactAuditPolicy,
  hasSameArtifactAuditSnapshot,
  isActiveArtifactAuditJob,
  isArtifactAuditLeaseOwned,
} from '../domain/artifactAuditJob';
import type { ArtifactAuditJobCursorCodec } from '../domain/artifactAuditJobCursor';
import {
  applyArtifactAuditCancel,
  applyArtifactAuditClaim,
  applyArtifactAuditFailure,
  applyArtifactAuditSuccess,
  applyArtifactAuditTerminalFailure,
  createArtifactAuditCompletionRecords,
  decideArtifactAuditFailure,
} from '../domain/artifactAuditJobTransitions';
import type {
  ArtifactAuditJobRepository,
  CompleteArtifactAuditJobInput,
  EnqueueArtifactAuditJobInput,
  FailArtifactAuditJobInput,
  RecoverAndClaimArtifactAuditJobInput,
  ScopedArtifactAuditJobKey,
} from './artifactAuditJobRepository';
import type { ProjectRepository } from './projectRepository';

export function createAggregateArtifactAuditJobRepository(
  projectRepository: ProjectRepository,
  cursorCodec: ArtifactAuditJobCursorCodec
): ArtifactAuditJobRepository {
  return {
    enqueue(input) {
      return projectRepository.mutate((data) => {
        const current = readProjectVersion(
          data,
          input.projectId,
          input.versionId
        );
        if (current.kind !== 'found') return current;
        if (!input.artifactPresent) return { kind: 'artifact-missing' };
        const snapshot = {
          artifactChecksum: current.version.checksum,
          engineVersion: input.engineVersion,
          policy: current.project.auditPolicy,
          context: current.project.settings,
        };
        const activeJobs = data.artifactAuditJobs.filter(
          (job) =>
            job.projectId === input.projectId &&
            job.versionId === input.versionId &&
            isActiveArtifactAuditJob(job)
        );
        const duplicate = activeJobs.find((job) =>
          hasSameArtifactAuditSnapshot(job, snapshot)
        );
        if (duplicate) return { kind: 'reused', job: duplicate };

        const counts = projectedCounts(
          data.artifactAuditJobs,
          input,
          activeJobs
        );
        if (counts.global > input.limits.global) {
          return { kind: 'rejected', scope: 'global' };
        }
        if (counts.requester > input.limits.requester) {
          return { kind: 'rejected', scope: 'requester' };
        }
        if (counts.project > input.limits.project) {
          return { kind: 'rejected', scope: 'project' };
        }
        for (const job of activeJobs) {
          applyArtifactAuditCancel(
            job,
            input.now,
            'AUDIT_REQUIRED',
            'Artifact or audit policy changed before the job started'
          );
        }
        const job: ArtifactAuditJob = {
          id: input.jobId,
          projectId: input.projectId,
          versionId: input.versionId,
          requestedBy: input.requestedBy,
          status: 'queued',
          priority: input.priority,
          attempts: 0,
          maxAttempts: input.maxAttempts,
          nextRunAt: input.now,
          lockedBy: null,
          lockedUntil: null,
          artifactChecksum: current.version.checksum,
          engineVersion: input.engineVersion,
          policy: structuredClone(current.project.auditPolicy),
          context: structuredClone(current.project.settings),
          reportId: null,
          errorCode: null,
          errorMessage: null,
          createdAt: input.now,
          updatedAt: input.now,
          startedAt: null,
          completedAt: null,
        };
        data.artifactAuditJobs.push(job);
        return {
          kind: 'enqueued',
          job,
          replacedJobCount: activeJobs.length,
        };
      });
    },

    get(input) {
      return readScopedJob(projectRepository.load(), input);
    },

    cancel(input) {
      return projectRepository.mutate((data) => {
        const current = readScopedJob(data, input);
        if (current.kind !== 'found') return current;
        if (!isActiveArtifactAuditJob(current.job)) {
          return { ...current, changed: false };
        }
        applyArtifactAuditCancel(current.job, input.now);
        return { ...current, changed: true };
      });
    },

    recoverAndClaim(input) {
      const snapshot = projectRepository.load();
      const currentTime = Date.parse(input.now);
      const hasTransition = snapshot.artifactAuditJobs.some(
        (job) =>
          (job.status === 'running' &&
            job.lockedUntil !== null &&
            Date.parse(job.lockedUntil) <= currentTime) ||
          (job.status === 'queued' && Date.parse(job.nextRunAt) <= currentTime)
      );
      if (!hasTransition) {
        return {
          job: null,
          recovered: { retried: 0, failed: 0 },
          stale: 0,
        };
      }
      return projectRepository.mutate((data) =>
        recoverAndClaimAggregate(data, input)
      );
    },

    heartbeat(input) {
      const snapshot = projectRepository
        .load()
        .artifactAuditJobs.find((job) => job.id === input.jobId);
      if (
        !snapshot ||
        !isArtifactAuditLeaseOwned(
          snapshot,
          input.workerId,
          new Date(input.now)
        )
      ) {
        return null;
      }
      return projectRepository.mutate((data) => {
        const job = data.artifactAuditJobs.find(
          (candidate) => candidate.id === input.jobId
        );
        if (
          !job ||
          !isArtifactAuditLeaseOwned(job, input.workerId, new Date(input.now))
        ) {
          return null;
        }
        job.lockedUntil = new Date(
          Date.parse(input.now) + input.leaseMs
        ).toISOString();
        job.updatedAt = input.now;
        return job;
      });
    },

    complete(input) {
      return projectRepository.mutate((data) => completeAggregate(data, input));
    },

    fail(input) {
      return projectRepository.mutate((data) => failAggregate(data, input));
    },

    health(input) {
      const jobs = projectRepository.load().artifactAuditJobs;
      const queued = jobs.filter((job) => job.status === 'queued');
      const oldestQueuedAt =
        queued
          .map((job) => job.createdAt)
          .sort((left, right) => left.localeCompare(right))[0] ?? null;
      return {
        queued: queued.length,
        running: jobs.filter((job) => job.status === 'running').length,
        oldestQueuedAt,
        oldestQueuedAgeSeconds: calculateQueueAge(oldestQueuedAt, input.now),
        terminal: {
          succeeded: jobs.filter((job) => job.status === 'succeeded').length,
          failed: jobs.filter((job) => job.status === 'failed').length,
          canceled: jobs.filter((job) => job.status === 'canceled').length,
        },
      };
    },

    list(input) {
      const data = projectRepository.load();
      const current = readProjectVersion(
        data,
        input.projectId,
        input.versionId
      );
      if (current.kind !== 'found') return current;
      const status = input.status ?? null;
      let anchor: ArtifactAuditJob | null = null;
      if (input.cursor) {
        const cursor = cursorCodec.decode(input.cursor);
        if (
          !cursor ||
          cursor.projectId !== input.projectId ||
          cursor.versionId !== input.versionId ||
          cursor.status !== status
        ) {
          return { kind: 'invalid-cursor' };
        }
        anchor =
          data.artifactAuditJobs.find(
            (job) =>
              job.id === cursor.anchorJobId &&
              job.projectId === input.projectId &&
              job.versionId === input.versionId
          ) ?? null;
        if (!anchor) return { kind: 'invalid-cursor' };
      }
      const limit = normalizeListLimit(input.limit);
      const rows = data.artifactAuditJobs
        .filter(
          (job) =>
            job.projectId === input.projectId &&
            job.versionId === input.versionId &&
            (!status || job.status === status) &&
            (!anchor ||
              job.createdAt < anchor.createdAt ||
              (job.createdAt === anchor.createdAt && job.id < anchor.id))
        )
        .sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) ||
            right.id.localeCompare(left.id)
        );
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const lastItem = items.at(-1);
      return {
        kind: 'page',
        page: {
          items,
          nextCursor:
            hasMore && lastItem
              ? cursorCodec.encode({
                  projectId: input.projectId,
                  versionId: input.versionId,
                  anchorJobId: lastItem.id,
                  status,
                })
              : null,
        },
      };
    },

    pruneTerminal(input) {
      const matches = projectRepository
        .load()
        .artifactAuditJobs.filter(
          (job) =>
            ['succeeded', 'failed', 'canceled'].includes(job.status) &&
            job.completedAt !== null &&
            job.completedAt < input.cutoff
        )
        .sort(
          (left, right) =>
            (left.completedAt ?? '').localeCompare(right.completedAt ?? '') ||
            left.id.localeCompare(right.id)
        )
        .slice(0, input.batchSize);
      if (input.dryRun || matches.length === 0) {
        return { matched: matches.length, removed: 0 };
      }
      const ids = new Set(matches.map((job) => job.id));
      return projectRepository.mutate((data) => {
        const before = data.artifactAuditJobs.length;
        data.artifactAuditJobs = data.artifactAuditJobs.filter(
          (job) => !ids.has(job.id)
        );
        return {
          matched: matches.length,
          removed: before - data.artifactAuditJobs.length,
        };
      });
    },
  };
}

function recoverAndClaimAggregate(
  data: Data,
  input: RecoverAndClaimArtifactAuditJobInput
): ReturnType<ArtifactAuditJobRepository['recoverAndClaim']> {
  const recovered = { retried: 0, failed: 0 };
  let stale = 0;
  const currentTime = Date.parse(input.now);
  for (const job of data.artifactAuditJobs) {
    if (
      job.status !== 'running' ||
      job.lockedUntil === null ||
      Date.parse(job.lockedUntil) > currentTime
    ) {
      continue;
    }
    if (job.attempts < job.maxAttempts) {
      applyArtifactAuditFailure(
        job,
        {
          status: 'queued',
          outcome: 'retried',
          nextRunAt: input.now,
          completedAt: null,
        },
        input.now,
        'AUDIT_JOB_FAILED',
        'Artifact audit worker lease expired'
      );
      recovered.retried += 1;
    } else {
      applyArtifactAuditFailure(
        job,
        {
          status: 'failed',
          outcome: 'failed',
          nextRunAt: job.nextRunAt,
          completedAt: input.now,
        },
        input.now,
        'AUDIT_JOB_FAILED',
        'Artifact audit worker lease expired'
      );
      recovered.failed += 1;
    }
  }
  const candidates = data.artifactAuditJobs
    .filter(
      (job) =>
        job.status === 'queued' && Date.parse(job.nextRunAt) <= currentTime
    )
    .sort(compareArtifactAuditClaimOrder);
  for (const job of candidates) {
    const current = readProjectVersion(data, job.projectId, job.versionId);
    if (
      current.kind !== 'found' ||
      job.artifactChecksum !== current.version.checksum ||
      job.engineVersion !== input.engineVersion ||
      !hasSameArtifactAuditPolicy(job.policy, current.project.auditPolicy) ||
      !hasSameArtifactAuditContext(job.context, current.project.settings)
    ) {
      applyArtifactAuditCancel(
        job,
        input.now,
        'AUDIT_REQUIRED',
        'Artifact or audit policy changed before the job was claimed'
      );
      stale += 1;
      continue;
    }
    applyArtifactAuditClaim(job, {
      now: input.now,
      workerId: input.workerId,
      leaseMs: input.leaseMs,
    });
    return { job, recovered, stale };
  }
  return { job: null, recovered, stale };
}

function completeAggregate(
  data: Data,
  input: CompleteArtifactAuditJobInput
): ReturnType<ArtifactAuditJobRepository['complete']> {
  const job = data.artifactAuditJobs.find(
    (candidate) => candidate.id === input.jobId
  );
  if (!job) return { kind: 'job-not-found' };
  if (!isArtifactAuditLeaseOwned(job, input.workerId, new Date(input.now))) {
    return { kind: 'lease-lost' };
  }
  const current = readProjectVersion(data, job.projectId, job.versionId);
  if (
    current.kind !== 'found' ||
    input.currentArtifactChecksum !== job.artifactChecksum ||
    input.result.artifactChecksum !== job.artifactChecksum ||
    current.version.checksum !== job.artifactChecksum ||
    job.engineVersion !== input.engineVersion ||
    !hasSameArtifactAuditPolicy(current.project.auditPolicy, job.policy) ||
    !hasSameArtifactAuditContext(current.project.settings, job.context)
  ) {
    applyArtifactAuditTerminalFailure(
      job,
      input.now,
      'AUDIT_REQUIRED',
      'Artifact or audit policy changed while the job was running'
    );
    return { kind: 'transitioned', job, outcome: 'failed' };
  }
  const records = createArtifactAuditCompletionRecords({
    job,
    result: input.result,
    now: input.now,
    reportId: input.reportId,
    historyEventId: input.historyEventId,
    projectName: current.project.name,
    versionName: current.version.name,
  });
  const previousReportIds = new Set(
    data.artifactAudits
      .filter((report) => report.versionId === job.versionId)
      .map((report) => report.id)
  );
  for (const previousJob of data.artifactAuditJobs) {
    if (
      previousJob.id !== job.id &&
      previousJob.reportId &&
      previousReportIds.has(previousJob.reportId)
    ) {
      previousJob.reportId = null;
    }
  }
  data.artifactAudits = data.artifactAudits.filter(
    (report) => report.versionId !== job.versionId
  );
  data.artifactAudits.push(records.report);
  data.history.unshift(records.history);
  if (data.history.length > 200) data.history.length = 200;
  applyArtifactAuditSuccess(job, records.report.id, input.now);
  return { kind: 'transitioned', job, outcome: 'succeeded' };
}

function failAggregate(
  data: Data,
  input: FailArtifactAuditJobInput
): ReturnType<ArtifactAuditJobRepository['fail']> {
  const job = data.artifactAuditJobs.find(
    (candidate) => candidate.id === input.jobId
  );
  if (!job) return { kind: 'job-not-found' };
  if (!isArtifactAuditLeaseOwned(job, input.workerId, new Date(input.now))) {
    return { kind: 'lease-lost' };
  }
  const decision = decideArtifactAuditFailure(job, input);
  applyArtifactAuditFailure(
    job,
    decision,
    input.now,
    input.errorCode,
    input.errorMessage
  );
  return {
    kind: 'transitioned',
    job,
    outcome: decision.outcome,
  };
}

function readScopedJob(
  data: Data,
  input: ScopedArtifactAuditJobKey
): ReturnType<ArtifactAuditJobRepository['get']> {
  const current = readProjectVersion(data, input.projectId, input.versionId);
  if (current.kind !== 'found') return current;
  const job = data.artifactAuditJobs.find(
    (candidate) =>
      candidate.id === input.jobId &&
      candidate.projectId === input.projectId &&
      candidate.versionId === input.versionId
  );
  return job ? { kind: 'found', job } : { kind: 'job-not-found' };
}

type ProjectVersionResult =
  | { kind: 'found'; project: Project; version: Version }
  | { kind: 'project-not-found' }
  | { kind: 'version-not-found' };

function readProjectVersion(
  data: Data,
  projectId: string,
  versionId: string
): ProjectVersionResult {
  const project = data.projects.find((candidate) => candidate.id === projectId);
  if (!project) return { kind: 'project-not-found' };
  const version = project.versions.find(
    (candidate) => candidate.id === versionId
  );
  return version
    ? { kind: 'found', project, version }
    : { kind: 'version-not-found' };
}

function projectedCounts(
  jobs: ArtifactAuditJob[],
  input: EnqueueArtifactAuditJobInput,
  replacements: ArtifactAuditJob[]
): { global: number; requester: number; project: number } {
  const active = jobs.filter(isActiveArtifactAuditJob);
  return {
    global: active.length - replacements.length + 1,
    requester:
      active.filter((job) => job.requestedBy === input.requestedBy).length -
      replacements.filter((job) => job.requestedBy === input.requestedBy)
        .length +
      1,
    project:
      active.filter((job) => job.projectId === input.projectId).length -
      replacements.length +
      1,
  };
}

function normalizeListLimit(limit: number | undefined): number {
  return Number.isSafeInteger(limit) && (limit ?? 0) > 0
    ? Math.min(limit ?? 50, 200)
    : 50;
}

function calculateQueueAge(oldestQueuedAt: string | null, now: string): number {
  if (!oldestQueuedAt) return 0;
  return Math.max(0, (Date.parse(now) - Date.parse(oldestQueuedAt)) / 1_000);
}
