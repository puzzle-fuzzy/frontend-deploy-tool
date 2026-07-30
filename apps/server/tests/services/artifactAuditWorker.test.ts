import { describe, expect, test } from 'bun:test';
import type { ArtifactAuditJob } from '@deploykit/shared';
import type { ArtifactAuditResult } from '../../src/services/artifactAuditEngine';
import type { ArtifactAuditExecutor } from '../../src/services/artifactAuditExecutor';
import type { ArtifactAuditJobService } from '../../src/services/artifactAuditJobService';
import { createArtifactAuditWorker } from '../../src/services/artifactAuditWorker';

describe('createArtifactAuditWorker', () => {
  test('claims one job, executes it, and commits the result', async () => {
    const calls: string[] = [];
    const job = jobFixture();
    const result = auditResultFixture();
    const service = serviceFixture({
      recoverAndClaim: () => {
        calls.push('claim');
        return { job, artifactDir: '/tmp/artifact' };
      },
      complete: (_job, _workerId, received) => {
        calls.push(`complete:${received.artifactChecksum}`);
        return { ...job, status: 'succeeded' };
      },
    });
    const executor: ArtifactAuditExecutor = {
      execute: async (input) => {
        calls.push(`execute:${input.expectedChecksum}`);
        expect(input).toEqual({
          artifactDir: '/tmp/artifact',
          expectedChecksum: job.artifactChecksum,
          policy: job.policy,
        });
        return result;
      },
    };
    const worker = createArtifactAuditWorker({
      jobService: service,
      executor,
      workerId: 'worker-1',
      pollIntervalMs: 1_000,
      leaseMs: 90_000,
    });

    expect(await worker.runOnce()).toBe(true);
    expect(calls).toEqual([
      'claim',
      `execute:${job.artifactChecksum}`,
      `complete:${result.artifactChecksum}`,
    ]);
  });

  test('records executor failures without rejecting the poll loop', async () => {
    const job = jobFixture();
    const failures: unknown[] = [];
    const failure = new Error('audit crashed');
    const service = serviceFixture({
      recoverAndClaim: () => ({ job, artifactDir: '/tmp/artifact' }),
      fail: (_jobId, _workerId, error) => {
        failures.push(error);
        return { ...job, status: 'queued' };
      },
    });
    const worker = createArtifactAuditWorker({
      jobService: service,
      executor: {
        execute: async () => {
          throw failure;
        },
      },
      workerId: 'worker-1',
      pollIntervalMs: 1_000,
      leaseMs: 90_000,
    });

    expect(await worker.runOnce()).toBe(true);
    expect(failures).toEqual([failure]);
  });

  test('heartbeats the active lease and aborts when ownership is lost', async () => {
    const job = jobFixture();
    let heartbeat: (() => void) | undefined;
    let failedWith: unknown;
    const service = serviceFixture({
      recoverAndClaim: () => ({ job, artifactDir: '/tmp/artifact' }),
      heartbeat: () => null,
      fail: (_jobId, _workerId, error) => {
        failedWith = error;
        return { ...job, status: 'queued' };
      },
    });
    const worker = createArtifactAuditWorker({
      jobService: service,
      executor: {
        execute: (_input, signal) =>
          new Promise((_, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true }
            );
          }),
      },
      workerId: 'worker-1',
      pollIntervalMs: 1_000,
      leaseMs: 90_000,
      scheduleInterval: (callback) => {
        heartbeat = callback;
        return 'heartbeat';
      },
      cancelInterval: () => {},
    });

    const execution = worker.runOnce();
    await Promise.resolve();
    heartbeat?.();
    expect(await execution).toBe(true);
    expect(failedWith).toMatchObject({ name: 'AbortError' });
  });

  test('cancels an active subprocess and drains it during stop', async () => {
    const job = jobFixture();
    const calls: string[] = [];
    const service = serviceFixture({
      recoverAndClaim: () => ({ job, artifactDir: '/tmp/artifact' }),
      fail: () => {
        calls.push('failed');
        return { ...job, status: 'queued' };
      },
    });
    const worker = createArtifactAuditWorker({
      jobService: service,
      executor: {
        execute: (_input, signal) =>
          new Promise((_, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                calls.push('aborted');
                reject(new DOMException('Aborted', 'AbortError'));
              },
              { once: true }
            );
          }),
      },
      workerId: 'worker-1',
      pollIntervalMs: 1_000,
      leaseMs: 90_000,
    });

    const execution = worker.runOnce();
    await Promise.resolve();
    worker.cancel(job.id);
    await worker.stop();

    expect(await execution).toBe(true);
    expect(calls).toEqual(['aborted', 'failed']);
    expect(await worker.runOnce()).toBe(false);
  });

  test('recovers leases through each claim and schedules polling exactly once', async () => {
    const calls: string[] = [];
    let poll: (() => void) | undefined;
    const service = serviceFixture({
      recoverAndClaim: () => {
        calls.push('claim');
        return null;
      },
    });
    const worker = createArtifactAuditWorker({
      jobService: service,
      executor: {
        execute: async () => auditResultFixture(),
      },
      workerId: 'worker-1',
      pollIntervalMs: 1_000,
      leaseMs: 90_000,
      scheduleInterval: (callback) => {
        calls.push('schedule');
        poll = callback;
        return 'poll';
      },
      cancelInterval: () => calls.push('clear'),
      logger: (message) => calls.push(`log:${message}`),
    });

    worker.start();
    worker.start();
    await Promise.resolve();
    poll?.();
    await Promise.resolve();
    await worker.stop();

    expect(calls.filter((call) => call === 'schedule')).toHaveLength(1);
    expect(calls.filter((call) => call === 'claim')).toHaveLength(2);
    expect(calls.filter((call) => call === 'clear')).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith('log:'))).toEqual([]);
  });
});

