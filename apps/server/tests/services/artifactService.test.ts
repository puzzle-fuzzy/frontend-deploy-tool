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
import { zip } from 'fflate';
import { ErrorCode } from '../../src/errors';
import {
  countFiles,
  extractZip,
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
  // `webkitRelativePath` is readonly on File (set by the browser); define it
  // directly so the synthesized upload behaves like a directory-picker file.
  Object.defineProperty(f, 'webkitRelativePath', {
    value: relativePath,
    configurable: true,
  });
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

test('writeFolderFiles preserves the relative directory structure', async () => {
  const destDir = join(tempDir, 'out');
  const size = await writeFolderFiles(destDir, [
    fileWithRelativePath('hello', 'a/b/c.txt'),
  ]);

  expect(size).toBe(5);
  expect(existsSync(join(destDir, 'a', 'b', 'c.txt'))).toBe(true);
  expect(existsSync(join(destDir, 'a'))).toBe(true); // real directory now
});

test('countFiles recursively counts every file under a directory', () => {
  const dir = join(tempDir, 'out');
  mkdirSync(join(dir, 'a', 'b'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<html></html>');
  writeFileSync(join(dir, 'a', 'one.css'), 'x');
  writeFileSync(join(dir, 'a', 'b', 'two.js'), 'y');

  expect(countFiles(dir)).toBe(3);
});

test('writeFolderFiles skips OS metadata files', async () => {
  const destDir = join(tempDir, 'out');
  const size = await writeFolderFiles(destDir, [
    fileWithRelativePath('keep', 'proj/index.html'),
    fileWithRelativePath('junk', 'proj/.DS_Store'),
    fileWithRelativePath('junk', 'proj/._resource'),
    fileWithRelativePath('junk', 'proj/__MACOSX/whatever'),
  ]);

  expect(size).toBe(4); // only index.html counted
  expect(existsSync(join(destDir, 'proj', 'index.html'))).toBe(true);
  expect(existsSync(join(destDir, 'proj', '.DS_Store'))).toBe(false);
  expect(existsSync(join(destDir, 'proj', '__MACOSX'))).toBe(false);
});

test('writeFolderFiles throws on an unsafe traversal path', async () => {
  const destDir = join(tempDir, 'out');
  await expect(
    writeFolderFiles(destDir, [fileWithRelativePath('x', '../../evil.txt')])
  ).rejects.toMatchObject({ code: ErrorCode.UNSAFE_ENTRY });
});

test('writeFolderFiles rejects a path that exceeds maxPathLength', async () => {
  const destDir = join(tempDir, 'out');
  const longName = `${'a'.repeat(50)}.txt`;
  await expect(
    writeFolderFiles(destDir, [fileWithRelativePath('x', longName)], 10)
  ).rejects.toThrow('Path too long');
});

test('extractZip throws when the archive is invalid', async () => {
  const zipPath = join(tempDir, 'broken.zip');
  writeFileSync(zipPath, 'this is not a zip');
  const destDir = join(tempDir, 'out');
  await expect(extractZip(zipPath, destDir)).rejects.toThrow(
    'Zip extraction failed'
  );
});

/** Builds an in-memory zip from path → bytes entries. */
async function makeZip(entries: Record<string, Uint8Array>): Promise<string> {
  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    zip(entries, (err, data) => (err ? reject(err) : resolve(data)));
  });
  const zipPath = join(tempDir, `test-${Math.random().toString(36)}.zip`);
  writeFileSync(zipPath, bytes);
  return zipPath;
}

test('extractZip writes valid entries and skips OS metadata', async () => {
  const zipPath = await makeZip({
    'index.html': new TextEncoder().encode('<html></html>'),
    '.DS_Store': new Uint8Array([1, 2, 3]),
  });
  const destDir = join(tempDir, 'out');

  await extractZip(zipPath, destDir);

  expect(existsSync(join(destDir, 'index.html'))).toBe(true);
  expect(existsSync(join(destDir, '.DS_Store'))).toBe(false);
});

test('extractZip rejects a path-traversal entry', async () => {
  const zipPath = await makeZip({
    '../escape.txt': new Uint8Array([42]),
  });
  const destDir = join(tempDir, 'out');

  await expect(extractZip(zipPath, destDir)).rejects.toThrow(
    'Unsafe zip entry'
  );
});

test('extractZip rejects dangerous entries (.env, .git/, id_rsa)', async () => {
  const destDir = join(tempDir, 'out');

  for (const path of ['.env', '.git/config', 'id_rsa', 'cert.pem']) {
    const zipPath = await makeZip({
      'index.html': new TextEncoder().encode('<html></html>'),
      [path]: new TextEncoder().encode('secret'),
    });
    await expect(extractZip(zipPath, destDir)).rejects.toThrow(
      'disallowed entry'
    );
  }
});

test('writeFolderFiles rejects dangerous entries', async () => {
  const destDir = join(tempDir, 'out');

  for (const path of ['.env', 'proj/.git/config', 'proj/id_rsa', 'cert.key']) {
    await expect(
      writeFolderFiles(destDir, [fileWithRelativePath('x', path)])
    ).rejects.toThrow('disallowed entry');
  }
});
