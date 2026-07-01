import type { Role, SafeUser } from '@deploykit/shared';
import type { MiddlewareHandler } from 'hono';
import { ApiError, ErrorCode } from '../errors';
import type { AppEnv } from '../services/contracts';

/**
 * Pure, Node-free authorization guards. The session-loading middleware (which
 * needs `node:crypto`) lives in `./session` so that this module can be imported
 * by the Bun-/Node-free `api.ts` without pulling Node types into the web build.
 */

/** Role hierarchy used by {@link requireMinRole}. */
const ROLE_LEVEL: Record<Role, number> = {
  viewer: 0,
  developer: 1,
  admin: 2,
};

/** Rejects the request with 401 when no user is authenticated. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('user')) {
    throw new ApiError(ErrorCode.UNAUTHORIZED, 'Authentication required', 401);
  }
  await next();
};

/** API paths that may be reached without a session (login/logout). */
const PUBLIC_API_PATHS = new Set(['/api/auth/login', '/api/auth/logout']);

/**
 * Like {@link requireAuth}, but lets the auth endpoints through so a client can
 * obtain a session in the first place.
 */
export const requireAuthExceptPublic: MiddlewareHandler<AppEnv> = async (
  c,
  next
) => {
  if (PUBLIC_API_PATHS.has(c.req.path)) {
    await next();
    return;
  }
  if (!c.get('user')) {
    throw new ApiError(ErrorCode.UNAUTHORIZED, 'Authentication required', 401);
  }
  await next();
};

/** Rejects with 403 when the user's role is below the minimum. */
export function requireMinRole(role: Role): MiddlewareHandler<AppEnv> {
  const minLevel = ROLE_LEVEL[role];
  return async (c, next) => {
    const user = c.get('user');
    if (!user) {
      throw new ApiError(
        ErrorCode.UNAUTHORIZED,
        'Authentication required',
        401
      );
    }
    if (ROLE_LEVEL[user.role] < minLevel) {
      throw new ApiError(ErrorCode.FORBIDDEN, 'Insufficient permissions', 403);
    }
    await next();
  };
}

/**
 * Inline role check for route handlers (avoids the dual route/middleware
 * registration that would widen `hono/client` output types to `unknown`).
 * Throws `UNAUTHORIZED`/`FORBIDDEN`.
 */
export function assertRole(
  c: { get: (k: 'user') => SafeUser | null },
  minRole: Role
): void {
  const user = c.get('user');
  if (!user) {
    throw new ApiError(ErrorCode.UNAUTHORIZED, 'Authentication required', 401);
  }
  if (ROLE_LEVEL[user.role] < ROLE_LEVEL[minRole]) {
    throw new ApiError(ErrorCode.FORBIDDEN, 'Insufficient permissions', 403);
  }
}
