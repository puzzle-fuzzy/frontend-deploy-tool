import type { Database } from 'bun:sqlite';

export const RELATIONAL_SCHEMA_VERSION = 6;

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
    audit_enforcement TEXT NOT NULL DEFAULT 'advisory' CHECK (
      audit_enforcement IN ('advisory', 'blocking')
    ),
    audit_max_total_bytes INTEGER NOT NULL DEFAULT 52428800 CHECK (
      audit_max_total_bytes > 0
    ),
    audit_max_file_bytes INTEGER NOT NULL DEFAULT 10485760 CHECK (
      audit_max_file_bytes > 0
    ),
    audit_max_file_count INTEGER NOT NULL DEFAULT 1000 CHECK (
      audit_max_file_count > 0
    ),
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

  CREATE TABLE IF NOT EXISTS artifact_audits (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    version_id TEXT NOT NULL UNIQUE,
    artifact_checksum TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('passed', 'warning', 'failed')),
    score INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    engine_version INTEGER NOT NULL CHECK (engine_version > 0),
    policy_json TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    checks_json TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (version_id) REFERENCES versions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS artifact_audits_project_created_idx
    ON artifact_audits(project_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS artifact_audit_jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')
    ),
    priority INTEGER NOT NULL CHECK (priority >= 0 AND priority <= 100),
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    max_attempts INTEGER NOT NULL CHECK (
      max_attempts > 0 AND max_attempts <= 10 AND attempts <= max_attempts
    ),
    next_run_at TEXT NOT NULL,
    locked_by TEXT NULL,
    locked_until TEXT NULL,
    artifact_checksum TEXT NOT NULL,
    engine_version INTEGER NOT NULL CHECK (engine_version > 0),
    policy_json TEXT NOT NULL,
    report_id TEXT NULL,
    error_code TEXT NULL,
    error_message TEXT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT NULL,
    completed_at TEXT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (version_id) REFERENCES versions(id) ON DELETE CASCADE,
    FOREIGN KEY (report_id) REFERENCES artifact_audits(id)
      ON DELETE SET NULL ON UPDATE SET NULL
  );

  CREATE INDEX IF NOT EXISTS artifact_audit_jobs_claim_idx
    ON artifact_audit_jobs(
      status,
      next_run_at,
      priority DESC,
      created_at ASC,
      id ASC
    );

  CREATE INDEX IF NOT EXISTS artifact_audit_jobs_version_created_idx
    ON artifact_audit_jobs(project_id, version_id, created_at DESC, id DESC);

  CREATE UNIQUE INDEX IF NOT EXISTS
    artifact_audit_jobs_active_version_unique_idx
    ON artifact_audit_jobs(project_id, version_id)
    WHERE status IN ('queued', 'running');

  CREATE INDEX IF NOT EXISTS artifact_audit_jobs_version_status_created_idx
    ON artifact_audit_jobs(
      project_id,
      version_id,
      status,
      created_at DESC,
      id DESC
    );

  CREATE INDEX IF NOT EXISTS artifact_audit_jobs_expired_lease_idx
    ON artifact_audit_jobs(locked_until, id)
    WHERE status = 'running';

  CREATE INDEX IF NOT EXISTS artifact_audit_jobs_terminal_retention_idx
    ON artifact_audit_jobs(completed_at, id)
    WHERE status IN ('succeeded', 'failed', 'canceled')
      AND completed_at IS NOT NULL;

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

  CREATE TABLE IF NOT EXISTS project_api_tokens (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    hash_version INTEGER NOT NULL CHECK (hash_version = 1),
    secret_digest TEXT NOT NULL CHECK (
      length(secret_digest) = 64
      AND secret_digest NOT GLOB '*[^0-9a-f]*'
    ),
    prefix TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_used_at TEXT NULL,
    revoked_at TEXT NULL,
    replaced_by_token_id TEXT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (replaced_by_token_id) REFERENCES project_api_tokens(id)
      ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED
  );

  CREATE INDEX IF NOT EXISTS project_api_tokens_project_created_idx
    ON project_api_tokens(project_id, created_at DESC, id DESC);

  CREATE INDEX IF NOT EXISTS project_api_tokens_expiry_idx
    ON project_api_tokens(expires_at, id)
    WHERE revoked_at IS NULL;

  CREATE TABLE IF NOT EXISTS api_token_security_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    project_name TEXT NOT NULL,
    token_id TEXT NULL,
    token_prefix TEXT NULL,
    action TEXT NOT NULL CHECK (
      action IN (
        'api_token.create',
        'api_token.rotate',
        'api_token.revoke',
        'api_token.authentication_failed'
      )
    ),
    outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'denied')),
    actor_id TEXT NULL,
    reason TEXT NULL CHECK (
      reason IS NULL OR reason IN (
        'digest_mismatch',
        'expired',
        'revoked',
        'project_mismatch',
        'scope_missing',
        'hash_version_unsupported'
      )
    ),
    occurred_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS api_token_security_events_project_sequence_idx
    ON api_token_security_events(project_id, sequence DESC);

  CREATE TABLE IF NOT EXISTS ci_idempotency_records (
    project_id TEXT NOT NULL,
    token_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    version_id TEXT NOT NULL,
    version_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (project_id, token_id, idempotency_key),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (token_id) REFERENCES project_api_tokens(id) ON DELETE CASCADE,
    FOREIGN KEY (version_id) REFERENCES versions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS ci_idempotency_records_expiry_idx
    ON ci_idempotency_records(expires_at, project_id, token_id);
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
  if (fromVersion < 3) {
    database.exec(`
      ALTER TABLE projects
        ADD COLUMN audit_enforcement TEXT NOT NULL DEFAULT 'advisory'
        CHECK (audit_enforcement IN ('advisory', 'blocking'));
      ALTER TABLE projects
        ADD COLUMN audit_max_total_bytes INTEGER NOT NULL DEFAULT 52428800
        CHECK (audit_max_total_bytes > 0);
      ALTER TABLE projects
        ADD COLUMN audit_max_file_bytes INTEGER NOT NULL DEFAULT 10485760
        CHECK (audit_max_file_bytes > 0);
      ALTER TABLE projects
        ADD COLUMN audit_max_file_count INTEGER NOT NULL DEFAULT 1000
        CHECK (audit_max_file_count > 0);

      CREATE TABLE artifact_audits (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        version_id TEXT NOT NULL UNIQUE,
        artifact_checksum TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('passed', 'warning', 'failed')
        ),
        score INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        engine_version INTEGER NOT NULL CHECK (engine_version > 0),
        policy_json TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        checks_json TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (version_id) REFERENCES versions(id) ON DELETE CASCADE
      );

      CREATE INDEX artifact_audits_project_created_idx
        ON artifact_audits(project_id, created_at DESC);
    `);
    database
      .query(
        `INSERT INTO schema_migrations (version, applied_at)
         VALUES (3, ?)`
      )
      .run(new Date().toISOString());
  }
  if (fromVersion < 4) {
    database.exec(`
      CREATE TABLE artifact_audit_jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')
        ),
        priority INTEGER NOT NULL CHECK (priority >= 0 AND priority <= 100),
        attempts INTEGER NOT NULL CHECK (attempts >= 0),
        max_attempts INTEGER NOT NULL CHECK (
          max_attempts > 0 AND max_attempts <= 10 AND attempts <= max_attempts
        ),
        next_run_at TEXT NOT NULL,
        locked_by TEXT NULL,
        locked_until TEXT NULL,
        artifact_checksum TEXT NOT NULL,
        engine_version INTEGER NOT NULL CHECK (engine_version > 0),
        policy_json TEXT NOT NULL,
        report_id TEXT NULL,
        error_code TEXT NULL,
        error_message TEXT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT NULL,
        completed_at TEXT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (version_id) REFERENCES versions(id) ON DELETE CASCADE,
        FOREIGN KEY (report_id) REFERENCES artifact_audits(id)
          ON DELETE SET NULL ON UPDATE SET NULL
      );

      CREATE INDEX artifact_audit_jobs_claim_idx
        ON artifact_audit_jobs(
          status,
          next_run_at,
          priority DESC,
          created_at
        );

      CREATE INDEX artifact_audit_jobs_version_created_idx
        ON artifact_audit_jobs(project_id, version_id, created_at DESC);
    `);
    database
      .query(
        `INSERT INTO schema_migrations (version, applied_at)
         VALUES (4, ?)`
      )
      .run(new Date().toISOString());
  }
  if (fromVersion < 5) {
    database.exec(`
      CREATE UNIQUE INDEX artifact_audit_jobs_active_version_unique_idx
        ON artifact_audit_jobs(project_id, version_id)
        WHERE status IN ('queued', 'running');

      DROP INDEX artifact_audit_jobs_claim_idx;
      CREATE INDEX artifact_audit_jobs_claim_idx
        ON artifact_audit_jobs(
          status,
          next_run_at,
          priority DESC,
          created_at ASC,
          id ASC
        );

      DROP INDEX artifact_audit_jobs_version_created_idx;
      CREATE INDEX artifact_audit_jobs_version_created_idx
        ON artifact_audit_jobs(
          project_id,
          version_id,
          created_at DESC,
          id DESC
        );

      CREATE INDEX artifact_audit_jobs_version_status_created_idx
        ON artifact_audit_jobs(
          project_id,
          version_id,
          status,
          created_at DESC,
          id DESC
        );

      CREATE INDEX artifact_audit_jobs_expired_lease_idx
        ON artifact_audit_jobs(locked_until, id)
        WHERE status = 'running';

      CREATE INDEX artifact_audit_jobs_terminal_retention_idx
        ON artifact_audit_jobs(completed_at, id)
        WHERE status IN ('succeeded', 'failed', 'canceled')
          AND completed_at IS NOT NULL;
    `);
    database
      .query(
        `INSERT INTO schema_migrations (version, applied_at)
         VALUES (5, ?)`
      )
      .run(new Date().toISOString());
  }
  if (fromVersion < 6) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS project_api_tokens (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        hash_version INTEGER NOT NULL CHECK (hash_version = 1),
        secret_digest TEXT NOT NULL CHECK (
          length(secret_digest) = 64
          AND secret_digest NOT GLOB '*[^0-9a-f]*'
        ),
        prefix TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_used_at TEXT NULL,
        revoked_at TEXT NULL,
        replaced_by_token_id TEXT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
        FOREIGN KEY (replaced_by_token_id) REFERENCES project_api_tokens(id)
          ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED
      );

      CREATE INDEX IF NOT EXISTS project_api_tokens_project_created_idx
        ON project_api_tokens(project_id, created_at DESC, id DESC);

      CREATE INDEX IF NOT EXISTS project_api_tokens_expiry_idx
        ON project_api_tokens(expires_at, id)
        WHERE revoked_at IS NULL;

      CREATE TABLE IF NOT EXISTS api_token_security_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        project_name TEXT NOT NULL,
        token_id TEXT NULL,
        token_prefix TEXT NULL,
        action TEXT NOT NULL CHECK (
          action IN (
            'api_token.create',
            'api_token.rotate',
            'api_token.revoke',
            'api_token.authentication_failed'
          )
        ),
        outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'denied')),
        actor_id TEXT NULL,
        reason TEXT NULL CHECK (
          reason IS NULL OR reason IN (
            'digest_mismatch',
            'expired',
            'revoked',
            'project_mismatch',
            'scope_missing',
            'hash_version_unsupported'
          )
        ),
        occurred_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS api_token_security_events_project_sequence_idx
        ON api_token_security_events(project_id, sequence DESC);

      CREATE TABLE IF NOT EXISTS ci_idempotency_records (
        project_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        version_id TEXT NOT NULL,
        version_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (project_id, token_id, idempotency_key),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (token_id) REFERENCES project_api_tokens(id)
          ON DELETE CASCADE,
        FOREIGN KEY (version_id) REFERENCES versions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS ci_idempotency_records_expiry_idx
        ON ci_idempotency_records(expires_at, project_id, token_id);
    `);
    database
      .query(
        `INSERT INTO schema_migrations (version, applied_at)
         VALUES (6, ?)`
      )
      .run(new Date().toISOString());
  }
}
