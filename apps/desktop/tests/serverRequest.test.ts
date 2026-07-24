import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  electronStub,
  type FakeResponse,
  makeFakeReq,
  setNetRequest,
} from './electron-stub';

/**
 * serverRequest is hard to unit-test end-to-end because it drives Electron's
 * `net` module, which only exists inside the Electron runtime. We register the
 * shared electron stub, drive a fake request via `setNetRequest`, and cover the
 * error-enveloping logic directly via the extracted pure `parseResponseBody`
 * helper (the load-bearing behavior).
 */

// Mutable handle: each test programs the fake response it wants before driving
// serverRequest.
let currentReq = makeFakeReq({ status: 200, body: '{}' });
// Re-asserted in beforeEach so other test files can't leave a different fn.
setNetRequest(() => currentReq);

// Register the shared stub so this file cooperates with other electron-mocking
// tests under bun's single-process model.
mock.module('electron', () => electronStub);

beforeEach(() => setNetRequest(() => currentReq));

// Import AFTER registering the mock (ESM static imports would hoist above it).
const { parseResponseBody, serverRequest, ServerError, NetworkError } =
  await import('../src/main/serverRequest');

// ---- Pure error-enveloping cases (the load-bearing behavior) ---------------

describe('parseResponseBody', () => {
  test('parses a 2xx JSON body', () => {
    const r = parseResponseBody<{ ok: boolean }>(
      200,
      JSON.stringify({ ok: true })
    );
    expect(r.isError).toBe(false);
    expect(r.data).toEqual({ ok: true });
  });

  test('treats an empty 2xx body as an empty object', () => {
    const r = parseResponseBody<unknown>(204, '');
    expect(r.data).toEqual({});
  });

  test('falls back to raw text when 2xx body is not JSON', () => {
    const r = parseResponseBody<string>(200, 'plain text');
    expect(r.data).toBe('plain text');
  });

  test('401 with {error.message} throws ServerError carrying that message', () => {
    const body = JSON.stringify({
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    });
    try {
      parseResponseBody(401, body, 'request-desktop-01');
      throw new Error('expected parseResponseBody to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ServerError);
      expect((e as ServerError).message).toBe('Authentication required');
      expect((e as ServerError).status).toBe(401);
      expect((e as ServerError).code).toBe('UNAUTHORIZED');
      expect((e as ServerError).requestId).toBe('request-desktop-01');
    }
  });

  test('non-2xx with non-JSON body falls back to HTTP status text', () => {
    try {
      parseResponseBody(500, '');
      throw new Error('expected parseResponseBody to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ServerError);
      expect((e as ServerError).status).toBe(500);
      expect((e as ServerError).message).toBe('HTTP 500');
    }
  });
});

// ---- End-to-end net-mock cases ---------------------------------------------

function stage(res: FakeResponse): void {
  currentReq = makeFakeReq(res);
}

describe('serverRequest', () => {
  test('resolves with parsed JSON on 2xx', async () => {
    stage({ status: 200, body: JSON.stringify({ ok: true }) });
    const r = await serverRequest<{ ok: boolean }>({} as never, 'http://x', {
      method: 'GET',
      path: '/api/projects',
    });
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ ok: true });
  });

  test('rejects with ServerError (message + status) on 401', async () => {
    stage({
      status: 401,
      body: JSON.stringify({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      }),
      headers: { 'x-request-id': 'request-desktop-02' },
    });
    const promise = serverRequest({} as never, 'http://x', {
      method: 'GET',
      path: '/api/me',
    });
    await expect(promise).rejects.toBeInstanceOf(ServerError);
    await expect(promise).rejects.toMatchObject({
      message: 'Authentication required',
      status: 401,
      code: 'UNAUTHORIZED',
      requestId: 'request-desktop-02',
    });
  });

  test('does not block auth responses on cookie persistence', async () => {
    const session = {
      cookies: {
        set: () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 50);
          }),
      },
    };
    stage({
      status: 200,
      body: JSON.stringify({ ok: true }),
      headers: { 'set-cookie': ['deploykit_session=abc; Path=/; HttpOnly'] },
    });

    await expect(
      serverRequest(session as never, 'http://x', {
        method: 'POST',
        path: '/api/auth/login',
      })
    ).resolves.toEqual({ status: 200, data: { ok: true } });
  });

  test('rejects with NetworkError on a connection error', async () => {
    stage({ status: 0, body: '', error: new Error('connect ECONNREFUSED') });
    const promise = serverRequest({} as never, 'http://x', {
      method: 'GET',
      path: '/api/me',
    });
    await expect(promise).rejects.toBeInstanceOf(NetworkError);
  });
});
