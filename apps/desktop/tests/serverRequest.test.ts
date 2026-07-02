import { describe, expect, mock, test } from 'bun:test';

/**
 * serverRequest is hard to unit-test end-to-end because it drives Electron's
 * `net` module, which only exists inside the Electron runtime. We:
 *   1. mock `electron` so the module under test loads under bun,
 *   2. drive a fake request emitter through a mutable handle for the
 *      integration cases, and
 *   3. cover the error-enveloping logic directly via the extracted pure
 *      `parseResponseBody` helper (the load-bearing behavior).
 */

// ---- Fake request/response machinery ---------------------------------------

interface FakeReq {
  setHeader(): void;
  on(event: string, cb: (arg?: unknown) => void): FakeReq;
  write(): void;
  end(): void;
}

interface FakeResponse {
  statusCode: number;
  on(event: string, cb: (arg?: unknown) => void): void;
}

/** Builds a fake ClientRequest that emits `response` (with a body) or `error`
 * asynchronously once `end()` is called. Returns the req plus the raw handler
 * lists for finer control if needed. */
function makeFakeReq(status: number, body: string, error?: Error): FakeReq {
  const handlers: Record<string, Array<(arg?: unknown) => void>> = {};
  const req: FakeReq = {
    setHeader() {},
    on(event, cb) {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(cb);
      return req;
    },
    write() {},
    end() {
      const response: FakeResponse = { statusCode: status, on() {} };
      // FakeIncomingMessage: deliver `data` then `end`.
      (
        response as unknown as {
          on: (e: string, cb: (a?: unknown) => void) => void;
        }
      ).on = (event, cb) => {
        if (event === 'data') setTimeout(() => cb(Buffer.from(body)), 0);
        if (event === 'end') setTimeout(() => cb(), 1);
      };
      if (error) setTimeout(() => handlers.error?.[0]?.(error), 0);
      else setTimeout(() => handlers.response?.[0]?.(response), 0);
    },
  };
  return req;
}

// Mutable handle: each test programs the fake request it wants before driving
// serverRequest.
let currentReq: FakeReq = makeFakeReq(200, '{}');

// Stub electron so `import '../src/main/serverRequest'` resolves. `net.request`
// returns whatever the current test staged in `currentReq`.
mock.module('electron', () => ({
  net: { request: () => currentReq },
  session: { fromPartition: () => ({}) },
}));

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
      error: { message: 'Authentication required' },
    });
    try {
      parseResponseBody(401, body);
      throw new Error('expected parseResponseBody to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ServerError);
      expect((e as ServerError).message).toBe('Authentication required');
      expect((e as ServerError).status).toBe(401);
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

describe('serverRequest', () => {
  test('resolves with parsed JSON on 2xx', async () => {
    currentReq = makeFakeReq(200, JSON.stringify({ ok: true }));
    const r = await serverRequest<{ ok: boolean }>({} as never, 'http://x', {
      method: 'GET',
      path: '/api/projects',
    });
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ ok: true });
  });

  test('rejects with ServerError (message + status) on 401', async () => {
    currentReq = makeFakeReq(
      401,
      JSON.stringify({ error: { message: 'Authentication required' } })
    );
    const promise = serverRequest({} as never, 'http://x', {
      method: 'GET',
      path: '/api/me',
    });
    await expect(promise).rejects.toBeInstanceOf(ServerError);
    await expect(promise).rejects.toMatchObject({
      message: 'Authentication required',
      status: 401,
    });
  });

  test('rejects with NetworkError on a connection error', async () => {
    currentReq = makeFakeReq(0, '', new Error('connect ECONNREFUSED'));
    const promise = serverRequest({} as never, 'http://x', {
      method: 'GET',
      path: '/api/me',
    });
    await expect(promise).rejects.toBeInstanceOf(NetworkError);
  });
});
