import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type Context, Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { requestId } from 'hono/request-id';
import { createApiApp } from './api';
import { type AppConfig, validateAppConfig } from './config';
import { createDesktopAuthCodeStore } from './desktopAuth';
import { createArtifactAuditJobCursorCodec } from './domain/artifactAuditJobCursor';
import { ApiError, ErrorCode } from './errors';
import {
  createObservabilityMiddleware,
  defaultStructuredLogger,
  type StructuredLogger,
} from './middleware/observability';
import { createRequestOriginProtection } from './middleware/requestOrigin';
import {
  clearSessionCookie,
  createSessionMiddleware,
  setSessionCookie,
} from './middleware/session';
import { createTrustBoundary } from './middleware/trustBoundary';
import { createUploadGate } from './middleware/uploadLimits';
import { createAggregateArtifactAuditJobRepository } from './repositories/aggregateArtifactAuditJobRepository';
import {
  createMemoryApiTokenRepository,
  createSqliteApiTokenRepository,
} from './repositories/apiTokenRepository';
import { createJsonProjectRepository } from './repositories/jsonProjectRepository';
import {
  createMemorySessionRepository,
  createSqliteSessionRepository,
} from './repositories/sessionRepository';
import { createSqliteArtifactAuditJobRepository } from './repositories/sqliteArtifactAuditJobRepository';
import { createSqliteProjectRepository } from './repositories/sqliteProjectRepository';
import { createCiVersionRoutes } from './routes/ciVersions';
import { createDeployRoutes } from './routes/deploy';
import { createApiTokenService } from './services/apiTokenService';
import {
  type ArtifactAuditExecutor,
  createSubprocessArtifactAuditExecutor,
} from './services/artifactAuditExecutor';
import { createArtifactAuditJobService } from './services/artifactAuditJobService';
import { createArtifactAuditService } from './services/artifactAuditService';
import {
  type ArtifactAuditWorker,
  createArtifactAuditWorker,
} from './services/artifactAuditWorker';
import { createArtifactRecoveryService } from './services/artifactRecovery';
import type { AppEnv } from './services/contracts';
import {
  createMetricsRegistry,
  type MetricsRegistry,
} from './services/metrics';
import { createProjectService } from './services/projectService';
import {
  acquireRuntimeOwnership,
  type RuntimeMigrationGuard,
  type RuntimeOwnership,
} from './services/runtimeOwnership';
import { createSessionService } from './services/sessionService';
import { reconcileStorage } from './services/storageReconciler';
import { createUserService } from './services/userService';
import { createVersionService } from './services/versionService';

export interface CreateAppOptions {
  logger?: StructuredLogger;
  metrics?: MetricsRegistry;
  artifactAuditExecutor?: ArtifactAuditExecutor;
  migrationGuard?: RuntimeMigrationGuard;
}

export interface DeployKitRuntime {
  app: ReturnType<typeof createApp>;
  artifactAuditWorker: ArtifactAuditWorker;
  runtimeOwnership: RuntimeOwnership;
}

/**
 * Test/internal composition seam. It does not acquire runtime ownership and is
 * unsupported as a production entrypoint. Production callers must use
 * createDeployKitRuntime() so migration, reconciliation, HTTP writes, workers,
 * and shutdown all share the database/storage ownership lifecycle.
 */
export function createApp(config: AppConfig, options: CreateAppOptions = {}) {
  return composeApp(config, options, undefined, options.migrationGuard).app;
}

