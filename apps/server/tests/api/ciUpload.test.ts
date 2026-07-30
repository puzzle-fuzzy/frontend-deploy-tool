import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app';
import { ADMIN_EMAIL, ADMIN_PASSWORD, withBearer } from './helpers';

const DESKTOP_REDIRECT_URI = 'http://127.0.0.1:59123/callback';
const SESSION_SECRET = 'ci-upload-test-session-secret';
const API_TOKEN_INVALID = 'API_TOKEN_INVALID';
const IDEMPOTENCY_CONFLICT = 'IDEMPOTENCY_CONFLICT';

type TestApp = ReturnType<typeof createApp>;

interface FixturePaths {
  databaseFile: string;
  dataFile: string;
  storageDir: string;
  publicDir: string;
}

interface BrowserSession {
  token: string;
  cookie: string;
}

interface ApiCredential {
  id: string;
  plaintextToken: string;
}

interface CiUploadBody {
  version: {
    id: string;
    name: string;
  };
  replayed: boolean;
}

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
  };
}

interface ProjectStorageState {
  activeVersionId: string | null;
  versionCount: number;
  idempotencyCount: number;
}

interface CiRequestOptions {
  bearer?: string;
  cookie?: string;
  idempotencyKey?: string;
  description?: string;
  content?: string;
  fileName?: string;
}

let tempDir: string;
let paths: FixturePaths;
let app: TestApp;
let browserSession: BrowserSession;
let projectId: string;
let credential: ApiCredential;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'deploykit-ci-upload-'));
  paths = {
    databaseFile: join(tempDir, 'deploykit.sqlite'),
    dataFile: join(tempDir, 'legacy-data.json'),
    storageDir: join(tempDir, 'storage'),
    publicDir: join(tempDir, 'public'),
  };
  app = createTestApp(paths);
  browserSession = await loginBrowserSession(app);
  projectId = await createProject(app, browserSession.token, {
    name: 'CI upload fixture',
    slug: 'ci-upload-fixture',
  });
  credential = await issueApiCredential(
    app,
    browserSession.token,
    projectId,
    'Primary CI credential'
  );
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test('requires a non-empty Idempotency-Key before creating upload state', async () => {
  const missing = await requestCiUpload(app, projectId, {
    bearer: credential.plaintextToken,
  });
  await expectError(missing, 400, 'INVALID_IDEMPOTENCY_KEY');

  const blank = await requestCiUpload(app, projectId, {
    bearer: credential.plaintextToken,
    idempotencyKey: '   ',
  });
  await expectError(blank, 400, 'INVALID_IDEMPOTENCY_KEY');

  expect(readProjectStorageState(projectId)).toEqual({
    activeVersionId: null,
    versionCount: 0,
    idempotencyCount: 0,
  });
  expect(countRegularFiles(paths.storageDir)).toBe(0);
});

test('terminates unknown CI paths and methods before the session API', async () => {
  const wrongMethod = await app.request(
    `/api/ci/projects/${projectId}/versions`
  );
  expect(wrongMethod.status).toBe(404);

  const unknownPath = await app.request(
    `/api/ci/projects/${projectId}/unknown`,
    { method: 'POST' }
  );
  expect(unknownPath.status).toBe(404);

  expect(readProjectStorageState(projectId)).toEqual({
    activeVersionId: null,
    versionCount: 0,
    idempotencyCount: 0,
  });
  expect(countRegularFiles(paths.storageDir)).toBe(0);
});

