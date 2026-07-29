import type { Database } from 'bun:sqlite';

export const RELATIONAL_SCHEMA_VERSION = 2;

const RELATIONAL_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'developer', 'viewer')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sort_order INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    active_version_id TEXT NULL,
    spa_mode INTEGER NOT NULL CHECK (spa_mode IN (0, 1)),
    routing_type TEXT NOT NULL CHECK (routing_type IN ('hash', 'path')),
    created_by TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    FOREIGN KEY (active_version_id) REFERENCES versions(id)
      ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED
  );

  CREATE TABLE IF NOT EXISTS versions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size >= 0),
    file_count INTEGER NOT NULL CHECK (file_count >= 0),
    source_type TEXT NOT NULL CHECK (source_type IN ('zip', 'folder', 'unknown')),
    status TEXT NOT NULL CHECK (
      status IN ('preview', 'production', 'archived', 'failed')
    ),
    published_at TEXT NULL,
    published_by TEXT NULL,
    checksum TEXT NOT NULL,
    integrity_status TEXT NOT NULL DEFAULT 'unknown' CHECK (
      integrity_status IN ('unknown', 'verified', 'missing', 'corrupted')
    ),
    integrity_checked_at TEXT NULL,
    sort_order INTEGER NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    UNIQUE (project_id, id)
  );

  CREATE INDEX IF NOT EXISTS versions_project_order_idx
    ON versions(project_id, sort_order);

  CREATE TABLE IF NOT EXISTS project_members (
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    invited_at TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    PRIMARY KEY (project_id, user_id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS project_members_user_idx
    ON project_members(user_id, project_id);

  CREATE TABLE IF NOT EXISTS audit_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    action TEXT NOT NULL,
    project_id TEXT NOT NULL,
    project_name TEXT NOT NULL,
    version_id TEXT NOT NULL,
    version_name TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    metadata_json TEXT NULL
  );

  CREATE INDEX IF NOT EXISTS audit_events_project_sequence_idx
    ON audit_events(project_id, sequence DESC);

  CREATE TABLE IF NOT EXISTS releases (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    project_name TEXT NOT NULL,
    version_id TEXT NOT NULL,
    version_name TEXT NOT NULL,
    previous_version_id TEXT NULL,
    action TEXT NOT NULL CHECK (
      action IN ('version.publish', 'version.activate', 'version.rollback')
    ),
    actor_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS releases_project_created_idx
    ON releases(project_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('browser', 'desktop')),
    created_at TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at TEXT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS sessions_user_expiry_idx
    ON sessions(user_id, expires_at DESC);
`;

export function configureSqlite(database: Database): void {
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA synchronous = NORMAL');
  database.exec('PRAGMA busy_timeout = 5000');
}

export function createRelationalSchema(database: Database): void {
  database.exec(RELATIONAL_SCHEMA_SQL);
}

export function hasTable(database: Database, tableName: string): boolean {
  return Boolean(
    database
      .query<{ present: number }, [string]>(
        `SELECT 1 AS present
         FROM sqlite_master
         WHERE type = 'table' AND name = ?
         LIMIT 1`
      )
      .get(tableName)
  );
}

export function hasRelationalMigration(database: Database): boolean {
  return getRelationalSchemaVersion(database) >= RELATIONAL_SCHEMA_VERSION;
}

export function getRelationalSchemaVersion(database: Database): number {
  if (!hasTable(database, 'schema_migrations')) return 0;
  return (
    database
      .query<{ version: number | null }, []>(
        'SELECT MAX(version) AS version FROM schema_migrations'
      )
      .get()?.version ?? 0
  );
}

export function upgradeRelationalSchema(
  database: Database,
  fromVersion: number
): void {
  if (fromVersion < 2) {
    database.exec(`
      ALTER TABLE versions
        ADD COLUMN integrity_status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (
          integrity_status IN ('unknown', 'verified', 'missing', 'corrupted')
        );
      ALTER TABLE versions
        ADD COLUMN integrity_checked_at TEXT NULL;
    `);
    database
      .query(
        `INSERT INTO schema_migrations (version, applied_at)
         VALUES (2, ?)`
      )
      .run(new Date().toISOString());
  }
}
