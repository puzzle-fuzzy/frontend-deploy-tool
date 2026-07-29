import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type Context, Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { createApiApp } from './api';
import { type AppConfig, validateAppConfig } from './config';
import { createDesktopAuthCodeStore } from './desktopAuth';
import { ApiError, ErrorCode } from './errors';
import {
  clearSessionCookie,
  createSessionMiddleware,
  setSessionCookie,
} from './middleware/session';
import { createTrustBoundary } from './middleware/trustBoundary';
import { createUploadGate } from './middleware/uploadLimits';
import { createJsonProjectRepository } from './repositories/jsonProjectRepository';
import {
  createMemorySessionRepository,
  createSqliteSessionRepository,
} from './repositories/sessionRepository';
import { createSqliteProjectRepository } from './repositories/sqliteProjectRepository';
import { createDeployRoutes } from './routes/deploy';
import { createProjectService } from './services/projectService';
import { createSessionService } from './services/sessionService';
import { reconcileStorage } from './services/storageReconciler';
import { createUserService } from './services/userService';
import { createVersionService } from './services/versionService';

/**
 * Composes the Hono application: wires the configured repository into the project,
 * version, and user services, seeds an admin on first run, resolves the session
 * secret, and provides the Node-backed auth helpers (session middleware, cookie
 * issue/clear) to the typed `/api` app. Then layers the deploy route, security
 * headers, static asset serving, and the SPA fallback. App creation is separated
 * from `Bun.serve` so tests can exercise `createApp()` without opening a port.
 */
export function createApp(config: AppConfig) {
  validateAppConfig(config);
  mkdirSync(config.storageDir, { recursive: true });

  const repo = config.databaseFile
    ? createSqliteProjectRepository({
        databaseFile: config.databaseFile,
        legacyDataFile: config.dataFile,
      })
    : createJsonProjectRepository(config.dataFile);
  const reconciliation = reconcileStorage(repo, config.storageDir);
  if (Object.values(reconciliation).some((count) => count > 0)) {
    console.warn(
      `[deploykit] Storage reconciliation: ${JSON.stringify(reconciliation)}`
    );
  }
  const projectService = createProjectService(repo);
  const versionService = createVersionService(repo, config);
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

  // Resolve the session secret; warn when falling back to an ephemeral one.
  const sessionSecret =
    config.sessionSecret ?? randomBytes(32).toString('base64url');
  if (!config.sessionSecret) {
    console.warn(
      '[deploykit] SESSION_SECRET not set; generated an ephemeral secret. ' +
        'Sessions will not survive a restart. Set SESSION_SECRET in production.'
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
    versionService,
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
    removeProjectDir: (projectId) =>
      rmSync(join(config.storageDir, projectId), {
        recursive: true,
        force: true,
      }),
  });

  return new Hono()
    .use('*', createTrustBoundary(config))
    .route('/', apiApp)
    .get('/health/live', (c) => c.body(null, 204))
    .get('/health/ready', (c) => {
      repo.load();
      return c.json({ status: 'ok' as const });
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
}
