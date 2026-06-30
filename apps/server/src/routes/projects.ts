import { join } from 'node:path';
import type { Hono } from 'hono';
import { parseSettings } from '../domain/project';
import { ApiError } from '../errors';
import { removeDir } from '../services/artifactService';
import type { ProjectService } from '../services/projectService';

export function registerProjectRoutes(
  app: Hono,
  deps: { projectService: ProjectService; storageDir: string }
): void {
  const { projectService, storageDir } = deps;

  app.get('/api/projects', (c) => {
    return c.json(projectService.listProjects());
  });

  app.post('/api/projects', async (c) => {
    const body = await c.req.json();
    const project = projectService.createProject(body);
    return c.json(project, 201);
  });

  app.delete('/api/projects/:id', (c) => {
    const removed = projectService.deleteProject(c.req.param('id'));
    removeDir(join(storageDir, removed.id));
    return c.json({ ok: true });
  });

  // Legacy settings endpoint: accepts either `{ settings: {...} }` or top-level settings.
  app.patch('/api/projects/:id', async (c) => {
    const body = await c.req.json();
    const settings = parseSettings(body.settings ?? body);
    if (!settings) throw new ApiError('Invalid settings payload');
    const project = projectService.updateProjectSettings(
      c.req.param('id'),
      settings
    );
    return c.json(project);
  });

  app.patch('/api/projects/:id/settings', async (c) => {
    const settings = parseSettings(await c.req.json());
    if (!settings) throw new ApiError('Invalid settings payload');
    const project = projectService.updateProjectSettings(
      c.req.param('id'),
      settings
    );
    return c.json(project);
  });

  app.get('/api/projects/:id/versions', (c) => {
    return c.json(projectService.getProject(c.req.param('id')));
  });
}
