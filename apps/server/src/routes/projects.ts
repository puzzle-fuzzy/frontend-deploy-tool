import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { parseSettings } from '../domain/project';
import {
  parseCreateProject,
  parseIdParam,
  parseUpdateProject,
} from '../domain/schemas';
import { ApiError, ErrorCode } from '../errors';
import { assertRole } from '../middleware/auth';
import type { AppEnv, ProjectService } from '../services/contracts';

export function createProjectRoutes(deps: {
  projectService: ProjectService;
  /** Removes the on-disk artifacts for a deleted project. */
  removeProjectDir: (projectId: string) => void;
}) {
  const { projectService, removeProjectDir } = deps;

  return new Hono<AppEnv>()
    .get('/api/projects', (c) => c.json(projectService.listProjects()))
    .post('/api/projects', validator('json', parseCreateProject), (c) => {
      assertRole(c, 'admin');
      const project = projectService.createProject(
        c.req.valid('json'),
        c.get('user')?.id ?? 'system'
      );
      return c.json(project, 201);
    })
    .delete('/api/projects/:id', (c) => {
      assertRole(c, 'admin');
      const id = parseIdParam(c.req.param('id'));
      const removed = projectService.deleteProject(
        id,
        c.get('user')?.id ?? 'system'
      );
      removeProjectDir(removed.id);
      return c.json({ ok: true });
    })
    .patch('/api/projects/:id', validator('json', parseUpdateProject), (c) => {
      assertRole(c, 'developer');
      const id = parseIdParam(c.req.param('id'));
      const project = projectService.updateProject(id, c.req.valid('json'));
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
        assertRole(c, 'developer');
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
    });
}
