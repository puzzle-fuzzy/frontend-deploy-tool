import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { inspectOpenDatabase } from '../../src/services/backupDatabaseInspection';

test('schema v6 inspection preserves count aliases and version ordering', () => {
  const database = new Database(':memory:');
  try {
    createSchemaMetadata(database, [1, 5, 6]);
    seedCountTable(database, 'users', 1);
    seedCountTable(database, 'projects', 2);
    seedVersions(database, [
      {
        id: 'version-b-2',
        projectId: 'project-b',
        sortOrder: 2,
        status: 'failed',
        checksum: 'checksum-b-2',
        integrityStatus: 'corrupted',
      },
      {
        id: 'version-a-2',
        projectId: 'project-a',
        sortOrder: 2,
        status: 'ready',
        checksum: 'checksum-a-2',
        integrityStatus: 'verified',
      },
      {
        id: 'version-a-1',
        projectId: 'project-a',
        sortOrder: 1,
        status: 'processing',
        checksum: 'checksum-a-1',
        integrityStatus: 'pending',
      },
    ]);
    seedCountTable(database, 'artifact_audits', 4);
    seedCountTable(database, 'artifact_audit_jobs', 5);
    seedCountTable(database, 'audit_events', 6);
    seedCountTable(database, 'releases', 7);
    seedCountTable(database, 'sessions', 8);
    seedCountTable(database, 'project_api_tokens', 9);
    seedCountTable(database, 'api_token_security_events', 10);
    seedCountTable(database, 'ci_idempotency_records', 11);

    expect(inspectOpenDatabase(database)).toEqual({
      schemaVersion: 6,
      versions: [
        {
          id: 'version-a-1',
          project_id: 'project-a',
          status: 'processing',
          checksum: 'checksum-a-1',
          integrity_status: 'pending',
        },
        {
          id: 'version-a-2',
          project_id: 'project-a',
          status: 'ready',
          checksum: 'checksum-a-2',
          integrity_status: 'verified',
        },
        {
          id: 'version-b-2',
          project_id: 'project-b',
          status: 'failed',
          checksum: 'checksum-b-2',
          integrity_status: 'corrupted',
        },
      ],
      counts: {
        users: 1,
        projects: 2,
        versions: 3,
        artifactAudits: 4,
        artifactAuditJobs: 5,
        auditEvents: 6,
        releases: 7,
        sessions: 8,
        apiTokens: 9,
        apiTokenSecurityEvents: 10,
        ciIdempotencyRecords: 11,
      },
    });
    expect(
      database.query<{ value: number }, []>('SELECT 1 AS value').get()
    ).toEqual({ value: 1 });
  } finally {
    database.close();
  }
});

test('schema v5 inspection omits schema v6 tables and count keys', () => {
  const database = new Database(':memory:');
  try {
    createSchemaMetadata(database, [1, 5]);
    seedCountTable(database, 'users', 1);
    seedCountTable(database, 'projects', 2);
    seedVersions(database, [
      {
        id: 'version-1',
        projectId: 'project-a',
        sortOrder: 1,
        status: 'ready',
        checksum: 'checksum-1',
        integrityStatus: 'verified',
      },
      {
        id: 'version-2',
        projectId: 'project-a',
        sortOrder: 2,
        status: 'ready',
        checksum: 'checksum-2',
        integrityStatus: 'verified',
      },
      {
        id: 'version-3',
        projectId: 'project-b',
        sortOrder: 1,
        status: 'ready',
        checksum: 'checksum-3',
        integrityStatus: 'verified',
      },
    ]);
    seedCountTable(database, 'artifact_audits', 4);
    seedCountTable(database, 'artifact_audit_jobs', 5);
    seedCountTable(database, 'audit_events', 6);
    seedCountTable(database, 'releases', 7);
    seedCountTable(database, 'sessions', 8);

    const inspection = inspectOpenDatabase(database);
    expect(inspection.counts).toEqual({
      users: 1,
      projects: 2,
      versions: 3,
      artifactAudits: 4,
      artifactAuditJobs: 5,
      auditEvents: 6,
      releases: 7,
      sessions: 8,
    });
    expect(Object.keys(inspection.counts)).toEqual([
      'users',
      'projects',
      'versions',
      'artifactAudits',
      'artifactAuditJobs',
      'auditEvents',
      'releases',
      'sessions',
    ]);
    expect(
      database.query<{ value: number }, []>('SELECT 1 AS value').get()
    ).toEqual({ value: 1 });
  } finally {
    database.close();
  }
});

function createSchemaMetadata(
  database: Database,
  schemaVersions: readonly number[]
): void {
  database.exec('CREATE TABLE schema_migrations (version INTEGER NOT NULL)');
  const insert = database.query(
    'INSERT INTO schema_migrations (version) VALUES (?)'
  );
  for (const schemaVersion of schemaVersions) insert.run(schemaVersion);
}

function seedCountTable(
  database: Database,
  table: string,
  rowCount: number
): void {
  database.exec(`CREATE TABLE ${table} (id INTEGER NOT NULL)`);
  const insert = database.query(`INSERT INTO ${table} (id) VALUES (?)`);
  for (let id = 1; id <= rowCount; id += 1) insert.run(id);
}

function seedVersions(
  database: Database,
  rows: Array<{
    id: string;
    projectId: string;
    sortOrder: number;
    status: string;
    checksum: string;
    integrityStatus: string;
  }>
): void {
  database.exec(`CREATE TABLE versions (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    status TEXT NOT NULL,
    checksum TEXT NOT NULL,
    integrity_status TEXT NOT NULL
  )`);
  const insert = database.query(
    `INSERT INTO versions (
      id, project_id, sort_order, status, checksum, integrity_status
    ) VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.projectId,
      row.sortOrder,
      row.status,
      row.checksum,
      row.integrityStatus
    );
  }
}