export function createDeployKitRuntime(
  config: AppConfig,
  options: CreateAppOptions = {}
): DeployKitRuntime {
  if (!config.databaseFile) {
    throw new Error(
      'createDeployKitRuntime requires databaseFile; JSON repositories are test-only'
    );
  }
  const runtimeOwnership = acquireRuntimeOwnership(
    config.databaseFile,
    config.storageDir
  );
  try {
    let artifactAuditWorker: ArtifactAuditWorker | null = null;
    const composition = composeApp(
      config,
      options,
      (jobId) => {
        artifactAuditWorker?.cancel(jobId);
      },
      runtimeOwnership.migrationGuard
    );
    artifactAuditWorker = createArtifactAuditWorker({
      jobService: composition.artifactAuditJobService,
      executor:
        options.artifactAuditExecutor ??
        createSubprocessArtifactAuditExecutor({
          timeoutMs: config.artifactAuditTimeoutMs ?? 60_000,
        }),
      workerId: `audit-${process.pid}-${randomBytes(6).toString('hex')}`,
      pollIntervalMs: config.artifactAuditPollIntervalMs ?? 1_000,
      leaseMs: config.artifactAuditLeaseMs ?? 90_000,
    });
    return { app: composition.app, artifactAuditWorker, runtimeOwnership };
  } catch (error) {
    runtimeOwnership.release();
    throw error;
  }
}

