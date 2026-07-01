import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project } from '@deploykit/shared';
import type { Hono } from 'hono';
import { createApp } from '../../src/app';

let app: Hono;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'deploykit-contract-'));
  app = createApp({
    dataFile: join(tempDir, 'data.json'),
    storageDir: join(tempDir, 'storage'),
    publicDir: join(tempDir, 'public'),
  });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function createProject(
  currentApp: Hono,
  slug = 'demo-app'
): Promise<Project> {
  const res = await currentApp.request('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Demo', slug, description: 'demo' }),
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function uploadVersion(
  currentApp: Hono,
  projectId: string,
  content = '<html><body>hello</body></html>',
  fileName = 'index.html'
): Promise<Response> {
  const form = new FormData();
  form.append('folderFiles', new File([content], fileName));
  form.append('versionDesc', 'build');
  return currentApp.request(`/api/projects/${projectId}/versions`, {
    method: 'POST',
    body: form,
  });
}

async function getProject(
  currentApp: Hono,
  projectId: string
): Promise<Project> {
  const res = await currentApp.request(`/api/projects/${projectId}/versions`);
  return res.json();
}

test('creates a project with default settings and lists it', async () => {
  const project = await createProject(app);
  expect(project).toMatchObject({
    name: 'Demo',
    slug: 'demo-app',
    versions: [],
    settings: { spaMode: false, routingType: 'path' },
  });
  expect(project.id).toBeTruthy();

  const list = await (await app.request('/api/projects')).json();
  expect(list).toHaveLength(1);
  expect(list[0].id).toBe(project.id);
});

test('rejects project creation for a missing name', async () => {
  const res = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: 'demo-app' }),
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: {
      code: 'PROJECT_NAME_REQUIRED',
      message: 'Project name is required',
    },
  });
});

test('rejects project creation for an invalid slug', async () => {
  const res = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Demo', slug: 'ab' }),
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: {
      code: 'PROJECT_SLUG_INVALID',
      message:
        'Project slug must be 3-64 lowercase letters, numbers, or hyphens',
    },
  });
});

test('rejects a duplicate project slug', async () => {
  await createProject(app, 'demo-app');
  const res = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Other', slug: 'demo-app' }),
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: {
      code: 'PROJECT_SLUG_TAKEN',
      message: 'Project slug already exists',
    },
  });
});

test('rejects a malformed route id with 400 INVALID_PARAMS', async () => {
  const res = await app.request('/api/projects/!!!/versions/some-id/activate', {
    method: 'PUT',
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: { code: 'INVALID_PARAMS', message: 'Invalid id parameter' },
  });
});

test('updates settings through the dedicated settings endpoint', async () => {
  const project = await createProject(app);
  const res = await app.request(`/api/projects/${project.id}/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spaMode: true, routingType: 'hash' }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).settings).toEqual({
    spaMode: true,
    routingType: 'hash',
  });
});

test('updates settings through the legacy project endpoint with a nested payload', async () => {
  const project = await createProject(app);
  const res = await app.request(`/api/projects/${project.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: { spaMode: true, routingType: 'hash' } }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).settings).toEqual({
    spaMode: true,
    routingType: 'hash',
  });
});

