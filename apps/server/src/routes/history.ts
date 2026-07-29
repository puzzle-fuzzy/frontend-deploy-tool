import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { parseIdParam } from '../domain/schemas';
import { ApiError, ErrorCode } from '../errors';
import type { AppEnv, ProjectService } from '../services/contracts';

const historyQueryValidator = validator('query', (value) => ({
  limit: typeof value.limit === 'string' ? value.limit : undefined,
  cursor: typeof value.cursor === 'string' ? value.cursor : undefined,
}));

export function createHistoryRoutes(deps: { projectService: ProjectService }) {
  const { projectService } = deps;

  return new Hono<AppEnv>()
    .get('/api/history', historyQueryValidator, (c) => {
      const actor = c.get('user');
      if (!actor)
        throw new ApiError(
          ErrorCode.UNAUTHORIZED,
          'Authentication required',
          401
        );
      const query = c.req.valid('query');
      return c.json(
        projectService.listHistory(actor, query.limit, query.cursor)
      );
    })
    .get('/api/projects/:id/history', historyQueryValidator, (c) => {
      const projectId = parseIdParam(c.req.param('id'));
      const actor = c.get('user');
      if (!actor)
        throw new ApiError(
          ErrorCode.UNAUTHORIZED,
          'Authentication required',
          401
        );
      const query = c.req.valid('query');
      return c.json(
        projectService.listProjectHistory(
          projectId,
          actor,
          query.limit,
          query.cursor
        )
      );
    });
}
