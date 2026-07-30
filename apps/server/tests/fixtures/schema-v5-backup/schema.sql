PRAGMA foreign_keys = ON;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'developer', 'viewer')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sort_order INTEGER NOT NULL
);

CREATE TABLE projects (
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

CREATE TABLE versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  file_count INTEGER NOT NULL CHECK (file_count >= 0),
  source_type TEXT NOT NULL CHECK (
    source_type IN ('zip', 'folder', 'unknown')
  ),
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

CREATE INDEX versions_project_order_idx
  ON versions(project_id, sort_order);

CREATE TABLE artifact_audits (
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

CREATE INDEX artifact_audits_project_created_idx
  ON artifact_audits(project_id, created_at DESC);

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
    created_at ASC,
    id ASC
  );

CREATE INDEX artifact_audit_jobs_version_created_idx
  ON artifact_audit_jobs(
    project_id,
    version_id,
    created_at DESC,
    id DESC
  );

CREATE UNIQUE INDEX artifact_audit_jobs_active_version_unique_idx
  ON artifact_audit_jobs(project_id, version_id)
  WHERE status IN ('queued', 'running');

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

CREATE TABLE project_members (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  invited_at TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX project_members_user_idx
  ON project_members(user_id, project_id);

CREATE TABLE audit_events (
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

CREATE INDEX audit_events_project_sequence_idx
  ON audit_events(project_id, sequence DESC);

CREATE TABLE releases (
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

CREATE INDEX releases_project_created_idx
  ON releases(project_id, created_at DESC);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('browser', 'desktop')),
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at TEXT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX sessions_user_expiry_idx
  ON sessions(user_id, expires_at DESC);

INSERT INTO schema_migrations (version, applied_at) VALUES
  (1, '2026-07-01T00:00:00.000Z'),
  (2, '2026-07-01T00:00:00.000Z'),
  (3, '2026-07-01T00:00:00.000Z'),
  (4, '2026-07-01T00:00:00.000Z'),
  (5, '2026-07-01T00:00:00.000Z');

INSERT INTO projects (
  id,
  name,
  slug,
  description,
  created_at,
  updated_at,
  active_version_id,
  spa_mode,
  routing_type,
  audit_enforcement,
  audit_max_total_bytes,
  audit_max_file_bytes,
  audit_max_file_count,
  created_by,
  sort_order
) VALUES (
  'schema-v5-project',
  'Preserved Schema V5 Project',
  'preserved-schema-v5',
  'Frozen compatibility fixture',
  '2026-07-01T00:00:00.000Z',
  '2026-07-01T00:00:00.000Z',
  NULL,
  0,
  'path',
  'advisory',
  52428800,
  10485760,
  1000,
  'legacy-system',
  0
);
