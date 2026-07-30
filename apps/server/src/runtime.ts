import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';

export type ShutdownSignal = 'SIGINT' | 'SIGTERM';

export interface DrainableServer {
  stop(closeActiveConnections?: boolean): Promise<void>;
}

export interface RuntimeLogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  event:
    | 'server_started'
    | 'shutdown_started'
    | 'shutdown_completed'
    | 'shutdown_timeout'
    | 'shutdown_failed';
  signal?: ShutdownSignal;
  port?: number;
  timeoutMs?: number;
  error?: string;
}

export type RuntimeLogger = (entry: RuntimeLogEntry) => void;

interface ShutdownControllerOptions {
  server: DrainableServer;
  databaseFile?: string;
  timeoutMs: number;
  forceCloseTimeoutMs?: number;
  drainBackground?: () => Promise<void>;
  releaseOwnership?: () => void;
  logger?: RuntimeLogger;
  checkpoint?: (databaseFile: string) => void;
  exit?: (code: number) => void;
  scheduleTimeout?: (callback: () => void, timeoutMs: number) => unknown;
  cancelTimeout?: (handle: unknown) => void;
}

export interface ShutdownController {
  shutdown(signal: ShutdownSignal): Promise<void>;
  isShuttingDown(): boolean;
}

export interface SignalRegistrar {
  once(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
}

/**
 * Coordinates a bounded graceful shutdown. The first signal owns the sequence;
 * subsequent signals reuse the same promise and cannot trigger a second
 * checkpoint or process exit.
 */
export function createShutdownController({
  server,
  databaseFile,
  timeoutMs,
  forceCloseTimeoutMs = Math.min(timeoutMs, 1_000),
  drainBackground,
  releaseOwnership,
  logger = defaultRuntimeLogger,
  checkpoint = checkpointSqlite,
  exit = (code) => process.exit(code),
  scheduleTimeout = (callback, delayMs) => setTimeout(callback, delayMs),
  cancelTimeout = (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
}: ShutdownControllerOptions): ShutdownController {
  let inFlight: Promise<void> | null = null;

  const runShutdown = async (signal: ShutdownSignal): Promise<void> => {
    const finishWithFailure = async (): Promise<void> => {
      await forceClose(
        server,
        forceCloseTimeoutMs,
        scheduleTimeout,
        cancelTimeout
      );
      try {
        checkpointIfConfigured(databaseFile, checkpoint);
      } catch (error) {
        logBestEffort(logger, {
          timestamp: new Date().toISOString(),
          level: 'error',
          event: 'shutdown_failed',
          signal,
          error: errorMessage(error),
        });
      }
      // A failed or timed-out drain cannot prove that HTTP and background work
      // have stopped touching the database/storage pair. Keep the kernel-backed
      // ownership locks until process death instead of advertising false reuse.
      exit(1);
    };

    logBestEffort(logger, {
      timestamp: new Date().toISOString(),
      level: 'info',
      event: 'shutdown_started',
      signal,
      timeoutMs,
    });

    let timeoutHandle: unknown;
    const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
      timeoutHandle = scheduleTimeout(
        () => resolve({ kind: 'timeout' }),
        timeoutMs
      );
    });
    const drain = Promise.all([
      Promise.resolve().then(() => server.stop(false)),
      Promise.resolve().then(() => drainBackground?.()),
    ]).then(
      () => ({ kind: 'drained' }) as const,
      (error: unknown) => ({ kind: 'failed', error }) as const
    );
    const outcome = await Promise.race([drain, timeout]);
    cancelTimeout(timeoutHandle);

    if (outcome.kind === 'timeout') {
      logBestEffort(logger, {
        timestamp: new Date().toISOString(),
        level: 'warn',
        event: 'shutdown_timeout',
        signal,
        timeoutMs,
      });
      await finishWithFailure();
      return;
    }

    if (outcome.kind === 'failed') {
      logBestEffort(logger, {
        timestamp: new Date().toISOString(),
        level: 'error',
        event: 'shutdown_failed',
        signal,
        error: errorMessage(outcome.error),
      });
      await finishWithFailure();
      return;
    }

    let shutdownError: unknown;
    try {
      checkpointIfConfigured(databaseFile, checkpoint);
    } catch (error) {
      shutdownError = error;
    }
    try {
      releaseOwnership?.();
    } catch (error) {
      shutdownError ??= error;
    }

    if (!shutdownError) {
      logBestEffort(logger, {
        timestamp: new Date().toISOString(),
        level: 'info',
        event: 'shutdown_completed',
        signal,
      });
      exit(0);
      return;
    }

    logBestEffort(logger, {
      timestamp: new Date().toISOString(),
      level: 'error',
      event: 'shutdown_failed',
      signal,
      error: errorMessage(shutdownError),
    });
    exit(1);
  };

  return {
    shutdown(signal) {
      inFlight ??= runShutdown(signal);
      return inFlight;
    },
    isShuttingDown() {
      return inFlight !== null;
    },
  };
}

export function installShutdownHandlers(
  controller: ShutdownController,
  signalProcess: SignalRegistrar = process
): () => void {
  const onSigint = () => {
    void controller.shutdown('SIGINT');
  };
  const onSigterm = () => {
    void controller.shutdown('SIGTERM');
  };
  let sigintInstalled = false;
  try {
    signalProcess.once('SIGINT', onSigint);
    sigintInstalled = true;
    signalProcess.once('SIGTERM', onSigterm);
  } catch (error) {
    if (sigintInstalled) {
      signalProcess.off('SIGINT', onSigint);
    }
    throw error;
  }
  return () => {
    signalProcess.off('SIGINT', onSigint);
    signalProcess.off('SIGTERM', onSigterm);
  };
}

/** Flushes committed WAL pages and truncates the WAL before process exit. */
export function checkpointSqlite(databaseFile: string): void {
  if (!existsSync(databaseFile)) return;
  const database = new Database(databaseFile);
  try {
    database.query('PRAGMA wal_checkpoint(TRUNCATE)').all();
  } finally {
    database.close();
  }
}

export const defaultRuntimeLogger: RuntimeLogger = (entry) => {
  const serialized = JSON.stringify(entry);
  if (entry.level === 'error') {
    console.error(serialized);
  } else if (entry.level === 'warn') {
    console.warn(serialized);
  } else {
    console.log(serialized);
  }
};

async function forceClose(
  server: DrainableServer,
  timeoutMs: number,
  scheduleTimeout: (callback: () => void, timeoutMs: number) => unknown,
  cancelTimeout: (handle: unknown) => void
): Promise<void> {
  let timeoutHandle: unknown;
  const timeout = new Promise<void>((resolve) => {
    timeoutHandle = scheduleTimeout(resolve, timeoutMs);
  });
  const stop = Promise.resolve()
    .then(() => server.stop(true))
    .then(
      () => undefined,
      () => undefined
    );
  await Promise.race([stop, timeout]);
  cancelTimeout(timeoutHandle);
}

function checkpointIfConfigured(
  databaseFile: string | undefined,
  checkpoint: (databaseFile: string) => void
): void {
  if (databaseFile) checkpoint(databaseFile);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logBestEffort(logger: RuntimeLogger, entry: RuntimeLogEntry): void {
  try {
    logger(entry);
  } catch {
    // Observability must never interrupt shutdown or resource cleanup.
  }
}
