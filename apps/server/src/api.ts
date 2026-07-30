import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { validator } from 'hono/validator';
import { z } from 'zod';
import { parseIdParam } from './domain/schemas';
import { ApiError, ErrorCode } from './errors';
import { requireAuthExceptPublic } from './middleware/auth';
import type { UploadRouteLimits } from './middleware/uploadLimits';
import { createArtifactAuditRoutes } from './routes/artifactAudits';
import { createHistoryRoutes } from './routes/history';
import { createMemberRoutes } from './routes/members';
import { createProjectRoutes } from './routes/projects';
import { createUserSearchRoutes } from './routes/userSearch';
import { createVersionRoutes } from './routes/versions';
import type {
  AppEnv,
  ArtifactAuditJobApiService,
  ArtifactAuditService,
  ProjectService,
  SessionService,
  UserService,
  VersionService,
} from './services/contracts';

const loginBodySchema = z.object({
  email: z.string(),
  password: z.string(),
});

const registerBodySchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

const desktopAuthorizeBodySchema = z.object({
  redirectUri: z.string(),
});

const desktopExchangeBodySchema = z.object({
  code: z.string().min(1),
});

/**
 * A loopback redirect URI for the desktop auth flow: `http:` only, host is
 * `127.0.0.1` or `localhost`, an explicit port, and no userinfo. Rejects
 * anything else to prevent open-redirect / SSRF via the authorize endpoint.
 */
function isLoopbackRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return false;
  return Boolean(u.port);
}

