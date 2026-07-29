import type { MiddlewareHandler } from 'hono';
import type { AppConfig } from '../config';

type TrustBoundaryConfig = Pick<
  AppConfig,
  'managementBaseURL' | 'deployBaseURL'
>;

/**
 * Keeps uploaded, attacker-controlled artifacts on a different browser origin
 * from the management UI and authenticated API. One Bun process may still
 * serve both hosts; the reverse proxy must preserve the original Host header.
 *
 * Development and tests retain the legacy same-origin behavior when neither
 * origin is configured. Production configuration validation prevents that
 * compatibility mode from being used in production.
 */
export function createTrustBoundary(
  config: TrustBoundaryConfig
): MiddlewareHandler {
  const managementOrigin = config.managementBaseURL
    ? new URL(config.managementBaseURL).origin
    : null;
  const deployOrigin = config.deployBaseURL
    ? new URL(config.deployBaseURL).origin
    : null;

  return async (c, next) => {
    if (!managementOrigin && !deployOrigin) {
      await next();
      return;
    }

    const requestOrigin = new URL(c.req.url).origin;
    const isDeployPath = c.req.path.startsWith('/deploy/');
    const isHealthPath = c.req.path.startsWith('/health/');

    if (requestOrigin === deployOrigin) {
      if (!isDeployPath && !isHealthPath) return c.notFound();
      await next();
      return;
    }

    if (requestOrigin === managementOrigin) {
      if (isDeployPath) return c.notFound();
      await next();
      return;
    }

    return c.notFound();
  };
}
