import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adminCookie, createAuthApp, withCookie } from './helpers';

const LOOPBACK = 'http://127.0.0.1:59123/callback';
const SESSION_COOKIE = 'deploykit_session';

let tempDir: string;
let cookie: string;
let app: ReturnType<typeof createAuthApp>;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'deploykit-desktop-auth-'));
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

function req(path: string, init?: RequestInit): Promise<Response> {
  return Promise.resolve(app.request(path, withCookie(init, cookie)));
}

function jsonBody(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

test('authorize requires a session (401 without cookie)', async () => {
  const res = await app.request(
    '/api/desktop/authorize',
    jsonBody({ redirectUri: LOOPBACK })
  );
  expect(res.status).toBe(401);
});

test('authorize issues a one-time code for a loopback redirect', async () => {
  const res = await req(
    '/api/desktop/authorize',
    jsonBody({ redirectUri: LOOPBACK })
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.code).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  expect(body.redirectUri).toBe(LOOPBACK);
});

const NON_LOOPBACK = [
  'https://127.0.0.1:5/', // wrong scheme
  'http://192.168.0.1:5/', // non-loopback host
  'http://evil.com:5/', // external host
  'http://127.0.0.1/', // no port
  'http://user:pass@127.0.0.1:5/', // userinfo
  'not-a-url',
];

for (const bad of NON_LOOPBACK) {
  test(`authorize rejects non-loopback redirect: ${bad}`, async () => {
    const res = await req(
      '/api/desktop/authorize',
      jsonBody({ redirectUri: bad })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_REQUEST');
  });
}

test('exchange turns a valid code into a real session token (no cookie needed)', async () => {
  const authRes = await req(
    '/api/desktop/authorize',
    jsonBody({ redirectUri: LOOPBACK })
  );
  const { code } = await authRes.json();

  // exchange is public (no session cookie)
  const exRes = await app.request('/api/desktop/exchange', jsonBody({ code }));
  expect(exRes.status).toBe(200);
  const { token, user } = await exRes.json();
  expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/); // payload.signature
  expect(user.email).toBe('admin@test.local');

  // the token is a real session token: /api/me with it works
  const meRes = await app.request('/api/me', {
    headers: { Cookie: `${SESSION_COOKIE}=${token}` },
  });
  expect(meRes.status).toBe(200);
  expect((await meRes.json()).id).toBe(user.id);
});

test('exchange is single-use (replay returns DESKTOP_AUTH_CODE_INVALID)', async () => {
  const { code } = await (
    await req('/api/desktop/authorize', jsonBody({ redirectUri: LOOPBACK }))
  ).json();

  const first = await app.request('/api/desktop/exchange', jsonBody({ code }));
  expect(first.status).toBe(200);

  const second = await app.request('/api/desktop/exchange', jsonBody({ code }));
  expect(second.status).toBe(400);
  expect((await second.json()).error.code).toBe('DESKTOP_AUTH_CODE_INVALID');
});

test('exchange rejects an unknown code', async () => {
  const res = await app.request(
    '/api/desktop/exchange',
    jsonBody({ code: 'bogus' })
  );
  expect(res.status).toBe(400);
  expect((await res.json()).error.code).toBe('DESKTOP_AUTH_CODE_INVALID');
});
