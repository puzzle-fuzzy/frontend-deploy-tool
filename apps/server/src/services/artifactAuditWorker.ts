import { ApiError, ErrorCode } from '../errors';
import type { ArtifactAuditExecutor } from './artifactAuditExecutor';
import type {
  ArtifactAuditJobService,
  ClaimedArtifactAuditJob,
} from './artifactAuditJobService';

type IntervalCallback = () => void;
type WorkerLogger = (message: string, error?: unknown) => void;

interface ArtifactAuditWorkerDependencies {
  jobService: ArtifactAuditJobService;
  executor: ArtifactAuditExecutor;
  workerId: string;
  pollIntervalMs: number;
  leaseMs: number;
  heartbeatIntervalMs?: number;
  scheduleInterval?: (
    callback: IntervalCallback,
    intervalMs: number
  ) => unknown;
  cancelInterval?: (handle: unknown) => void;
  logger?: WorkerLogger;
}

export interface ArtifactAuditWorker {
  start(): void;
  runOnce(): Promise<boolean>;
  cancel(jobId: string): void;
  stop(): Promise<void>;
}

/**
 * Runs at most one audit subprocess at a time. Durable ownership lives in the
 * job service; this runtime only renews the lease and aborts local work when
 * that ownership is lost or the server is draining.
 */
export function createArtifactAuditWorker({
  jobService,
  executor,
  workerId,
  pollIntervalMs,
  leaseMs,
  heartbeatIntervalMs = Math.max(1_000, Math.floor(leaseMs / 3)),
  scheduleInterval = (callback, intervalMs) =>
    setInterval(callback, intervalMs),
  cancelInterval = (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
  logger = defaultWorkerLogger,
}: ArtifactAuditWorkerDependencies): ArtifactAuditWorker {
  requirePositiveInteger('poll interval', pollIntervalMs);
  requirePositiveInteger('lease', leaseMs);
  requirePositiveInteger('heartbeat interval', heartbeatIntervalMs);
  if (heartbeatIntervalMs >= leaseMs) {
    throw new Error(
      'Artifact audit heartbeat interval must be below the lease'
    );
  }
  if (workerId.trim() === '') {
    throw new Error('Artifact audit worker ID must not be empty');
  }

  let started = false;
  let stopping = false;
  let pollHandle: unknown;
  let activePromise: Promise<void> | null = null;
  let activeJobId: string | null = null;
  let activeController: AbortController | null = null;

  const runClaimed = async ({
    job,
    artifactDir,
  }: ClaimedArtifactAuditJob): Promise<void> => {
    const controller = new AbortController();
    activeJobId = job.id;
    activeController = controller;
    const heartbeatHandle = scheduleInterval(() => {
      try {
        const renewed = jobService.heartbeat(job.id, workerId, leaseMs);
        if (!renewed) controller.abort();
      } catch (error) {
        logger('Artifact audit heartbeat failed', error);
        controller.abort();
      }
    }, heartbeatIntervalMs);
    unrefTimer(heartbeatHandle);

    try {
      const result = await executor.execute(
        {
          artifactDir,
          expectedChecksum: job.artifactChecksum,
          policy: job.policy,
        },
        controller.signal
      );
      jobService.complete(job.id, workerId, result);
    } catch (error) {
      try {
        jobService.fail(job.id, workerId, error);
      } catch (failureError) {
        if (!isExpectedOwnershipLoss(failureError)) {
          logger('Artifact audit failure could not be persisted', failureError);
        }
      }
    } finally {
      cancelInterval(heartbeatHandle);
      if (activeJobId === job.id) {
        activeJobId = null;
        activeController = null;
      }
    }
  };

  const worker: ArtifactAuditWorker = {
    start() {
      if (started || stopping) return;
      started = true;
      try {
        jobService.sweepExpired();
      } catch (error) {
        logger('Artifact audit lease sweep failed', error);
      }
      void worker.runOnce();
      pollHandle = scheduleInterval(() => {
        void worker.runOnce();
      }, pollIntervalMs);
      unrefTimer(pollHandle);
    },

    async runOnce() {
      if (stopping || activePromise) return false;
      let claimed: ClaimedArtifactAuditJob | null;
      try {
        claimed = jobService.claim(workerId, leaseMs);
      } catch (error) {
        logger('Artifact audit claim failed', error);
        return false;
      }
      if (!claimed) return false;

      const execution = Promise.resolve().then(() => runClaimed(claimed));
      activePromise = execution;
      try {
        await execution;
      } finally {
        if (activePromise === execution) activePromise = null;
      }
      return true;
    },

    cancel(jobId) {
      if (activeJobId === jobId) activeController?.abort();
    },

    async stop() {
      stopping = true;
      started = false;
      if (pollHandle !== undefined) {
        cancelInterval(pollHandle);
        pollHandle = undefined;
      }
      activeController?.abort();
      await activePromise;
    },
  };

  return worker;
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Artifact audit ${name} must be a positive integer`);
  }
}

function isExpectedOwnershipLoss(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === ErrorCode.AUDIT_JOB_CONFLICT ||
      error.code === ErrorCode.AUDIT_JOB_NOT_FOUND)
  );
}

function unrefTimer(handle: unknown): void {
  if (
    typeof handle === 'object' &&
    handle !== null &&
    'unref' in handle &&
    typeof handle.unref === 'function'
  ) {
    handle.unref();
  }
}

const defaultWorkerLogger: WorkerLogger = (message, error) => {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      event: 'artifact_audit_worker_error',
      message,
      error: error instanceof Error ? error.message : String(error ?? ''),
    })
  );
};
