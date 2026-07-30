import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adminCookie, createAuthApp, withCookie } from './helpers';

let tempDir: string;
let cookie: string;
let request: (path: string, init?: RequestInit) => Promise<Response>;
let rawRequest: (path: string, init?: RequestInit) => Promise<Response>;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'deploykit-test-'));
  const app = createAuthApp({
    dataFile: join(tempDir, 'data.json'),
    storageDir: join(tempDir, 'storage'),
    publicDir: join(tempDir, 'public'),
  });
  cookie = await adminCookie(app);
  rawRequest = (path, init) => Promise.resolve(app.request(path, init));
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
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedActiveVersionId: null }),
    }
  );
  expect(failed.status).toBe(404);

  const list = await request(`/api/projects/${project.id}/versions`);
  const currentProject = await list.json();
  // Upload ≠ go-live and the failed activate must not set an active version.
  expect(currentProject.activeVersionId).toBeNull();
});

test('upload fails closed without writing through a symlinked staging root', async () => {
  const project = await createProject();
  const storageDir = join(tempDir, 'storage');
  const externalDir = join(tempDir, 'external-staging');
  mkdirSync(externalDir, { recursive: true });
  writeFileSync(join(externalDir, 'marker.txt'), 'outside');
  symlinkSync(externalDir, join(storageDir, '.staging'));
  const projectBefore = await (
    await request(`/api/projects/${project.id}/versions`)
  ).json();
  const historyBefore = await (
    await request(`/api/projects/${project.id}/history?limit=20`)
  ).json();
  const form = new FormData();
  form.append('folderFiles', new File(['<html>unsafe</html>'], 'index.html'));
  form.append('versionDesc', 'must fail closed');

  const upload = await request(`/api/projects/${project.id}/versions`, {
    method: 'POST',
    body: form,
  });

  expect(upload.status).toBe(503);
  expect(await upload.json()).toEqual({
    error: {
      code: 'STORAGE_CONTROL_CONFLICT',
      message: 'Artifact storage control paths are unsafe',
    },
  });
  expect(readdirSync(externalDir)).toEqual(['marker.txt']);
  expect(readFileSync(join(externalDir, 'marker.txt'), 'utf8')).toBe('outside');
  expect(
    await (await request(`/api/projects/${project.id}/versions`)).json()
  ).toEqual(projectBefore);
  expect(
    await (await request(`/api/projects/${project.id}/history?limit=20`)).json()
  ).toEqual(historyBefore);
});

test('exposes public liveness and repository readiness endpoints', async () => {
  const live = await rawRequest('/health/live');
  expect(live.status).toBe(204);
  expect(live.headers.get('X-Request-Id')).toBeTruthy();

  const ready = await rawRequest('/health/ready');
  expect(ready.status).toBe(200);
  expect(await ready.json()).toEqual({ status: 'ok' });
});

test('propagates a valid request id across success and error responses', async () => {
  const requestId = 'deploykit-test-request-01';
  const ready = await rawRequest('/health/ready', {
    headers: { 'X-Request-Id': requestId },
  });
  expect(ready.headers.get('X-Request-Id')).toBe(requestId);

  const unauthorized = await rawRequest('/api/projects', {
    headers: { 'X-Request-Id': requestId },
  });
  expect(unauthorized.status).toBe(401);
  expect(unauthorized.headers.get('X-Request-Id')).toBe(requestId);
});

test('readiness fails when the metadata repository cannot be opened', async () => {
  const databaseFile = join(tempDir, 'broken.sqlite');
  const brokenApp = createAuthApp({
    databaseFile,
    dataFile: join(tempDir, 'broken.json'),
    storageDir: join(tempDir, 'broken-storage'),
    publicDir: join(tempDir, 'broken-public'),
  });
  rmSync(databaseFile, { force: true });
  rmSync(`${databaseFile}-wal`, { force: true });
  rmSync(`${databaseFile}-shm`, { force: true });
  writeFileSync(databaseFile, 'not a sqlite database');

  const response = await brokenApp.request('/health/ready');
  expect(response.status).toBe(500);
  expect((await response.json()).error.code).toBe('INTERNAL_ERROR');
  expect(response.headers.get('X-Request-Id')).toBeTruthy();
});

test('cleans expired interrupted staging uploads while composing the app', () => {
  const recoveryRoot = mkdtempSync(join(tmpdir(), 'deploykit-recovery-'));
  const stagingDir = join(recoveryRoot, 'storage', '.staging', 'interrupted');
  mkdirSync(stagingDir, { recursive: true });
  writeFileSync(join(stagingDir, 'index.html'), 'partial');
  const expired = new Date(Date.now() - 25 * 60 * 60 * 1000);
  utimesSync(stagingDir, expired, expired);

  try {
    createAuthApp({
      dataFile: join(recoveryRoot, 'data.json'),
      storageDir: join(recoveryRoot, 'storage'),
      publicDir: join(recoveryRoot, 'public'),
    });

    expect(existsSync(join(recoveryRoot, 'storage', '.staging'))).toBe(false);
  } finally {
    rmSync(recoveryRoot, { recursive: true, force: true });
  }
});
