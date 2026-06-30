import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from 'hono/bun';
import { createApiApp } from './api';
import type { AppConfig } from './config';
import { ApiError, ErrorCode } from './errors';
import { createJsonProjectRepository } from './repositories/jsonProjectRepository';
import { createDeployRoutes } from './routes/deploy';
import { createProjectService } from './services/projectService';
import { createVersionService } from './services/versionService';

/**
 * Composes the Hono application: wires the JSON repository into the project and
 * version services, mounts the typed `/api` routes, the deploy route, then layers
 * security headers, static asset serving, and the SPA fallback. App creation is
 * separated from `Bun.serve` so tests can exercise `createApp()` without opening
 * a port.
 */
export function createApp(config: AppConfig) {
  mkdirSync(config.storageDir, { recursive: true });

  const repo = createJsonProjectRepository(config.dataFile);
  const projectService = createProjectService(repo);
  const versionService = createVersionService(repo, config);

  return createApiApp({
    projectService,
    versionService,
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
