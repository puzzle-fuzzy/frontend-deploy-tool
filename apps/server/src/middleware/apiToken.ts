import type { Context, MiddlewareHandler } from 'hono';
import { parseIdParam } from '../domain/schemas';
import { ApiError, ErrorCode } from '../errors';
import type { ApiTokenService, AppEnv } from '../services/contracts';

const BEARER_PATTERN = /^Bearer ([^\s,]+)$/i;
const TOKEN_AUTH_ERROR_CODES: ReadonlySet<ApiError['code']> = new Set([
  ErrorCode.API_TOKEN_INVALID,
  ErrorCode.API_TOKEN_EXPIRED,
  ErrorCode.API_TOKEN_REVOKED,
  ErrorCode.API_TOKEN_SCOPE_REQUIRED,
]);

/**
 * Authenticates only project API tokens. Browser/desktop sessions are not
 * loaded on the CI router and therefore cannot become automation principals.
 */
export function createApiTokenMiddleware(
  apiTokenService: ApiTokenService
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const match = BEARER_PATTERN.exec(c.req.header('Authorization') ?? '');
    if (!match) return invalidApiTokenResponse(c);

    try {
      const projectId = parseIdParam(c.req.param('id'));
      const principal = apiTokenService.authenticate(
        match[1],
        projectId,
        'preview:upload'
      );
      c.set('apiToken', principal);
      await next();
    } catch (error) {
      if (isApiTokenAuthenticationError(error)) {
        return invalidApiTokenResponse(c);
      }
      throw error;
    }
  };
}

export function isApiTokenAuthenticationError(error: unknown): boolean {
  return error instanceof ApiError && TOKEN_AUTH_ERROR_CODES.has(error.code);
}

export function invalidApiTokenResponse(c: Context<AppEnv>): Response {
  c.header(
    'WWW-Authenticate',
    'Bearer realm="deploykit-ci", error="invalid_token"'
  );
  c.header('Cache-Control', 'no-store');
  return c.json(
    {
      error: {
        code: ErrorCode.API_TOKEN_INVALID,
        message: 'API token is invalid',
      },
    },
    401
  );
}
