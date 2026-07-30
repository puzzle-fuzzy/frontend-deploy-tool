import type { DeployKitRuntime } from './app';
import type { ServerConfig } from './config';
import {
  createShutdownController,
  type DrainableServer,
  defaultRuntimeLogger,
  installShutdownHandlers,
  type RuntimeLogger,
  type ShutdownController,
} from './runtime';

interface ServeOptions {
  port: number;
  fetch: DeployKitRuntime['app']['fetch'];
}

export interface ServerEntryDependencies {
  serve?: (options: ServeOptions) => DrainableServer;
  installHandlers?: (controller: ShutdownController) => () => void;
  logger?: RuntimeLogger;
  cleanupTimeoutMs?: number;
  scheduleTimeout?: (callback: () => void, timeoutMs: number) => unknown;
  cancelTimeout?: (handle: unknown) => void;
}

export interface StartedDeployKitServer {
  server: DrainableServer;
  shutdown: ShutdownController;
  disposeSignalHandlers(): void;
}

/**
 * Owns the complete post-composition server lifecycle. Any failure after the
 * runtime has acquired ownership cleans up HTTP, worker and signal state before
 * releasing the resource locks and rethrowing the startup error.
 */
export async function startDeployKitServer(
  config: ServerConfig,
  runtime: DeployKitRuntime,
  dependencies: ServerEntryDependencies = {}
): Promise<StartedDeployKitServer> {
  const serve =
    dependencies.serve ??
    ((options) =>
      Bun.serve({
        port: options.port,
        fetch: options.fetch,
      }));
  const installHandlers =
    dependencies.installHandlers ?? installShutdownHandlers;
  const logger = dependencies.logger ?? defaultRuntimeLogger;
  const scheduleTimeout =
    dependencies.scheduleTimeout ??
    ((callback, timeoutMs) => setTimeout(callback, timeoutMs));
  const cancelTimeout =
    dependencies.cancelTimeout ??
    ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const cleanupTimeoutMs =
    dependencies.cleanupTimeoutMs ??
    Math.min(config.shutdownTimeoutMs ?? 30_000, 1_000);
  let server: DrainableServer | undefined;
  let disposeSignalHandlers: (() => void) | undefined;

  try {
    server = serve({ port: config.port, fetch: runtime.app.fetch });
    const shutdown = createShutdownController({
      server,
      databaseFile: config.databaseFile,
      timeoutMs: config.shutdownTimeoutMs ?? 30_000,
      drainBackground: () => runtime.artifactAuditWorker.stop(),
      releaseOwnership: () => runtime.runtimeOwnership.release(),
      logger,
    });
    disposeSignalHandlers = installHandlers(shutdown);
    if (config.artifactAuditWorkerEnabled ?? true) {
      runtime.artifactAuditWorker.start();
    }
    logger({
      timestamp: new Date().toISOString(),
      level: 'info',
      event: 'server_started',
      port: config.port,
    });
    return {
      server,
      shutdown,
      disposeSignalHandlers,
    };
  } catch (error) {
    try {
      disposeSignalHandlers?.();
    } catch {
      // Startup must continue cleaning the remaining resources.
    }

    const cleanup: Promise<unknown>[] = [];
    if (server) {
      cleanup.push(invokeCleanup(() => server?.stop(true)));
    }
    cleanup.push(invokeCleanup(() => runtime.artifactAuditWorker.stop()));
    const cleanupConfirmed = await waitBounded(
      Promise.all(cleanup),
      cleanupTimeoutMs,
      scheduleTimeout,
      cancelTimeout
    );
    if (cleanupConfirmed) {
      try {
        runtime.runtimeOwnership.release();
      } catch {
        // The original startup failure remains the actionable diagnostic.
      }
    }
    throw error;
  }
}

function invokeCleanup(work: () => unknown): Promise<void> {
  return Promise.resolve()
    .then(work)
    .then(() => undefined);
}

async function waitBounded(
  work: Promise<unknown>,
  timeoutMs: number,
  scheduleTimeout: (callback: () => void, timeoutMs: number) => unknown,
  cancelTimeout: (handle: unknown) => void
): Promise<boolean> {
  let timeoutHandle: unknown;
  const timeout = new Promise<boolean>((resolve) => {
    timeoutHandle = scheduleTimeout(() => resolve(false), timeoutMs);
  });
  const completed = work.then(
    () => true,
    () => false
  );
  const cleanupConfirmed = await Promise.race([completed, timeout]);
  cancelTimeout(timeoutHandle);
  return cleanupConfirmed;
}