test('replays the same normalized request and conflicts on content or description changes', async () => {
  const activeVersionId = await uploadAndActivateManagementVersion(
    app,
    browserSession.token,
    projectId
  );
  const idempotencyKey = 'release-build-42';

  const first = await requestCiUpload(app, projectId, {
    bearer: credential.plaintextToken,
    idempotencyKey,
    description: '  release candidate  ',
  });
  expect(first.status).toBe(201);
  expect(first.headers.get('Idempotency-Replayed')).toBe('false');
  const firstBody = await expectCiUploadBody(first, false);
  expect(firstBody.version.id).not.toBe(activeVersionId);
  expect(readProjectStorageState(projectId)).toEqual({
    activeVersionId,
    versionCount: 2,
    idempotencyCount: 1,
  });

  const replay = await requestCiUpload(app, projectId, {
    bearer: credential.plaintextToken,
    idempotencyKey,
    description: 'release candidate',
  });
  expect(replay.status).toBe(200);
  expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
  const replayBody = await expectCiUploadBody(replay, true);
  expect(replayBody.version).toEqual(firstBody.version);

  const contentConflict = await requestCiUpload(app, projectId, {
    bearer: credential.plaintextToken,
    idempotencyKey,
    description: 'release candidate',
    content: '<html><body>changed artifact</body></html>',
  });
  await expectError(contentConflict, 409, IDEMPOTENCY_CONFLICT);

  const descriptionConflict = await requestCiUpload(app, projectId, {
    bearer: credential.plaintextToken,
    idempotencyKey,
    description: 'different normalized description',
  });
  await expectError(descriptionConflict, 409, IDEMPOTENCY_CONFLICT);

  expect(readProjectStorageState(projectId)).toEqual({
    activeVersionId,
    versionCount: 2,
    idempotencyCount: 1,
  });
});

test('serializes concurrent duplicate requests into one version and one replay', async () => {
  const idempotencyKey = 'concurrent-build-42';
  const [left, right] = await Promise.all([
    requestCiUpload(app, projectId, {
      bearer: credential.plaintextToken,
      idempotencyKey,
    }),
    requestCiUpload(app, projectId, {
      bearer: credential.plaintextToken,
      idempotencyKey,
    }),
  ]);

  expect([left.status, right.status].sort()).toEqual([200, 201]);
  const leftBody = (await left.json()) as CiUploadBody;
  const rightBody = (await right.json()) as CiUploadBody;
  expect(leftBody.version).toEqual(rightBody.version);
  expect([leftBody.replayed, rightBody.replayed].sort()).toEqual([false, true]);
  expect(readProjectStorageState(projectId)).toEqual({
    activeVersionId: null,
    versionCount: 1,
    idempotencyCount: 1,
  });
});

test('scopes an idempotency key to its API token as well as its project', async () => {
  const secondCredential = await issueApiCredential(
    app,
    browserSession.token,
    projectId,
    'Secondary CI credential'
  );
  const idempotencyKey = 'shared-build-number';

  const first = await requestCiUpload(app, projectId, {
    bearer: credential.plaintextToken,
    idempotencyKey,
  });
  expect(first.status).toBe(201);
  const firstBody = await expectCiUploadBody(first, false);

  const second = await requestCiUpload(app, projectId, {
    bearer: secondCredential.plaintextToken,
    idempotencyKey,
  });
  expect(second.status).toBe(201);
  const secondBody = await expectCiUploadBody(second, false);
  expect(secondBody.version.id).not.toBe(firstBody.version.id);

  const secondProjectId = await createProject(app, browserSession.token, {
    name: 'Second idempotency project',
    slug: 'second-idempotency-project',
  });
  const projectCredential = await issueApiCredential(
    app,
    browserSession.token,
    secondProjectId,
    'Other project credential'
  );
  const otherProject = await requestCiUpload(app, secondProjectId, {
    bearer: projectCredential.plaintextToken,
    idempotencyKey,
  });
  expect(otherProject.status).toBe(201);
  await expectCiUploadBody(otherProject, false);

  expect(readProjectStorageState(projectId)).toEqual({
    activeVersionId: null,
    versionCount: 2,
    idempotencyCount: 2,
  });
  expect(readProjectStorageState(secondProjectId)).toEqual({
    activeVersionId: null,
    versionCount: 1,
    idempotencyCount: 1,
  });
});

