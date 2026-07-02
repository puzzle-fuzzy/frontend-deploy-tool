import { expect, test } from 'bun:test';
import type { NativeFile } from '@deploykit/client';
import { LIMITS, preflight } from '../src/main/nativeUpload';

const mk = (rel: string, size: number): NativeFile => ({
  name: rel.split('/').pop() || rel,
  size,
  type: 'application/octet-stream',
  webkitRelativePath: rel,
  path: `/fake/${rel}`,
});

test('preflight passes under all limits', () => {
  expect(preflight([mk('a.js', 10), mk('b.js', 20)])).toBeNull();
});

test('preflight rejects too many files', () => {
  const files = Array.from({ length: LIMITS.maxFileCount + 1 }, (_, i) =>
    mk(`f${i}.js`, 1)
  );
  const err = preflight(files);
  expect(err?.reason).toMatch(/Too many files/);
});

test('preflight rejects oversized total', () => {
  const err = preflight([mk('big.bin', LIMITS.maxExtractedSize + 1)]);
  expect(err?.reason).toMatch(/Total size too large/);
});

test('preflight rejects a too-long path', () => {
  const long = 'a'.repeat(LIMITS.maxPathLength + 1);
  const err = preflight([mk(long, 1)]);
  expect(err?.reason).toMatch(/Path too long/);
});

test('preflight accepts exactly the limits (boundary)', () => {
  // maxFileCount files of size 1 each → total well under maxExtractedSize.
  const files = Array.from({ length: LIMITS.maxFileCount }, (_, i) =>
    mk(`f${i}.js`, 1)
  );
  expect(preflight(files)).toBeNull();
});