test('rejects an invalid settings payload with 400', async () => {
  const project = await createProject(app);
  const res = await app.request(`/api/projects/${project.id}/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spaMode: 'not-a-boolean' }),
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: { code: 'INVALID_SETTINGS', message: 'Invalid settings payload' },
  });
});

test('returns 404 when updating settings for an unknown project', async () => {
  const res = await app.request('/api/projects/unknown/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spaMode: true, routingType: 'hash' }),
  });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({
    error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' },
  });
});

test('uploads a folder version that becomes the active version', async () => {
  const project = await createProject(app);
  const res = await uploadVersion(app, project.id);
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.version.id).toBeTruthy();
  expect(body.version.name).toBe(body.version.id.slice(0, 7));

  const after = await getProject(app, project.id);
  expect(after.versions).toHaveLength(1);
  expect(after.activeVersionId).toBe(after.versions[0].id);

  // Upload metadata is recorded for the version.
  const version = after.versions[0];
  expect(version.sourceType).toBe('folder');
  expect(version.fileCount).toBe(1);
  expect(version.size).toBeGreaterThan(0);
});

test('rejects a non-zip single file upload with 400', async () => {
  const project = await createProject(app);
  const form = new FormData();
  form.append('file', new File(['nope'], 'not-a-zip.txt'));
  form.append('versionDesc', 'bad');
  const res = await app.request(`/api/projects/${project.id}/versions`, {
    method: 'POST',
    body: form,
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: { code: 'INVALID_UPLOAD', message: 'Please upload a .zip file' },
  });

  // No version should be recorded after the failed upload.
  const after = await getProject(app, project.id);
  expect(after.versions).toHaveLength(0);
});

test('activating a version sets it as the active version', async () => {
  const project = await createProject(app);
  await uploadVersion(app, project.id, '<html>v1</html>');
  await uploadVersion(app, project.id, '<html>v2</html>');
  const [, second] = (await getProject(app, project.id)).versions;

  const res = await app.request(
    `/api/projects/${project.id}/versions/${second.id}/activate`,
    { method: 'PUT' }
  );
  expect(res.status).toBe(200);

  const after = await getProject(app, project.id);
  expect(after.activeVersionId).toBe(second.id);
});

test('deleting the active version promotes a replacement', async () => {
  const project = await createProject(app);
  await uploadVersion(app, project.id, '<html>v1</html>');
  await uploadVersion(app, project.id, '<html>v2</html>');
  const [first] = (await getProject(app, project.id)).versions;

  const res = await app.request(
    `/api/projects/${project.id}/versions/${first.id}`,
    { method: 'DELETE' }
  );
  expect(res.status).toBe(200);

  const after = await getProject(app, project.id);
  expect(after.versions).toHaveLength(1);
  expect(after.activeVersionId).toBe(after.versions[0].id);
});

test('serves the active version via /deploy/:slug/', async () => {
  const project = await createProject(app, 'demo-app');
  await uploadVersion(app, project.id, '<html><body>deployed</body></html>');

  const res = await app.request('/deploy/demo-app/');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(await res.text()).toBe('<html><body>deployed</body></html>');
});

test('returns 404 for a missing path when SPA mode is off', async () => {
  const project = await createProject(app, 'demo-app');
  await uploadVersion(app, project.id);

  const res = await app.request('/deploy/demo-app/missing.txt');
  expect(res.status).toBe(404);
});

test('falls back to index.html for a missing path when SPA mode is on', async () => {
  const project = await createProject(app, 'demo-app');
  await uploadVersion(app, project.id, '<html><body>spa</body></html>');
  await app.request(`/api/projects/${project.id}/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spaMode: true, routingType: 'path' }),
  });

  const res = await app.request('/deploy/demo-app/some/deep/route');
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('<html><body>spa</body></html>');
});

test('returns 404 for an unknown deploy slug', async () => {
  const res = await app.request('/deploy/unknown-slug/');
  expect(res.status).toBe(404);
});

test('does not add security headers to API or deploy responses', async () => {
  const apiRes = await app.request('/api/projects');
  expect(apiRes.headers.get('x-frame-options')).toBeNull();

  const deployRes = await app.request('/deploy/unknown-slug/');
  expect(deployRes.headers.get('x-frame-options')).toBeNull();
});

test('adds security headers to management UI responses', async () => {
  const res = await app.request('/');
  expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
});

test('records project and version events in history', async () => {
  const project = await createProject(app);
  await uploadVersion(app, project.id);

  const res = await app.request('/api/history?limit=10');
  const events = await res.json();
  expect(events.map((e: { action: string }) => e.action)).toEqual([
    'version.upload',
    'project.create',
  ]);
});

test('cleans up and returns 500 when zip extraction fails', async () => {
  const project = await createProject(app);
  const form = new FormData();
  form.append('file', new File(['this is not a zip'], 'broken.zip'));
  form.append('versionDesc', 'bad');

  const res = await app.request(`/api/projects/${project.id}/versions`, {
    method: 'POST',
    body: form,
  });
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({
    error: {
      code: 'FILE_PROCESSING_FAILED',
      message: 'File processing failed: Zip extraction failed',
    },
  });

  // The failed version must not be recorded.
  const after = await getProject(app, project.id);
  expect(after.versions).toHaveLength(0);
});
