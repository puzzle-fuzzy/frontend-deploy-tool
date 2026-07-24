import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Data } from '@deploykit/shared';
import { CURRENT_SCHEMA_VERSION } from '../../src/domain/schema';
import { createSqliteProjectRepository } from '../../src/repositories/sqliteProjectRepository';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'deploykit-sqlite-repo-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function createData(projectName = 'Signal Desk'): Data {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projects: [
      {
        id: 'project-1',
        name: projectName,
        slug: 'signal-desk',
        description: '',
        createdAt: '2026-07-24T00:00:00.000Z',
        updatedAt: '2026-07-24T00:00:00.000Z',
        versions: [],
        activeVersionId: null,
        settings: { spaMode: false, routingType: 'path' },
        createdBy: 'user-1',
        members: [],
      },
    ],
    users: [],
    history: [],
  };
}

test('creates a SQLite store with WAL enabled', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  createSqliteProjectRepository({ databaseFile }).load();

  const database = new Database(databaseFile);
  const mode = database
    .query<{ journal_mode: string }, []>('PRAGMA journal_mode')
    .get();
  database.close();

  expect(mode?.journal_mode.toLowerCase()).toBe('wal');
});

test('save persists data that a second repository can read', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const first = createSqliteProjectRepository({ databaseFile });
  first.save(createData());

  const second = createSqliteProjectRepository({ databaseFile });
  expect(second.load()).toEqual(createData());
});

test('imports legacy JSON only when the SQLite state is empty', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const legacyDataFile = join(tempDir, 'data.json');
  writeFileSync(legacyDataFile, JSON.stringify(createData('Legacy Project')));

  const repository = createSqliteProjectRepository({
    databaseFile,
    legacyDataFile,
  });

  expect(repository.load().projects[0]?.name).toBe('Legacy Project');
  expect(existsSync(`${legacyDataFile}.sqlite-migration.bak`)).toBe(true);

  writeFileSync(legacyDataFile, JSON.stringify(createData('Changed JSON')));
  expect(repository.load().projects[0]?.name).toBe('Legacy Project');
});

test('does not replace existing SQLite data with legacy JSON', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const legacyDataFile = join(tempDir, 'data.json');
  const repository = createSqliteProjectRepository({
    databaseFile,
    legacyDataFile,
  });
  repository.save(createData('SQLite Project'));
  writeFileSync(legacyDataFile, JSON.stringify(createData('Legacy Project')));

  expect(repository.load().projects[0]?.name).toBe('SQLite Project');
  expect(existsSync(`${legacyDataFile}.sqlite-migration.bak`)).toBe(false);
});

test('migrates and persists an older payload', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const database = new Database(databaseFile, { create: true });
  database.exec(`
    CREATE TABLE deploykit_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  database
    .query(
      `INSERT INTO deploykit_state
        (id, schema_version, payload, updated_at)
       VALUES (1, 0, ?, ?)`
    )
    .run(
      JSON.stringify({
        projects: [],
        users: [],
        history: [],
      }),
      '2026-07-24T00:00:00.000Z'
    );
  database.close();

  const repository = createSqliteProjectRepository({ databaseFile });
  expect(repository.load().schemaVersion).toBe(CURRENT_SCHEMA_VERSION);

  const verifyDatabase = new Database(databaseFile);
  const row = verifyDatabase
    .query<{ schema_version: number }, []>(
      'SELECT schema_version FROM deploykit_state WHERE id = 1'
    )
    .get();
  verifyDatabase.close();
  expect(row?.schema_version).toBe(CURRENT_SCHEMA_VERSION);
});

test('mutate returns the callback result and persists its changes', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const repository = createSqliteProjectRepository({ databaseFile });

  const result = repository.mutate((data) => {
    data.projects.push(createData().projects[0]);
    return data.projects[0].id;
  });

  expect(result).toBe('project-1');
  expect(repository.load().projects).toHaveLength(1);
});

test('mutate rolls back stored changes when the callback throws', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const repository = createSqliteProjectRepository({ databaseFile });
  repository.save(createData());

  expect(() =>
    repository.mutate((data) => {
      data.projects[0].name = 'Uncommitted';
      throw new Error('reject mutation');
    })
  ).toThrow('reject mutation');

  expect(repository.load().projects[0].name).toBe('Signal Desk');
});

test('separate repository instances mutate the latest committed state', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const first = createSqliteProjectRepository({ databaseFile });
  const second = createSqliteProjectRepository({ databaseFile });

  first.mutate((data) => {
    data.projects.push(createData('First Project').projects[0]);
  });
  second.mutate((data) => {
    data.projects.push({
      ...createData('Second Project').projects[0],
      id: 'project-2',
      slug: 'second-project',
    });
  });

  expect(first.load().projects.map((project) => project.name)).toEqual([
    'First Project',
    'Second Project',
  ]);
});
