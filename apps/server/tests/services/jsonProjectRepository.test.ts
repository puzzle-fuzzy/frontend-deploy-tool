import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Data } from '@deploykit/shared';
import { DEFAULT_PROJECT_SETTINGS } from '../../src/domain/project';
import { createJsonProjectRepository } from '../../src/repositories/jsonProjectRepository';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'deploykit-repo-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test('load returns empty data when the file is missing', () => {
  const repo = createJsonProjectRepository(join(tempDir, 'missing.json'));
  expect(repo.load()).toEqual({ projects: [], history: [] });
});

test('load hydrates projects that are missing settings with defaults', () => {
  const dataFile = join(tempDir, 'data.json');
  writeFileSync(
    dataFile,
    JSON.stringify({
      projects: [
        {
          id: 'p1',
          name: 'P',
          slug: 'p',
          description: '',
          createdAt: '',
          updatedAt: '',
          versions: [],
        },
      ],
      history: [],
    })
  );

  const repo = createJsonProjectRepository(dataFile);
  expect(repo.load().projects[0].settings).toEqual(DEFAULT_PROJECT_SETTINGS);
});

test('load returns empty data on malformed JSON instead of throwing', () => {
  const dataFile = join(tempDir, 'data.json');
  writeFileSync(dataFile, '{ not valid json');

  const repo = createJsonProjectRepository(dataFile);
  expect(repo.load()).toEqual({ projects: [], history: [] });
});

test('save persists data that load can read back', () => {
  const dataFile = join(tempDir, 'data.json');
  const repo = createJsonProjectRepository(dataFile);
  const data: Data = { projects: [], history: [] };

  repo.save(data);

  expect(existsSync(dataFile)).toBe(true);
  expect(repo.load()).toEqual(data);
});

test('save is atomic and leaves no temp file behind', () => {
  const dataFile = join(tempDir, 'data.json');
  const repo = createJsonProjectRepository(dataFile);

  repo.save({ projects: [], history: [] });

  const leftover = readdirSync(tempDir).filter((f) => f.endsWith('.tmp'));
  expect(leftover).toEqual([]);
});

test('save creates the parent directory when it does not exist', () => {
  const dataFile = join(tempDir, 'nested', 'deep', 'data.json');
  const repo = createJsonProjectRepository(dataFile);

  repo.save({ projects: [], history: [] });

  expect(existsSync(dataFile)).toBe(true);
});
