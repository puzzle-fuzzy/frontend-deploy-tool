import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app';

const MANAGEMENT_ORIGIN = 'http://console.example.test';
const DEPLOY_ORIGIN = 'http://deploy.example.test';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'deploykit-boundary-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test('serves trusted routes and deployed artifacts on separate origins', async () => {
  const storageDir = join(tempDir, 'storage');
  const versionDir = join(storageDir, 'project-1', 'version-1');
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(join(versionDir, 'index.html'), '<h1>deployed</h1>');
  writeFileSync(
    join(tempDir, 'data.json'),
    JSON.stringify({
      schemaVersion: 5,
      users: [],
      history: [],
      projects: [
        {
          id: 'project-1',
          name: 'Demo',
          slug: 'demo',
          description: '',
          createdAt: '2026-07-30T00:00:00.000Z',
          updatedAt: '2026-07-30T00:00:00.000Z',
          activeVersionId: 'version-1',
          createdBy: 'system',
          members: [],
          settings: { spaMode: false, routingType: 'hash' },
          auditPolicy: {
            enforcement: 'advisory',
            maxTotalBytes: 50 * 1024 * 1024,
            maxFileBytes: 10 * 1024 * 1024,
            maxFileCount: 1_000,
          },
          versions: [
            {
              id: 'version-1',
              name: 'version',
              description: '',
              createdAt: '2026-07-30T00:00:00.000Z',
              size: 17,
              fileCount: 1,
              sourceType: 'folder',
              status: 'production',
              publishedAt: '2026-07-30T00:00:00.000Z',
              publishedBy: 'system',
              checksum: 'unused-by-serving',
            },
          ],
        },
      ],
    })
  );

  const app = createApp({
    environment: 'test',
    dataFile: join(tempDir, 'data.json'),
    storageDir,
    publicDir: join(tempDir, 'public'),
    managementBaseURL: MANAGEMENT_ORIGIN,
    deployBaseURL: DEPLOY_ORIGIN,
    adminEmail: 'admin@test.local',
    adminPassword: 'test-password',
    sessionSecret: 'test-session-secret',
    secureCookies: false,
    registrationEnabled: false,
  });

  expect((await app.request('http://console.example.test/api/me')).status).toBe(
    401
  );
  expect((await app.request('http://deploy.example.test/api/me')).status).toBe(
    404
  );
  expect(
    (await app.request('http://console.example.test/deploy/demo/')).status
  ).toBe(404);

  const deployed = await app.request('http://deploy.example.test/deploy/demo/');
  expect(deployed.status).toBe(200);
  expect(await deployed.text()).toContain('deployed');
});

test('rejects deploy-origin writes made with a real browser session cookie', async () => {
  const app = createApp({
    environment: 'test',
    dataFile: join(tempDir, 'data.json'),
    storageDir: join(tempDir, 'storage'),
    publicDir: join(tempDir, 'public'),
    managementBaseURL: MANAGEMENT_ORIGIN,
    deployBaseURL: DEPLOY_ORIGIN,
    adminEmail: 'admin@test.local',
    adminPassword: 'test-password',
    sessionSecret: 'test-session-secret',
    secureCookies: false,
    registrationEnabled: false,
  });
  const login = await app.request(`${MANAGEMENT_ORIGIN}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'admin@test.local',
      password: 'test-password',
    }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get('Set-Cookie')?.split(';', 1)[0];
  if (!cookie) throw new Error('login did not set a session cookie');

  for (const [path, body] of [
    ['/api/auth/logout-all', undefined],
    ['/api/projects/not-a-project/versions', new FormData()],
    [
      '/api/projects/not-a-project/versions/not-a-version/audit-jobs',
      undefined,
    ],
  ] as const) {
    const response = await app.request(`${MANAGEMENT_ORIGIN}${path}`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: DEPLOY_ORIGIN,
      },
      body,
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('CSRF_VALIDATION_FAILED');
  }

  const sessionRemainsValid = await app.request(`${MANAGEMENT_ORIGIN}/api/me`, {
    headers: { Cookie: cookie },
  });
  expect(sessionRemainsValid.status).toBe(200);
});

test('preserves same-origin development behavior when origins are unset', async () => {
  writeFileSync(
    join(tempDir, 'data.json'),
    JSON.stringify({
      schemaVersion: 5,
      users: [],
      history: [],
      projects: [],
    })
  );
  const app = createApp({
    environment: 'test',
    dataFile: join(tempDir, 'data.json'),
    storageDir: join(tempDir, 'storage'),
    publicDir: join(tempDir, 'public'),
    adminEmail: 'admin@test.local',
    adminPassword: 'test-password',
    sessionSecret: 'test-session-secret',
    secureCookies: false,
    registrationEnabled: false,
  });

  expect((await app.request('/api/me')).status).toBe(401);
});
