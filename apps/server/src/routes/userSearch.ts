import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { requireProjectRole } from '../middleware/auth';
import type {
  AppEnv,
  ProjectService,
  UserService,
} from '../services/contracts';

export function createUserSearchRoutes(deps: {
  userService: UserService;
  projectService: ProjectService;
}) {
  const { userService, projectService } = deps;

  return new Hono<AppEnv>().get(
    '/api/projects/:id/users/search',
    requireProjectRole('owner', () => projectService),
    validator('query', (value) => ({
      q: typeof value.q === 'string' ? value.q : '',
    })),
    (c) => {
      const { q } = c.req.valid('query');
      return c.json(userService.searchByEmail(q));
    }
  );
}
