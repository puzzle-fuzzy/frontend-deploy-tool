import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project } from '@deploykit/shared';
import { createArtifactAuditJobCursorCodec } from '../../src/domain/artifactAuditJobCursor';
import { createEmptyData } from '../../src/domain/schema';
import { ErrorCode } from '../../src/errors';
import { createAggregateArtifactAuditJobRepository } from '../../src/repositories/aggregateArtifactAuditJobRepository';
import { createJsonProjectRepository } from '../../src/repositories/jsonProjectRepository';
import type { ProjectRepository } from '../../src/repositories/projectRepository';
import type { ArtifactAuditResult } from '../../src/services/artifactAuditEngine';
import { createArtifactAuditJobService } from '../../src/services/artifactAuditJobService';
import { checksumDirectory } from '../../src/services/artifactService';

let tempDir: string;
let storageDir: string;
let dataFile: string;
let currentTime: Date;
let idSequence: number;
const CURSOR_CODEC = createArtifactAuditJobCursorCodec(
  'aggregate-audit-job-repository-test-secret'
);

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'deploykit-audit-jobs-'));
  storageDir = join(tempDir, 'storage');
  dataFile = join(tempDir, 'data.json');
  currentTime = new Date('2026-07-30T00:00:00.000Z');
  idSequence = 0;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('createArtifactAuditJobService', () => {
  test('rejects queue sub-limits above the global admission limit', () => {
    const { repo } = createFixture();
    expect(() =>
      createService(repo, {
        maxActiveJobs: 1,
        maxActiveJobsPerRequester: 2,
        maxActiveJobsPerProject: 1,
      })
    ).toThrow(
      'Artifact audit requester and project limits must not exceed the global limit'
    );
    expect(() =>
      createService(repo, {
        maxActiveJobs: 1,
        maxActiveJobsPerRequester: 1,
        maxActiveJobsPerProject: 2,
      })
    ).toThrow(
      'Artifact audit requester and project limits must not exceed the global limit'
    );
  });

  test('deduplicates an active snapshot and cancels it when policy changes', () => {
    const { repo } = createFixture();
    const service = createService(repo);

    const first = service.enqueue('project-1', 'version-1', 'owner-1');
    const duplicate = service.enqueue('project-1', 'version-1', 'owner-1');
    expect(duplicate).toEqual({ job: first.job, reused: true });

    repo.mutate((data) => {
      data.projects[0].auditPolicy.maxTotalBytes -= 1;
    });
    advance(1_000);
    const replacement = service.enqueue('project-1', 'version-1', 'owner-1');
    const jobs = repo.load().artifactAuditJobs;

    expect(replacement.reused).toBe(false);
    expect(replacement.job.id).not.toBe(first.job.id);
    expect(jobs.find((job) => job.id === first.job.id)).toMatchObject({
      status: 'canceled',
      errorCode: ErrorCode.AUDIT_REQUIRED,
      completedAt: currentTime.toISOString(),
    });
  });

  test('claims, heartbeats, and atomically completes one job with a report', () => {
    const { repo, checksum } = createFixture();
    const outcomes: string[] = [];
    const service = createService(repo, {
      recordOutcome: (outcome) => outcomes.push(outcome),
    });
    const { job } = service.enqueue('project-1', 'version-1', 'owner-1');

    const claimed = service.recoverAndClaim('worker-1', 90_000);
    expect(claimed).toMatchObject({
      artifactDir: join(storageDir, 'project-1', 'version-1'),
      job: {
        id: job.id,
        status: 'running',
        attempts: 1,
        lockedBy: 'worker-1',
        lockedUntil: '2026-07-30T00:01:30.000Z',
      },
    });
    expect(service.recoverAndClaim('worker-2', 90_000)).toBeNull();

    advance(15_000);
    expect(service.heartbeat(job.id, 'worker-1', 90_000)).toMatchObject({
      lockedUntil: '2026-07-30T00:01:45.000Z',
    });
    const completed = service.complete(
      job,
      'worker-1',
      resultFixture(checksum)
    );
    const stored = repo.load();

    expect(completed).toMatchObject({
      status: 'succeeded',
      reportId: expect.any(String),
      lockedBy: null,
      completedAt: currentTime.toISOString(),
    });
    expect(stored.artifactAudits).toHaveLength(1);
    expect(stored.artifactAudits[0]).toMatchObject({
      id: completed.reportId,
      artifactChecksum: checksum,
      createdBy: 'owner-1',
    });
    expect(stored.history[0]).toMatchObject({
      action: 'version.audit',
      metadata: {
        reportId: completed.reportId,
        status: 'warning',
        score: 90,
        warningCount: 0,
        errorCount: 0,
        totalBytes: 1,
        fileCount: 1,
        artifactChecksum: checksum,
        engineVersion: 1,
        jobId: job.id,
      },
    });
    expect(outcomes).toEqual(['succeeded']);
  });

  test('rejects completion by a different or expired lease owner', () => {
    const { repo, checksum } = createFixture();
    const service = createService(repo);
    const { job } = service.enqueue('project-1', 'version-1', 'owner-1');
    service.recoverAndClaim('worker-1', 1_000);

    expect(() =>
      service.complete(job, 'worker-2', resultFixture(checksum))
    ).toThrow(expect.objectContaining({ code: ErrorCode.AUDIT_JOB_CONFLICT }));

    advance(1_001);
    expect(() =>
      service.complete(job, 'worker-1', resultFixture(checksum))
    ).toThrow(expect.objectContaining({ code: ErrorCode.AUDIT_JOB_CONFLICT }));
    expect(repo.load().artifactAudits).toEqual([]);
  });

  test('retries infrastructure failures with backoff and stops at max attempts', () => {
    const { repo } = createFixture();
    const outcomes: string[] = [];
    const service = createService(repo, {
      maxAttempts: 2,
      retryBaseDelayMs: 2_000,
      recordOutcome: (outcome) => outcomes.push(outcome),
    });
    const { job } = service.enqueue('project-1', 'version-1', 'owner-1');
    service.recoverAndClaim('worker-1', 90_000);

    const retry = service.fail(job.id, 'worker-1', new Error('worker crashed'));
    expect(retry).toMatchObject({
      status: 'queued',
      attempts: 1,
      nextRunAt: '2026-07-30T00:00:02.000Z',
      errorCode: ErrorCode.AUDIT_JOB_FAILED,
      errorMessage: 'Artifact audit worker failed',
    });
    expect(service.recoverAndClaim('worker-1', 90_000)).toBeNull();

    advance(2_000);
    service.recoverAndClaim('worker-1', 90_000);
    const failed = service.fail(
      job.id,
      'worker-1',
      new Error('worker crashed')
    );
    expect(failed).toMatchObject({
      status: 'failed',
      attempts: 2,
      completedAt: currentTime.toISOString(),
    });
    expect(outcomes).toEqual(['retried', 'failed']);
  });

  test('recovers expired leases and fails one that exhausted its attempts', () => {
    const { repo } = createFixture();
    const service = createService(repo, { maxAttempts: 1 });
    const { job } = service.enqueue('project-1', 'version-1', 'owner-1');
    service.recoverAndClaim('worker-1', 1_000);
    advance(1_001);

    expect(service.recoverAndClaim('worker-2', 1_000)).toBeNull();
    expect(service.get('project-1', 'version-1', job.id)).toMatchObject({
      status: 'failed',
      errorCode: ErrorCode.AUDIT_JOB_FAILED,
      lockedBy: null,
      completedAt: currentTime.toISOString(),
    });
  });

  test('cancels queued and running jobs and discards late executor output', () => {
    const { repo, checksum } = createFixture();
    const service = createService(repo);
    const queued = service.enqueue('project-1', 'version-1', 'owner-1').job;
    expect(
      service.cancel('project-1', 'version-1', queued.id, 'owner-1')
    ).toMatchObject({ status: 'canceled' });

    advance(1_000);
    const running = service.enqueue('project-1', 'version-1', 'owner-1').job;
    service.recoverAndClaim('worker-1', 90_000);
    service.cancel('project-1', 'version-1', running.id, 'owner-1');
    expect(() =>
      service.complete(running, 'worker-1', resultFixture(checksum))
    ).toThrow(expect.objectContaining({ code: ErrorCode.AUDIT_JOB_CONFLICT }));
    expect(repo.load().artifactAudits).toEqual([]);
  });

  test('marks stale input terminal without replacing the current report', () => {
    const { repo, checksum } = createFixture();
    const service = createService(repo);
    const { job } = service.enqueue('project-1', 'version-1', 'owner-1');
    service.recoverAndClaim('worker-1', 90_000);
    repo.mutate((data) => {
      data.projects[0].auditPolicy.maxFileCount -= 1;
    });

    const failed = service.complete(job, 'worker-1', resultFixture(checksum));
    expect(failed).toMatchObject({
      status: 'failed',
      errorCode: ErrorCode.AUDIT_REQUIRED,
      errorMessage:
        'Artifact or audit policy changed while the job was running',
    });
    expect(repo.load().artifactAudits).toEqual([]);
  });

  test('keeps job reads scoped to their exact project and version', () => {
    const { repo } = createFixture();
    const service = createService(repo);
    const { job } = service.enqueue('project-1', 'version-1', 'owner-1');

    expect(() => service.get('project-1', 'other-version', job.id)).toThrow(
      expect.objectContaining({ code: ErrorCode.VERSION_NOT_FOUND })
    );
    expect(() => service.get('other-project', 'version-1', job.id)).toThrow(
      expect.objectContaining({ code: ErrorCode.PROJECT_NOT_FOUND })
    );
    expect(() => service.get('project-1', 'version-1', 'other-job')).toThrow(
      expect.objectContaining({ code: ErrorCode.AUDIT_JOB_NOT_FOUND })
    );
  });

  test('rejects aggregate cursors whose authenticated payload is re-encoded', () => {
    const { repo } = createFixture();
    const service = createService(repo);
    const first = service.enqueue('project-1', 'version-1', 'owner-1').job;
    service.cancel('project-1', 'version-1', first.id, 'owner-1');
    advance(1_000);
    const second = service.enqueue('project-1', 'version-1', 'owner-1').job;
    service.cancel('project-1', 'version-1', second.id, 'owner-1');
    advance(1_000);
    const third = service.enqueue('project-1', 'version-1', 'owner-1').job;
    service.cancel('project-1', 'version-1', third.id, 'owner-1');

    const queue = createAggregateArtifactAuditJobRepository(repo, CURSOR_CODEC);
    const firstPage = queue.list({
      projectId: 'project-1',
      versionId: 'version-1',
      limit: 1,
    });
    if (firstPage.kind !== 'page' || !firstPage.page.nextCursor) {
      throw new Error('aggregate cursor fixture is incomplete');
    }
    const cursor = firstPage.page.nextCursor;

    expect(
      queue.list({
        projectId: 'project-1',
        versionId: 'version-1',
        limit: 1,
        cursor: rewriteCursorPayload(cursor, (payload) => ({
          ...payload,
          anchorJobId: second.id,
        })),
      })
    ).toEqual({ kind: 'invalid-cursor' });
    expect(
      queue.list({
        projectId: 'project-1',
        versionId: 'version-1',
        status: 'failed',
        limit: 1,
        cursor: rewriteCursorPayload(cursor, (payload) => ({
          ...payload,
          status: 'failed',
        })),
      })
    ).toEqual({ kind: 'invalid-cursor' });
  });

  test('keeps an empty aggregate claim read-only and preserves JSON mtime', () => {
    const { repo } = createFixture();
    const queue = createAggregateArtifactAuditJobRepository(repo, CURSOR_CODEC);
    const oldTime = new Date('2020-01-01T00:00:00.000Z');
    utimesSync(dataFile, oldTime, oldTime);

    expect(
      queue.recoverAndClaim({
        workerId: 'worker-1',
        now: currentTime.toISOString(),
        leaseMs: 90_000,
        engineVersion: 1,
        retryBaseDelayMs: 2_000,
      })
    ).toEqual({
      job: null,
      recovered: { retried: 0, failed: 0 },
      stale: 0,
    });
    expect(statSync(dataFile).mtimeMs).toBe(oldTime.getTime());
  });

  test('keeps aggregate completion atomic when persistence rejects', () => {
    const { repo, checksum } = createFixture();
    const queue = createAggregateArtifactAuditJobRepository(repo, CURSOR_CODEC);
    expect(
      queue.enqueue({
        projectId: 'project-1',
        versionId: 'version-1',
        requestedBy: 'owner-1',
        priority: 0,
        maxAttempts: 3,
        now: currentTime.toISOString(),
        jobId: 'job-atomic',
        engineVersion: 1,
        artifactPresent: true,
        limits: { global: 10, requester: 10, project: 10 },
      }).kind
    ).toBe('enqueued');
    queue.recoverAndClaim({
      workerId: 'worker-1',
      now: currentTime.toISOString(),
      leaseMs: 90_000,
      engineVersion: 1,
      retryBaseDelayMs: 2_000,
    });
    const rejectingRepository: ProjectRepository = {
      load: repo.load,
      save: repo.save,
      mutate(operation) {
        const data = repo.load();
        operation(data);
        throw new Error('aggregate persistence rejected');
      },
    };
    const rejectingQueue = createAggregateArtifactAuditJobRepository(
      rejectingRepository,
      CURSOR_CODEC
    );

    expect(() =>
      rejectingQueue.complete({
        jobId: 'job-atomic',
        workerId: 'worker-1',
        now: '2026-07-30T00:00:01.000Z',
        currentArtifactChecksum: checksum,
        engineVersion: 1,
        reportId: 'report-atomic',
        historyEventId: 'history-atomic',
        result: resultFixture(checksum),
      })
    ).toThrow('aggregate persistence rejected');
    expect(repo.load()).toMatchObject({
      artifactAudits: [],
      history: [],
      artifactAuditJobs: [
        expect.objectContaining({
          id: 'job-atomic',
          status: 'running',
          reportId: null,
        }),
      ],
    });
  });
});

