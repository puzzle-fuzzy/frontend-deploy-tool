import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Data } from '@deploykit/shared';
import { appendHistoryEvent } from '../../src/domain/history';
import { CURRENT_SCHEMA_VERSION } from '../../src/domain/schema';
import { createSqliteProjectRepository } from '../../src/repositories/sqliteProjectRepository';
import {
  configureSqlite,
  createRelationalSchema,
} from '../../src/repositories/sqliteSchema';

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
        auditPolicy: {
          enforcement: 'advisory',
          maxTotalBytes: 50 * 1024 * 1024,
          maxFileBytes: 10 * 1024 * 1024,
          maxFileCount: 1_000,
        },
        createdBy: 'user-1',
        members: [],
      },
    ],
    users: [],
    history: [],
    artifactAudits: [],
    artifactAuditJobs: [],
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

test('creates the normalized relational schema', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  createSqliteProjectRepository({ databaseFile }).load();

  const database = new Database(databaseFile);
  const tables = database
    .query<{ name: string }, []>(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`
    )
    .all()
    .map((row) => row.name);
  database.close();

  expect(tables).toEqual([
    'artifact_audit_jobs',
    'artifact_audits',
    'audit_events',
    'project_members',
    'projects',
    'releases',
    'schema_migrations',
    'sessions',
    'users',
    'versions',
  ]);
});

test('upgrades the deployed relational v3 schema to v4 with a backup', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const database = new Database(databaseFile, { create: true });
  configureSqlite(database);
  createRelationalSchema(database);
  database.exec(`
    DROP TABLE artifact_audit_jobs;
    DELETE FROM schema_migrations;
    INSERT INTO schema_migrations (version, applied_at)
    VALUES
      (1, '2026-07-30T00:00:00.000Z'),
      (2, '2026-07-30T00:00:00.000Z'),
      (3, '2026-07-30T00:00:00.000Z');
  `);
  database.close();

  const loaded = createSqliteProjectRepository({ databaseFile }).load();
  const verify = new Database(databaseFile);
  const migration = verify
    .query<{ version: number }, []>(
      'SELECT MAX(version) AS version FROM schema_migrations'
    )
    .get();
  const jobColumns = verify
    .query<{ name: string }, []>('PRAGMA table_info(artifact_audit_jobs)')
    .all()
    .map((column) => column.name);
  verify.close();

  expect(loaded.artifactAuditJobs).toEqual([]);
  expect(migration?.version).toBe(4);
  expect(jobColumns).toContain('locked_until');
  expect(jobColumns).toContain('policy_json');
  expect(existsSync(`${databaseFile}.pre-relational-v4.bak`)).toBe(true);
});

test('upgrades relational v1 through v4 with policy, audit, jobs, integrity, and backup', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const database = new Database(databaseFile, { create: true });
  configureSqlite(database);
  createRelationalSchema(database);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE artifact_audit_jobs;
    DROP TABLE artifact_audits;
    DROP TABLE projects;
    DROP TABLE versions;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      active_version_id TEXT NULL,
      spa_mode INTEGER NOT NULL,
      routing_type TEXT NOT NULL,
      created_by TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    );
    CREATE TABLE versions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL,
      size INTEGER NOT NULL,
      file_count INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      status TEXT NOT NULL,
      published_at TEXT NULL,
      published_by TEXT NULL,
      checksum TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    );
    DELETE FROM schema_migrations;
    INSERT INTO schema_migrations (version, applied_at)
    VALUES (1, '2026-07-30T00:00:00.000Z');
  `);
  database.close();

  createSqliteProjectRepository({ databaseFile }).load();

  const verify = new Database(databaseFile);
  const columns = verify
    .query<{ name: string }, []>('PRAGMA table_info(versions)')
    .all()
    .map((column) => column.name);
  const projectColumns = verify
    .query<{ name: string }, []>('PRAGMA table_info(projects)')
    .all()
    .map((column) => column.name);
  const migration = verify
    .query<{ version: number }, []>(
      'SELECT MAX(version) AS version FROM schema_migrations'
    )
    .get();
  verify.close();

  expect(columns).toContain('integrity_status');
  expect(columns).toContain('integrity_checked_at');
  expect(projectColumns).toContain('audit_enforcement');
  expect(projectColumns).toContain('audit_max_total_bytes');
  expect(migration?.version).toBe(4);
  expect(existsSync(`${databaseFile}.pre-relational-v4.bak`)).toBe(true);
});

