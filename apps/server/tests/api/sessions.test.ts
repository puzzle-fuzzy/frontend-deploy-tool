import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app';
import { verifySessionToken } from '../../src/middleware/session';
import { createAuthApp, withBearer } from './helpers';

const SESSION_SECRET = 'test-session-secret';
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'deploykit-sessions-api-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function login(
  app: ReturnType<typeof createAuthApp>,
  email = 'admin@test.local',
  password = 'test-password'
): Promise<string> {
  const response = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  expect(response.status).toBe(200);
  return (await response.json()).token;
}

test('logout revokes the current bearer session immediately', async () => {
  const app = createAuthApp({
    dataFile: join(tempDir, 'data.json'),
    storageDir: join(tempDir, 'storage'),
    publicDir: join(tempDir, 'public'),
  });
  const token = await login(app);

  const logout = await app.request(
    '/api/auth/logout',
    withBearer({ method: 'POST' }, token)
  );
  expect(logout.status).toBe(200);

  const me = await app.request('/api/me', withBearer(undefined, token));
  expect(me.status).toBe(401);
});

test('requires an Origin for cookie writes but preserves bearer compatibility', async () => {
  const app = createApp({
    environment: 'test',
    dataFile: join(tempDir, 'data.json'),
    storageDir: join(tempDir, 'storage'),
    publicDir: join(tempDir, 'public'),
    managementBaseURL: 'http://console.example.test',
    deployBaseURL: 'http://deploy.example.test',
    adminEmail: 'admin@test.local',
    adminPassword: 'test-password',
    sessionSecret: SESSION_SECRET,
    secureCookies: false,
    registrationEnabled: false,
  });
  const loginResponse = await app.request(
    'http://console.example.test/api/auth/login',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@test.local',
        password: 'test-password',
      }),
    }
  );
  const token = (await loginResponse.json()).token as string;
  const cookie = loginResponse.headers.get('Set-Cookie')?.split(';', 1)[0];
  if (!cookie) throw new Error('login did not set a session cookie');

  const cookieWithoutOrigin = await app.request(
    'http://console.example.test/api/auth/logout-all',
    {
      method: 'POST',
      headers: { Cookie: cookie },
    }
  );
  expect(cookieWithoutOrigin.status).toBe(403);
  expect((await cookieWithoutOrigin.json()).error.code).toBe(
    'CSRF_VALIDATION_FAILED'
  );

  const bearerWithoutOrigin = await app.request(
    'http://console.example.test/api/auth/logout-all',
    withBearer({ method: 'POST' }, token)
  );
  expect(bearerWithoutOrigin.status).toBe(200);

  const sameOriginLogin = await app.request(
    'http://console.example.test/api/auth/login',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@test.local',
        password: 'test-password',
      }),
    }
  );
  const sameOriginCookie = sameOriginLogin.headers
    .get('Set-Cookie')
    ?.split(';', 1)[0];
  if (!sameOriginCookie) throw new Error('login did not set a session cookie');
  const sameOriginWrite = await app.request(
    'http://console.example.test/api/auth/logout-all',
    {
      method: 'POST',
      headers: {
        Cookie: sameOriginCookie,
        Origin: 'http://console.example.test',
      },
    }
  );
  expect(sameOriginWrite.status).toBe(200);

  const fetchMetadataLogin = await app.request(
    'http://console.example.test/api/auth/login',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@test.local',
        password: 'test-password',
      }),
    }
  );
  const fetchMetadataCookie = fetchMetadataLogin.headers
    .get('Set-Cookie')
    ?.split(';', 1)[0];
  if (!fetchMetadataCookie) {
    throw new Error('login did not set a session cookie');
  }
  const rejectedFetchMetadata = await app.request(
    'http://console.example.test/api/auth/logout-all',
    {
      method: 'POST',
      headers: {
        Cookie: fetchMetadataCookie,
        Origin: 'http://console.example.test',
        'Sec-Fetch-Site': 'same-site',
      },
    }
  );
  expect(rejectedFetchMetadata.status).toBe(403);
  expect((await rejectedFetchMetadata.json()).error.code).toBe(
    'CSRF_VALIDATION_FAILED'
  );
});

test('a user can list and revoke their own sessions but not another user session', async () => {
  const app = createAuthApp({
    dataFile: join(tempDir, 'data.json'),
    storageDir: join(tempDir, 'storage'),
    publicDir: join(tempDir, 'public'),
  });
  const first = await login(app);
  const second = await login(app);
  const register = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Alice',
      email: 'alice@example.com',
      password: 'password123',
    }),
  });
  const other = (await register.json()).token as string;
  const otherSessionId = verifySessionToken(other, SESSION_SECRET)?.jti;
  expect(otherSessionId).toBeTruthy();

  const listed = await app.request(
    '/api/auth/sessions',
    withBearer(undefined, first)
  );
  const sessions = (await listed.json()).sessions as Array<{
    id: string;
    current: boolean;
  }>;
  expect(sessions).toHaveLength(2);
  const secondSessionId = verifySessionToken(second, SESSION_SECRET)?.jti;
  expect(secondSessionId).toBeTruthy();

  const revoked = await app.request(
    `/api/auth/sessions/${secondSessionId}`,
    withBearer({ method: 'DELETE' }, first)
  );
  expect(revoked.status).toBe(200);
  expect(
    (await app.request('/api/me', withBearer(undefined, second))).status
  ).toBe(401);

  const forbidden = await app.request(
    `/api/auth/sessions/${otherSessionId}`,
    withBearer({ method: 'DELETE' }, first)
  );
  expect(forbidden.status).toBe(404);
  expect(
    (await app.request('/api/me', withBearer(undefined, other))).status
  ).toBe(200);
});

test('SQLite sessions survive an application restart and logout-all revokes them', async () => {
  const dirs = {
    databaseFile: join(tempDir, 'deploykit.sqlite'),
    dataFile: join(tempDir, 'data.json'),
    storageDir: join(tempDir, 'storage'),
    publicDir: join(tempDir, 'public'),
  };
  const firstApp = createAuthApp(dirs);
  const first = await login(firstApp);
  const second = await login(firstApp);

  const restarted = createAuthApp(dirs);
  expect(
    (await restarted.request('/api/me', withBearer(undefined, first))).status
  ).toBe(200);

  const logoutAll = await restarted.request(
    '/api/auth/logout-all',
    withBearer({ method: 'POST' }, first)
  );
  expect(logoutAll.status).toBe(200);
  expect((await logoutAll.json()).revoked).toBe(2);
  expect(
    (await restarted.request('/api/me', withBearer(undefined, first))).status
  ).toBe(401);
  expect(
    (await restarted.request('/api/me', withBearer(undefined, second))).status
  ).toBe(401);
});
