import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SafeUser } from '@deploykit/shared';
import { type Session, shell } from 'electron';
import { getMe, setDesktopAuthToken } from './auth';
import { serverRequest } from './serverRequest';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;


const SUCCESS_HTML = `<!doctype html><meta charset="utf-8">
<title>Authorized</title>
<body style="font-family:system-ui;text-align:center;padding:2rem">
<h2>✅ Authorized</h2><p>You can close this tab and return to the app.</p>
<script>window.close();</script>
</body>`;

const INVALID_HTML =
  '<body style="font-family:system-ui;text-align:center;padding:2rem">' +
  '<p>Invalid authorization response. Please try again from the app.</p></body>';

export interface LoginViaWebOptions {
  /** How long to wait for the browser flow before resolving null. */
  timeoutMs?: number;
}

/**
 * Opens the system browser at `{origin}/desktop-auth` so the user can sign in
 * and authorize the desktop client. A one-shot HTTP server on 127.0.0.1 receives
 * the authorization `code`, exchanges it for a session token, writes it into the
 * partition session's cookie jar, and resolves with the logged-in user.
 *
 * Resolves `null` if the user cancels (closes the browser) or the flow times
 * out. Mirrors the OAuth 2.0 loopback redirect (RFC 8252).
 */
export async function loginViaWeb(
  ses: Session,
  origin: string,
  opts?: LoginViaWebOptions
): Promise<SafeUser | null> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const state = randomBytes(16).toString('base64url');

  return new Promise((resolve) => {
    let settled = false;
    // Assigned synchronously below before any async callback can fire.
    let server!: http.Server;
    let timer!: ReturnType<typeof setTimeout>;

    const finish = (val: SafeUser | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
      resolve(val);
    };

    server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (u.pathname !== '/callback') {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Connection', 'close');

      const code = u.searchParams.get('code');
      const returnedState = u.searchParams.get('state');
      if (!code || returnedState !== state) {
        res.end(INVALID_HTML);
        return;
      }
      // Reply to the browser immediately; finish the flow after.
      res.end(SUCCESS_HTML);

      void (async () => {
        try {
          const { token } = await exchangeCode(ses, origin, code);
          setDesktopAuthToken(token);
          const me = await getMe(ses, origin);
          finish(me ?? null);
        } catch {
          finish(null);
        }
      })();
    });

    timer = setTimeout(() => finish(null), timeoutMs);

    server.on('error', () => finish(null));
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port =
        addr && typeof addr === 'object' ? (addr as AddressInfo).port : 0;
      if (!port) {
        finish(null);
        return;
      }
      const cb = `http://127.0.0.1:${port}/callback?state=${state}`;
      void shell.openExternal(
        `${origin}/desktop-auth?cb=${encodeURIComponent(cb)}`
      );
    });
  });
}

async function exchangeCode(
  ses: Session,
  origin: string,
  code: string
): Promise<{ token: string }> {
  const r = await serverRequest<{ token: string; user: SafeUser }>(
    ses,
    origin,
    {
      method: 'POST',
      path: '/api/desktop/exchange',
      body: { code },
    }
  );
  return { token: r.data.token };
}
