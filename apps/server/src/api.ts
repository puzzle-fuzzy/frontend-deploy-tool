import { Hono } from 'hono';
import { createHistoryRoutes } from './routes/history';
import { createProjectRoutes } from './routes/projects';
import { createVersionRoutes } from './routes/versions';
import type { ProjectService, VersionService } from './services/contracts';

export interface ApiDeps {
  projectService: ProjectService;
  versionService: VersionService;
  removeProjectDir: (projectId: string) => void;
  removeVersionDir: (projectId: string, versionId: string) => void;
}

/**
 * Builds the typed `/api` Hono app (project, version, and history routes). This
 * module is intentionally Bun- and Node-free so the exported `ApiApp` type can
 * be consumed by the frontend (`hono/client`) without pulling Bun or Node types
 * into the web build. The deploy route and static-serving layer live in `app.ts`.
 */
export function createApiApp(deps: ApiDeps) {
  return new Hono()
    .route(
      '/',
      createProjectRoutes({
        projectService: deps.projectService,
        removeProjectDir: deps.removeProjectDir,
      })
    )
    .route(
      '/',
      createVersionRoutes({
        versionService: deps.versionService,
        removeVersionDir: deps.removeVersionDir,
      })
    )
    .route('/', createHistoryRoutes({ projectService: deps.projectService }));
}

export type ApiApp = ReturnType<typeof createApiApp>;
