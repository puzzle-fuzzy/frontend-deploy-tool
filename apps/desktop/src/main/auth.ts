import type { SafeUser } from '@deploykit/shared';
import type { BrowserWindow, Session } from 'electron';

export async function getMe(
  _session: Session,
  _origin: string
): Promise<SafeUser | null> {
  throw new Error('auth.getMe not implemented yet (Task 7)');
}

export async function login(
  _session: Session,
  _origin: string,
  _email: string,
  _password: string
): Promise<SafeUser> {
  throw new Error('auth.login not implemented yet (Task 7)');
}

export async function logout(
  _session: Session,
  _origin: string
): Promise<void> {
  throw new Error('auth.logout not implemented yet (Task 7)');
}

export async function validateServer(
  _session: Session,
  _origin: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  throw new Error('auth.validateServer not implemented yet (Task 7)');
}

export async function loginViaWeb(
  _session: Session,
  _origin: string,
  _parent: BrowserWindow
): Promise<SafeUser | null> {
  throw new Error('auth.loginViaWeb not implemented yet (Task 7)');
}
