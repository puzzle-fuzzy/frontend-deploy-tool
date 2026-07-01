import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmSync, unlinkSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testClient } from 'hono/testing';
import { createApp } from '../../src/app';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'deploykit-audit-api-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function createTestClient() {
  return testClient(createTestApp());
}

function createTestApp() {
  return createApp({
    dataFile: join(tempDir, 'data.json'),
    storageDir: join(tempDir, 'storage'),
    publicDir: join(tempDir, 'public'),
  });
}

async function createProject(client: ReturnType<typeof createTestClient>) {
  const res = await client.api.projects.$post({
    json: {
      name: 'Demo App',
      slug: 'demo-app',
      description: 'Demo deployment',
    },
  });

  expect(res.status).toBe(201);
  return res.json();
}

async function uploadVersion(
  client: ReturnType<typeof createTestClient>,
  projectId: string,
  content = validHtml(),
  fileName = 'index.html'
) {
  const res = await client.api.projects[':id'].versions.$post({
    param: { id: projectId },
    form: {
      folderFiles: new File([content], fileName),
      versionDesc: 'first build',
    },
  } as { param: { id: string }; form: unknown });

  expect(res.status).toBe(201);
  return (await res.json()).version;
}

function validHtml(): string {
  return `
    <!doctype html>
    <html lang="en">
      <head>
        <title>Demo</title>
        <meta name="description" content="Demo description.">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="canonical" href="https://example.com/">
        <meta property="og:title" content="Demo">
        <meta property="og:description" content="Demo description">
        <meta property="og:image" content="https://example.com/og.png">
        <meta name="twitter:card" content="summary_large_image">
      </head>
      <body>
        <h1>Demo</h1>
        <a href="/docs">Docs</a>
      </body>
    </html>
  `;
}

test('audits an uploaded version', async () => {
  const client = createTestClient();
  const project = await createProject(client);
  const version = await uploadVersion(client, project.id);

  const res = await client.api.projects[':id'].versions[
    ':versionId'
  ].audit.$post({
    param: { id: project.id, versionId: version.id },
    json: { profile: 'demo' },
  });

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    projectId: project.id,
    versionId: version.id,
    profile: 'demo',
    status: 'passed',
    score: 100,
    checks: [],
  });
});

test('defaults an omitted profile to production-web', async () => {
  const client = createTestClient();
  const project = await createProject(client);
  const version = await uploadVersion(client, project.id);

  const res = await client.api.projects[':id'].versions[
    ':versionId'
  ].audit.$post({
    param: { id: project.id, versionId: version.id },
    json: {},
  });

  expect(res.status).toBe(200);
  expect((await res.json()).profile).toBe('production-web');
});

test('defaults a missing body to production-web', async () => {
  const app = createTestApp();
  const client = testClient(app);
  const project = await createProject(client);
  const version = await uploadVersion(client, project.id);

  const res = await app.request(
    `/api/projects/${project.id}/versions/${version.id}/audit`,
    { method: 'POST' }
  );

  expect(res.status).toBe(200);
  expect((await res.json()).profile).toBe('production-web');
});

test('returns 400 INVALID_REQUEST for malformed JSON', async () => {
  const app = createTestApp();
  const client = testClient(app);
  const project = await createProject(client);
  const version = await uploadVersion(client, project.id);

  const res = await app.request(
    `/api/projects/${project.id}/versions/${version.id}/audit`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    }
  );

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: {
      code: 'INVALID_REQUEST',
      message: 'Invalid request payload',
    },
  });
});

test('returns 404 VERSION_NOT_FOUND for an unknown version', async () => {
  const client = createTestClient();
  const project = await createProject(client);

  const res = await client.api.projects[':id'].versions[
    ':versionId'
  ].audit.$post({
    param: { id: project.id, versionId: 'missing-version' },
    json: {},
  });

  expect(res.status).toBe(404);
  const body: unknown = await res.json();
  expect(body).toEqual({
    error: { code: 'VERSION_NOT_FOUND', message: 'Version not found' },
  });
});

test('returns 400 AUDIT_PROFILE_INVALID for an invalid profile', async () => {
  const client = createTestClient();
  const project = await createProject(client);
  const version = await uploadVersion(client, project.id);

  const res = await client.api.projects[':id'].versions[
    ':versionId'
  ].audit.$post({
    param: { id: project.id, versionId: version.id },
    json: { profile: 'invalid-profile' as never },
  });

  expect(res.status).toBe(400);
  const body: unknown = await res.json();
  expect(body).toEqual({
    error: {
      code: 'AUDIT_PROFILE_INVALID',
      message: 'Audit profile is invalid',
    },
  });
});

test('returns 404 AUDIT_ENTRY_NOT_FOUND when index.html is missing', async () => {
  const client = createTestClient();
  const project = await createProject(client);
  const version = await uploadVersion(client, project.id);
  unlinkSync(join(tempDir, 'storage', project.id, version.id, 'index.html'));

  const res = await client.api.projects[':id'].versions[
    ':versionId'
  ].audit.$post({
    param: { id: project.id, versionId: version.id },
    json: {},
  });

  expect(res.status).toBe(404);
  const body: unknown = await res.json();
  expect(body).toEqual({
    error: {
      code: 'AUDIT_ENTRY_NOT_FOUND',
      message: 'Audit entry index.html not found',
    },
  });
});