test('upgrades the deployed relational v2 schema to v4 with a backup', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const database = new Database(databaseFile, { create: true });
  configureSqlite(database);
  createRelationalSchema(database);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE artifact_audit_jobs;
    DROP TABLE artifact_audits;
    DROP TABLE projects;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      active_version_id TEXT NULL,
      spa_mode INTEGER NOT NULL,
      routing_type TEXT NOT NULL,
      created_by TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    );
    DELETE FROM schema_migrations;
    INSERT INTO schema_migrations (version, applied_at)
    VALUES
      (1, '2026-07-30T00:00:00.000Z'),
      (2, '2026-07-30T00:00:00.000Z');
  `);
  database.close();

  const loaded = createSqliteProjectRepository({ databaseFile }).load();
  const verify = new Database(databaseFile);
  const migration = verify
    .query<{ version: number }, []>(
      'SELECT MAX(version) AS version FROM schema_migrations'
    )
    .get();
  const auditColumns = verify
    .query<{ name: string }, []>('PRAGMA table_info(artifact_audits)')
    .all()
    .map((column) => column.name);
  verify.close();

  expect(loaded.projects).toEqual([]);
  expect(migration?.version).toBe(4);
  expect(auditColumns).toContain('engine_version');
  expect(auditColumns).toContain('policy_json');
  expect(existsSync(`${databaseFile}.pre-relational-v4.bak`)).toBe(true);
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

test('migrates an older document payload once and keeps a database backup', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const backupFile = `${databaseFile}.pre-relational-v1.bak`;
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
  expect(existsSync(backupFile)).toBe(true);
  const firstBackup = readFileSync(backupFile);

  const verifyDatabase = new Database(databaseFile);
  const migration = verifyDatabase
    .query<{ version: number }, []>(
      'SELECT version FROM schema_migrations WHERE version = 1'
    )
    .get();
  verifyDatabase.close();
  expect(migration?.version).toBe(1);

  createSqliteProjectRepository({ databaseFile }).load();
  expect(readFileSync(backupFile)).toEqual(firstBackup);
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

test('persists project, member, and version changes as normalized rows', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const repository = createSqliteProjectRepository({ databaseFile });
  const data = createData();
  data.users.push({
    id: 'user-1',
    name: 'Owner',
    email: 'owner@example.com',
    passwordHash: 'hash',
    role: 'developer',
    createdAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:00.000Z',
  });
  data.projects[0].members.push({
    userId: 'user-1',
    role: 'owner',
    invitedAt: '2026-07-24T00:00:00.000Z',
  });
  data.projects[0].versions.push({
    id: 'version-1',
    name: 'v1',
    description: '',
    createdAt: '2026-07-24T00:00:00.000Z',
    size: 10,
    fileCount: 1,
    sourceType: 'folder',
    status: 'production',
    publishedAt: '2026-07-24T00:00:00.000Z',
    publishedBy: 'user-1',
    checksum: 'checksum-1',
    integrityStatus: 'verified',
    integrityCheckedAt: '2026-07-30T00:00:00.000Z',
  });
  data.projects[0].activeVersionId = 'version-1';
  repository.save(data);

  repository.mutate((next) => {
    next.projects[0].name = 'Renamed';
    next.projects[0].activeVersionId = null;
    next.projects[0].members[0].role = 'member';
    next.projects[0].versions = [];
  });

  const database = new Database(databaseFile);
  const project = database
    .query<{ name: string; active_version_id: string | null }, []>(
      'SELECT name, active_version_id FROM projects WHERE id = "project-1"'
    )
    .get();
  const member = database
    .query<{ role: string }, []>(
      'SELECT role FROM project_members WHERE project_id = "project-1"'
    )
    .get();
  const versionCount = database
    .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM versions')
    .get();
  database.close();

  expect(project).toEqual({ name: 'Renamed', active_version_id: null });
  expect(member?.role).toBe('member');
  expect(versionCount?.count).toBe(0);
  expect(repository.load().projects[0].versions).toEqual([]);
});

test('round-trips persisted version integrity state', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const repository = createSqliteProjectRepository({ databaseFile });
  const data = createData();
  data.projects[0].versions.push({
    id: 'version-1',
    name: 'v1',
    description: '',
    createdAt: '2026-07-24T00:00:00.000Z',
    size: 10,
    fileCount: 1,
    sourceType: 'folder',
    status: 'preview',
    publishedAt: null,
    publishedBy: null,
    checksum: 'checksum-1',
    integrityStatus: 'corrupted',
    integrityCheckedAt: '2026-07-30T00:00:00.000Z',
  });

  repository.save(data);

  expect(repository.load().projects[0].versions[0]).toMatchObject({
    integrityStatus: 'corrupted',
    integrityCheckedAt: '2026-07-30T00:00:00.000Z',
  });
});

test('round-trips project audit policy and replaces a version current report', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const repository = createSqliteProjectRepository({ databaseFile });
  const data = createData();
  data.projects[0].auditPolicy = {
    enforcement: 'blocking',
    maxTotalBytes: 2_000,
    maxFileBytes: 1_000,
    maxFileCount: 10,
  };
  data.projects[0].versions.push({
    id: 'version-1',
    name: 'v1',
    description: '',
    createdAt: '2026-07-24T00:00:00.000Z',
    size: 10,
    fileCount: 1,
    sourceType: 'folder',
    status: 'preview',
    publishedAt: null,
    publishedBy: null,
    checksum: 'checksum-1',
    integrityStatus: 'verified',
    integrityCheckedAt: '2026-07-30T00:00:00.000Z',
  });
  data.artifactAudits.push({
    id: 'audit-1',
    projectId: 'project-1',
    versionId: 'version-1',
    artifactChecksum: 'checksum-1',
    status: 'warning',
    score: 82,
    createdAt: '2026-07-30T00:00:00.000Z',
    createdBy: 'user-1',
    engineVersion: 1,
    policy: { ...data.projects[0].auditPolicy },
    summary: {
      totalBytes: 10,
      fileCount: 1,
      largestFiles: [{ path: 'index.html', size: 10 }],
      extensions: [{ extension: '.html', bytes: 10, count: 1 }],
    },
    checks: [
      {
        id: 'seo.title',
        category: 'seo',
        severity: 'warning',
        passed: false,
        message: 'Title is missing',
      },
    ],
  });

  repository.save(data);
  repository.mutate((next) => {
    next.artifactAudits[0] = {
      ...next.artifactAudits[0],
      id: 'audit-2',
      score: 100,
      status: 'passed',
      checks: [],
    };
  });

  const loaded = repository.load();
  expect(loaded.projects[0].auditPolicy).toEqual(data.projects[0].auditPolicy);
  expect(loaded.artifactAudits).toEqual([
    expect.objectContaining({
      id: 'audit-2',
      versionId: 'version-1',
      score: 100,
      status: 'passed',
    }),
  ]);
});

test('round-trips artifact audit job leases, snapshots, and terminal fields', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const repository = createSqliteProjectRepository({ databaseFile });
  const data = createData();
  data.projects[0].versions.push({
    id: 'version-1',
    name: 'v1',
    description: '',
    createdAt: '2026-07-30T00:00:00.000Z',
    size: 10,
    fileCount: 1,
    sourceType: 'folder',
    status: 'preview',
    publishedAt: null,
    publishedBy: null,
    checksum: 'checksum-1',
    integrityStatus: 'verified',
    integrityCheckedAt: '2026-07-30T00:00:00.000Z',
  });
  data.artifactAuditJobs.push({
    id: 'job-1',
    projectId: 'project-1',
    versionId: 'version-1',
    requestedBy: 'user-1',
    status: 'running',
    priority: 7,
    attempts: 1,
    maxAttempts: 3,
    nextRunAt: '2026-07-30T00:00:00.000Z',
    lockedBy: 'worker-1',
    lockedUntil: '2026-07-30T00:01:30.000Z',
    artifactChecksum: 'checksum-1',
    engineVersion: 1,
    policy: { ...data.projects[0].auditPolicy },
    reportId: null,
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:05.000Z',
    startedAt: '2026-07-30T00:00:05.000Z',
    completedAt: null,
  });

  repository.save(data);

  expect(repository.load().artifactAuditJobs).toEqual(data.artifactAuditJobs);
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

test('retains and paginates more than 200 audit events with a release ledger', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const repository = createSqliteProjectRepository({ databaseFile });
  repository.save(createData());

  for (let batch = 0; batch < 10; batch += 1) {
    repository.mutate((data) => {
      const project = data.projects[0];
      for (let offset = 0; offset < 25; offset += 1) {
        const ordinal = batch * 25 + offset;
        appendHistoryEvent(
          data,
          ordinal === 249 ? 'version.publish' : 'project.update',
          project,
          'user-1',
          ordinal === 249 ? { id: 'version-live', name: 'live' } : undefined,
          ordinal === 249 ? { previousActiveVersionId: null } : { ordinal }
        );
      }
    });
  }

  expect(repository.load().history).toHaveLength(200);

  const eventIds: string[] = [];
  let cursor: string | undefined;
  do {
    const page = repository.listHistoryPage?.({
      projectIds: null,
      limit: '37',
      cursor,
    });
    expect(page).toBeDefined();
    if (!page) break;
    eventIds.push(...page.items.map((event) => event.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  expect(eventIds).toHaveLength(250);
  expect(new Set(eventIds).size).toBe(250);

  const database = new Database(databaseFile);
  const auditCount = database
    .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM audit_events')
    .get();
  const releases = database
    .query<
      {
        action: string;
        version_id: string;
        previous_version_id: string | null;
      },
      []
    >(
      `SELECT action, version_id, previous_version_id
       FROM releases`
    )
    .all();
  database.close();

  expect(auditCount?.count).toBe(250);
  expect(releases).toEqual([
    {
      action: 'version.publish',
      version_id: 'version-live',
      previous_version_id: null,
    },
  ]);
});
