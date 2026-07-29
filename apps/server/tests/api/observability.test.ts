import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app';
import type { RequestLogEntry } from '../../src/middleware/observability';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'deploykit-observability-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function createTestApp(
  logs: RequestLogEntry[],
  overrides: {
    metricsEnabled?: boolean;
    metricsToken?: string;
    managementBaseURL?: string;
    deployBaseURL?: string;
  } = {}
) {
  return createApp(
    {
      environment: 'test',
      databaseFile: join(tempDir, 'deploykit.sqlite'),
      dataFile: join(tempDir, 'data.json'),
      storageDir: join(tempDir, 'storage'),
      publicDir: join(tempDir, 'public'),
      adminEmail: 'admin@test.local',
      adminPassword: 'test-password',
      sessionSecret: 'test-session-secret',
      secureCookies: false,
      registrationEnabled: false,
      ...overrides,
    },
    { logger: (entry) => logs.push(entry) }
  );
}

test('records one structured low-cardinality log and returns its request id', async () => {
  const logs: RequestLogEntry[] = [];
  const app = createTestApp(logs);
  const response = await app.request('/api/projects/private-project-id');

  expect(response.status).toBe(401);
  const requestId = response.headers.get('X-Request-Id');
  expect(requestId).toBeTruthy();
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({
    event: 'http_request',
    requestId,
    method: 'GET',
    route: '/api/*',
    status: 401,
    statusClass: '4xx',
  });
  expect(JSON.stringify(logs[0])).not.toContain('private-project-id');
});

test('keeps metrics on the management origin and requires its bearer token', async () => {
  const logs: RequestLogEntry[] = [];
  const token = 'metrics-token-that-is-long-enough-for-production';
  const app = createTestApp(logs, {
    metricsEnabled: true,
    metricsToken: token,
    managementBaseURL: 'http://console.example.test',
    deployBaseURL: 'http://deploy.example.test',
  });

  expect((await app.request('http://deploy.example.test/metrics')).status).toBe(
    404
  );
  const unauthorized = await app.request('http://console.example.test/metrics');
  expect(unauthorized.status).toBe(401);
  expect(unauthorized.headers.get('WWW-Authenticate')).toContain('Bearer');

  const metrics = await app.request('http://console.example.test/metrics', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(metrics.status).toBe(200);
  expect(metrics.headers.get('Content-Type')).toContain('version=0.0.4');
  expect(await metrics.text()).toContain('deploykit_http_requests_total');
});

test('returns not found when metrics are disabled', async () => {
  const logs: RequestLogEntry[] = [];
  const app = createTestApp(logs, { metricsEnabled: false });
  expect((await app.request('/metrics')).status).toBe(404);
});
