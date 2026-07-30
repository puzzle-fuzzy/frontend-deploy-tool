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
  const token = (await login.json()).token as string;
  const cookie = login.headers.get('Set-Cookie')?.split(';', 1)[0];
  if (!cookie) throw new Error('login did not set a session cookie');

  const rejectedLogout = await app.request(
    `${MANAGEMENT_ORIGIN}/api/auth/logout-all`,
    {
      method: 'POST',
      headers: { Cookie: cookie, Origin: DEPLOY_ORIGIN },
    }
  );
  expect(rejectedLogout.status).toBe(403);
  expect((await rejectedLogout.json()).error.code).toBe(
    'CSRF_VALIDATION_FAILED'
  );

  const sessionRemainsValid = await app.request(`${MANAGEMENT_ORIGIN}/api/me`, {
    headers: { Cookie: cookie },
  });
  expect(sessionRemainsValid.status).toBe(200);

  const created = await app.request(`${MANAGEMENT_ORIGIN}/api/projects`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'CSRF boundary project',
      slug: 'csrf-boundary-project',
      description: 'regression fixture',
    }),
  });
  expect(created.status).toBe(201);
  const project = (await created.json()) as { id: string };

  const rejectedTokenCreate = await app.request(
    `${MANAGEMENT_ORIGIN}/api/projects/${project.id}/api-tokens`,
    {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: DEPLOY_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Cross-origin token' }),
    }
  );
  expect(rejectedTokenCreate.status).toBe(403);
  expect((await rejectedTokenCreate.json()).error.code).toBe(
    'CSRF_VALIDATION_FAILED'
  );
  const tokenListAfterRejection = await app.request(
    `${MANAGEMENT_ORIGIN}/api/projects/${project.id}/api-tokens`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  expect(tokenListAfterRejection.status).toBe(200);
  expect((await tokenListAfterRejection.json()).tokens).toEqual([]);

  const legitimateTokenCreate = await app.request(
    `${MANAGEMENT_ORIGIN}/api/projects/${project.id}/api-tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Legitimate token' }),
    }
  );
  expect(legitimateTokenCreate.status).toBe(201);
  const legitimateApiToken = (await legitimateTokenCreate.json()) as {
    plaintextToken: string;
  };

  const ciSessionForm = new FormData();
  ciSessionForm.append(
    'folderFiles',
    new File(['<html><body>session CI</body></html>'], 'index.html')
  );
  const rejectedCiSession = await app.request(
    `${MANAGEMENT_ORIGIN}/api/ci/projects/${project.id}/versions`,
    {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: MANAGEMENT_ORIGIN,
        'Idempotency-Key': 'browser-session-ci',
      },
      body: ciSessionForm,
    }
  );
  expect(rejectedCiSession.status).toBe(401);
  expect((await rejectedCiSession.json()).error.code).toBe('API_TOKEN_INVALID');

  const deployOriginCiForm = new FormData();
  deployOriginCiForm.append(
    'folderFiles',
    new File(['<html><body>wrong origin</body></html>'], 'index.html')
  );
  const rejectedDeployOriginCi = await app.request(
    `${DEPLOY_ORIGIN}/api/ci/projects/${project.id}/versions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${legitimateApiToken.plaintextToken}`,
        'Idempotency-Key': 'deploy-origin-ci',
      },
      body: deployOriginCiForm,
    }
  );
  expect(rejectedDeployOriginCi.status).toBe(404);

  const previewForm = new FormData();
  previewForm.append(
    'folderFiles',
    new File(['<html><body>preview</body></html>'], 'index.html')
  );
  previewForm.append('versionDesc', 'preview');
  const uploaded = await app.request(
    `${MANAGEMENT_ORIGIN}/api/projects/${project.id}/versions`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: previewForm,
    }
  );
  expect(uploaded.status).toBe(201);
  const preview = (await uploaded.json()) as { version: { id: string } };

  const attackUpload = new FormData();
  attackUpload.append(
    'folderFiles',
    new File(['<html><body>attacker</body></html>'], 'index.html')
  );
  attackUpload.append('versionDesc', 'attacker upload');
  const rejectedUpload = await app.request(
    `${MANAGEMENT_ORIGIN}/api/projects/${project.id}/versions`,
    {
      method: 'POST',
      headers: { Cookie: cookie, Origin: DEPLOY_ORIGIN },
      body: attackUpload,
    }
  );
  expect(rejectedUpload.status).toBe(403);
  expect((await rejectedUpload.json()).error.code).toBe(
    'CSRF_VALIDATION_FAILED'
  );
  const projectAfterRejectedUpload = await app.request(
    `${MANAGEMENT_ORIGIN}/api/projects/${project.id}/versions`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  expect(projectAfterRejectedUpload.status).toBe(200);
  expect((await projectAfterRejectedUpload.json()).versions).toHaveLength(1);

  const auditJobsPath = `/api/projects/${project.id}/versions/${preview.version.id}/audit-jobs`;
  const rejectedAuditEnqueue = await app.request(
    `${MANAGEMENT_ORIGIN}${auditJobsPath}`,
    {
      method: 'POST',
      headers: { Cookie: cookie, Origin: DEPLOY_ORIGIN },
    }
  );
  expect(rejectedAuditEnqueue.status).toBe(403);
  expect((await rejectedAuditEnqueue.json()).error.code).toBe(
    'CSRF_VALIDATION_FAILED'
  );
  const legitimateAuditEnqueue = await app.request(
    `${MANAGEMENT_ORIGIN}${auditJobsPath}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  expect(legitimateAuditEnqueue.status).toBe(202);
  expect((await legitimateAuditEnqueue.json()).reused).toBe(false);
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
