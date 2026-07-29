import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { canCreateProject } from '../domain/authorization';
import { parseSettings } from '../domain/project';
import {
  parseCreateProject,
  parseIdParam,
  parseUpdateProject,
} from '../domain/schemas';
import { ApiError, ErrorCode } from '../errors';
import { requireProjectRole } from '../middleware/auth';
import type { AppEnv, ProjectService } from '../services/contracts';

export function createProjectRoutes(deps: {
  projectService: ProjectService;
  /** Removes the on-disk artifacts for a deleted project. */
  removeProjectDir: (projectId: string) => void;
}) {
  const { projectService, removeProjectDir } = deps;

  return new Hono<AppEnv>()
    .get('/api/projects', (c) => {
      const actor = c.get('user');
      if (!actor)
        throw new ApiError(
          ErrorCode.UNAUTHORIZED,
          'Authentication required',
          401
        );
      return c.json(projectService.listProjects(actor));
    })
    .post('/api/projects', validator('json', parseCreateProject), (c) => {
      const actor = c.get('user');
      if (!actor)
        throw new ApiError(
          ErrorCode.UNAUTHORIZED,
          'Authentication required',
          401
        );
      if (!canCreateProject(actor)) {
        throw new ApiError(
          ErrorCode.FORBIDDEN,
          'Project creation requires developer access',
          403
        );
      }
      const project = projectService.createProject(
        c.req.valid('json'),
        actor.id
      );
      return c.json(project, 201);
    })
    .delete(
      '/api/projects/:id',
      requireProjectRole('owner', () => projectService),
      (c) => {
        const id = parseIdParam(c.req.param('id'));
        const removed = projectService.deleteProject(
          id,
          c.get('user')?.id ?? 'system'
        );
        removeProjectDir(removed.id);
        return c.json({ ok: true });
      }
    )
    .patch(
      '/api/projects/:id',
      requireProjectRole('owner', () => projectService),
      validator('json', parseUpdateProject),
      (c) => {
        const id = parseIdParam(c.req.param('id'));
        const project = projectService.updateProject(
          id,
          c.req.valid('json'),
          c.get('user')?.id ?? 'system'
        );
        return c.json(project);
      }
    )
    .patch(
      '/api/projects/:id/settings',
      requireProjectRole('owner', () => projectService),
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
          c.req.valid('json'),
          c.get('user')?.id ?? 'system'
        );
        return c.json(project);
      }
    )
    .get('/api/projects/:id/versions', (c) => {
      const id = parseIdParam(c.req.param('id'));
      const actor = c.get('user');
      if (!actor)
        throw new ApiError(
          ErrorCode.UNAUTHORIZED,
          'Authentication required',
          401
        );
      return c.json(projectService.getProjectForActor(id, actor));
    });
}
