import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { parseIdParam } from '../domain/schemas';
import type { AppEnv, ProjectService } from '../services/contracts';

const historyQueryValidator = validator('query', (value) => ({
  limit: typeof value.limit === 'string' ? value.limit : undefined,
  cursor: typeof value.cursor === 'string' ? value.cursor : undefined,
}));

export function createHistoryRoutes(deps: { projectService: ProjectService }) {
  const { projectService } = deps;

  return new Hono<AppEnv>()
    .get('/api/history', historyQueryValidator, (c) => {
      const query = c.req.valid('query');
      return c.json(projectService.listHistory(query.limit, query.cursor));
    })
    .get('/api/projects/:id/history', historyQueryValidator, (c) => {
      const projectId = parseIdParam(c.req.param('id'));
      const query = c.req.valid('query');
      return c.json(
        projectService.listProjectHistory(projectId, query.limit, query.cursor)
      );
    });
}
