import type { MiddlewareHandler } from 'hono';
import { ApiError, ErrorCode } from '../errors';
import { SESSION_COOKIE } from './session';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const REJECTED_FETCH_SITES = new Set(['same-site', 'cross-site']);

export interface RequestOriginProtectionConfig {
  managementBaseURL?: string;
}

/**
 * Rejects browser-initiated unsafe management API writes that could carry an
 * authenticated session cookie from a sibling or untrusted origin. This is
 * deliberately independent of CORS: requests that fail CORS still reach the
 * server and can mutate state when the browser attaches a SameSite cookie.
 */
export function createRequestOriginProtection({
  managementBaseURL,
}: RequestOriginProtectionConfig): MiddlewareHandler {
  const managementOrigin = managementBaseURL
    ? new URL(managementBaseURL).origin
    : null;

  return async (c, next) => {
    if (
      !managementOrigin ||
      !c.req.path.startsWith('/api/') ||
      SAFE_METHODS.has(c.req.method)
    ) {
      await next();
      return;
    }

    const origin = c.req.header('Origin');
    const fetchSite = c.req.header('Sec-Fetch-Site');
    const cookie = c.req.header('Cookie');
    const hasSessionCookie = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=`).test(
      cookie ?? ''
    );

    if (
      REJECTED_FETCH_SITES.has(fetchSite ?? '') ||
      (origin !== undefined && origin !== managementOrigin) ||
      (origin === undefined && hasSessionCookie)
    ) {
      throw new ApiError(
        ErrorCode.CSRF_VALIDATION_FAILED,
        'Request origin validation failed',
        403
      );
    }

    await next();
  };
}
