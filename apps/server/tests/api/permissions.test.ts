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
let viewerCookie: string;

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
        {
          id: 'viewer-id',
          name: 'Viewer',
          email: 'viewer@test.local',
          passwordHash: Bun.password.hashSync('viewer-pass'),
          role: 'viewer',
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
  viewerCookie = await loginAs(app, 'viewer@test.local', 'viewer-pass');
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

test('a developer can create a project and becomes its owner', async () => {
  const res = await createProjectAs(devCookie);
  expect(res.status).toBe(201);
  const project = await res.json();
  expect(project.id).toBeDefined();
  expect(project.members).toContainEqual(
    expect.objectContaining({ userId: 'dev-id', role: 'owner' })
  );
});

test('a viewer cannot create a project', async () => {
  const res = await createProjectAs(viewerCookie);
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe('FORBIDDEN');
});

test('an admin creates a project and a developer can upload after being added as a member', async () => {
  const createRes = await createProjectAs(adminCookie);
  expect(createRes.status).toBe(201);
  const project = await createRes.json();

  // Admin adds the developer as a member of the project.
  const addRes = await app.request(
    `/api/projects/${project.id}/members`,
    withCookie(
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'dev@test.local', role: 'member' }),
      },
      adminCookie
    )
  );
  expect(addRes.status).toBe(200);

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

test('project reads are scoped to members while admins can read all', async () => {
  const project = await (await createProjectAs(adminCookie)).json();

  const addRes = await app.request(
    `/api/projects/${project.id}/members`,
    withCookie(
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'dev@test.local', role: 'member' }),
      },
      adminCookie
    )
  );
  expect(addRes.status).toBe(200);

  const adminList = await app.request(
    '/api/projects',
    withCookie({ method: 'GET' }, adminCookie)
  );
  expect(
    (await adminList.json()).map((item: { id: string }) => item.id)
  ).toEqual([project.id]);

  const memberList = await app.request(
    '/api/projects',
    withCookie({ method: 'GET' }, devCookie)
  );
  expect(
    (await memberList.json()).map((item: { id: string }) => item.id)
  ).toEqual([project.id]);

  const viewerList = await app.request(
    '/api/projects',
    withCookie({ method: 'GET' }, viewerCookie)
  );
  expect(viewerList.status).toBe(200);
  expect(await viewerList.json()).toEqual([]);

  const versionsRes = await app.request(
    `/api/projects/${project.id}/versions`,
    withCookie({ method: 'GET' }, viewerCookie)
  );
  expect(versionsRes.status).toBe(403);

  const historyRes = await app.request(
    `/api/projects/${project.id}/history`,
    withCookie({ method: 'GET' }, viewerCookie)
  );
  expect(historyRes.status).toBe(403);

  const globalHistoryRes = await app.request(
    '/api/history',
    withCookie({ method: 'GET' }, viewerCookie)
  );
  expect(globalHistoryRes.status).toBe(200);
  expect((await globalHistoryRes.json()).items).toEqual([]);
});

test('a global viewer remains read-only even when added as a project member', async () => {
  const project = await (await createProjectAs(adminCookie)).json();
  const addRes = await app.request(
    `/api/projects/${project.id}/members`,
    withCookie(
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'viewer@test.local', role: 'member' }),
      },
      adminCookie
    )
  );
  expect(addRes.status).toBe(200);

  const updateRes = await app.request(
    `/api/projects/${project.id}`,
    withCookie(
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Nope' }),
      },
      viewerCookie
    )
  );
  expect(updateRes.status).toBe(403);

  const form = new FormData();
  form.append('folderFiles', new File(['<html></html>'], 'index.html'));
  form.append('versionDesc', 'viewer build');
  const uploadRes = await app.request(
    `/api/projects/${project.id}/versions`,
    withCookie({ method: 'POST', body: form }, viewerCookie)
  );
  expect(uploadRes.status).toBe(403);
});

test('only project owners and admins can search member candidates', async () => {
  const project = await (await createProjectAs(adminCookie)).json();
  const addRes = await app.request(
    `/api/projects/${project.id}/members`,
    withCookie(
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'dev@test.local', role: 'member' }),
      },
      adminCookie
    )
  );
  expect(addRes.status).toBe(200);

  const ownerSearch = await app.request(
    `/api/projects/${project.id}/users/search?q=viewer`,
    withCookie({ method: 'GET' }, adminCookie)
  );
  expect(ownerSearch.status).toBe(200);
  expect((await ownerSearch.json())[0].email).toBe('viewer@test.local');

  const memberSearch = await app.request(
    `/api/projects/${project.id}/users/search?q=viewer`,
    withCookie({ method: 'GET' }, devCookie)
  );
  expect(memberSearch.status).toBe(403);

  const legacySearch = await app.request(
    '/api/users/search?q=viewer',
    withCookie({ method: 'GET' }, adminCookie)
  );
  expect(legacySearch.status).toBe(404);
});
