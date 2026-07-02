import type { SafeUser } from '@deploykit/shared';
import type { Session } from 'electron';
import { ServerError, serverRequest } from './serverRequest';

export async function getMe(
  ses: Session,
  origin: string
): Promise<SafeUser | null> {
  try {
    const r = await serverRequest<SafeUser>(ses, origin, {
      method: 'GET',
      path: '/api/me',
    });
    return r.data;
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
  await serverRequest(ses, origin, {
    method: 'POST',
    path: '/api/auth/login',
    body: { email, password },
  });
  // Server Set-Cookie is captured by the partition session automatically.
  const me = await getMe(ses, origin);
  if (!me) throw new Error('Login succeeded but /api/me returned no user');
  return me;
}

export async function register(
  ses: Session,
  origin: string,
  input: { name: string; email: string; password: string }
): Promise<SafeUser> {
  await serverRequest(ses, origin, {
    method: 'POST',
    path: '/api/auth/register',
    body: input,
  });
  const me = await getMe(ses, origin);
  if (!me) {
    throw new Error('Registration succeeded but /api/me returned no user');
  }
  return me;
}

export async function logout(ses: Session, origin: string): Promise<void> {
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
