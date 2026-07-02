import { expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { electronStub } from './electron-stub';

// nativeUpload imports `dialog` from electron and pulls in serverRequest
// (which imports `net`), so the electron stub must cover both. Only
// collectDirectory is exercised here — it touches node:fs only — so net/dialog
// are no-ops. The shared stub keeps this file from clobbering other electron-
// mocking tests under bun's single-process model.
mock.module('electron', () => electronStub);

const { collectDirectory } = await import('../src/main/nativeUpload');

test('collectDirectory walks subdirs and yields POSIX relative paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dk-'));
  await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'index.html'), '<html/>');
  await writeFile(join(dir, 'assets', 'app.js'), 'console.log(1)');

  const files = await collectDirectory(dir);
  const paths = files.map((f) => f.webkitRelativePath).sort();
  expect(paths).toEqual(['assets/app.js', 'index.html']);
});

test('collectDirectory reports on-disk size and absolute path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dk-'));
  const payload = 'console.log(42)';
  await writeFile(join(dir, 'app.js'), payload);

  const files = await collectDirectory(dir);
  expect(files).toHaveLength(1);
  const f = files[0];
  expect(f.name).toBe('app.js');
  expect(f.size).toBe(payload.length);
  expect(f.type).toBe('text/javascript');
  expect(f.webkitRelativePath).toBe('app.js');
  expect(f.path).toBe(join(dir, 'app.js'));
});

test('collectDirectory yields nothing for an empty directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dk-'));
  const files = await collectDirectory(dir);
  expect(files).toEqual([]);
});
