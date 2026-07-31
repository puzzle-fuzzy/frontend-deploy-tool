import { Database } from 'bun:sqlite';
import type { BackupManifest } from './backupTypes';

export interface VersionIntegrityRow {
  id: string;
  project_id: string;
  status: string;
  checksum: string;
  integrity_status: string;
}

export interface BackupDatabaseInspection {
  schemaVersion: number;
  versions: VersionIntegrityRow[];
  counts: BackupManifest['metadataCounts'];
}

export function inspectOpenDatabase(
  database: Database
): BackupDatabaseInspection {
  const count = (table: string): number =>
    database
      .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`)
      .get()?.count ?? 0;
  const schemaVersion =
    database
      .query<{ version: number | null }, []>(
        'SELECT MAX(version) AS version FROM schema_migrations'
      )
      .get()?.version ?? 0;
  const versions = database
    .query<VersionIntegrityRow, []>(
      `SELECT id, project_id, status, checksum, integrity_status
       FROM versions
       ORDER BY project_id, sort_order`
    )
    .all();
  return {
    schemaVersion,
    versions,
    counts: {
      users: count('users'),
      projects: count('projects'),
      versions: count('versions'),
      artifactAudits: count('artifact_audits'),
      artifactAuditJobs: count('artifact_audit_jobs'),
      auditEvents: count('audit_events'),
      releases: count('releases'),
      sessions: count('sessions'),
      ...(schemaVersion >= 6
        ? {
            apiTokens: count('project_api_tokens'),
            apiTokenSecurityEvents: count('api_token_security_events'),
            ciIdempotencyRecords: count('ci_idempotency_records'),
          }
        : {}),
    },
  };
}

export function inspectDatabase(
  databaseFile: string
): BackupDatabaseInspection {
  const database = new Database(databaseFile, { readonly: true });
  try {
    return inspectOpenDatabase(database);
  } finally {
    database.close();
  }
}
