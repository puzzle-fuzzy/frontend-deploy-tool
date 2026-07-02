import { Hono } from 'hono';
import { parseIdParam } from '../domain/schemas';
import type { AppEnv, ProjectService } from '../services/contracts';

export function createHistoryRoutes(deps: { projectService: ProjectService }) {
  const { projectService } = deps;

  return new Hono<AppEnv>()
    .get('/api/history', (c) =>
      c.json(projectService.listHistory(c.req.query('limit')))
    )
    .get('/api/projects/:id/history', (c) => {
      const projectId = parseIdParam(c.req.param('id'));
      return c.json(
        projectService.listProjectHistory(projectId, c.req.query('limit'))
      );
    });
}
