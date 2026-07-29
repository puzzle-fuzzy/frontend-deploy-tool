export interface RequestMetric {
  method: string;
  route: string;
  status: number;
  durationSeconds: number;
}

export interface MetricsGaugeProviders {
  artifactStorageBytes: () => number;
  sqliteStorageBytes: () => number;
}

const LATENCY_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const VERSION_UPLOAD_ROUTE = /^\/api\/projects\/:[^/]+\/versions$/;
const RELEASE_ROUTE =
  /^\/api\/projects\/:[^/]+\/versions\/:[^/]+\/(publish|activate|rollback)$/;

interface RequestSeries {
  method: string;
  route: string;
  statusClass: string;
  count: number;
  durationSum: number;
  bucketCounts: number[];
}

/**
 * A deliberately small in-process Prometheus registry. Labels are restricted
 * to registered route templates and finite enums so arbitrary slugs, ids, and
 * filenames cannot create unbounded time series.
 */
export function createMetricsRegistry(providers: MetricsGaugeProviders) {
  const requestSeries = new Map<string, RequestSeries>();
  const uploadCounts = new Map<string, number>();
  const releaseCounts = new Map<string, number>();
  const artifactAuditCounts = new Map<ArtifactAuditStatus, number>();
  let failureCount = 0;

  return {
    observeRequest(metric: RequestMetric): void {
      const method = normalizeMethod(metric.method);
      const route = normalizeRoute(metric.route);
      const statusClass = normalizeStatusClass(metric.status);
      const durationSeconds = Math.max(0, metric.durationSeconds);
      const key = JSON.stringify([method, route, statusClass]);
      const series = requestSeries.get(key) ?? {
        method,
        route,
        statusClass,
        count: 0,
        durationSum: 0,
        bucketCounts: LATENCY_BUCKETS.map(() => 0),
      };
      series.count += 1;
      series.durationSum += durationSeconds;
      for (const [index, upperBound] of LATENCY_BUCKETS.entries()) {
        if (durationSeconds <= upperBound) series.bucketCounts[index] += 1;
      }
      requestSeries.set(key, series);

      const outcome = metric.status < 400 ? 'success' : 'failure';
      if (VERSION_UPLOAD_ROUTE.test(route) && method === 'POST') {
        increment(uploadCounts, outcome);
      }
      const release = route.match(RELEASE_ROUTE);
      if (release && (method === 'PUT' || method === 'POST')) {
        increment(releaseCounts, `${release[1]}:${outcome}`);
      }
      if (metric.status >= 400) failureCount += 1;
    },

    recordArtifactAudit(status: ArtifactAuditStatus): void {
      increment(artifactAuditCounts, status);
    },

    render(): string {
      const lines: string[] = [
        '# HELP deploykit_http_requests_total Completed HTTP requests.',
        '# TYPE deploykit_http_requests_total counter',
      ];
      const sortedSeries = [...requestSeries.values()].sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      );
      for (const series of sortedSeries) {
        const baseLabels = labels({
          method: series.method,
          route: series.route,
          status_class: series.statusClass,
        });
        lines.push(
          `deploykit_http_requests_total${baseLabels} ${series.count}`
        );
      }

      lines.push(
        '# HELP deploykit_http_request_duration_seconds HTTP request latency.',
        '# TYPE deploykit_http_request_duration_seconds histogram'
      );
      for (const series of sortedSeries) {
        const base = {
          method: series.method,
          route: series.route,
          status_class: series.statusClass,
        };
        for (const [index, upperBound] of LATENCY_BUCKETS.entries()) {
          lines.push(
            `deploykit_http_request_duration_seconds_bucket${labels({
              ...base,
              le: String(upperBound),
            })} ${series.bucketCounts[index]}`
          );
        }
        lines.push(
          `deploykit_http_request_duration_seconds_bucket${labels({
            ...base,
            le: '+Inf',
          })} ${series.count}`,
          `deploykit_http_request_duration_seconds_sum${labels(base)} ${formatNumber(
            series.durationSum
          )}`,
          `deploykit_http_request_duration_seconds_count${labels(base)} ${
            series.count
          }`
        );
      }

      lines.push(
        '# HELP deploykit_http_failures_total Completed HTTP requests with a 4xx or 5xx response.',
        '# TYPE deploykit_http_failures_total counter',
        `deploykit_http_failures_total ${failureCount}`,
        '# HELP deploykit_upload_requests_total Artifact upload requests by outcome.',
        '# TYPE deploykit_upload_requests_total counter'
      );
      for (const [outcome, count] of [...uploadCounts.entries()].sort()) {
        lines.push(
          `deploykit_upload_requests_total${labels({ outcome })} ${count}`
        );
      }

      lines.push(
        '# HELP deploykit_release_requests_total Release state changes by action and outcome.',
        '# TYPE deploykit_release_requests_total counter'
      );
      for (const [key, count] of [...releaseCounts.entries()].sort()) {
        const [action, outcome] = key.split(':');
        lines.push(
          `deploykit_release_requests_total${labels({ action, outcome })} ${count}`
        );
      }

      lines.push(
        '# HELP deploykit_artifact_audits_total Completed artifact audits by report status.',
        '# TYPE deploykit_artifact_audits_total counter'
      );
      for (const [status, count] of [...artifactAuditCounts.entries()].sort()) {
        lines.push(
          `deploykit_artifact_audits_total${labels({ status })} ${count}`
        );
      }

      lines.push(
        '# HELP deploykit_artifact_storage_bytes Artifact bytes recorded in deployment metadata.',
        '# TYPE deploykit_artifact_storage_bytes gauge',
        `deploykit_artifact_storage_bytes ${readGauge(
          providers.artifactStorageBytes
        )}`,
        '# HELP deploykit_sqlite_storage_bytes SQLite database, WAL, and shared-memory bytes.',
        '# TYPE deploykit_sqlite_storage_bytes gauge',
        `deploykit_sqlite_storage_bytes ${readGauge(
          providers.sqliteStorageBytes
        )}`
      );
      return `${lines.join('\n')}\n`;
    },
  };
}

export type MetricsRegistry = ReturnType<typeof createMetricsRegistry>;

function normalizeMethod(method: string): string {
  const normalized = method.toUpperCase();
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(
    normalized
  )
    ? normalized
    : 'OTHER';
}

function normalizeRoute(route: string): string {
  if (!route || route === '*' || route === '/*') return 'unmatched';
  return route.length <= 160 ? route : 'oversized';
}

function normalizeStatusClass(status: number): string {
  if (!Number.isInteger(status) || status < 100 || status > 599) return 'other';
  return `${Math.floor(status / 100)}xx`;
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function labels(values: Record<string, string>): string {
  return `{${Object.entries(values)
    .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
    .join(',')}}`;
}

function escapeLabel(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll('"', '\\"');
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? String(Number(value.toFixed(9))) : '0';
}

function readGauge(provider: () => number): number {
  try {
    const value = provider();
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

import type { ArtifactAuditStatus } from '@deploykit/shared';
