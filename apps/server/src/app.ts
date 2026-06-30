import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import type { AppConfig } from './config';
import { ApiError } from './errors';
import { createJsonProjectRepository } from './repositories/jsonProjectRepository';
import { registerDeployRoutes } from './routes/deploy';
import { registerHistoryRoutes } from './routes/history';
import { registerProjectRoutes } from './routes/projects';
import { registerVersionRoutes } from './routes/versions';
import { createProjectService } from './services/projectService';
import { createVersionService } from './services/versionService';

/**
 * Composes the Hono application: wires the JSON repository into the project and
 * version services, mounts the API/deploy routes, then layers security headers,
 * static asset serving, and the SPA fallback. App creation is separated from
 * `Bun.serve` so tests can exercise `createApp()` without opening a port.
 */
export function createApp(config: AppConfig): Hono {
  mkdirSync(config.storageDir, { recursive: true });

  const app = new Hono();

  // Convert service errors into the existing `{ error }` JSON shape; all other
  // errors fall back to Hono's default behavior (500 "Internal Server Error").
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: err.message }, err.status);
    }
    console.error(err);
    return c.text('Internal Server Error', 500);
  });

  const repo = createJsonProjectRepository(config.dataFile);
  const projectService = createProjectService(repo);
  const versionService = createVersionService(repo, config);

  registerProjectRoutes(app, {
    projectService,
    storageDir: config.storageDir,
  });
  registerVersionRoutes(app, {
    versionService,
    storageDir: config.storageDir,
  });
  registerHistoryRoutes(app, { projectService });
  registerDeployRoutes(app, {
    projectService,
    storageDir: config.storageDir,
  });

  // Add security headers for management UI static assets
  app.use('/*', async (c, next) => {
    await next();
    // Only add security headers to management UI responses, not API routes
    if (c.req.path.startsWith('/api') || c.req.path.startsWith('/deploy')) {
      return;
    }
    // Add security headers to management UI static assets
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'SAMEORIGIN');
    c.header('X-XSS-Protection', '1; mode=block');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  });

  // Serve static files with appropriate cache headers
  app.use(
    '/*',
    serveStatic({
      root: config.publicDir,
    })
  );

  app.get('*', (c) => {
    const indexHtml = join(config.publicDir, 'index.html');
    if (existsSync(indexHtml)) {
      return new Response(Bun.file(indexHtml), {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          // Security headers for management UI
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'SAMEORIGIN',
          'X-XSS-Protection': '1; mode=block',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
        },
      });
    }
    return c.notFound();
  });

  return app;
}
