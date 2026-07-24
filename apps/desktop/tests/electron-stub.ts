import { mock } from 'bun:test';

/**
 * Shared electron stub for desktop tests.
 *
 * bun runs test files in a single process with a shared module graph, so each
 * file's `mock.module('electron', …)` would clobber the others (the last
 * registration wins). Every electron-mocking test registers this same object
 * so all named imports (`shell`, `dialog`, `net`, `session`) stay resolvable
 * regardless of registration order, and the `shell`/`dialog` spies are shared.
 *
 * `net.request` is configured per-test via `setNetRequest()`.
 */

interface NoopReq {
  headers: Record<string, string>;
  setHeader(name: string, value: string): void;
  on(): NoopReq;
  write(): void;
  end(): void;
}

function noopReq(): NoopReq {
  const r: NoopReq = {
    headers: {},
    setHeader(name: string, value: string) {
      r.headers[name.toLowerCase()] = value;
    },
    on() {
      return r;
    },
    write() {},
    end() {},
  };
  return r;
}

export interface FakeResponse {
  status: number;
  body: string;
  headers?: Record<string, string | string[] | undefined>;
  error?: Error;
}

/**
 * Builds a fake ClientRequest that asynchronously emits `response` (with a
 * body) or `error` once `end()` is called.
 */
export function makeFakeReq(res: FakeResponse): unknown {
  const handlers: Record<string, Array<(arg?: unknown) => void>> = {};
  const req = {
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      req.headers[name.toLowerCase()] = value;
    },
    on(event: string, cb: (arg?: unknown) => void) {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(cb);
      return req;
    },
    write() {},
    end() {
      const response = {
        statusCode: res.status,
        headers: res.headers ?? {},
        on(event: string, cb: (a?: unknown) => void) {
          if (event === 'data') setTimeout(() => cb(Buffer.from(res.body)), 0);
          if (event === 'end') setTimeout(() => cb(), 1);
        },
      };
      if (res.error) setTimeout(() => handlers.error?.[0]?.(res.error), 0);
      else setTimeout(() => handlers.response?.[0]?.(response), 0);
    },
  };
  return req;
}

let netRequest: () => unknown = () => noopReq();

/** Swaps the function backing `net.request` for the current test. */
export function setNetRequest(fn: () => unknown): void {
  netRequest = fn;
}

export const electronStub = {
  net: { request: () => netRequest() },
  dialog: {
    showOpenDialog: mock(async () => ({ canceled: true, filePaths: [] })),
  },
  shell: {
    openExternal: mock((_url: string) => Promise.resolve()),
  },
  session: { fromPartition: () => ({}) },
};
