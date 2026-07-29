import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app';

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
    managementBaseURL: 'http://console.example.test',
    deployBaseURL: 'http://deploy.example.test',
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
