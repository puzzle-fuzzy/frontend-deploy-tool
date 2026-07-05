import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app';
import { createAuthApp } from './helpers';

let tempDir: string;
let app: ReturnType<typeof createAuthApp>;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'deploykit-register-'));
  app = createAuthApp({
    dataFile: join(tempDir, 'data.json'),
    storageDir: join(tempDir, 'storage'),
    publicDir: join(tempDir, 'public'),
  });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function jsonPost(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

const GOOD = {
  name: 'Alice',
  email: 'alice@example.com',
  password: 'password123',
};

test('registers a new viewer account and issues a bearer token', async () => {
  const res = await app.request('/api/auth/register', jsonPost(GOOD));
  expect(res.status).toBe(200);

  const body = await res.json();
  expect(body.user.email).toBe('alice@example.com');
  expect(body.user.role).toBe('viewer');
  expect(body.user.name).toBe('Alice');
  expect(body.user).not.toHaveProperty('passwordHash');
  expect(body.token).toBeTruthy();

  const meRes = await app.request('/api/me', {
    headers: { Authorization: `Bearer ${body.token}` },
  });
  expect(meRes.status).toBe(200);
  expect((await meRes.json()).id).toBe(body.user.id);
});

test('the new account can sign in via /api/auth/login', async () => {
  await app.request('/api/auth/register', jsonPost(GOOD));

  const loginRes = await app.request(
    '/api/auth/login',
    jsonPost({ email: GOOD.email, password: GOOD.password })
  );
  expect(loginRes.status).toBe(200);
  const body = await loginRes.json();
  expect(body.token).toBeTruthy();
});

test('rejects a duplicate email (case-insensitive)', async () => {
  await app.request('/api/auth/register', jsonPost(GOOD));
  const res = await app.request(
    '/api/auth/register',
    jsonPost({ ...GOOD, email: 'ALICE@example.com', name: 'Other' })
  );
  expect(res.status).toBe(400);
  expect((await res.json()).error.code).toBe('EMAIL_ALREADY_EXISTS');
});

test('rejects the seeded admin email as a duplicate', async () => {
  const res = await app.request(
    '/api/auth/register',
    jsonPost({ ...GOOD, email: 'admin@test.local' })
  );
  expect(res.status).toBe(400);
  expect((await res.json()).error.code).toBe('EMAIL_ALREADY_EXISTS');
});

const INVALID_INPUTS = [
  {
    label: 'empty name',
    body: { name: '', email: 'a@b.co', password: 'password123' },
  },
  {
    label: 'bad email',
    body: { name: 'A', email: 'not-an-email', password: 'password123' },
  },
  {
    label: 'short password',
    body: { name: 'A', email: 'a@b.co', password: 'short' },
  },
];

for (const { label, body } of INVALID_INPUTS) {
  test(`rejects invalid input: ${label}`, async () => {
    const res = await app.request('/api/auth/register', jsonPost(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_REQUEST');
  });
}

test('rejects registration when registrationEnabled is false', async () => {
  const closedApp = createApp({
    dataFile: join(tempDir, 'closed.json'),
    storageDir: join(tempDir, 'closed-storage'),
    publicDir: join(tempDir, 'closed-public'),
    adminEmail: 'admin@test.local',
    adminPassword: 'test-password',
    sessionSecret: 'test-session-secret',
    secureCookies: false,
    registrationEnabled: false,
  });
  const res = await closedApp.request('/api/auth/register', jsonPost(GOOD));
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe('REGISTRATION_DISABLED');
});

test('register is reachable without a session (public)', async () => {
  // No cookie; a missing/invalid body yields 400, never 401.
  const res = await app.request('/api/auth/register', jsonPost({}));
  expect(res.status).toBe(400);
  expect((await res.json()).error.code).toBe('INVALID_REQUEST');
});
