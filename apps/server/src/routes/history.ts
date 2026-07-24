import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { parseIdParam } from '../domain/schemas';
import type { AppEnv, ProjectService } from '../services/contracts';

const historyQueryValidator = validator('query', (value) => ({
  limit: typeof value.limit === 'string' ? value.limit : undefined,
}));

export function createHistoryRoutes(deps: { projectService: ProjectService }) {
  const { projectService } = deps;

  return new Hono<AppEnv>()
    .get('/api/history', historyQueryValidator, (c) =>
      c.json(projectService.listHistory(c.req.valid('query').limit))
    )
    .get('/api/projects/:id/history', historyQueryValidator, (c) => {
      const projectId = parseIdParam(c.req.param('id'));
      return c.json(
        projectService.listProjectHistory(projectId, c.req.valid('query').limit)
      );
    });
}
