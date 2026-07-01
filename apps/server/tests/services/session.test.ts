import { expect, test } from 'bun:test';
import type { Role } from '@deploykit/shared';
import {
  createSessionToken,
  verifySessionToken,
} from '../../src/middleware/session';

const SECRET = 'test-session-secret';
const future = Math.floor(Date.now() / 1000) + 3600;
const payload = { sub: 'user-1', role: 'admin' as Role, exp: future };

test('round-trips a valid token', () => {
  const token = createSessionToken(payload, SECRET);
  expect(verifySessionToken(token, SECRET)).toEqual(payload);
});

test('rejects a token signed with a different secret', () => {
  const token = createSessionToken(payload, SECRET);
  expect(verifySessionToken(token, 'some-other-secret')).toBeNull();
});

test('rejects a tampered token', () => {
  const token = createSessionToken(payload, SECRET);
  const tampered = `${token.slice(0, -2)}xx`;
  expect(verifySessionToken(tampered, SECRET)).toBeNull();
});

test('rejects a malformed token', () => {
  expect(verifySessionToken('not-a-token', SECRET)).toBeNull();
  expect(verifySessionToken('abc.def', SECRET)).toBeNull();
});

test('rejects an expired token', () => {
  const expired = { ...payload, exp: Math.floor(Date.now() / 1000) - 1 };
  expect(
    verifySessionToken(createSessionToken(expired, SECRET), SECRET)
  ).toBeNull();
});
