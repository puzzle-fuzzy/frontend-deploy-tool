import { describe, expect, test } from 'bun:test';
import { createMetricsRegistry } from '../../src/services/metrics';

describe('metrics registry', () => {
  test('renders bounded HTTP, upload, release, failure, and storage metrics', () => {
    const metrics = createMetricsRegistry({
      artifactStorageBytes: () => 4096,
      sqliteStorageBytes: () => 8192,
      artifactAuditJobsActive: () => ({ queued: 2, running: 1 }),
    });

    metrics.observeRequest({
      method: 'POST',
      route: '/api/projects/:id/versions',
      status: 201,
      durationSeconds: 0.04,
    });
    metrics.observeRequest({
      method: 'POST',
      route: '/api/projects/:id/versions/:versionId/rollback',
      status: 409,
      durationSeconds: 0.5,
    });
    metrics.recordArtifactAudit('warning');
    for (const outcome of [
      'succeeded',
      'failed',
      'canceled',
      'retried',
    ] as const) {
      metrics.recordArtifactAuditJob(outcome);
    }

    const output = metrics.render();
    expect(output).toContain(
      'deploykit_http_requests_total{method="POST",route="/api/projects/:id/versions",status_class="2xx"} 1'
    );
    expect(output).toContain(
      'deploykit_upload_requests_total{outcome="success"} 1'
    );
    expect(output).toContain(
      'deploykit_release_requests_total{action="rollback",outcome="failure"} 1'
    );
    expect(output).toContain('deploykit_http_failures_total 1');
    expect(output).toContain(
      'deploykit_artifact_audits_total{status="warning"} 1'
    );
    for (const outcome of ['succeeded', 'failed', 'canceled', 'retried']) {
      expect(output).toContain(
        `deploykit_artifact_audit_jobs_total{outcome="${outcome}"} 1`
      );
    }
    expect(output).toContain(
      'deploykit_artifact_audit_jobs_active{status="queued"} 2'
    );
    expect(output).toContain(
      'deploykit_artifact_audit_jobs_active{status="running"} 1'
    );
    expect(output).toContain('deploykit_artifact_storage_bytes 4096');
    expect(output).toContain('deploykit_sqlite_storage_bytes 8192');
    expect(output).toContain(
      'deploykit_http_request_duration_seconds_bucket{method="POST",route="/api/projects/:id/versions/:versionId/rollback",status_class="4xx",le="0.5"} 1'
    );
  });

  test('does not preserve arbitrary unsupported methods or oversized routes', () => {
    const metrics = createMetricsRegistry({
      artifactStorageBytes: () => Number.NaN,
      sqliteStorageBytes: () => {
        throw new Error('unavailable');
      },
    });

    metrics.observeRequest({
      method: 'ATTACKER-METHOD',
      route: `/${'x'.repeat(200)}`,
      status: 999,
      durationSeconds: -1,
    });

    const output = metrics.render();
    expect(output).toContain(
      'deploykit_http_requests_total{method="OTHER",route="oversized",status_class="other"} 1'
    );
    expect(output).toContain('deploykit_artifact_storage_bytes 0');
    expect(output).toContain('deploykit_sqlite_storage_bytes 0');
    expect(output).toContain(
      'deploykit_artifact_audit_jobs_active{status="queued"} 0'
    );
    expect(output).toContain(
      'deploykit_artifact_audit_jobs_active{status="running"} 0'
    );
  });
});