test('returns one generic failure for every public token state', async () => {
  const secondProjectId = await createProject(app, browserSession.token, {
    name: 'Other project',
    slug: 'other-project',
  });
  const idempotencyKey = 'invalid-auth-build';
  const expiredCredential = await issueApiCredential(
    app,
    browserSession.token,
    projectId,
    'Expired credential'
  );
  const unscopedCredential = await issueApiCredential(
    app,
    browserSession.token,
    projectId,
    'Unscoped credential'
  );
  const database = new Database(paths.databaseFile);
  try {
    database
      .query('UPDATE project_api_tokens SET expires_at = ? WHERE id = ?')
      .run('2000-01-01T00:00:00.000Z', expiredCredential.id);
    database
      .query('UPDATE project_api_tokens SET scopes_json = ? WHERE id = ?')
      .run('[]', unscopedCredential.id);
  } finally {
    database.close();
  }
  const responses = [
    await requestCiUpload(app, projectId, { idempotencyKey }),
    await requestCiUpload(app, projectId, {
      bearer: `dpk_v1.unknown.${'A'.repeat(43)}`,
      idempotencyKey,
    }),
    await requestCiUpload(app, secondProjectId, {
      bearer: credential.plaintextToken,
      idempotencyKey,
    }),
    await requestCiUpload(app, projectId, {
      bearer: expiredCredential.plaintextToken,
      idempotencyKey,
    }),
    await requestCiUpload(app, projectId, {
      bearer: unscopedCredential.plaintextToken,
      idempotencyKey,
    }),
  ];

  await revokeApiCredential(
    app,
    browserSession.token,
    projectId,
    credential.id
  );
  responses.push(
    await requestCiUpload(app, projectId, {
      bearer: credential.plaintextToken,
      idempotencyKey,
    })
  );

  const bodies: ErrorEnvelope[] = [];
  for (const response of responses) {
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="deploykit-ci", error="invalid_token"'
    );
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = (await response.json()) as ErrorEnvelope;
    expect(body.error.code).toBe(API_TOKEN_INVALID);
    bodies.push(body);
  }
  for (const body of bodies.slice(1)) {
    expect(body).toEqual(bodies[0]);
  }

  expect(readProjectStorageState(projectId)).toEqual({
    activeVersionId: null,
    versionCount: 0,
    idempotencyCount: 0,
  });
  expect(readProjectStorageState(secondProjectId)).toEqual({
    activeVersionId: null,
    versionCount: 0,
    idempotencyCount: 0,
  });
  expect(countRegularFiles(paths.storageDir)).toBe(0);
});

test('does not accept a browser cookie or a real desktop bearer session', async () => {
  const browserResponse = await requestCiUpload(app, projectId, {
    cookie: browserSession.cookie,
    idempotencyKey: 'browser-session-build',
  });
  const browserBody = await expectError(
    browserResponse,
    401,
    API_TOKEN_INVALID
  );

  const desktopToken = await issueDesktopSession(app, browserSession.token);
  const desktopResponse = await requestCiUpload(app, projectId, {
    bearer: desktopToken,
    idempotencyKey: 'desktop-session-build',
  });
  const desktopBody = await expectError(
    desktopResponse,
    401,
    API_TOKEN_INVALID
  );
  expect(desktopBody).toEqual(browserBody);

  expect(readProjectStorageState(projectId)).toEqual({
    activeVersionId: null,
    versionCount: 0,
    idempotencyCount: 0,
  });
  expect(countRegularFiles(paths.storageDir)).toBe(0);
});

test('replays the stored version snapshot after a SQLite application restart', async () => {
  const idempotencyKey = 'restart-build-42';
  const first = await requestCiUpload(app, projectId, {
    bearer: credential.plaintextToken,
    idempotencyKey,
    description: 'restart-safe build',
  });
  expect(first.status).toBe(201);
  const firstBody = await expectCiUploadBody(first, false);

  const restartedApp = createTestApp(paths);
  const replay = await requestCiUpload(restartedApp, projectId, {
    bearer: credential.plaintextToken,
    idempotencyKey,
    description: 'restart-safe build',
  });
  expect(replay.status).toBe(200);
  const replayBody = await expectCiUploadBody(replay, true);
  expect(replayBody.version).toEqual(firstBody.version);

  expect(readProjectStorageState(projectId)).toEqual({
    activeVersionId: null,
    versionCount: 1,
    idempotencyCount: 1,
  });
});

