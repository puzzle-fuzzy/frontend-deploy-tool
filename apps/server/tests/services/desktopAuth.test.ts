import { expect, test } from 'bun:test';
import { createDesktopAuthCodeStore } from '../../src/desktopAuth';

test('consumeCode returns the entry once, then null on replay', () => {
  const store = createDesktopAuthCodeStore();
  const code = store.issueCode('user-1', 'http://127.0.0.1:5/cb');
  expect(code).toMatch(/^[A-Za-z0-9_-]{40,}$/);

  expect(store.consumeCode(code)).toEqual({
    userId: 'user-1',
    redirectUri: 'http://127.0.0.1:5/cb',
  });
  // single-use: a second consume of the same code is null
  expect(store.consumeCode(code)).toBeNull();
});

test('consumeCode returns null for an unknown code', () => {
  const store = createDesktopAuthCodeStore();
  expect(store.consumeCode('does-not-exist')).toBeNull();
});

test('issueCode returns distinct codes', () => {
  const store = createDesktopAuthCodeStore();
  const a = store.issueCode('u', 'http://127.0.0.1:5/cb');
  const b = store.issueCode('u', 'http://127.0.0.1:5/cb');
  expect(a).not.toBe(b);
});

test('an expired code cannot be consumed', () => {
  let now = 1_000_000;
  const store = createDesktopAuthCodeStore({ ttlMs: 1000, now: () => now });
  const code = store.issueCode('user-1', 'http://127.0.0.1:5/cb');
  now += 1001; // advance past the TTL
  expect(store.consumeCode(code)).toBeNull();
});

test('a code is still valid just before expiry', () => {
  let now = 1_000_000;
  const store = createDesktopAuthCodeStore({ ttlMs: 1000, now: () => now });
  const code = store.issueCode('user-1', 'http://127.0.0.1:5/cb');
  now += 999;
  expect(store.consumeCode(code)).not.toBeNull();
});

test('a code is consumed (deleted) even when checked after expiry', () => {
  // consumeCode deletes before checking expiry, so an expired code can't be
  // retried later after the clock moves back.
  let now = 1_000_000;
  const store = createDesktopAuthCodeStore({ ttlMs: 1000, now: () => now });
  const code = store.issueCode('user-1', 'http://127.0.0.1:5/cb');
  now += 1001;
  expect(store.consumeCode(code)).toBeNull();
  now -= 1001; // clock rewinds
  expect(store.consumeCode(code)).toBeNull();
});