function serviceFixture(
  overrides: Partial<ArtifactAuditJobService> = {}
): ArtifactAuditJobService {
  const job = jobFixture();
  const defaults: ArtifactAuditJobService = {
    enqueue: () => ({ job, reused: false }),
    get: () => job,
    list: () => ({ items: [], nextCursor: null }),
    cancel: () => ({ ...job, status: 'canceled' }),
    recoverAndClaim: () => null,
    heartbeat: () => job,
    complete: () => ({ ...job, status: 'succeeded' }),
    fail: () => ({ ...job, status: 'failed' }),
    health: () => ({
      queued: 0,
      running: 0,
      oldestQueuedAt: null,
      oldestQueuedAgeSeconds: 0,
      terminal: { succeeded: 0, failed: 0, canceled: 0 },
    }),
  };
  return { ...defaults, ...overrides };
}

function jobFixture(): ArtifactAuditJob {
  return {
    id: 'audit-job-1',
    projectId: 'project-1',
    versionId: 'version-1',
    requestedBy: 'user-1',
    status: 'running',
    priority: 0,
    attempts: 1,
    maxAttempts: 3,
    nextRunAt: '2026-07-30T00:00:00.000Z',
    lockedBy: 'worker-1',
    lockedUntil: '2026-07-30T00:01:30.000Z',
    artifactChecksum: 'sha256:test',
    engineVersion: 1,
    policy: {
      enforcement: 'advisory',
      maxTotalBytes: 50 * 1024 * 1024,
      maxFileBytes: 10 * 1024 * 1024,
      maxFileCount: 1_000,
    },
    reportId: null,
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    startedAt: '2026-07-30T00:00:00.000Z',
    completedAt: null,
  };
}

function auditResultFixture(): ArtifactAuditResult {
  return {
    artifactChecksum: 'sha256:test',
    status: 'passed' as const,
    score: 100,
    summary: {
      fileCount: 1,
      totalBytes: 128,
      largestFiles: [{ path: 'index.html', size: 128 }],
      extensions: [{ extension: '.html', bytes: 128, count: 1 }],
    },
    checks: [],
  };
}