test('checks revocation before replaying an existing idempotency record', async () => {
  const idempotencyKey = 'revoked-replay-build';
  const first = await requestCiUpload(app, projectId, {
    bearer: credential.plaintextToken,
    idempotencyKey,
  });
  expect(first.status).toBe(201);
  await expectCiUploadBody(first, false);
  const storedFiles = countRegularFiles(paths.storageDir);

  await revokeApiCredential(
    app,
    browserSession.token,
    projectId,
    credential.id
  );
  const rejectedReplay = await requestCiUpload(app, projectId, {
    bearer: credential.plaintextToken,
    idempotencyKey,
  });
  await expectError(rejectedReplay, 401, API_TOKEN_INVALID);

  expect(readProjectStorageState(projectId)).toEqual({
    activeVersionId: null,
    versionCount: 1,
    idempotencyCount: 1,
  });
  expect(countRegularFiles(paths.storageDir)).toBe(storedFiles);
});

async function loginBrowserSession(
  targetApp: TestApp
): Promise<BrowserSession> {
  const response = await targetApp.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { token?: string };
  const cookie = response.headers.get('Set-Cookie')?.split(';', 1)[0];
  if (!body.token || !cookie) {
    throw new Error('browser login did not return both session transports');
  }
  return { token: body.token, cookie };
}

function createTestApp(fixturePaths: FixturePaths): TestApp {
  return createApp({
    ...fixturePaths,
    environment: 'test',
    adminEmail: ADMIN_EMAIL,
    adminPassword: ADMIN_PASSWORD,
    sessionSecret: SESSION_SECRET,
    secureCookies: false,
    registrationEnabled: true,
    maxConcurrentUploads: 4,
    maxConcurrentUploadsPerUser: 4,
    maxConcurrentUploadsPerProject: 4,
  });
}

async function createProject(
  targetApp: TestApp,
  sessionToken: string,
  input: { name: string; slug: string }
): Promise<string> {
  const response = await targetApp.request(
    '/api/projects',
    withBearer(
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input, description: '' }),
      },
      sessionToken
    )
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function issueApiCredential(
  targetApp: TestApp,
  sessionToken: string,
  targetProjectId: string,
  name: string
): Promise<ApiCredential> {
  const response = await targetApp.request(
    `/api/projects/${targetProjectId}/api-tokens`,
    withBearer(
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      },
      sessionToken
    )
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as {
    token: { id: string };
    plaintextToken: string;
  };
  return { id: body.token.id, plaintextToken: body.plaintextToken };
}

async function revokeApiCredential(
  targetApp: TestApp,
  sessionToken: string,
  targetProjectId: string,
  tokenId: string
): Promise<void> {
  const response = await targetApp.request(
    `/api/projects/${targetProjectId}/api-tokens/${tokenId}`,
    withBearer({ method: 'DELETE' }, sessionToken)
  );
  expect(response.status).toBe(200);
}

async function issueDesktopSession(
  targetApp: TestApp,
  browserToken: string
): Promise<string> {
  const authorize = await targetApp.request(
    '/api/desktop/authorize',
    withBearer(
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirectUri: DESKTOP_REDIRECT_URI }),
      },
      browserToken
    )
  );
  expect(authorize.status).toBe(200);
  const { code } = (await authorize.json()) as { code: string };

  const exchange = await targetApp.request('/api/desktop/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  expect(exchange.status).toBe(200);
  return ((await exchange.json()) as { token: string }).token;
}

