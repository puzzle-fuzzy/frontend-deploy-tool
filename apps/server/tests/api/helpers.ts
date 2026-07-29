import { createApp } from '../../src/app';

/**
 * Shared auth fixture for API tests: a deterministic admin account + session
 * secret so tests can log in and forward the session cookie.
 */
export const ADMIN_EMAIL = 'admin@test.local';
export const ADMIN_PASSWORD = 'test-password';
const SESSION_SECRET = 'test-session-secret';

/** Anything with a Hono-style `request` method (avoids Hono's invariant Env). */
interface RequestApp {
  request: (
    path: string,
    options?: RequestInit
  ) => Response | Promise<Response>;
}

export interface TmpDirs {
  databaseFile?: string;
  dataFile: string;
  storageDir: string;
  publicDir: string;
  maxUploadRequestSize?: number;
}

export function createAuthApp(dirs: TmpDirs) {
  return createApp({
    ...dirs,
    adminEmail: ADMIN_EMAIL,
    adminPassword: ADMIN_PASSWORD,
    sessionSecret: SESSION_SECRET,
    secureCookies: false,
    registrationEnabled: true,
  });
}

/** Logs in as the seeded admin and returns the bearer token. */
export async function adminToken(app: RequestApp): Promise<string> {
  return loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD);
}

/** Legacy alias used by older tests that still call the cookie-style helper name. */
export async function adminCookie(app: RequestApp): Promise<string> {
  return adminToken(app);
}

/** Logs in as any user and returns the bearer token. */
export async function loginAs(
  app: RequestApp,
  email: string,
  password: string
): Promise<string> {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error(`login as ${email} did not return a token`);
  return body.token;
}

/** Adds the bearer token to a request init, preserving existing headers. */
export function withBearer(
  init: RequestInit | undefined,
  token: string
): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return { ...init, headers };
}

/** Legacy alias used by older tests that still call the cookie-style helper. */
export function withCookie(
  init: RequestInit | undefined,
  token: string
): RequestInit {
  return withBearer(init, token);
}
