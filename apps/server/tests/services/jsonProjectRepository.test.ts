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
import { CURRENT_SCHEMA_VERSION } from '../../src/domain/schema';
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
  expect(repo.load()).toEqual({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projects: [],
    users: [],
    history: [],
    artifactAudits: [],
    artifactAuditJobs: [],
  });
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

test('load fails closed on malformed JSON', () => {
  const dataFile = join(tempDir, 'data.json');
  writeFileSync(dataFile, '{ not valid json');

  const repo = createJsonProjectRepository(dataFile);
  expect(() => repo.load()).toThrow();
});

test('save persists data that load can read back', () => {
  const dataFile = join(tempDir, 'data.json');
  const repo = createJsonProjectRepository(dataFile);
  const data: Data = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projects: [],
    users: [],
    history: [],
    artifactAudits: [],
    artifactAuditJobs: [],
  };

  repo.save(data);

  expect(existsSync(dataFile)).toBe(true);
  expect(repo.load()).toEqual(data);
});

test('save is atomic and leaves no temp file behind', () => {
  const dataFile = join(tempDir, 'data.json');
  const repo = createJsonProjectRepository(dataFile);

  repo.save({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projects: [],
    users: [],
    history: [],
    artifactAudits: [],
    artifactAuditJobs: [],
  });

  const leftover = readdirSync(tempDir).filter((f) => f.endsWith('.tmp'));
  expect(leftover).toEqual([]);
});

test('save creates the parent directory when it does not exist', () => {
  const dataFile = join(tempDir, 'nested', 'deep', 'data.json');
  const repo = createJsonProjectRepository(dataFile);

  repo.save({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projects: [],
    users: [],
    history: [],
    artifactAudits: [],
    artifactAuditJobs: [],
  });

  expect(existsSync(dataFile)).toBe(true);
});

test('mutate returns the callback result and persists its changes', () => {
  const dataFile = join(tempDir, 'data.json');
  const repo = createJsonProjectRepository(dataFile);

  const result = repo.mutate((data) => {
    data.history.push({
      id: 'history-1',
      action: 'project.create',
      projectId: 'project-1',
      projectName: 'Signal Desk',
      versionId: '',
      versionName: '',
      timestamp: '2026-07-24T00:00:00.000Z',
      actorId: 'user-1',
    });
    return data.history.length;
  });

  expect(result).toBe(1);
  expect(repo.load().history).toHaveLength(1);
});

test('mutate does not persist changes when the callback throws', () => {
  const dataFile = join(tempDir, 'data.json');
  const repo = createJsonProjectRepository(dataFile);
  repo.save({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projects: [],
    users: [],
    history: [],
    artifactAudits: [],
    artifactAuditJobs: [],
  });

  expect(() =>
    repo.mutate((data) => {
      data.history.push({
        id: 'history-1',
        action: 'project.create',
        projectId: 'project-1',
        projectName: 'Signal Desk',
        versionId: '',
        versionName: '',
        timestamp: '2026-07-24T00:00:00.000Z',
        actorId: 'user-1',
      });
      throw new Error('reject mutation');
    })
  ).toThrow('reject mutation');

  expect(repo.load().history).toEqual([]);
});