async function uploadAndActivateManagementVersion(
  targetApp: TestApp,
  sessionToken: string,
  targetProjectId: string
): Promise<string> {
  const form = new FormData();
  form.append(
    'folderFiles',
    new File(['<html><body>active baseline</body></html>'], 'index.html')
  );
  form.append('versionDesc', 'active baseline');
  const uploaded = await targetApp.request(
    `/api/projects/${targetProjectId}/versions`,
    withBearer({ method: 'POST', body: form }, sessionToken)
  );
  expect(uploaded.status).toBe(201);
  const versionId = ((await uploaded.json()) as { version: { id: string } })
    .version.id;

  const activated = await targetApp.request(
    `/api/projects/${targetProjectId}/versions/${versionId}/activate`,
    withBearer(
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedActiveVersionId: null }),
      },
      sessionToken
    )
  );
  expect(activated.status).toBe(200);
  return versionId;
}

function requestCiUpload(
  targetApp: TestApp,
  targetProjectId: string,
  options: CiRequestOptions
): Promise<Response> {
  const form = new FormData();
  form.append(
    'folderFiles',
    new File(
      [
        options.content ??
          '<html><body>deterministic CI artifact</body></html>',
      ],
      options.fileName ?? 'index.html',
      { type: 'text/html' }
    )
  );
  form.append('versionDesc', options.description ?? 'CI build');

  const headers = new Headers();
  if (options.bearer !== undefined) {
    headers.set('Authorization', `Bearer ${options.bearer}`);
  }
  if (options.cookie !== undefined) {
    headers.set('Cookie', options.cookie);
  }
  if (options.idempotencyKey !== undefined) {
    headers.set('Idempotency-Key', options.idempotencyKey);
  }
  return Promise.resolve(
    targetApp.request(`/api/ci/projects/${targetProjectId}/versions`, {
      method: 'POST',
      headers,
      body: form,
    })
  );
}

async function expectCiUploadBody(
  response: Response,
  replayed: boolean
): Promise<CiUploadBody> {
  const body = (await response.json()) as CiUploadBody;
  expect(Object.keys(body).sort()).toEqual(['replayed', 'version']);
  expect(Object.keys(body.version).sort()).toEqual(['id', 'name']);
  expect(typeof body.version.id).toBe('string');
  expect(body.version.id.length).toBeGreaterThan(0);
  expect(typeof body.version.name).toBe('string');
  expect(body.version.name.length).toBeGreaterThan(0);
  expect(body.replayed).toBe(replayed);
  return body;
}

async function expectError(
  response: Response,
  status: number,
  code: string
): Promise<ErrorEnvelope> {
  expect(response.status).toBe(status);
  const body = (await response.json()) as ErrorEnvelope;
  expect(body.error.code).toBe(code);
  return body;
}

function readProjectStorageState(targetProjectId: string): ProjectStorageState {
  const database = new Database(paths.databaseFile, { readonly: true });
  try {
    const project = database
      .query<{ active_version_id: string | null }, [string]>(
        'SELECT active_version_id FROM projects WHERE id = ?'
      )
      .get(targetProjectId);
    const versions = database
      .query<{ count: number }, [string]>(
        'SELECT COUNT(*) AS count FROM versions WHERE project_id = ?'
      )
      .get(targetProjectId);
    const idempotencyRecords = database
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count
         FROM ci_idempotency_records
         WHERE project_id = ?`
      )
      .get(targetProjectId);
    if (!project || !versions || !idempotencyRecords) {
      throw new Error('project storage state is unavailable');
    }
    return {
      activeVersionId: project.active_version_id,
      versionCount: versions.count,
      idempotencyCount: idempotencyRecords.count,
    };
  } finally {
    database.close();
  }
}

function countRegularFiles(directory: string): number {
  if (!existsSync(directory)) return 0;
  let count = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      count += countRegularFiles(entryPath);
    } else if (entry.isFile()) {
      count += 1;
    }
  }
  return count;
}
