import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { SessionKind } from '../domain/session';
import type { AppEnv, SessionService } from '../services/contracts';
import type { UserService } from '../services/userService';

/** Cookie name holding the HMAC-signed session token. */
export const SESSION_COOKIE = 'deploykit_session';
/** Session lifetime in seconds (7 days). */
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export interface SessionPayload {
  /** User id. */
  sub: string;
  /** Durable session id checked against the session repository. */
  jti: string;
  kind: SessionKind;
  /** Expiry, unix seconds. */
  exp: number;
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

/** Builds a `payload.signature` token where the signature is HMAC-SHA256. */
export function createSessionToken(
  payload: SessionPayload,
  secret: string
): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url'
  );
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verifies the signature (constant-time) and expiry, returning the payload or
 * `null` for any malformed/tampered/expired token. Never throws.
 */
export function verifySessionToken(
  token: string,
  secret: string
): SessionPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = sign(body, secret);
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8')
    ) as SessionPayload;
    if (
      typeof payload.sub !== 'string' ||
      !payload.sub ||
      typeof payload.jti !== 'string' ||
      !payload.jti ||
      (payload.kind !== 'browser' && payload.kind !== 'desktop') ||
      typeof payload.exp !== 'number' ||
      payload.exp < Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/** Writes the session cookie (HttpOnly, SameSite=Lax, Path=/). */
export function setSessionCookie(
  c: Context,
  token: string,
  secure: boolean
): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

/** Clears the session cookie. */
export function clearSessionCookie(c: Context, secure: boolean): void {
  deleteCookie(c, SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    path: '/',
  });
}

/** Reads the raw session cookie value, if present. */
export function readSessionCookie(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

/** Reads a bearer token from the Authorization header, if present. */
export function readBearerToken(c: Context): string | undefined {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) return undefined;
  return auth.slice('Bearer '.length).trim();
}

/**
 * Reads either a bearer token or the session cookie, verifies it, and loads the
 * matching user into `c.var.user` (or `null`). Never rejects — bad/expired
 * tokens just mean no user, so downstream `requireAuth`/`requireMinRole`
 * decide.
 */
export function createSessionMiddleware(deps: {
  sessionService: SessionService;
  userService: UserService;
}): MiddlewareHandler<AppEnv> {
  const { sessionService, userService } = deps;
  return async (c, next) => {
    const token = readBearerToken(c) ?? readSessionCookie(c);
    const identity = token ? sessionService.authenticate(token) : null;
    const user = identity
      ? (userService.getSafeUser(identity.userId) ?? null)
      : null;
    c.set('user', user);
    c.set('sessionId', user && identity ? identity.id : null);
    await next();
  };
}
