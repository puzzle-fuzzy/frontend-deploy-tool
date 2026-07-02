import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adminCookie, createAuthApp, withCookie } from './helpers';

let tempDir: string;
let cookie: string;
let request: (path: string, init?: RequestInit) => Promise<Response>;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'deploykit-test-'));
  const app = createAuthApp({
    dataFile: join(tempDir, 'data.json'),
    storageDir: join(tempDir, 'storage'),
    publicDir: join(tempDir, 'public'),
  });
  cookie = await adminCookie(app);
  request = (path, init) =>
    Promise.resolve(app.request(path, withCookie(init, cookie)));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function createProject(): Promise<{ id: string }> {
  const res = await request('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Demo App',
      slug: 'demo-app',
      description: 'Demo deployment',
    }),
  });
  expect(res.status).toBe(201);
  return res.json();
}

test('updates project settings through the settings endpoint', async () => {
  const project = await createProject();

  const res = await request(`/api/projects/${project.id}/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spaMode: true, routingType: 'hash' }),
  });

  expect(res.status).toBe(200);
  const updated = await res.json();
  expect(updated.settings).toEqual({ spaMode: true, routingType: 'hash' });
});

test('rejects activating an unknown version without setting an active version', async () => {
  const project = await createProject();

  const uploadRes = await request(`/api/projects/${project.id}/versions`, {
    method: 'POST',
    body: (() => {
      const form = new FormData();
      form.append('folderFiles', new File(['<html></html>'], 'index.html'));
      form.append('versionDesc', 'first build');
      return form;
    })(),
  });
  expect(uploadRes.status).toBe(201);

  const failed = await request(
    `/api/projects/${project.id}/versions/missing-version/activate`,
    { method: 'PUT' }
  );
  expect(failed.status).toBe(404);

  const list = await request(`/api/projects/${project.id}/versions`);
  const currentProject = await list.json();
  // Upload ≠ go-live and the failed activate must not set an active version.
  expect(currentProject.activeVersionId).toBeNull();
});
