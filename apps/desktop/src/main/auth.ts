import type { SafeUser } from '@deploykit/shared';
import { BrowserWindow, type Session } from 'electron';
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

export async function loginViaWeb(
  ses: Session,
  partition: string,
  origin: string,
  parent: BrowserWindow
): Promise<SafeUser | null> {
  return new Promise((resolve) => {
    let settled = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    const finish = async () => {
      if (settled) return;
      const me = await getMe(ses, origin);
      if (me) {
        settled = true;
        ses.cookies.off('changed', onCookie);
        if (poll) clearInterval(poll);
        child.close();
        resolve(me);
      }
    };

    const onCookie = () => void finish();
    ses.cookies.on('changed', onCookie);

    // Fallback poll (~1s) in case the changed event misses.
    poll = setInterval(() => void finish(), 1000);

    const child = new BrowserWindow({
      parent,
      modal: true,
      width: 480,
      height: 640,
      webPreferences: {
        // Share the partition so the deployed SPA's login sets the same cookie
        // the main window's net requests read.
        partition,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    child.on('closed', () => {
      if (!settled) {
        settled = true;
        ses.cookies.off('changed', onCookie);
        if (poll) clearInterval(poll);
        resolve(null); // user cancelled
      }
    });

    child.loadURL(origin);
  });
}
