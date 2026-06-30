import { Hono } from 'hono';
import type { ProjectService } from '../services/contracts';

export function createHistoryRoutes(deps: { projectService: ProjectService }) {
  const { projectService } = deps;

  return new Hono().get('/api/history', (c) =>
    c.json(projectService.listHistory(c.req.query('limit')))
  );
}
