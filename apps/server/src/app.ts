import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SafeUser } from '@deploykit/shared';
import type { Context } from 'hono';
import { serveStatic } from 'hono/bun';
import { createApiApp } from './api';
import type { AppConfig } from './config';
import { ApiError, ErrorCode } from './errors';
import {
  clearSessionCookie,
  createSessionMiddleware,
  createSessionToken,
  SESSION_MAX_AGE_SECONDS,
  setSessionCookie,
} from './middleware/session';
import { createJsonProjectRepository } from './repositories/jsonProjectRepository';
import { createDeployRoutes } from './routes/deploy';
import { createProjectService } from './services/projectService';
import { createUserService } from './services/userService';
import { createVersionService } from './services/versionService';

/**
 * Composes the Hono application: wires the JSON repository into the project,
 * version, and user services, seeds an admin on first run, resolves the session
 * secret, and provides the Node-backed auth helpers (session middleware, cookie
 * issue/clear) to the typed `/api` app. Then layers the deploy route, security
 * headers, static asset serving, and the SPA fallback. App creation is separated
 * from `Bun.serve` so tests can exercise `createApp()` without opening a port.
 */
export function createApp(config: AppConfig) {
  mkdirSync(config.storageDir, { recursive: true });

  const repo = createJsonProjectRepository(config.dataFile);
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

  // Node-backed auth helpers injected into the (otherwise Node-free) typed API.
  const issueSession = (c: Context, user: SafeUser) => {
    const token = createSessionToken(
      {
        sub: user.id,
        role: user.role,
        exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
      },
      sessionSecret
    );
    setSessionCookie(c, token, config.secureCookies);
  };
  const clearSession = (c: Context) => {
    clearSessionCookie(c, config.secureCookies);
  };

  return createApiApp({
    projectService,
    versionService,
    userService,
    sessionMiddleware: createSessionMiddleware({
      secret: sessionSecret,
      userService,
    }),
    issueSession,
    clearSession,
    removeProjectDir: (projectId) =>
      rmSync(join(config.storageDir, projectId), {
        recursive: true,
        force: true,
      }),
    removeVersionDir: (projectId, versionId) =>
      rmSync(join(config.storageDir, projectId, versionId), {
        recursive: true,
        force: true,
      }),
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
