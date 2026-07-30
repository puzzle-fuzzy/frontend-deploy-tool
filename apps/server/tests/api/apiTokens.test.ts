import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteApiTokenRepository } from '../../src/repositories/apiTokenRepository';
import { createSqliteProjectRepository } from '../../src/repositories/sqliteProjectRepository';
import { createApiTokenService } from '../../src/services/apiTokenService';
import { createProjectService } from '../../src/services/projectService';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  createAuthApp,
  loginAs,
  withBearer,
} from './helpers';

let tempDir: string;
let app: ReturnType<typeof createAuthApp>;
let adminToken: string;
let ownerToken: string;
let memberToken: string;
let viewerToken: string;
let projectId: string;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'deploykit-api-tokens-'));
  const now = '2026-07-31T00:00:00.000Z';
  writeFileSync(
    join(tempDir, 'data.json'),
    JSON.stringify({
      schemaVersion: 8,
      projects: [],
      users: [
        user('admin-id', ADMIN_EMAIL, ADMIN_PASSWORD, 'admin', now),
        user('owner-id', 'owner@test.local', 'owner-pass', 'developer', now),
        user('member-id', 'member@test.local', 'member-pass', 'developer', now),
        user('viewer-id', 'viewer@test.local', 'viewer-pass', 'viewer', now),
      ],
      history: [],
      artifactAudits: [],
      artifactAuditJobs: [],
    })
  );
  app = createAuthApp({
    dataFile: join(tempDir, 'data.json'),
    storageDir: join(tempDir, 'storage'),
    publicDir: join(tempDir, 'public'),
  });
  [adminToken, ownerToken, memberToken, viewerToken] = await Promise.all([
    loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD),
    loginAs(app, 'owner@test.local', 'owner-pass'),
    loginAs(app, 'member@test.local', 'member-pass'),
    loginAs(app, 'viewer@test.local', 'viewer-pass'),
  ]);

  const created = await app.request(
    '/api/projects',
    jsonRequest(
      'POST',
      {
        name: 'Signal Desk',
        slug: 'signal-desk',
        description: '',
      },
      ownerToken
    )
  );
  expect(created.status).toBe(201);
  projectId = (await created.json()).id as string;
  for (const [email, role] of [
    ['member@test.local', 'member'],
    ['viewer@test.local', 'owner'],
  ] as const) {
    const added = await app.request(
      `/api/projects/${projectId}/members`,
      jsonRequest('POST', { email, role }, ownerToken)
    );
    expect(added.status).toBe(200);
  }
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test('owner and admin manage redacted project tokens while members cannot', async () => {
  const path = `/api/projects/${projectId}/api-tokens`;
  const forbiddenMember = await app.request(
    path,
    jsonRequest('POST', { unexpected: true }, memberToken)
  );
  expect(forbiddenMember.status).toBe(403);
  const forbiddenViewer = await app.request(
    path,
    jsonRequest('POST', { name: 'Nope' }, viewerToken)
  );
  expect(forbiddenViewer.status).toBe(403);
  expect((await app.request(path)).status).toBe(401);

  const ownerCreate = await app.request(
    path,
    jsonRequest('POST', { name: 'GitHub Actions' }, ownerToken)
  );
  expect(ownerCreate.status).toBe(201);
  expect(ownerCreate.headers.get('Cache-Control')).toBe('no-store');
  const ownerIssued = (await ownerCreate.json()) as {
    token: { id: string; prefix: string; scopes: string[] };
    plaintextToken: string;
  };
  expect(ownerIssued.plaintextToken).toMatch(
    /^dpk_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/
  );
  expect(ownerIssued.token.prefix).toMatch(/^dpk_v1\.[A-Za-z0-9_-]+$/);
  expect(ownerIssued.token.scopes).toEqual(['preview:upload']);

  const adminCreate = await app.request(
    path,
    jsonRequest('POST', { name: 'Admin automation' }, adminToken)
  );
  expect(adminCreate.status).toBe(201);

  const listed = await app.request(
    path,
    withBearer({ method: 'GET' }, ownerToken)
  );
  expect(listed.status).toBe(200);
  const listBody = await listed.json();
  expect(listBody.tokens).toHaveLength(2);
  expect(JSON.stringify(listBody)).not.toContain(ownerIssued.plaintextToken);
  expect(JSON.stringify(listBody)).not.toContain('secretDigest');

  const apiTokenCannotManage = await app.request(
    path,
    withBearer({ method: 'GET' }, ownerIssued.plaintextToken)
  );
  expect(apiTokenCannotManage.status).toBe(401);
});

