import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  electronStub,
  type FakeResponse,
  makeFakeReq,
  setNetRequest,
} from './electron-stub';

/**
 * loginViaWeb spins up a real node:http loopback server and talks to the
 * server via `serverRequest` (Electron `net`). We register the shared electron
 * stub (shell.openExternal as a spy; net.request returns scripted fake
 * responses), then drive the loopback with `fetch`. getMe/serverRequest run for
 * real on top of the stubbed net, so we don't have to mock relative imports.
 */

// Register the shared stub; `shell.openExternal` is the spy we assert on.
mock.module('electron', () => electronStub);
const openExternal = electronStub.shell.openExternal;

// Scripted responses for each net.request call, in call order
// (exchange, then /api/me).
const queue: FakeResponse[] = [];
let qIndex = 0;
let recordedReqs: Array<{ headers: Record<string, string> }> = [];

// Import AFTER registering the mock.
const { loginViaWeb } = await import('../src/main/desktopAuth');

const FAKE_USER = {
  id: 'u1',
  name: 'Admin',
  email: 'admin@example.com',
  role: 'admin',
  createdAt: '',
  updatedAt: '',
};

/** A fake session whose `cookies.set` records its calls. */
function makeSes(): { ses: unknown; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const ses = {
    cookies: {
      set: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve();
      },
    },
  };
  return { ses, calls };
}

async function waitFor(fn: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor timed out');
}

/** The loopback callback URL the desktop passed to the browser. */
function openedCb(): string {
  const url = openExternal.mock.calls.at(-1)?.[0];
  if (!url) throw new Error('openExternal was not called');
  const opened = new URL(url);
  const cb = opened.searchParams.get('cb');
  if (!cb) throw new Error('opened URL had no cb param');
  return cb;
}

beforeEach(() => {
  queue.length = 0;
  qIndex = 0;
  recordedReqs = [];
  mock.clearAllMocks();
  setNetRequest(() => {
    const response = queue[qIndex++] ?? { status: 200, body: '{}' };
    const req = makeFakeReq(response) as { headers: Record<string, string> };
    recordedReqs.push(req);
    return req;
  });
});

describe('loginViaWeb', () => {
  test('exchanges the code and uses a bearer token for follow-up requests', async () => {
    queue.push(
      {
        status: 200,
        body: JSON.stringify({ token: 'tok.sig', user: FAKE_USER }),
      }, // /api/desktop/exchange
      { status: 200, body: JSON.stringify(FAKE_USER) } // /api/me
    );
    const { ses, calls } = makeSes();
    const result = loginViaWeb(ses as never, 'http://localhost:3000', {
      timeoutMs: 1000,
    });

    await waitFor(() => openExternal.mock.calls.length > 0);
    const cb = new URL(openedCb());
    const res = await fetch(
      `${cb.origin}${cb.pathname}${cb.search}&code=fake-code`
    );

    const user = await result;
    expect(user).toEqual(FAKE_USER);
    expect((await res.text()).includes('Authorized')).toBe(true);

    expect(calls).toHaveLength(0);
    expect(recordedReqs.at(-1)?.headers.authorization).toBe('Bearer tok.sig');
  });

  test('uses the bearer header for an https origin as well', async () => {
    queue.push(
      {
        status: 200,
        body: JSON.stringify({ token: 'tok.sig', user: FAKE_USER }),
      },
      { status: 200, body: JSON.stringify(FAKE_USER) }
    );
    const { ses, calls } = makeSes();
    const result = loginViaWeb(ses as never, 'https://deploy.example.com', {
      timeoutMs: 1000,
    });
    await waitFor(() => openExternal.mock.calls.length > 0);
    const cb = new URL(openedCb());
    await fetch(`${cb.origin}${cb.pathname}${cb.search}&code=fake-code`);
    await result;
    expect(calls).toHaveLength(0);
    expect(recordedReqs.at(-1)?.headers.authorization).toBe('Bearer tok.sig');
  });

  test('rejects a callback with the wrong state (no exchange, resolves null)', async () => {
    const { ses, calls } = makeSes();
    const result = loginViaWeb(ses as never, 'http://localhost:3000', {
      timeoutMs: 100,
    });
    await waitFor(() => openExternal.mock.calls.length > 0);
    const cb = new URL(openedCb());
    const res = await fetch(
      `${cb.origin}${cb.pathname}?state=wrong&code=fake-code`
    );
    expect(res.status).toBe(200);

    const user = await result;
    expect(user).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test('resolves null on timeout when the browser never authorizes', async () => {
    const { ses, calls } = makeSes();
    const user = await loginViaWeb(ses as never, 'http://localhost:3000', {
      timeoutMs: 50,
    });
    expect(user).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
