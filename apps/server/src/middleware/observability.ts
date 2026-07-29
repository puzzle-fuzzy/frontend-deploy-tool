import type { MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
import type { AppEnv } from '../services/contracts';
import type { MetricsRegistry } from '../services/metrics';

export interface RequestLogEntry {
  timestamp: string;
  level: 'info';
  event: 'http_request';
  requestId: string;
  method: string;
  route: string;
  status: number;
  statusClass: string;
  durationMs: number;
}

export type StructuredLogger = (entry: RequestLogEntry) => void;

export interface ObservabilityOptions {
  metrics: MetricsRegistry;
  logger: StructuredLogger;
  now?: () => number;
}

export function createObservabilityMiddleware({
  metrics,
  logger,
  now = performance.now.bind(performance),
}: ObservabilityOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const startedAt = now();
    await next();
    const durationMs = Math.max(0, now() - startedAt);
    const registeredRoute = routePath(c) || 'unmatched';
    metrics.observeRequest({
      method: c.req.method,
      route: registeredRoute,
      status: c.res.status,
      durationSeconds: durationMs / 1000,
    });
    logger({
      timestamp: new Date().toISOString(),
      level: 'info',
      event: 'http_request',
      requestId: c.get('requestId'),
      method: c.req.method,
      route: registeredRoute,
      status: c.res.status,
      statusClass: statusClass(c.res.status),
      durationMs: Number(durationMs.toFixed(3)),
    });
  };
}

export const defaultStructuredLogger: StructuredLogger = (entry) => {
  console.log(JSON.stringify(entry));
};

function statusClass(status: number): string {
  return status >= 100 && status <= 599
    ? `${Math.floor(status / 100)}xx`
    : 'other';
}
