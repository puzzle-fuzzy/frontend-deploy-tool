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
  dataFile: string;
  storageDir: string;
  publicDir: string;
}

export function createAuthApp(dirs: TmpDirs) {
  return createApp({
    ...dirs,
    adminEmail: ADMIN_EMAIL,
    adminPassword: ADMIN_PASSWORD,
    sessionSecret: SESSION_SECRET,
    secureCookies: false,
  });
}

/** Logs in as the seeded admin and returns the `name=value` cookie pair. */
export async function adminCookie(app: RequestApp): Promise<string> {
  return loginAs(app, ADMIN_EMAIL, ADMIN_PASSWORD);
}

/** Logs in as any user and returns the `name=value` cookie pair. */
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
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error(`login as ${email} did not set a cookie`);
  return setCookie.split(';')[0];
}

/** Adds the session cookie to a request init, preserving existing headers. */
export function withCookie(
  init: RequestInit | undefined,
  cookie: string
): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('Cookie', cookie);
  return { ...init, headers };
}
