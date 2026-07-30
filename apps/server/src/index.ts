import { join } from 'node:path';
import { createDeployKitRuntime } from './app';
import { loadConfig } from './config';
import {
  createShutdownController,
  defaultRuntimeLogger,
  installShutdownHandlers,
} from './runtime';

// Resolve paths relative to the package root (this file lives in `<root>/src/`).
const config = loadConfig({ appDir: join(import.meta.dir, '..') });
const { app, artifactAuditWorker, runtimeOwnership } =
  createDeployKitRuntime(config);

let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({
    port: config.port,
    fetch: app.fetch,
  });
} catch (error) {
  runtimeOwnership.release();
  throw error;
}

const shutdown = createShutdownController({
  server,
  databaseFile: config.databaseFile,
  timeoutMs: config.shutdownTimeoutMs ?? 30_000,
  drainBackground: () => artifactAuditWorker.stop(),
  releaseOwnership: () => runtimeOwnership.release(),
});
installShutdownHandlers(shutdown);
if (config.artifactAuditWorkerEnabled ?? true) {
  artifactAuditWorker.start();
}

defaultRuntimeLogger({
  timestamp: new Date().toISOString(),
  level: 'info',
  event: 'server_started',
  port: config.port,
});