function createService(
  repo: ReturnType<typeof createJsonProjectRepository>,
  overrides: {
    maxAttempts?: number;
    retryBaseDelayMs?: number;
    maxActiveJobs?: number;
    maxActiveJobsPerRequester?: number;
    maxActiveJobsPerProject?: number;
    recordOutcome?: (
      outcome: 'succeeded' | 'failed' | 'canceled' | 'retried'
    ) => void;
  } = {}
) {
  return createArtifactAuditJobService(
    createAggregateArtifactAuditJobRepository(repo, CURSOR_CODEC),
    storageDir,
    {
      now: () => new Date(currentTime),
      createId: () => `id-${++idSequence}`,
      ...overrides,
    }
  );
}

function createFixture() {
  const repo = createJsonProjectRepository(dataFile);
  const data = createEmptyData();
  const artifactDir = join(storageDir, 'project-1', 'version-1');
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, 'index.html'), 'x');
  const checksum = checksumDirectory(artifactDir);
  const project = projectFixture(checksum);
  data.projects.push(project);
  repo.save(data);
  return { repo, data, project, artifactDir, checksum };
}

function projectFixture(checksum: string): Project {
  return {
    id: 'project-1',
    name: 'Project',
    slug: 'project',
    description: '',
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    versions: [
      {
        id: 'version-1',
        name: 'v1',
        description: '',
        createdAt: '2026-07-30T00:00:00.000Z',
        size: 1,
        fileCount: 1,
        sourceType: 'folder',
        status: 'preview',
        publishedAt: null,
        publishedBy: null,
        checksum,
        integrityStatus: 'verified',
        integrityCheckedAt: '2026-07-30T00:00:00.000Z',
      },
    ],
    activeVersionId: null,
    settings: { spaMode: false, routingType: 'path' },
    auditPolicy: {
      enforcement: 'advisory',
      maxTotalBytes: 50 * 1024 * 1024,
      maxFileBytes: 10 * 1024 * 1024,
      maxFileCount: 1_000,
    },
    createdBy: 'owner-1',
    members: [
      {
        userId: 'owner-1',
        role: 'owner',
        invitedAt: '2026-07-30T00:00:00.000Z',
      },
    ],
  };
}

function resultFixture(checksum: string): ArtifactAuditResult {
  return {
    artifactChecksum: checksum,
    status: 'warning',
    score: 90,
    summary: {
      totalBytes: 1,
      fileCount: 1,
      largestFiles: [{ path: 'index.html', size: 1 }],
      extensions: [{ extension: '.html', bytes: 1, count: 1 }],
    },
    checks: [],
  };
}

function advance(milliseconds: number): void {
  currentTime = new Date(currentTime.getTime() + milliseconds);
}

function rewriteCursorPayload(
  cursor: string,
  rewrite: (payload: Record<string, unknown>) => Record<string, unknown>
): string {
  const [encodedPayload, signature] = cursor.split('.');
  if (!encodedPayload) throw new Error('cursor payload is missing');
  const payload = JSON.parse(
    Buffer.from(encodedPayload, 'base64url').toString('utf8')
  ) as Record<string, unknown>;
  const rewritten = Buffer.from(JSON.stringify(rewrite(payload))).toString(
    'base64url'
  );
  return signature ? `${rewritten}.${signature}` : rewritten;
}