test('rotation returns a replacement once and revocation is idempotent', async () => {
  const path = `/api/projects/${projectId}/api-tokens`;
  const created = await app.request(
    path,
    jsonRequest('POST', { name: 'Release bot' }, ownerToken)
  );
  const first = (await created.json()) as {
    token: { id: string };
    plaintextToken: string;
  };

  const rotated = await app.request(
    `${path}/${first.token.id}/rotate`,
    jsonRequest('POST', { overlapSeconds: 0 }, ownerToken)
  );
  expect(rotated.status).toBe(201);
  expect(rotated.headers.get('Cache-Control')).toBe('no-store');
  const replacement = (await rotated.json()) as {
    token: { id: string };
    plaintextToken: string;
  };
  expect(replacement.token.id).not.toBe(first.token.id);
  expect(replacement.plaintextToken).not.toBe(first.plaintextToken);

  const secondRotation = await app.request(
    `${path}/${first.token.id}/rotate`,
    jsonRequest('POST', {}, ownerToken)
  );
  expect(secondRotation.status).toBe(404);
  expect((await secondRotation.json()).error.code).toBe('API_TOKEN_NOT_FOUND');

  const firstRevoke = await app.request(
    `${path}/${replacement.token.id}`,
    withBearer({ method: 'DELETE' }, ownerToken)
  );
  expect(firstRevoke.status).toBe(200);
  const revokedAt = (await firstRevoke.json()).token.revokedAt as string;
  expect(revokedAt).toBeString();
  const secondRevoke = await app.request(
    `${path}/${replacement.token.id}`,
    withBearer({ method: 'DELETE' }, ownerToken)
  );
  expect(secondRevoke.status).toBe(200);
  expect((await secondRevoke.json()).token.revokedAt).toBe(revokedAt);

  const events = await app.request(
    `${path}/security-events`,
    withBearer({ method: 'GET' }, ownerToken)
  );
  expect(events.status).toBe(200);
  const eventBody = await events.json();
  expect(
    eventBody.events.map((event: { action: string }) => event.action)
  ).toEqual(['api_token.revoke', 'api_token.rotate', 'api_token.create']);
  expect(JSON.stringify(eventBody)).not.toContain(first.plaintextToken);
  expect(JSON.stringify(eventBody)).not.toContain(replacement.plaintextToken);
});

test('invalid lifecycle inputs stay stable and do not create credentials', async () => {
  const path = `/api/projects/${projectId}/api-tokens`;
  for (const body of [
    {},
    { name: '' },
    { name: 'CI', expiresAt: 'not-a-date' },
    { name: 'CI', unexpected: true },
  ]) {
    const response = await app.request(
      path,
      jsonRequest('POST', body, ownerToken)
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('INVALID_REQUEST');
  }
  const listed = await app.request(
    path,
    withBearer({ method: 'GET' }, ownerToken)
  );
  expect((await listed.json()).tokens).toEqual([]);
});

test('SQLite composition persists only digest and redacted metadata across restart', async () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const dirs = {
    databaseFile,
    dataFile: join(tempDir, 'sqlite-legacy.json'),
    storageDir: join(tempDir, 'sqlite-storage'),
    publicDir: join(tempDir, 'sqlite-public'),
  };
  const firstApp = createAuthApp(dirs);
  const firstAdminToken = await loginAs(firstApp, ADMIN_EMAIL, ADMIN_PASSWORD);
  const projectResponse = await firstApp.request(
    '/api/projects',
    jsonRequest(
      'POST',
      { name: 'Persistent', slug: 'persistent', description: '' },
      firstAdminToken
    )
  );
  expect(projectResponse.status).toBe(201);
  const persistentProjectId = (await projectResponse.json()).id as string;
  const created = await firstApp.request(
    `/api/projects/${persistentProjectId}/api-tokens`,
    jsonRequest('POST', { name: 'Persistent CI' }, firstAdminToken)
  );
  expect(created.status).toBe(201);
  const issued = (await created.json()) as {
    plaintextToken: string;
    token: { prefix: string };
  };

  const database = new Database(databaseFile);
  const stored = database
    .query<{ secret_digest: string; prefix: string }, []>(
      'SELECT secret_digest, prefix FROM project_api_tokens'
    )
    .get();
  database.close();
  expect(stored?.secret_digest).toMatch(/^[0-9a-f]{64}$/);
  expect(stored?.prefix).toBe(issued.token.prefix);
  expect(stored?.secret_digest).not.toContain(issued.plaintextToken);

  const restartedApp = createAuthApp(dirs);
  const restartedAdminToken = await loginAs(
    restartedApp,
    ADMIN_EMAIL,
    ADMIN_PASSWORD
  );
  const listed = await restartedApp.request(
    `/api/projects/${persistentProjectId}/api-tokens`,
    withBearer({ method: 'GET' }, restartedAdminToken)
  );
  expect(listed.status).toBe(200);
  const body = await listed.json();
  expect(body.tokens).toHaveLength(1);
  expect(body.tokens[0].prefix).toBe(issued.token.prefix);
  expect(JSON.stringify(body)).not.toContain(issued.plaintextToken);
  expect(JSON.stringify(body)).not.toContain('secretDigest');

  const restartedProjectService = createProjectService(
    createSqliteProjectRepository({
      databaseFile,
      legacyDataFile: dirs.dataFile,
    })
  );
  const restartedTokenService = createApiTokenService({
    repository: createSqliteApiTokenRepository(databaseFile),
    projectService: restartedProjectService,
  });
  expect(
    restartedTokenService.authenticate(
      issued.plaintextToken,
      persistentProjectId,
      'preview:upload'
    )
  ).toMatchObject({
    projectId: persistentProjectId,
    prefix: issued.token.prefix,
    scopes: ['preview:upload'],
  });
});

function user(
  id: string,
  email: string,
  password: string,
  role: 'admin' | 'developer' | 'viewer',
  timestamp: string
) {
  return {
    id,
    name: id,
    email,
    passwordHash: Bun.password.hashSync(password),
    role,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function jsonRequest(
  method: string,
  body: unknown,
  token: string
): RequestInit {
  return withBearer(
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    token
  );
}
