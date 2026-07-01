import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  createAuthApp,
  loginAs,
  withCookie,
} from './helpers';

let tempDir: string;
let app: ReturnType<typeof createAuthApp>;
let adminCookie: string;
let devCookie: string;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'deploykit-perm-'));
  // Seed both an admin and a developer directly so role gates are exercised.
  const now = new Date().toISOString();
  writeFileSync(
    join(tempDir, 'data.json'),
    JSON.stringify({
      schemaVersion: 3,
      projects: [],
      users: [
        {
          id: 'admin-id',
          name: 'Admin',
          email: ADMIN_EMAIL,
          passwordHash: Bun.password.hashSync(ADMIN_PASSWORD),
          role: 'admin',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'dev-id',
          name: 'Dev',
          email: 'dev@test.local',
          passwordHash: Bun.password.hashSync('dev-pass'),
          role: 'developer',
          createdAt: now,
          updatedAt: now,
        },
      ],
      history: [],
    })
  );
  app = createAuthApp({
    dataFile: join(tempDir, 'data.json'),
    storageDir: join(tempDir, 'storage'),
    publicDir: join(tempDir, 'public'),
  });
  adminCookie = await loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD);
  devCookie = await loginAs(app, 'dev@test.local', 'dev-pass');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function createProjectAs(cookie: string, slug = 'demo-app') {
  return app.request(
    '/api/projects',
    withCookie(
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Demo', slug, description: '' }),
      },
      cookie
    )
  );
}

test('a developer cannot create a project (admin-only)', async () => {
  const res = await createProjectAs(devCookie);
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({
    error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
  });
});

test('an admin creates a project and a developer can upload to it', async () => {
  const createRes = await createProjectAs(adminCookie);
  expect(createRes.status).toBe(201);
  const project = await createRes.json();

  const form = new FormData();
  form.append('folderFiles', new File(['<html></html>'], 'index.html'));
  form.append('versionDesc', 'build');
  const uploadRes = await app.request(
    `/api/projects/${project.id}/versions`,
    withCookie({ method: 'POST', body: form }, devCookie)
  );
  expect(uploadRes.status).toBe(201);
});

test('a developer cannot delete a project', async () => {
  const project = await (await createProjectAs(adminCookie)).json();
  const res = await app.request(
    `/api/projects/${project.id}`,
    withCookie({ method: 'DELETE' }, devCookie)
  );
  expect(res.status).toBe(403);
});
