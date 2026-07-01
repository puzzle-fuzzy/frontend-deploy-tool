import type { SafeUser } from '@deploykit/shared';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { validator } from 'hono/validator';
import { z } from 'zod';
import { ApiError, ErrorCode } from './errors';
import { requireAuthExceptPublic } from './middleware/auth';
import { createHistoryRoutes } from './routes/history';
import { createProjectRoutes } from './routes/projects';
import { createVersionRoutes } from './routes/versions';
import type {
  AppEnv,
  ProjectService,
  UserService,
  VersionService,
} from './services/contracts';

const loginBodySchema = z.object({
  email: z.string(),
  password: z.string(),
});

export interface ApiDeps {
  projectService: ProjectService;
  versionService: VersionService;
  userService: UserService;
  /** Loads the session user into `c.var.user` (Node-backed; injected). */
  sessionMiddleware: MiddlewareHandler<AppEnv>;
  /** Issues a session cookie for `user` (Node-backed; injected). */
  issueSession: (c: Context, user: SafeUser) => void;
  /** Clears the session cookie (Node-backed; injected). */
  clearSession: (c: Context) => void;
  removeProjectDir: (projectId: string) => void;
  removeVersionDir: (projectId: string, versionId: string) => void;
}

/**
 * Builds the typed `/api` Hono app: the full auth layer (session loading,
 * require-auth, per-route role gates, login/logout/me) plus the project,
 * version, and history routes. This module stays Bun- and Node-free — the
 * `Bun.password` call lives behind `userService`, and the cookie/crypto helpers
 * are injected via `ApiDeps` — so the exported `ApiApp` type (including the auth
 * routes) is consumable by the frontend via `hono/client`. The deploy route and
 * static-serving layer live in `app.ts`.
 */
export function createApiApp(deps: ApiDeps) {
  return new Hono<AppEnv>()
    .use('/api/*', deps.sessionMiddleware)
    .use('/api/*', requireAuthExceptPublic)
    .post(
      '/api/auth/login',
      validator('json', (value) => {
        const parsed = loginBodySchema.safeParse(value);
        if (!parsed.success) {
          throw new ApiError(
            ErrorCode.INVALID_CREDENTIALS,
            'Invalid email or password',
            401
          );
        }
        return parsed.data;
      }),
      async (c) => {
        const { email, password } = c.req.valid('json');
        const user = await deps.userService.verifyCredentials(email, password);
        if (!user) {
          throw new ApiError(
            ErrorCode.INVALID_CREDENTIALS,
            'Invalid email or password',
            401
          );
        }
        deps.issueSession(c, user);
        return c.json({ user });
      }
    )
    .post('/api/auth/logout', (c) => {
      deps.clearSession(c);
      return c.json({ ok: true });
    })
    .get('/api/me', (c) => c.json(c.get('user')))
    .route(
      '/',
      createProjectRoutes({
        projectService: deps.projectService,
        removeProjectDir: deps.removeProjectDir,
      })
    )
    .route(
      '/',
      createVersionRoutes({
        versionService: deps.versionService,
        removeVersionDir: deps.removeVersionDir,
      })
    )
    .route('/', createHistoryRoutes({ projectService: deps.projectService }));
}

export type ApiApp = ReturnType<typeof createApiApp>;