function composeApp(
  config: AppConfig,
  options: CreateAppOptions,
  cancelArtifactAuditJob?: (jobId: string) => void,
  migrationGuard?: RuntimeMigrationGuard
) {
  validateAppConfig(config);
  mkdirSync(config.storageDir, { recursive: true });

  // One effective secret owns both session tokens and purpose-separated
  // audit-job cursor signatures. Development fallback is random per process.
  const sessionSecret =
    config.sessionSecret ?? randomBytes(32).toString('base64url');
  if (!config.sessionSecret) {
    console.warn(
      '[deploykit] SESSION_SECRET not set; generated an ephemeral secret. ' +
        'Sessions and audit-job cursors will not survive a restart. ' +
        'Set SESSION_SECRET in production.'
    );
  }
  const artifactAuditJobCursorCodec =
    createArtifactAuditJobCursorCodec(sessionSecret);

  const repo = config.databaseFile
    ? createSqliteProjectRepository({
        databaseFile: config.databaseFile,
        legacyDataFile: config.dataFile,
        migrationGuard,
      })
    : createJsonProjectRepository(config.dataFile);
  const reconciliation = reconcileStorage(repo, config.storageDir, {
    stagingRetentionMs: (config.stagingRetentionHours ?? 24) * 60 * 60 * 1000,
    recoveryRetentionMs:
      (config.recoveryRetentionHours ?? 168) * 60 * 60 * 1000,
  });
  if (Object.values(reconciliation).some((count) => count > 0)) {
    console.warn(
      `[deploykit] Storage reconciliation: ${JSON.stringify(reconciliation)}`
    );
  }
  const artifactAuditJobRepository = config.databaseFile
    ? createSqliteArtifactAuditJobRepository({
        databaseFile: config.databaseFile,
        cursorCodec: artifactAuditJobCursorCodec,
      })
    : createAggregateArtifactAuditJobRepository(
        repo,
        artifactAuditJobCursorCodec
      );
  let recordArtifactAuditJob: MetricsRegistry['recordArtifactAuditJob'] =
    () => {};
  let recordArtifactAuditLeaseRecovery: MetricsRegistry['recordArtifactAuditLeaseRecovery'] =
    () => {};
  let recordArtifactAuditAdmissionRejection: MetricsRegistry['recordArtifactAuditAdmissionRejection'] =
    () => {};
  const artifactAuditJobService = createArtifactAuditJobService(
    artifactAuditJobRepository,
    config.storageDir,
    {
      maxAttempts: config.artifactAuditMaxAttempts ?? 3,
      maxActiveJobs: config.artifactAuditMaxActiveJobs ?? 100,
      maxActiveJobsPerRequester:
        config.artifactAuditMaxActiveJobsPerRequester ?? 25,
      maxActiveJobsPerProject:
        config.artifactAuditMaxActiveJobsPerProject ?? 10,
      recordOutcome: (outcome) => recordArtifactAuditJob(outcome),
      recordLeaseRecovery: (outcome) =>
        recordArtifactAuditLeaseRecovery(outcome),
      recordAdmissionRejection: (scope) =>
        recordArtifactAuditAdmissionRejection(scope),
    }
  );
  const metrics =
    options.metrics ??
    createMetricsRegistry({
      artifactStorageBytes: () =>
        repo
          .load()
          .projects.flatMap((project) => project.versions)
          .reduce((total, version) => total + version.size, 0),
      sqliteStorageBytes: () =>
        config.databaseFile
          ? [
              config.databaseFile,
              `${config.databaseFile}-wal`,
              `${config.databaseFile}-shm`,
            ].reduce(
              (total, path) =>
                total + (existsSync(path) ? statSync(path).size : 0),
              0
            )
          : 0,
      artifactAuditJobsActive: () => {
        const health = artifactAuditJobService.health();
        return { queued: health.queued, running: health.running };
      },
      artifactAuditQueueHealth: () => artifactAuditJobService.health(),
    });
  recordArtifactAuditJob = (outcome) => metrics.recordArtifactAuditJob(outcome);
  recordArtifactAuditLeaseRecovery = (outcome) =>
    metrics.recordArtifactAuditLeaseRecovery(outcome);
  recordArtifactAuditAdmissionRejection = (scope) =>
    metrics.recordArtifactAuditAdmissionRejection(scope);
  const artifactRecovery = createArtifactRecoveryService(config.storageDir);
  const projectService = createProjectService(repo, { artifactRecovery });
  const apiTokenRepository = config.databaseFile
    ? createSqliteApiTokenRepository(config.databaseFile)
    : createMemoryApiTokenRepository();
  const apiTokenService = createApiTokenService({
    repository: apiTokenRepository,
    projectService,
  });
  const versionService = createVersionService(repo, config, {
    artifactRecovery,
    apiTokenService,
  });
  const artifactAuditService = createArtifactAuditService(
    repo,
    config.storageDir,
    {
      recordOutcome: (status) => metrics.recordArtifactAudit(status),
    }
  );
  const userService = createUserService(repo);

  // Seed an admin on first run so the app is usable immediately.
  const seededPassword = userService.seedAdminIfMissing(
    config.adminEmail,
    config.adminPassword
  );
  if (seededPassword) {
    console.log(
      `[deploykit] Seeded admin "${config.adminEmail}". ` +
        (config.adminPassword
          ? '(password from ADMIN_PASSWORD)'
          : `Generated password: ${seededPassword}`)
    );
  }

  const sessionRepository = config.databaseFile
    ? createSqliteSessionRepository(config.databaseFile)
    : createMemorySessionRepository();
  const sessionService = createSessionService({
    repository: sessionRepository,
    secret: sessionSecret,
  });
  sessionService.cleanupExpired();

  // Cookie transport remains separate from durable session issuance.
  const writeSessionCookie = (c: Context, token: string) => {
    setSessionCookie(c, token, config.secureCookies);
  };
  const deleteSessionCookie = (c: Context) => {
    clearSessionCookie(c, config.secureCookies);
  };
  const desktopAuth = createDesktopAuthCodeStore();
  const uploadRouteLimits = {
    maxUploadRequestSize:
      config.maxUploadRequestSize ??
      Math.max(
        config.maxZipSize ?? 100 * 1024 * 1024,
        config.maxExtractedSize ?? 100 * 1024 * 1024
      ) +
        1024 * 1024,
    gate: createUploadGate({
      maxConcurrentUploads: config.maxConcurrentUploads ?? 4,
      maxConcurrentUploadsPerUser: config.maxConcurrentUploadsPerUser ?? 2,
      maxConcurrentUploadsPerProject:
        config.maxConcurrentUploadsPerProject ?? 1,
    }),
  };
  const apiApp = createApiApp({
    projectService,
    apiTokenService,
    versionService,
    artifactAuditService,
    artifactAuditJobService,
    userService,
    sessionMiddleware: createSessionMiddleware({
      sessionService,
      userService,
    }),
    sessionService,
    setSessionCookie: writeSessionCookie,
    clearSessionCookie: deleteSessionCookie,
    desktopAuth,
    registrationEnabled: config.registrationEnabled,
    uploadRouteLimits,
    cancelArtifactAuditJob,
    artifactAuditPollIntervalMs: config.artifactAuditPollIntervalMs ?? 1_000,
  });
  const ciApp = createCiVersionRoutes({
    apiTokenService,
    versionService,
    uploadRouteLimits,
  });

  const app = new Hono<AppEnv>()
    .use('*', requestId())
    .use(
      '*',
      createObservabilityMiddleware({
        metrics,
        logger:
          options.logger ??
          (config.environment === 'test' ? () => {} : defaultStructuredLogger),
      })
    )
    .use('*', createTrustBoundary(config))
    .use(
      '/api/*',
      createRequestOriginProtection({
        managementBaseURL: config.managementBaseURL,
      })
    )
    .route('/api/ci', ciApp)
    .all('/api/ci', (c) => c.notFound())
    .all('/api/ci/*', (c) => c.notFound())
    .route('/', apiApp)
    .get('/health/live', (c) => c.body(null, 204))
    .get('/health/ready', (c) => {
      repo.load();
      if (reconciliation.recoveryConflicts > 0) {
        return c.json(
          {
            status: 'error' as const,
            reason: 'artifact_recovery_conflicts' as const,
            conflicts: reconciliation.recoveryConflicts,
          },
          503
        );
      }
      return c.json({ status: 'ok' as const });
    })
    .get('/metrics', (c) => {
      const metricsEnabled =
        config.metricsEnabled ?? config.environment !== 'production';
      if (!metricsEnabled) return c.notFound();
      if (
        config.metricsToken &&
        !hasValidBearerToken(c.req.header('Authorization'), config.metricsToken)
      ) {
        c.header('WWW-Authenticate', 'Bearer realm="deploykit-metrics"');
        return c.json(
          {
            error: {
              code: ErrorCode.UNAUTHORIZED,
              message: 'Metrics authentication required',
            },
          },
          401
        );
      }
      return c.text(metrics.render(), 200, {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        'Cache-Control': 'no-store',
      });
    })
    .route(
      '/',
      createDeployRoutes({ projectService, storageDir: config.storageDir })
    )
    .onError((err, c) => {
      // Convert service errors into `{ error: { code, message } }`; all other
      // errors become a generic 500 with the same shape.
      if (err instanceof ApiError) {
        return c.json(
          { error: { code: err.code, message: err.message } },
          err.status
        );
      }
      console.error(err);
      return c.json(
        {
          error: {
            code: ErrorCode.INTERNAL_ERROR,
            message: 'Internal Server Error',
          },
        },
        500
      );
    })
    .use('/*', async (c, next) => {
      await next();
      // Only add security headers to management UI responses, not API routes
      if (c.req.path.startsWith('/api') || c.req.path.startsWith('/deploy')) {
        return;
      }
      c.header('X-Content-Type-Options', 'nosniff');
      c.header('X-Frame-Options', 'SAMEORIGIN');
      c.header('X-XSS-Protection', '1; mode=block');
      c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    })
    .use('/*', serveStatic({ root: config.publicDir }))
    .get('*', (c) => {
      const indexHtml = join(config.publicDir, 'index.html');
      if (existsSync(indexHtml)) {
        return new Response(Bun.file(indexHtml), {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'SAMEORIGIN',
            'X-XSS-Protection': '1; mode=block',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
          },
        });
      }
      return c.notFound();
    });
  return { app, artifactAuditJobService };
}

function hasValidBearerToken(
  authorization: string | undefined,
  expectedToken: string
): boolean {
  if (!authorization?.startsWith('Bearer ')) return false;
  const receivedToken = authorization.slice('Bearer '.length);
  const received = Buffer.from(receivedToken);
  const expected = Buffer.from(expectedToken);
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}
