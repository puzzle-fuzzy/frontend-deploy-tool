import type { Hono } from 'hono';
import type { ProjectService } from '../services/projectService';

export function registerHistoryRoutes(
  app: Hono,
  deps: { projectService: ProjectService }
): void {
  const { projectService } = deps;

  app.get('/api/history', (c) => {
    return c.json(projectService.listHistory(c.req.query('limit')));
  });
}
