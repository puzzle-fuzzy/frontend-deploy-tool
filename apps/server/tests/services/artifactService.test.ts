import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  flattenOutput,
  writeFolderFiles,
} from '../../src/services/artifactService';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'deploykit-artifact-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function fileWithRelativePath(content: string, relativePath: string): File {
  const f = new File([content], relativePath.split('/').pop() ?? relativePath);
  (f as File & { webkitRelativePath?: string }).webkitRelativePath =
    relativePath;
  return f;
}

test('flattenOutput hoists a subdirectory containing index.html and drops __MACOSX', () => {
  const dir = join(tempDir, 'out');
  mkdirSync(join(dir, 'build'), { recursive: true });
  writeFileSync(join(dir, 'build', 'index.html'), '<html></html>');
  mkdirSync(join(dir, '__MACOSX'));

  flattenOutput(dir);

  expect(existsSync(join(dir, 'index.html'))).toBe(true);
  expect(existsSync(join(dir, 'build'))).toBe(false);
  expect(existsSync(join(dir, '__MACOSX'))).toBe(false);
});

test('flattenOutput leaves a root index.html untouched when present', () => {
  const dir = join(tempDir, 'out');
  mkdirSync(join(dir, 'build'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<html></html>');
  writeFileSync(join(dir, 'build', 'index.html'), '<html></html>');

  flattenOutput(dir);

  expect(existsSync(join(dir, 'build'))).toBe(true);
});

test('writeFolderFiles preserves the backslash path normalization quirk', async () => {
  const destDir = join(tempDir, 'out');
  const size = await writeFolderFiles(destDir, [
    fileWithRelativePath('hello', 'a/b/c.txt'),
  ]);

  expect(size).toBe(5);
  expect(existsSync(join(destDir, 'a\\b\\c.txt'))).toBe(true);
  expect(existsSync(join(destDir, 'a'))).toBe(false);
});

test('writeFolderFiles throws on an unsafe traversal path', async () => {
  const destDir = join(tempDir, 'out');
  await expect(
    writeFolderFiles(destDir, [fileWithRelativePath('x', '../../evil.txt')])
  ).rejects.toThrow('Unsafe upload path');
});

test('writeFolderFiles rejects a path that exceeds maxPathLength', async () => {
  const destDir = join(tempDir, 'out');
  const longName = `${'a'.repeat(50)}.txt`;
  await expect(
    writeFolderFiles(destDir, [fileWithRelativePath('x', longName)], 10)
  ).rejects.toThrow('Path too long');
});
