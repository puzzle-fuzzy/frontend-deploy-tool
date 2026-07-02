import { randomBytes } from 'node:crypto';

/**
 * One-time authorization codes for the desktop "sign in via web" flow.
 *
 * Deliberately a sibling of (not imported by) `api.ts`: this module uses
 * `node:crypto`, and `api.ts` must stay Node-free so its exported `ApiApp` type
 * is consumable by the web build. `api.ts` consumes this through the injected
 * `DesktopAuthCodeStore` interface (declared in `api.ts`).
 */

export interface DesktopAuthEntry {
  userId: string;
  redirectUri: string;
}

export interface DesktopAuthCodeStore {
  issueCode(userId: string, redirectUri: string): string;
  consumeCode(code: string): DesktopAuthEntry | null;
}

interface Entry {
  userId: string;
  redirectUri: string;
  expiresAt: number;
}

/**
 * Creates an in-memory, single-use code store. Codes are 32 random bytes
 * (base64url) and expire after `ttlMs` (default 60s). `now` is injectable so
 * tests can advance time without waiting.
 */
export function createDesktopAuthCodeStore(opts?: {
  ttlMs?: number;
  now?: () => number;
}): DesktopAuthCodeStore {
  const ttlMs = opts?.ttlMs ?? 60_000;
  const now = opts?.now ?? Date.now;
  const codes = new Map<string, Entry>();

  // Best-effort expiry sweep; unref so it never keeps the process alive.
  const sweep = setInterval(() => {
    for (const [k, v] of codes) {
      if (now() > v.expiresAt) codes.delete(k);
    }
  }, 60_000);
  sweep.unref?.();

  return {
    issueCode(userId, redirectUri) {
      const code = randomBytes(32).toString('base64url');
      codes.set(code, {
        userId,
        redirectUri,
        expiresAt: now() + ttlMs,
      });
      return code;
    },
    consumeCode(code) {
      const entry = codes.get(code);
      if (!entry) return null;
      // Single-use: delete before returning, even on a successful consume.
      codes.delete(code);
      if (now() > entry.expiresAt) return null;
      return { userId: entry.userId, redirectUri: entry.redirectUri };
    },
  };
}
