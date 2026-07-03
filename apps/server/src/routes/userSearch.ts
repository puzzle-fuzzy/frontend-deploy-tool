import { Hono } from 'hono';
import type { AppEnv, UserService } from '../services/contracts';

export function createUserSearchRoutes(deps: { userService: UserService }) {
  const { userService } = deps;

  return new Hono<AppEnv>()
    .get('/api/users/search', (c) => {
      const q = c.req.query('q') ?? '';
      return c.json(userService.searchByEmail(q));
    });
}
