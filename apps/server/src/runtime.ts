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
  drainBackground?: () => Promise<void>;
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
  drainBackground,
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
      await forceClose(server);
      try {
        checkpointIfConfigured(databaseFile, checkpoint);
      } catch (error) {
        logger({
          timestamp: new Date().toISOString(),
          level: 'error',
          event: 'shutdown_failed',
          signal,
          error: errorMessage(error),
        });
      } finally {
        exit(1);
      }
    };

    logger({
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
      logger({
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
      logger({
        timestamp: new Date().toISOString(),
        level: 'error',
        event: 'shutdown_failed',
        signal,
        error: errorMessage(outcome.error),
      });
      await finishWithFailure();
      return;
    }

    try {
      checkpointIfConfigured(databaseFile, checkpoint);
      logger({
        timestamp: new Date().toISOString(),
        level: 'info',
        event: 'shutdown_completed',
        signal,
      });
      exit(0);
    } catch (error) {
      logger({
        timestamp: new Date().toISOString(),
        level: 'error',
        event: 'shutdown_failed',
        signal,
        error: errorMessage(error),
      });
      exit(1);
    }
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
  signalProcess.once('SIGINT', onSigint);
  signalProcess.once('SIGTERM', onSigterm);
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

async function forceClose(server: DrainableServer): Promise<void> {
  try {
    await server.stop(true);
  } catch {
    // The process exits non-zero below; a second stop failure cannot be healed.
  }
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
