import type { ApiApp } from '@deploykit/server/api';
import { hc } from 'hono/client';
import { checkOk } from './errors';

// Same-origin API; the Vite dev server proxies `/api` to the backend in dev.
const client = hc<ApiApp>('');

/**
 * Web-only: asks the server to issue a one-time desktop authorization code for
 * the currently logged-in user. The desktop client exchanges the code for a
 * session token via `/api/desktop/exchange` (main process); the web app never
 * sees the token. Not part of the shared `ApiClient` interface on purpose —
 * only the web SPA renders the authorize page.
 */
export async function desktopAuthorize(
  redirectUri: string
): Promise<{ code: string; redirectUri: string }> {
  const res = await client.api.desktop.authorize.$post({
    json: { redirectUri },
  });
  await checkOk(res);
  return (await res.json()) as { code: string; redirectUri: string };
}
