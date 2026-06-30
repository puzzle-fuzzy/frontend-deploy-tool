import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { parseSettings } from '../domain/project';
import { parseCreateProject, parseIdParam } from '../domain/schemas';
import { ApiError, ErrorCode } from '../errors';
import type { ProjectService } from '../services/contracts';

export function createProjectRoutes(deps: {
  projectService: ProjectService;
  /** Removes the on-disk artifacts for a deleted project. */
  removeProjectDir: (projectId: string) => void;
}) {
  const { projectService, removeProjectDir } = deps;

  return (
    new Hono()
      .get('/api/projects', (c) => c.json(projectService.listProjects()))
      .post('/api/projects', validator('json', parseCreateProject), (c) => {
        const project = projectService.createProject(c.req.valid('json'));
        return c.json(project, 201);
      })
      .delete('/api/projects/:id', (c) => {
        const id = parseIdParam(c.req.param('id'));
        const removed = projectService.deleteProject(id);
        removeProjectDir(removed.id);
        return c.json({ ok: true });
      })
      // Legacy settings endpoint: accepts either `{ settings: {...} }` or top-level settings.
      .patch('/api/projects/:id', async (c) => {
        const id = parseIdParam(c.req.param('id'));
        const body = await c.req.json();
        const settings = parseSettings(body.settings ?? body);
        if (!settings)
          throw new ApiError(
            ErrorCode.INVALID_SETTINGS,
            'Invalid settings payload'
          );
        const project = projectService.updateProjectSettings(id, settings);
        return c.json(project);
      })
      .patch(
        '/api/projects/:id/settings',
        validator('json', (value) => {
          const settings = parseSettings(value);
          if (!settings)
            throw new ApiError(
              ErrorCode.INVALID_SETTINGS,
              'Invalid settings payload'
            );
          return settings;
        }),
        (c) => {
          const id = parseIdParam(c.req.param('id'));
          const project = projectService.updateProjectSettings(
            id,
            c.req.valid('json')
          );
          return c.json(project);
        }
      )
      .get('/api/projects/:id/versions', (c) => {
        const id = parseIdParam(c.req.param('id'));
        return c.json(projectService.getProject(id));
      })
  );
}
