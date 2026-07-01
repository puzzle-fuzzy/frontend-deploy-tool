import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project } from '@deploykit/shared';
import { adminCookie, createAuthApp, withCookie } from './helpers';

let app: ReturnType<typeof createAuthApp>;
let cookie: string;
let tempDir: string;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'deploykit-contract-'));
  app = createAuthApp({
    dataFile: join(tempDir, 'data.json'),
    storageDir: join(tempDir, 'storage'),
    publicDir: join(tempDir, 'public'),
  });
  cookie = await adminCookie(app);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** Forwards the admin session cookie on an API request. */
function req(path: string, init?: RequestInit): Promise<Response> {
  return Promise.resolve(app.request(path, withCookie(init, cookie)));
}

async function createProject(slug = 'demo-app'): Promise<Project> {
  const res = await req('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Demo', slug, description: 'demo' }),
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function uploadVersion(
  projectId: string,
  content = '<html><body>hello</body></html>',
  fileName = 'index.html'
): Promise<Response> {
  const form = new FormData();
  form.append('folderFiles', new File([content], fileName));
  form.append('versionDesc', 'build');
  return req(`/api/projects/${projectId}/versions`, {
    method: 'POST',
    body: form,
  });
}

async function getProject(projectId: string): Promise<Project> {
  const res = await req(`/api/projects/${projectId}/versions`);
  return res.json();
}

/** Publishes a version (explicit go-live). Uploads no longer auto-publish. */
async function activateVersion(
  projectId: string,
  versionId: string
): Promise<void> {
  const res = await req(
    `/api/projects/${projectId}/versions/${versionId}/activate`,
    { method: 'PUT' }
  );
  expect(res.status).toBe(200);
}

async function publishVersion(
  projectId: string,
  versionId: string
): Promise<void> {
  const res = await req(
    `/api/projects/${projectId}/versions/${versionId}/publish`,
    { method: 'POST' }
  );
  expect(res.status).toBe(200);
}

async function rollbackVersion(
  projectId: string,
  versionId: string
): Promise<void> {
  const res = await req(
    `/api/projects/${projectId}/versions/${versionId}/rollback`,
    { method: 'POST' }
  );
  expect(res.status).toBe(200);
}

/** Resolves the version id from an upload response. */
async function versionIdOf(res: Response): Promise<string> {
  const body = await res.json();
  return body.version.id;
}

test('rejects API access without a session cookie', async () => {
  const res = await app.request('/api/projects');
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({
    error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
  });
});

test('login returns the safe user (no password hash) and sets a cookie', async () => {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'admin@test.local',
      password: 'test-password',
    }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('set-cookie')).toContain('deploykit_session=');
  const body = await res.json();
  expect(body.user).not.toHaveProperty('passwordHash');
  expect(body.user.email).toBe('admin@test.local');
  expect(body.user.role).toBe('admin');
});

test('rejects login with the wrong password', async () => {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@test.local', password: 'nope' }),
  });
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({
    error: {
      code: 'INVALID_CREDENTIALS',
      message: 'Invalid email or password',
    },
  });
});

test('GET /api/me returns the authenticated user', async () => {
  const res = await req('/api/me');
  expect(res.status).toBe(200);
  const user = await res.json();
  expect(user.email).toBe('admin@test.local');
  expect(user).not.toHaveProperty('passwordHash');
});

test('creates a project with default settings and lists it', async () => {
  const project = await createProject();
  expect(project).toMatchObject({
    name: 'Demo',
    slug: 'demo-app',
    versions: [],
    settings: { spaMode: false, routingType: 'path' },
  });
  expect(project.id).toBeTruthy();

  const list = await (await req('/api/projects')).json();
  expect(list).toHaveLength(1);
  expect(list[0].id).toBe(project.id);
});

