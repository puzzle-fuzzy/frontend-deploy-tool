import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
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
          maxJavaScriptBytes: 10 * 1024 * 1024,
          maxStylesheetBytes: 2 * 1024 * 1024,
          maxFontBytes: 10 * 1024 * 1024,
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

function downgradeSchemaToV6(database: Database): void {
  for (const [table, column] of [
    ['projects', 'audit_max_javascript_bytes'],
    ['projects', 'audit_max_stylesheet_bytes'],
    ['projects', 'audit_max_font_bytes'],
    ['artifact_audits', 'context_json'],
    ['artifact_audit_jobs', 'context_json'],
  ] as const) {
    const present = database
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .some((candidate) => candidate.name === column);
    if (present) database.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
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
    'api_token_security_events',
    'artifact_audit_jobs',
    'artifact_audits',
    'audit_events',
    'ci_idempotency_records',
    'project_api_tokens',
    'project_members',
    'projects',
    'releases',
    'schema_migrations',
    'sessions',
    'users',
    'versions',
  ]);
});

test('upgrades relational v6 audit snapshots to v7 without rejecting small total budgets', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const database = new Database(databaseFile, { create: true });
  configureSqlite(database);
  createRelationalSchema(database);
  for (const [table, column] of [
    ['projects', 'audit_max_javascript_bytes'],
    ['projects', 'audit_max_stylesheet_bytes'],
    ['projects', 'audit_max_font_bytes'],
    ['artifact_audits', 'context_json'],
    ['artifact_audit_jobs', 'context_json'],
  ] as const) {
    const present = database
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .some((candidate) => candidate.name === column);
    if (present) database.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
  const policy = {
    enforcement: 'blocking' as const,
    maxTotalBytes: 1_024,
    maxFileBytes: 512,
    maxFileCount: 10,
  };
  database
    .query(
      `INSERT INTO users (
         id, name, email, password_hash, role, created_at, updated_at, sort_order
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'user-1',
      'Owner',
      'owner@example.com',
      'hash',
      'developer',
      '2026-07-30T00:00:00.000Z',
      '2026-07-30T00:00:00.000Z',
      0
    );
  database
    .query(
      `INSERT INTO projects (
         id, name, slug, description, created_at, updated_at, active_version_id,
         spa_mode, routing_type, audit_enforcement, audit_max_total_bytes,
         audit_max_file_bytes, audit_max_file_count, created_by, sort_order
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'project-1',
      'Project',
      'project',
      '',
      '2026-07-30T00:00:00.000Z',
      '2026-07-30T00:00:00.000Z',
      null,
      1,
      'hash',
      policy.enforcement,
      policy.maxTotalBytes,
      policy.maxFileBytes,
      policy.maxFileCount,
      'user-1',
      0
    );
  database
    .query(
      `INSERT INTO versions (
         id, project_id, name, description, created_at, size, file_count,
         source_type, status, published_at, published_by, checksum,
         integrity_status, integrity_checked_at, sort_order
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'version-1',
      'project-1',
      'v1',
      '',
      '2026-07-30T00:00:00.000Z',
      10,
      1,
      'folder',
      'preview',
      null,
      null,
      'checksum-1',
      'verified',
      '2026-07-30T00:00:00.000Z',
      0
    );
  database
    .query(
      `INSERT INTO artifact_audits (
         id, project_id, version_id, artifact_checksum, status, score,
         created_at, created_by, engine_version, policy_json, summary_json,
         checks_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'report-1',
      'project-1',
      'version-1',
      'checksum-1',
      'warning',
      90,
      '2026-07-30T00:01:00.000Z',
      'user-1',
      1,
      JSON.stringify(policy),
      JSON.stringify({
        totalBytes: 10,
        fileCount: 1,
        largestFiles: [{ path: 'index.html', size: 10 }],
        extensions: [{ extension: '.html', bytes: 10, count: 1 }],
      }),
      JSON.stringify([
        {
          id: 'seo.title',
          category: 'seo',
          severity: 'warning',
          passed: false,
          message: 'Title is missing',
        },
      ])
    );
  database
    .query(
      `INSERT INTO artifact_audit_jobs (
         id, project_id, version_id, requested_by, status, priority, attempts,
         max_attempts, next_run_at, locked_by, locked_until, artifact_checksum,
         engine_version, policy_json, report_id, error_code, error_message,
         created_at, updated_at, started_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'job-1',
      'project-1',
      'version-1',
      'user-1',
      'succeeded',
      0,
      1,
      3,
      '2026-07-30T00:00:00.000Z',
      null,
      null,
      'checksum-1',
      1,
      JSON.stringify(policy),
      'report-1',
      null,
      null,
      '2026-07-30T00:00:00.000Z',
      '2026-07-30T00:01:00.000Z',
      '2026-07-30T00:00:05.000Z',
      '2026-07-30T00:01:00.000Z'
    );
  database.exec(`
    DELETE FROM schema_migrations;
    INSERT INTO schema_migrations (version, applied_at)
    VALUES
      (1, '2026-07-30T00:00:00.000Z'),
      (2, '2026-07-30T00:00:00.000Z'),
      (3, '2026-07-30T00:00:00.000Z'),
      (4, '2026-07-30T00:00:00.000Z'),
      (5, '2026-07-30T00:00:00.000Z'),
      (6, '2026-07-30T00:00:00.000Z');
  `);
  database.close();

  const loaded = createSqliteProjectRepository({ databaseFile }).load();
  const verify = new Database(databaseFile);
  const migration = verify
    .query<{ version: number | null }, []>(
      'SELECT MAX(version) AS version FROM schema_migrations'
    )
    .get();
  const integrity = verify
    .query<{ integrity_check: string }, []>('PRAGMA integrity_check')
    .get();
  const foreignKeyViolations = verify.query('PRAGMA foreign_key_check').all();
  verify.close();

  expect(migration?.version).toBe(7);
  expect(integrity?.integrity_check).toBe('ok');
  expect(foreignKeyViolations).toEqual([]);
  expect(existsSync(`${databaseFile}.pre-relational-v7.bak`)).toBe(true);
  expect(loaded.projects[0].auditPolicy).toEqual({
    ...policy,
    maxJavaScriptBytes: 10 * 1024 * 1024,
    maxStylesheetBytes: 2 * 1024 * 1024,
    maxFontBytes: 10 * 1024 * 1024,
  });
  expect(loaded.artifactAudits[0]).toMatchObject({
    engineVersion: 1,
    context: { spaMode: false, routingType: 'path' },
    summary: {
      assetBytes: {
        javascript: 0,
        stylesheet: 0,
        font: 0,
        image: 0,
      },
    },
    checks: [{ ruleVersion: 1 }],
  });
  expect(loaded.artifactAuditJobs[0]).toMatchObject({
    engineVersion: 1,
    context: { spaMode: false, routingType: 'path' },
  });
});

test('fails relational v6 to v7 closed when an audit budget column has drifted', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const database = new Database(databaseFile, { create: true });
  configureSqlite(database);
  createRelationalSchema(database);
  downgradeSchemaToV6(database);
  database.exec(`
    ALTER TABLE projects
      ADD COLUMN audit_max_javascript_bytes TEXT NULL;
    DELETE FROM schema_migrations;
    INSERT INTO schema_migrations (version, applied_at)
    VALUES
      (1, '2026-07-30T00:00:00.000Z'),
      (2, '2026-07-30T00:00:00.000Z'),
      (3, '2026-07-30T00:00:00.000Z'),
      (4, '2026-07-30T00:00:00.000Z'),
      (5, '2026-07-30T00:00:00.000Z'),
      (6, '2026-07-30T00:00:00.000Z');
  `);
  database.close();

  expect(() => createSqliteProjectRepository({ databaseFile }).load()).toThrow(
    'duplicate column name: audit_max_javascript_bytes'
  );

  const verify = new Database(databaseFile);
  const migration = verify
    .query<{ version: number | null }, []>(
      'SELECT MAX(version) AS version FROM schema_migrations'
    )
    .get();
  const javascriptColumn = verify
    .query<{ name: string; type: string; notnull: number }, []>(
      'PRAGMA table_info(projects)'
    )
    .all()
    .find((column) => column.name === 'audit_max_javascript_bytes');
  verify.close();

  expect(migration?.version).toBe(6);
  expect(javascriptColumn).toMatchObject({ type: 'TEXT', notnull: 0 });
  expect(existsSync(`${databaseFile}.pre-relational-v7.bak`)).toBe(true);
});

test('upgrades the deployed relational v3 schema to v7 with a backup', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const database = new Database(databaseFile, { create: true });
  configureSqlite(database);
  createRelationalSchema(database);
  downgradeSchemaToV6(database);
  database.exec(`
    DROP TABLE ci_idempotency_records;
    DROP TABLE api_token_security_events;
    DROP TABLE project_api_tokens;
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
  expect(migration?.version).toBe(7);
  expect(jobColumns).toContain('locked_until');
  expect(jobColumns).toContain('policy_json');
  expect(existsSync(`${databaseFile}.pre-relational-v7.bak`)).toBe(true);
});

test('upgrades relational v5 to v7 with token tables and a backup', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const database = new Database(databaseFile, { create: true });
  configureSqlite(database);
  createRelationalSchema(database);
  downgradeSchemaToV6(database);
  database.exec(`
    DROP TABLE ci_idempotency_records;
    DROP TABLE api_token_security_events;
    DROP TABLE project_api_tokens;
    DELETE FROM schema_migrations;
    INSERT INTO schema_migrations (version, applied_at)
    VALUES
      (1, '2026-07-30T00:00:00.000Z'),
      (2, '2026-07-30T00:00:00.000Z'),
      (3, '2026-07-30T00:00:00.000Z'),
      (4, '2026-07-30T00:00:00.000Z'),
      (5, '2026-07-30T00:00:00.000Z');
  `);
  database.close();

  createSqliteProjectRepository({ databaseFile }).load();

  const verify = new Database(databaseFile);
  const migration = verify
    .query<{ version: number }, []>(
      'SELECT MAX(version) AS version FROM schema_migrations'
    )
    .get();
  const tables = verify
    .query<{ name: string }, []>(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
         AND name IN (
           'project_api_tokens',
           'api_token_security_events',
           'ci_idempotency_records'
         )
       ORDER BY name`
    )
    .all()
    .map((row) => row.name);
  verify.close();

  expect(migration?.version).toBe(7);
  expect(tables).toEqual([
    'api_token_security_events',
    'ci_idempotency_records',
    'project_api_tokens',
  ]);
  expect(existsSync(`${databaseFile}.pre-relational-v7.bak`)).toBe(true);
});

test('refuses to mark v6 applied when a token table has drifted', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const database = new Database(databaseFile, { create: true });
  configureSqlite(database);
  createRelationalSchema(database);
  downgradeSchemaToV6(database);
  database.exec(`
    DROP TABLE ci_idempotency_records;
    DROP TABLE api_token_security_events;
    DROP TABLE project_api_tokens;
    CREATE TABLE project_api_tokens (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL
    );
    DELETE FROM schema_migrations;
    INSERT INTO schema_migrations (version, applied_at)
    VALUES
      (1, '2026-07-30T00:00:00.000Z'),
      (2, '2026-07-30T00:00:00.000Z'),
      (3, '2026-07-30T00:00:00.000Z'),
      (4, '2026-07-30T00:00:00.000Z'),
      (5, '2026-07-30T00:00:00.000Z');
  `);
  database.close();

  expect(() => createSqliteProjectRepository({ databaseFile }).load()).toThrow(
    'table project_api_tokens already exists'
  );

  const verify = new Database(databaseFile);
  const migration = verify
    .query<{ version: number }, []>(
      'SELECT MAX(version) AS version FROM schema_migrations'
    )
    .get();
  const tokenColumns = verify
    .query<{ name: string }, []>('PRAGMA table_info(project_api_tokens)')
    .all()
    .map((column) => column.name);
  verify.close();
  expect(migration?.version).toBe(5);
  expect(tokenColumns).toEqual(['id', 'project_id']);
  expect(existsSync(`${databaseFile}.pre-relational-v7.bak`)).toBe(true);
});

test('upgrades relational v1 through v7 with policy, audit, jobs, integrity, and backup', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const database = new Database(databaseFile, { create: true });
  configureSqlite(database);
  createRelationalSchema(database);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE ci_idempotency_records;
    DROP TABLE api_token_security_events;
    DROP TABLE project_api_tokens;
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
  expect(migration?.version).toBe(7);
  expect(existsSync(`${databaseFile}.pre-relational-v7.bak`)).toBe(true);
});

test('upgrades the deployed relational v2 schema to v7 with a backup', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const database = new Database(databaseFile, { create: true });
  configureSqlite(database);
  createRelationalSchema(database);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE ci_idempotency_records;
    DROP TABLE api_token_security_events;
    DROP TABLE project_api_tokens;
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
  expect(migration?.version).toBe(7);
  expect(auditColumns).toContain('engine_version');
  expect(auditColumns).toContain('policy_json');
  expect(existsSync(`${databaseFile}.pre-relational-v7.bak`)).toBe(true);
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
  writeFileSync(
    legacyDataFile,
    JSON.stringify({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      projects: 'not-an-array',
    })
  );

  expect(repository.load().projects[0]?.name).toBe('SQLite Project');
  expect(existsSync(`${legacyDataFile}.sqlite-migration.bak`)).toBe(false);
});

test('invalid WAL deploykit_state preflight never creates source SHM or mutates source bytes', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const database = new Database(databaseFile, { create: true });
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA wal_autocheckpoint = 0');
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
       VALUES (1, 9, ?, ?)`
    )
    .run(
      JSON.stringify({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        projects: 'not-an-array',
        users: [],
        history: [],
        artifactAudits: [],
        artifactAuditJobs: [],
      }),
      '2026-07-24T00:00:00.000Z'
    );
  rmSync(`${databaseFile}-shm`, { force: true });
  const originalMain = readFileSync(databaseFile);
  const originalWal = readFileSync(`${databaseFile}-wal`);

  try {
    expect(() =>
      createSqliteProjectRepository({ databaseFile }).load()
    ).toThrow('Document schema v9 failed validation');

    expect(readFileSync(databaseFile)).toEqual(originalMain);
    expect(readFileSync(`${databaseFile}-wal`)).toEqual(originalWal);
    expect(existsSync(`${databaseFile}-shm`)).toBe(false);
    expect(existsSync(`${databaseFile}.pre-relational-v1.bak`)).toBe(false);
  } finally {
    database.close();
  }
});

test('invalid legacy JSON preflight creates no backup or SQLite target', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const legacyDataFile = join(tempDir, 'data.json');
  const original = Buffer.from(
    JSON.stringify({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      projects: 'not-an-array',
      users: [],
      history: [],
      artifactAudits: [],
      artifactAuditJobs: [],
    })
  );
  writeFileSync(legacyDataFile, original);

  expect(() =>
    createSqliteProjectRepository({ databaseFile, legacyDataFile }).load()
  ).toThrow('Document schema v9 failed validation');

  expect(readFileSync(legacyDataFile)).toEqual(original);
  expect(existsSync(`${legacyDataFile}.sqlite-migration.bak`)).toBe(false);
  expect(existsSync(databaseFile)).toBe(false);
  expect(existsSync(`${databaseFile}-wal`)).toBe(false);
  expect(existsSync(`${databaseFile}-shm`)).toBe(false);
});

test('legacy JSON backup uses validated bytes and aborts on same-inode content drift', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const legacyDataFile = join(tempDir, 'data.json');
  const original = Buffer.from(JSON.stringify(createData('Validated JSON')));
  const replacement = Buffer.from(
    JSON.stringify(createData('Changed After Validation'))
  );
  writeFileSync(legacyDataFile, original);

  const repository = createSqliteProjectRepository(
    { databaseFile, legacyDataFile },
    {
      afterLegacySourceValidated() {
        writeFileSync(legacyDataFile, replacement);
      },
    }
  );

  expect(() => repository.load()).toThrow(
    'Legacy migration source changed after validation'
  );
  expect(readFileSync(legacyDataFile)).toEqual(replacement);
  expect(readFileSync(`${legacyDataFile}.sqlite-migration.bak`)).toEqual(
    original
  );
  expect(existsSync(databaseFile)).toBe(false);
  expect(existsSync(`${databaseFile}-wal`)).toBe(false);
  expect(existsSync(`${databaseFile}-shm`)).toBe(false);
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
  writeFileSync(backupFile, 'stale backup');

  const repository = createSqliteProjectRepository({ databaseFile });
  expect(repository.load().schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  expect(existsSync(backupFile)).toBe(true);
  const firstBackup = readFileSync(backupFile);
  expect(firstBackup.toString()).not.toBe('stale backup');

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

test('legacy SQLite backup uses the validated snapshot and aborts on identity replacement', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const displacedDatabaseFile = `${databaseFile}.validated-source`;
  const backupFile = `${databaseFile}.pre-relational-v1.bak`;
  const payload = JSON.stringify({
    projects: [],
    users: [],
    history: [],
  });
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
    .run(payload, '2026-07-24T00:00:00.000Z');
  database.close();
  const original = readFileSync(databaseFile);
  const replacement = Buffer.from('replacement database bytes');

  const repository = createSqliteProjectRepository(
    { databaseFile },
    {
      afterLegacySourceValidated() {
        renameSync(databaseFile, displacedDatabaseFile);
        writeFileSync(databaseFile, replacement);
      },
    }
  );

  expect(() => repository.load()).toThrow(
    'Legacy migration source changed after validation'
  );
  expect(readFileSync(displacedDatabaseFile)).toEqual(original);
  expect(readFileSync(databaseFile)).toEqual(replacement);
  expect(existsSync(`${databaseFile}-wal`)).toBe(false);
  expect(existsSync(`${databaseFile}-shm`)).toBe(false);

  const backup = new Database(backupFile, { readonly: true });
  const backedUpPayload = backup
    .query<{ payload: string }, []>(
      'SELECT payload FROM deploykit_state WHERE id = 1'
    )
    .get()?.payload;
  backup.close();
  expect(backedUpPayload).toBe(payload);
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
    maxJavaScriptBytes: 1_500,
    maxStylesheetBytes: 500,
    maxFontBytes: 1_250,
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
    context: { spaMode: false, routingType: 'path' },
    summary: {
      totalBytes: 10,
      fileCount: 1,
      largestFiles: [{ path: 'index.html', size: 10 }],
      extensions: [{ extension: '.html', bytes: 10, count: 1 }],
      assetBytes: {
        javascript: 0,
        stylesheet: 0,
        font: 0,
        image: 0,
      },
    },
    checks: [
      {
        id: 'seo.title',
        ruleVersion: 1,
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
    context: { spaMode: false, routingType: 'path' },
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
