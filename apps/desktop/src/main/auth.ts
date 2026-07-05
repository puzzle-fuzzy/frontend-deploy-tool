import type { SafeUser } from '@deploykit/shared';
import type { Session } from 'electron';
import { ServerError, serverRequest } from './serverRequest';

let desktopToken: string | null = null;

export function setDesktopAuthToken(token: string | null): void {
  desktopToken = token;
}

function getDesktopToken(): string | null {
  return desktopToken;
}

async function requestWithToken<T>(
  ses: Session,
  origin: string,
  opts: { method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; path: string; body?: unknown }
): Promise<T> {
  const token = getDesktopToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const r = await serverRequest<T>(ses, origin, {
    ...opts,
    headers,
  });
  return r.data;
}

export async function getMe(
  ses: Session,
  origin: string
): Promise<SafeUser | null> {
  try {
    const user = await requestWithToken<SafeUser>(ses, origin, {
      method: 'GET',
      path: '/api/me',
    });
    return user;
  } catch (e) {
    if (e instanceof ServerError && e.status === 401) return null;
    throw e;
  }
}

export async function login(
  ses: Session,
  origin: string,
  email: string,
  password: string
): Promise<SafeUser> {
  const r = await serverRequest<{ user: SafeUser; token?: string }>(ses, origin, {
    method: 'POST',
    path: '/api/auth/login',
    body: { email, password },
  });
  if (r.data.token) {
    setDesktopAuthToken(r.data.token);
  }
  return r.data.user;
}

export async function register(
  ses: Session,
  origin: string,
  input: { name: string; email: string; password: string }
): Promise<SafeUser> {
  const r = await serverRequest<{ user: SafeUser; token?: string }>(ses, origin, {
    method: 'POST',
    path: '/api/auth/register',
    body: input,
  });
  if (r.data.token) {
    setDesktopAuthToken(r.data.token);
  }
  return r.data.user;
}

export async function logout(ses: Session, origin: string): Promise<void> {
  setDesktopAuthToken(null);
  await serverRequest(ses, origin, {
    method: 'POST',
    path: '/api/auth/logout',
  });
}

export async function validateServer(
  ses: Session,
  origin: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    // 401 = reachable & needs login → valid. A logged-in me is also fine.
    await getMe(ses, origin);
    return { ok: true };
  } catch (e) {
    const reason =
      e instanceof Error ? e.message : 'Could not reach the server';
    return { ok: false, reason };
  }
}