test('rejects project creation for a missing name', async () => {
  const res = await req('/api/projects', {
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
  const res = await req('/api/projects', {
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
  await createProject('demo-app');
  const res = await req('/api/projects', {
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
  const res = await req('/api/projects/!!!/versions/some-id/activate', {
    method: 'PUT',
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: { code: 'INVALID_PARAMS', message: 'Invalid id parameter' },
  });
});

test('updates settings through the dedicated settings endpoint', async () => {
  const project = await createProject();
  const res = await req(`/api/projects/${project.id}/settings`, {
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

test('updates project info (name, slug, description) through the project endpoint', async () => {
  const project = await createProject();
  const res = await req(`/api/projects/${project.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Renamed',
      slug: 'renamed-slug',
      description: 'a new description',
    }),
  });
  expect(res.status).toBe(200);
  const updated = await res.json();
  expect(updated.name).toBe('Renamed');
  expect(updated.slug).toBe('renamed-slug');
  expect(updated.description).toBe('a new description');
});

test('rejects a duplicate slug with 400 PROJECT_SLUG_TAKEN', async () => {
  await createProject('first');
  const second = await createProject('second');
  const res = await req(`/api/projects/${second.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: 'first' }),
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: { code: 'PROJECT_SLUG_TAKEN', message: 'Slug already exists' },
  });
});

test('returns 404 when updating info for an unknown project', async () => {
  const res = await req('/api/projects/unknown', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x' }),
  });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({
    error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' },
  });
});

test('rejects an invalid settings payload with 400', async () => {
  const project = await createProject();
  const res = await req(`/api/projects/${project.id}/settings`, {
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
  const res = await req('/api/projects/unknown/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spaMode: true, routingType: 'hash' }),
  });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({
    error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' },
  });
});

test('uploads a folder version as preview-only (not auto-published)', async () => {
  const project = await createProject();
  const res = await uploadVersion(project.id);
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.version.id).toBeTruthy();
  expect(body.version.name).toBe(body.version.id.slice(0, 7));

  const after = await getProject(project.id);
  expect(after.versions).toHaveLength(1);
  // Upload ≠ go-live: the version exists but is not production yet.
  expect(after.activeVersionId).toBeNull();

  // Upload metadata is recorded for the version.
  const version = after.versions[0];
  expect(version.sourceType).toBe('folder');
  expect(version.fileCount).toBe(1);
  expect(version.size).toBeGreaterThan(0);
  expect(version.status).toBe('preview');
  expect(version.publishedAt).toBeNull();
  expect(version.publishedBy).toBeNull();
  expect(version.checksum).toMatch(/^[a-f0-9]{64}$/);
});

test('rejects a non-zip single file upload with 400', async () => {
  const project = await createProject();
  const form = new FormData();
  form.append('file', new File(['nope'], 'not-a-zip.txt'));
  form.append('versionDesc', 'bad');
  const res = await req(`/api/projects/${project.id}/versions`, {
    method: 'POST',
    body: form,
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: { code: 'INVALID_UPLOAD', message: 'Please upload a .zip file' },
  });

  const after = await getProject(project.id);
  expect(after.versions).toHaveLength(0);
});

test('rejects a folder upload containing a dangerous file with 400', async () => {
  const project = await createProject();
  const form = new FormData();
  form.append('folderFiles', new File(['SECRET=1'], '.env'));
  form.append('folderFiles', new File(['<html></html>'], 'index.html'));
  form.append('versionDesc', 'leaky');
  const res = await req(`/api/projects/${project.id}/versions`, {
    method: 'POST',
    body: form,
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: { code: 'UNSAFE_ENTRY' } });
  expect((await getProject(project.id)).versions).toHaveLength(0);
});

test('rejects a folder upload path traversal with 400', async () => {
  const project = await createProject();
  const form = new FormData();
  form.append('folderFiles', new File(['x'], 'evil.txt'), '../../evil.txt');
  form.append('folderFiles', new File(['<html></html>'], 'index.html'));
  form.append('versionDesc', 'traversal');
  const res = await req(`/api/projects/${project.id}/versions`, {
    method: 'POST',
    body: form,
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: { code: 'UNSAFE_ENTRY' } });
  expect((await getProject(project.id)).versions).toHaveLength(0);
});

test('rejects an upload without index.html with 400', async () => {
  const project = await createProject();
  const form = new FormData();
  form.append('folderFiles', new File(['body { color: red; }'], 'style.css'));
  form.append('versionDesc', 'no html');
  const res = await req(`/api/projects/${project.id}/versions`, {
    method: 'POST',
    body: form,
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({
    error: { code: 'MISSING_INDEX_HTML' },
  });
  expect((await getProject(project.id)).versions).toHaveLength(0);
});

test('activating a version sets it as the active version', async () => {
  const project = await createProject();
  await uploadVersion(project.id, '<html>v1</html>');
  await uploadVersion(project.id, '<html>v2</html>');
  const [, second] = (await getProject(project.id)).versions;

  const res = await req(
    `/api/projects/${project.id}/versions/${second.id}/activate`,
    { method: 'PUT' }
  );
  expect(res.status).toBe(200);

  const after = await getProject(project.id);
  expect(after.activeVersionId).toBe(second.id);
});

test('publishing a version marks it production and demotes the previous version', async () => {
  const project = await createProject();
  await uploadVersion(project.id, '<html>v1</html>');
  await uploadVersion(project.id, '<html>v2</html>');
  const [first, second] = (await getProject(project.id)).versions;

  await publishVersion(project.id, first.id);
  await publishVersion(project.id, second.id);

  const after = await getProject(project.id);
  const firstAfter = after.versions.find((v) => v.id === first.id);
  const secondAfter = after.versions.find((v) => v.id === second.id);
  expect(after.activeVersionId).toBe(second.id);
  expect(firstAfter?.status).toBe('preview');
  expect(secondAfter?.status).toBe('production');
  expect(secondAfter?.publishedAt).toBeTruthy();
  expect(secondAfter?.publishedBy).toBeTruthy();

  const events = await (await req('/api/history?limit=10')).json();
  const publishEvents = events.filter(
    (e: { action: string }) => e.action === 'version.publish'
  );
  expect(publishEvents).toHaveLength(2);
  expect(publishEvents[0].metadata).toEqual({
    previousActiveVersionId: first.id,
  });
});

test('rollback is a distinct publish-like action in history', async () => {
  const project = await createProject();
  await uploadVersion(project.id, '<html>v1</html>');
  await uploadVersion(project.id, '<html>v2</html>');
  const [first, second] = (await getProject(project.id)).versions;
  await publishVersion(project.id, first.id);
  await publishVersion(project.id, second.id);

  await rollbackVersion(project.id, first.id);

  const after = await getProject(project.id);
  expect(after.activeVersionId).toBe(first.id);
  expect(after.versions.find((v) => v.id === first.id)?.status).toBe(
    'production'
  );
  expect(after.versions.find((v) => v.id === second.id)?.status).toBe(
    'preview'
  );

  const events = await (await req('/api/history?limit=10')).json();
  const rollback = events.find(
    (e: { action: string }) => e.action === 'version.rollback'
  );
  expect(rollback.versionId).toBe(first.id);
  expect(rollback.metadata).toEqual({
    previousActiveVersionId: second.id,
  });
});

test('deleting the active version promotes a replacement', async () => {
  const project = await createProject();
  await uploadVersion(project.id, '<html>v1</html>');
  await uploadVersion(project.id, '<html>v2</html>');
  const [first] = (await getProject(project.id)).versions;
  await activateVersion(project.id, first.id);

  const res = await req(`/api/projects/${project.id}/versions/${first.id}`, {
    method: 'DELETE',
  });
  expect(res.status).toBe(200);

  const after = await getProject(project.id);
  expect(after.versions).toHaveLength(1);
  expect(after.activeVersionId).toBe(after.versions[0].id);
  expect(after.versions[0].status).toBe('production');
});

test('serves the active version via /deploy/:slug/', async () => {
  const project = await createProject('demo-app');
  const upload = await uploadVersion(
    project.id,
    '<html><body>deployed</body></html>'
  );
  await activateVersion(project.id, await versionIdOf(upload));

  const res = await app.request('/deploy/demo-app/');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(await res.text()).toBe('<html><body>deployed</body></html>');
});

test('returns 404 for a missing path when SPA mode is off', async () => {
  const project = await createProject('demo-app');
  const upload = await uploadVersion(project.id);
  await activateVersion(project.id, await versionIdOf(upload));

  const res = await app.request('/deploy/demo-app/missing.txt');
  expect(res.status).toBe(404);
});

test('falls back to index.html for a missing path when SPA mode is on', async () => {
  const project = await createProject('demo-app');
  const upload = await uploadVersion(
    project.id,
    '<html><body>spa</body></html>'
  );
  await activateVersion(project.id, await versionIdOf(upload));
  await req(`/api/projects/${project.id}/settings`, {
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
  const apiRes = await req('/api/projects');
  expect(apiRes.headers.get('x-frame-options')).toBeNull();

  const deployRes = await app.request('/deploy/unknown-slug/');
  expect(deployRes.headers.get('x-frame-options')).toBeNull();
});

test('adds security headers to management UI responses', async () => {
  const res = await app.request('/');
  expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
});

test('records project and version events in history with the actor id', async () => {
  const project = await createProject();
  await uploadVersion(project.id);

  const res = await req('/api/history?limit=10');
  const events = await res.json();
  expect(events.map((e: { action: string }) => e.action)).toEqual([
    'version.upload',
    'project.create',
  ]);
  // Every event records the admin actor.
  for (const event of events) {
    expect(event.actorId).toBe(events[0].actorId);
    expect(event.actorId).toBeTruthy();
  }
});

test('records structured metadata on upload and activate history events', async () => {
  const project = await createProject();
  await uploadVersion(project.id, '<html>v1</html>');
  await uploadVersion(project.id, '<html>v2</html>');
  const [, second] = (await getProject(project.id)).versions;

  await req(`/api/projects/${project.id}/versions/${second.id}/activate`, {
    method: 'PUT',
  });

  const events = await (await req('/api/history?limit=10')).json();
  const upload = events.find(
    (e: { action: string }) => e.action === 'version.upload'
  );
  const activate = events.find(
    (e: { action: string }) => e.action === 'version.activate'
  );

  expect(upload.metadata).toMatchObject({
    sourceType: 'folder',
    fileCount: 1,
  });
  expect(upload.metadata.size).toBeGreaterThan(0);
  // Upload ≠ go-live: the first publish has no prior active version.
  expect(activate.metadata).toEqual({
    previousActiveVersionId: null,
  });
});

test('records project update and settings update events', async () => {
  const project = await createProject();

  await req(`/api/projects/${project.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Renamed', description: 'new desc' }),
  });
  await req(`/api/projects/${project.id}/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spaMode: true, routingType: 'hash' }),
  });

  const events = await (await req('/api/history?limit=10')).json();
  expect(events.map((e: { action: string }) => e.action)).toEqual([
    'project.update_settings',
    'project.update',
    'project.create',
  ]);
  expect(events[1].metadata).toEqual({
    changes: {
      name: { from: 'Demo', to: 'Renamed' },
      description: { from: 'demo', to: 'new desc' },
    },
  });
});

test('does not record history for project or settings no-op updates', async () => {
  const project = await createProject();

  const projectRes = await req(`/api/projects/${project.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: project.name,
      slug: project.slug,
      description: project.description,
    }),
  });
  expect(projectRes.status).toBe(200);
  expect((await projectRes.json()).updatedAt).toBe(project.updatedAt);

  const settingsRes = await req(`/api/projects/${project.id}/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(project.settings),
  });
  expect(settingsRes.status).toBe(200);
  expect((await settingsRes.json()).updatedAt).toBe(project.updatedAt);

  const events = await (await req('/api/history?limit=10')).json();
  expect(events.map((e: { action: string }) => e.action)).toEqual([
    'project.create',
  ]);
});

test('lists history for a single project', async () => {
  const first = await createProject('first');
  const second = await createProject('second');
  await uploadVersion(first.id, '<html>first</html>');
  await uploadVersion(second.id, '<html>second</html>');

  const res = await req(`/api/projects/${first.id}/history?limit=10`);
  expect(res.status).toBe(200);
  const events = await res.json();
  expect(events.map((e: { projectId: string }) => e.projectId)).toEqual([
    first.id,
    first.id,
  ]);
});

test('cleans up and returns 500 when zip extraction fails', async () => {
  const project = await createProject();
  const form = new FormData();
  form.append('file', new File(['this is not a zip'], 'broken.zip'));
  form.append('versionDesc', 'bad');

  const res = await req(`/api/projects/${project.id}/versions`, {
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

  const after = await getProject(project.id);
  expect(after.versions).toHaveLength(0);
});