export interface ApiDeps {
  projectService: ProjectService;
  versionService: VersionService;
  artifactAuditService: ArtifactAuditService;
  artifactAuditJobService: ArtifactAuditJobApiService;
  userService: UserService;
  /** Loads the session user into `c.var.user` (Node-backed; injected). */
  sessionMiddleware: MiddlewareHandler<AppEnv>;
  /** Durable browser/desktop session operations (runtime-backed; injected). */
  sessionService: SessionService;
  /** Writes the browser's HttpOnly session cookie. */
  setSessionCookie: (c: Context, token: string) => void;
  /** Clears the browser's HttpOnly session cookie. */
  clearSessionCookie: (c: Context) => void;
  /** Whether self-service registration is allowed on this instance. */
  registrationEnabled: boolean;
  /** Request-size and concurrency limits for artifact uploads. */
  uploadRouteLimits: UploadRouteLimits;
  /** One-time code store for the desktop auth flow (Node-backed; injected). */
  desktopAuth: {
    issueCode(userId: string, redirectUri: string): string;
    consumeCode(code: string): {
      userId: string;
      redirectUri: string;
    } | null;
  };
  /** Aborts the local subprocess after a durable job cancellation. */
  cancelArtifactAuditJob?: (jobId: string) => void;
  /** Poll interval used to derive the audit-job POST Retry-After hint. */
  artifactAuditPollIntervalMs?: number;
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
        const token = deps.sessionService.issue(user.id, 'browser');
        deps.setSessionCookie(c, token);
        return c.json({ user, token });
      }
    )
    .post(
      '/api/auth/register',
      validator('json', (value) => {
        const parsed = registerBodySchema.safeParse(value);
        if (!parsed.success) {
          throw new ApiError(
            ErrorCode.INVALID_REQUEST,
            'Invalid registration details',
            400
          );
        }
        return parsed.data;
      }),
      async (c) => {
        if (!deps.registrationEnabled) {
          throw new ApiError(
            ErrorCode.REGISTRATION_DISABLED,
            'Registration is disabled',
            403
          );
        }
        const { name, email, password } = c.req.valid('json');
        const normalizedEmail = email.toLowerCase();
        const user = deps.userService.createUser({
          name,
          email: normalizedEmail,
          password,
          role: 'developer',
        });
        const token = deps.sessionService.issue(user.id, 'browser');
        deps.setSessionCookie(c, token);
        return c.json({ user, token });
      }
    )
    .post('/api/auth/logout', (c) => {
      const user = c.get('user');
      const sessionId = c.get('sessionId');
      if (user && sessionId) {
        deps.sessionService.revoke(sessionId, user.id);
      }
      deps.clearSessionCookie(c);
      return c.json({ ok: true });
    })
    .get('/api/me', (c) => c.json(c.get('user')))
    .get('/api/auth/sessions', (c) => {
      const user = c.get('user');
      if (!user) {
        throw new ApiError(
          ErrorCode.UNAUTHORIZED,
          'Authentication required',
          401
        );
      }
      return c.json({
        sessions: deps.sessionService.listForUser(user.id, c.get('sessionId')),
      });
    })
    .delete('/api/auth/sessions/:sessionId', (c) => {
      const user = c.get('user');
      if (!user) {
        throw new ApiError(
          ErrorCode.UNAUTHORIZED,
          'Authentication required',
          401
        );
      }
      const sessionId = parseIdParam(c.req.param('sessionId'));
      if (!deps.sessionService.revoke(sessionId, user.id)) {
        throw new ApiError(
          ErrorCode.SESSION_NOT_FOUND,
          'Session not found',
          404
        );
      }
      if (sessionId === c.get('sessionId')) {
        deps.clearSessionCookie(c);
      }
      return c.json({ ok: true });
    })
    .post('/api/auth/logout-all', (c) => {
      const user = c.get('user');
      if (!user) {
        throw new ApiError(
          ErrorCode.UNAUTHORIZED,
          'Authentication required',
          401
        );
      }
      const revoked = deps.sessionService.revokeAll(user.id);
      deps.clearSessionCookie(c);
      return c.json({ ok: true, revoked });
    })
    .post(
      '/api/desktop/authorize',
      validator('json', (value) => {
        const parsed = desktopAuthorizeBodySchema.safeParse(value);
        if (!parsed.success) {
          throw new ApiError(
            ErrorCode.INVALID_REQUEST,
            'redirectUri is required',
            400
          );
        }
        if (!isLoopbackRedirectUri(parsed.data.redirectUri)) {
          throw new ApiError(
            ErrorCode.INVALID_REQUEST,
            'Redirect URI must be a loopback address',
            400
          );
        }
        return parsed.data;
      }),
      async (c) => {
        const user = c.get('user');
        if (!user) {
          throw new ApiError(
            ErrorCode.UNAUTHORIZED,
            'Authentication required',
            401
          );
        }
        const { redirectUri } = c.req.valid('json');
        const code = deps.desktopAuth.issueCode(user.id, redirectUri);
        return c.json({ code, redirectUri });
      }
    )
    .post(
      '/api/desktop/exchange',
      validator('json', (value) => {
        const parsed = desktopExchangeBodySchema.safeParse(value);
        if (!parsed.success) {
          throw new ApiError(
            ErrorCode.INVALID_REQUEST,
            'code is required',
            400
          );
        }
        return parsed.data;
      }),
      async (c) => {
        const { code } = c.req.valid('json');
        const entry = deps.desktopAuth.consumeCode(code);
        if (!entry) {
          throw new ApiError(
            ErrorCode.DESKTOP_AUTH_CODE_INVALID,
            'Authorization code is invalid or expired',
            400
          );
        }
        const user = deps.userService.getSafeUser(entry.userId);
        if (!user) {
          throw new ApiError(
            ErrorCode.UNAUTHORIZED,
            'Authentication required',
            401
          );
        }
        const token = deps.sessionService.issue(user.id, 'desktop');
        return c.json({ token, user });
      }
    )
    .route(
      '/',
      createProjectRoutes({
        projectService: deps.projectService,
      })
    )
    .route(
      '/',
      createVersionRoutes({
        versionService: deps.versionService,
        projectService: deps.projectService,
        uploadRouteLimits: deps.uploadRouteLimits,
      })
    )
    .route(
      '/',
      createArtifactAuditRoutes({
        artifactAuditJobService: deps.artifactAuditJobService,
        artifactAuditService: deps.artifactAuditService,
        projectService: deps.projectService,
        cancelArtifactAuditJob: deps.cancelArtifactAuditJob,
        artifactAuditPollIntervalMs: deps.artifactAuditPollIntervalMs,
      })
    )
    .route('/', createMemberRoutes({ projectService: deps.projectService }))
    .route(
      '/',
      createUserSearchRoutes({
        userService: deps.userService,
        projectService: deps.projectService,
      })
    )
    .route('/', createHistoryRoutes({ projectService: deps.projectService }));
}

export type ApiApp = ReturnType<typeof createApiApp>;
