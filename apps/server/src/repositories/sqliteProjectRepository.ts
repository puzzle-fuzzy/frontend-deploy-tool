import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  ArtifactAuditJob,
  ArtifactAuditReport,
  Data,
  HistoryAction,
  HistoryEvent,
  Project,
  ProjectMember,
  User,
  Version,
} from '@deploykit/shared';
import {
  artifactAuditJobSchema,
  artifactAuditReportSchema,
} from '@deploykit/shared';
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  parseHistoryLimit,
} from '../domain/history';
import {
  CURRENT_SCHEMA_VERSION,
  createEmptyData,
  migrate,
} from '../domain/schema';
import { createJsonProjectRepository } from './jsonProjectRepository';
import type {
  HistoryPageRequest,
  ProjectRepository,
} from './projectRepository';
import {
  configureSqlite,
  createRelationalSchema,
  getRelationalSchemaVersion,
  hasRelationalMigration,
  hasTable,
  RELATIONAL_SCHEMA_VERSION,
  upgradeRelationalSchema,
} from './sqliteSchema';

interface LegacyStateRow {
  payload: string;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: User['role'];
  created_at: string;
  updated_at: string;
}

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  created_at: string;
  updated_at: string;
  active_version_id: string | null;
  spa_mode: number;
  routing_type: Project['settings']['routingType'];
  audit_enforcement: Project['auditPolicy']['enforcement'];
  audit_max_total_bytes: number;
  audit_max_file_bytes: number;
  audit_max_file_count: number;
  created_by: string;
}

interface VersionRow {
  id: string;
  project_id: string;
  name: string;
  description: string;
  created_at: string;
  size: number;
  file_count: number;
  source_type: Version['sourceType'];
  status: Version['status'];
  published_at: string | null;
  published_by: string | null;
  checksum: string;
  integrity_status: Version['integrityStatus'];
  integrity_checked_at: string | null;
}

interface MemberRow {
  project_id: string;
  user_id: string;
  role: ProjectMember['role'];
  invited_at: string;
}

interface AuditRow {
  id: string;
  action: HistoryAction;
  project_id: string;
  project_name: string;
  version_id: string;
  version_name: string;
  occurred_at: string;
  actor_id: string;
  metadata_json: string | null;
}

interface SequencedAuditRow extends AuditRow {
  sequence: number;
}

interface ArtifactAuditRow {
  id: string;
  project_id: string;
  version_id: string;
  artifact_checksum: string;
  status: ArtifactAuditReport['status'];
  score: number;
  created_at: string;
  created_by: string;
  engine_version: number;
  policy_json: string;
  summary_json: string;
  checks_json: string;
}

interface ArtifactAuditJobRow {
  id: string;
  project_id: string;
  version_id: string;
  requested_by: string;
  status: ArtifactAuditJob['status'];
  priority: number;
  attempts: number;
  max_attempts: number;
  next_run_at: string;
  locked_by: string | null;
  locked_until: string | null;
  artifact_checksum: string;
  engine_version: number;
  policy_json: string;
  report_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface SqliteProjectRepositoryOptions {
  databaseFile: string;
  legacyDataFile?: string;
}

/**
 * Relational SQLite metadata repository.
 *
 * Services still mutate the domain aggregate synchronously, but this adapter
 * hydrates it from normalized rows and commits row-level upserts/deletes in one
 * IMMEDIATE transaction. Audit rows are append-only: the aggregate carries a
 * bounded compatibility window while SQL pagination can retain the full log.
 */
export function createSqliteProjectRepository({
  databaseFile,
  legacyDataFile,
}: SqliteProjectRepositoryOptions): ProjectRepository {
  const withDatabase = <T>(work: (database: Database) => T): T => {
    mkdirSync(dirname(databaseFile), { recursive: true });
    const database = new Database(databaseFile, { create: true });
    try {
      configureSqlite(database);
      initializeDatabase(database, databaseFile, legacyDataFile);
      return work(database);
    } finally {
      database.close();
    }
  };

  return {
    load(): Data {
      return withDatabase(loadRelationalData);
    },

    save(data: Data): void {
      withDatabase((database) => {
        const replace = database.transaction((nextData: Data) => {
          replaceDomainData(database, nextData);
        });
        replace.immediate(data);
      });
    },

    mutate<T>(operation: (data: Data) => T): T {
      return withDatabase((database) => {
        const applyMutation = database.transaction(
          (nextOperation: (data: Data) => T) => {
            const data = loadRelationalData(database);
            const before = structuredClone(data);
            const result = nextOperation(data);
            persistDomainDiff(database, before, data);
            return result;
          }
        );
        return applyMutation.immediate(operation);
      });
    },

    listHistoryPage(
      request
    ): ReturnType<NonNullable<ProjectRepository['listHistoryPage']>> {
      return withDatabase((database) =>
        listSqliteHistoryPage(database, request)
      );
    },
  };
}

function initializeDatabase(
  database: Database,
  databaseFile: string,
  legacyDataFile?: string
): void {
  if (hasRelationalMigration(database)) return;
  const relationalVersion = getRelationalSchemaVersion(database);
  if (relationalVersion > 0 && relationalVersion < RELATIONAL_SCHEMA_VERSION) {
    createDatabaseBackup(database, databaseFile, RELATIONAL_SCHEMA_VERSION);
    const upgrade = database.transaction(() => {
      upgradeRelationalSchema(database, relationalVersion);
    });
    upgrade.immediate();
    return;
  }

  const hasAnyRelationalTable = [
    'users',
    'projects',
    'versions',
    'artifact_audit_jobs',
    'artifact_audits',
    'project_members',
    'audit_events',
    'releases',
    'sessions',
  ].some((table) => hasTable(database, table));
  if (hasAnyRelationalTable) {
    throw new Error(
      'Relational SQLite schema is incomplete; restore the pre-migration backup'
    );
  }

  const legacyRow = hasTable(database, 'deploykit_state')
    ? database
        .query<LegacyStateRow, []>(
          'SELECT payload FROM deploykit_state WHERE id = 1'
        )
        .get()
    : null;

  if (legacyRow) {
    createDatabaseBackup(database, databaseFile);
  }

  const initialData = legacyRow
    ? migrate(JSON.parse(legacyRow.payload) as unknown).data
    : legacyDataFile && existsSync(legacyDataFile)
      ? importLegacyData(legacyDataFile)
      : createEmptyData();

  const migrateDatabase = database.transaction((data: Data) => {
    createRelationalSchema(database);
    replaceDomainData(database, data);
    const appliedAt = new Date().toISOString();
    for (let version = 1; version <= RELATIONAL_SCHEMA_VERSION; version += 1) {
      database
        .query(
          `INSERT INTO schema_migrations (version, applied_at)
           VALUES (?, ?)`
        )
        .run(version, appliedAt);
    }
  });
  migrateDatabase.immediate(initialData);
}

function createDatabaseBackup(
  database: Database,
  databaseFile: string,
  targetVersion = 1
): void {
  const backupFile = `${databaseFile}.pre-relational-v${targetVersion}.bak`;
  if (existsSync(backupFile)) return;
  database.exec('PRAGMA wal_checkpoint(FULL)');
  database.query('VACUUM INTO ?').run(backupFile);
}

function loadRelationalData(database: Database): Data {
  const users = database
    .query<UserRow, []>(
      `SELECT id, name, email, password_hash, role, created_at, updated_at
       FROM users
       ORDER BY sort_order ASC`
    )
    .all()
    .map(rowToUser);

  const projectRows = database
    .query<ProjectRow, []>(
      `SELECT id, name, slug, description, created_at, updated_at,
              active_version_id, spa_mode, routing_type, audit_enforcement,
              audit_max_total_bytes, audit_max_file_bytes,
              audit_max_file_count, created_by
       FROM projects
       ORDER BY sort_order ASC`
    )
    .all();
  const versionRows = database
    .query<VersionRow, []>(
      `SELECT id, project_id, name, description, created_at, size, file_count,
              source_type, status, published_at, published_by, checksum,
              integrity_status, integrity_checked_at
       FROM versions
       ORDER BY project_id ASC, sort_order ASC`
    )
    .all();
  const memberRows = database
    .query<MemberRow, []>(
      `SELECT project_id, user_id, role, invited_at
       FROM project_members
       ORDER BY project_id ASC, sort_order ASC`
    )
    .all();

  const versionsByProject = new Map<string, Version[]>();
  for (const row of versionRows) {
    const versions = versionsByProject.get(row.project_id) ?? [];
    versions.push(rowToVersion(row));
    versionsByProject.set(row.project_id, versions);
  }
  const membersByProject = new Map<string, ProjectMember[]>();
  for (const row of memberRows) {
    const members = membersByProject.get(row.project_id) ?? [];
    members.push({
      userId: row.user_id,
      role: row.role,
      invitedAt: row.invited_at,
    });
    membersByProject.set(row.project_id, members);
  }

  const projects = projectRows.map<Project>((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    versions: versionsByProject.get(row.id) ?? [],
    activeVersionId: row.active_version_id,
    settings: {
      spaMode: row.spa_mode === 1,
      routingType: row.routing_type,
    },
    auditPolicy: {
      enforcement: row.audit_enforcement,
      maxTotalBytes: row.audit_max_total_bytes,
      maxFileBytes: row.audit_max_file_bytes,
      maxFileCount: row.audit_max_file_count,
    },
    createdBy: row.created_by,
    members: membersByProject.get(row.id) ?? [],
  }));

  const history = database
    .query<AuditRow, []>(
      `SELECT id, action, project_id, project_name, version_id, version_name,
              occurred_at, actor_id, metadata_json
       FROM audit_events
       ORDER BY sequence DESC
       LIMIT 200`
    )
    .all()
    .map(rowToHistoryEvent);
  const artifactAudits = database
    .query<ArtifactAuditRow, []>(
      `SELECT id, project_id, version_id, artifact_checksum, status, score,
              created_at, created_by, engine_version, policy_json,
              summary_json, checks_json
       FROM artifact_audits
       ORDER BY project_id ASC, created_at DESC`
    )
    .all()
    .map(rowToArtifactAuditReport);
  const artifactAuditJobs = database
    .query<ArtifactAuditJobRow, []>(
      `SELECT id, project_id, version_id, requested_by, status, priority,
              attempts, max_attempts, next_run_at, locked_by, locked_until,
              artifact_checksum, engine_version, policy_json, report_id,
              error_code, error_message, created_at, updated_at, started_at,
              completed_at
       FROM artifact_audit_jobs
       ORDER BY priority DESC, created_at ASC`
    )
    .all()
    .map(rowToArtifactAuditJob);

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projects,
    users,
    history,
    artifactAudits,
    artifactAuditJobs,
  };
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToVersion(row: VersionRow): Version {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    size: row.size,
    fileCount: row.file_count,
    sourceType: row.source_type,
    status: row.status,
    publishedAt: row.published_at,
    publishedBy: row.published_by,
    checksum: row.checksum,
    integrityStatus: row.integrity_status,
    integrityCheckedAt: row.integrity_checked_at,
  };
}

function rowToHistoryEvent(row: AuditRow): HistoryEvent {
  return {
    id: row.id,
    action: row.action,
    projectId: row.project_id,
    projectName: row.project_name,
    versionId: row.version_id,
    versionName: row.version_name,
    timestamp: row.occurred_at,
    actorId: row.actor_id,
    ...(row.metadata_json
      ? { metadata: JSON.parse(row.metadata_json) as Record<string, unknown> }
      : {}),
  };
}

function rowToArtifactAuditReport(row: ArtifactAuditRow): ArtifactAuditReport {
  return artifactAuditReportSchema.parse({
    id: row.id,
    projectId: row.project_id,
    versionId: row.version_id,
    artifactChecksum: row.artifact_checksum,
    status: row.status,
    score: row.score,
    createdAt: row.created_at,
    createdBy: row.created_by,
    engineVersion: row.engine_version,
    policy: JSON.parse(row.policy_json) as ArtifactAuditReport['policy'],
    summary: JSON.parse(row.summary_json) as ArtifactAuditReport['summary'],
    checks: JSON.parse(row.checks_json) as ArtifactAuditReport['checks'],
  });
}

function rowToArtifactAuditJob(row: ArtifactAuditJobRow): ArtifactAuditJob {
  return artifactAuditJobSchema.parse({
    id: row.id,
    projectId: row.project_id,
    versionId: row.version_id,
    requestedBy: row.requested_by,
    status: row.status,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextRunAt: row.next_run_at,
    lockedBy: row.locked_by,
    lockedUntil: row.locked_until,
    artifactChecksum: row.artifact_checksum,
    engineVersion: row.engine_version,
    policy: JSON.parse(row.policy_json) as ArtifactAuditJob['policy'],
    reportId: row.report_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  });
}

function listSqliteHistoryPage(
  database: Database,
  { projectIds, limit, cursor }: HistoryPageRequest
): ReturnType<NonNullable<ProjectRepository['listHistoryPage']>> {
  if (projectIds?.length === 0) return cursor ? undefined : emptyHistoryPage();

  const pageSize = parseHistoryLimit(limit);
  const visibilityClause =
    projectIds === null
      ? ''
      : ` AND project_id IN (${projectIds.map(() => '?').join(', ')})`;
  const visibilityBindings = projectIds ?? [];
  let beforeSequence: number | null = null;

  if (cursor) {
    const eventId = decodeHistoryCursor(cursor);
    if (!eventId) return undefined;
    const cursorRow = database
      .query(
        `SELECT sequence
         FROM audit_events
         WHERE id = ?${visibilityClause}`
      )
      .get(eventId, ...visibilityBindings) as { sequence: number } | null;
    if (!cursorRow) return undefined;
    beforeSequence = cursorRow.sequence;
  }

  const sequenceClause = beforeSequence === null ? '' : ' AND sequence < ?';
  const rows = database
    .query(
      `SELECT sequence, id, action, project_id, project_name, version_id,
              version_name, occurred_at, actor_id, metadata_json
       FROM audit_events
       WHERE 1 = 1${visibilityClause}${sequenceClause}
       ORDER BY sequence DESC
       LIMIT ?`
    )
    .all(
      ...visibilityBindings,
      ...(beforeSequence === null ? [] : [beforeSequence]),
      pageSize + 1
    ) as SequencedAuditRow[];

  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
  const items = pageRows.map(rowToHistoryEvent);
  const lastItem = items.at(-1);
  return {
    items,
    nextCursor: hasMore && lastItem ? encodeHistoryCursor(lastItem.id) : null,
  };
}

function emptyHistoryPage(): {
  items: HistoryEvent[];
  nextCursor: null;
} {
  return { items: [], nextCursor: null };
}

function replaceDomainData(database: Database, data: Data): void {
  database.exec(`
    DELETE FROM sessions;
    DELETE FROM project_members;
    UPDATE projects SET active_version_id = NULL;
    DELETE FROM artifact_audit_jobs;
    DELETE FROM artifact_audits;
    DELETE FROM versions;
    DELETE FROM projects;
    DELETE FROM users;
    DELETE FROM releases;
    DELETE FROM audit_events;
  `);
  persistUsers(database, data.users);
  persistProjects(database, data.projects);
  persistVersions(database, data.projects);
  persistArtifactAudits(database, data.artifactAudits);
  persistArtifactAuditJobs(database, data.artifactAuditJobs);
  persistMembers(database, data.projects, new Set(data.users.map((u) => u.id)));
  for (const event of [...data.history].reverse()) {
    insertAuditEvent(database, event);
  }
}

function persistDomainDiff(
  database: Database,
  before: Data,
  after: Data
): void {
  persistUsers(database, after.users);
  persistProjects(database, after.projects);
  persistVersions(database, after.projects);
  persistArtifactAudits(database, after.artifactAudits);
  persistArtifactAuditJobs(database, after.artifactAuditJobs);
  persistMembers(
    database,
    after.projects,
    new Set(after.users.map((u) => u.id))
  );

  const afterMemberKeys = new Set(
    after.projects.flatMap((project) =>
      project.members.map((member) => `${project.id}\0${member.userId}`)
    )
  );
  for (const project of before.projects) {
    for (const member of project.members) {
      if (!afterMemberKeys.has(`${project.id}\0${member.userId}`)) {
        database
          .query(
            `DELETE FROM project_members
             WHERE project_id = ? AND user_id = ?`
          )
          .run(project.id, member.userId);
      }
    }
  }

  const afterVersionIds = new Set(
    after.projects.flatMap((project) =>
      project.versions.map((version) => version.id)
    )
  );
  const afterArtifactAuditIds = new Set(
    after.artifactAudits.map((report) => report.id)
  );
  const afterArtifactAuditJobIds = new Set(
    after.artifactAuditJobs.map((job) => job.id)
  );
  for (const job of before.artifactAuditJobs) {
    if (!afterArtifactAuditJobIds.has(job.id)) {
      database
        .query('DELETE FROM artifact_audit_jobs WHERE id = ?')
        .run(job.id);
    }
  }
  for (const report of before.artifactAudits) {
    if (!afterArtifactAuditIds.has(report.id)) {
      database.query('DELETE FROM artifact_audits WHERE id = ?').run(report.id);
    }
  }
  for (const version of before.projects.flatMap(
    (project) => project.versions
  )) {
    if (!afterVersionIds.has(version.id)) {
      database.query('DELETE FROM versions WHERE id = ?').run(version.id);
    }
  }

  const afterProjectIds = new Set(after.projects.map((project) => project.id));
  for (const project of before.projects) {
    if (!afterProjectIds.has(project.id)) {
      database.query('DELETE FROM projects WHERE id = ?').run(project.id);
    }
  }

  const afterUserIds = new Set(after.users.map((user) => user.id));
  for (const user of before.users) {
    if (!afterUserIds.has(user.id)) {
      database.query('DELETE FROM users WHERE id = ?').run(user.id);
    }
  }

  const previousEventIds = new Set(before.history.map((event) => event.id));
  for (const event of [...after.history].reverse()) {
    if (!previousEventIds.has(event.id)) insertAuditEvent(database, event);
  }
}

function persistUsers(database: Database, users: User[]): void {
  const statement = database.query(
    `INSERT INTO users (
       id, name, email, password_hash, role, created_at, updated_at, sort_order
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       email = excluded.email,
       password_hash = excluded.password_hash,
       role = excluded.role,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       sort_order = excluded.sort_order`
  );
  users.forEach((user, index) => {
    statement.run(
      user.id,
      user.name,
      user.email,
      user.passwordHash,
      user.role,
      user.createdAt,
      user.updatedAt,
      index
    );
  });
}

function persistProjects(database: Database, projects: Project[]): void {
  const statement = database.query(
    `INSERT INTO projects (
       id, name, slug, description, created_at, updated_at, active_version_id,
       spa_mode, routing_type, audit_enforcement, audit_max_total_bytes,
       audit_max_file_bytes, audit_max_file_count, created_by, sort_order
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       slug = excluded.slug,
       description = excluded.description,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       active_version_id = excluded.active_version_id,
       spa_mode = excluded.spa_mode,
       routing_type = excluded.routing_type,
       audit_enforcement = excluded.audit_enforcement,
       audit_max_total_bytes = excluded.audit_max_total_bytes,
       audit_max_file_bytes = excluded.audit_max_file_bytes,
       audit_max_file_count = excluded.audit_max_file_count,
       created_by = excluded.created_by,
       sort_order = excluded.sort_order`
  );
  projects.forEach((project, index) => {
    statement.run(
      project.id,
      project.name,
      project.slug,
      project.description,
      project.createdAt,
      project.updatedAt,
      project.activeVersionId,
      project.settings.spaMode ? 1 : 0,
      project.settings.routingType,
      project.auditPolicy.enforcement,
      project.auditPolicy.maxTotalBytes,
      project.auditPolicy.maxFileBytes,
      project.auditPolicy.maxFileCount,
      project.createdBy,
      index
    );
  });
}

function persistArtifactAudits(
  database: Database,
  reports: ArtifactAuditReport[]
): void {
  const statement = database.query(
    `INSERT INTO artifact_audits (
       id, project_id, version_id, artifact_checksum, status, score,
       created_at, created_by, engine_version, policy_json, summary_json,
       checks_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(version_id) DO UPDATE SET
       id = excluded.id,
       project_id = excluded.project_id,
       artifact_checksum = excluded.artifact_checksum,
       status = excluded.status,
       score = excluded.score,
       created_at = excluded.created_at,
       created_by = excluded.created_by,
       engine_version = excluded.engine_version,
       policy_json = excluded.policy_json,
       summary_json = excluded.summary_json,
       checks_json = excluded.checks_json`
  );
  for (const report of reports) {
    statement.run(
      report.id,
      report.projectId,
      report.versionId,
      report.artifactChecksum,
      report.status,
      report.score,
      report.createdAt,
      report.createdBy,
      report.engineVersion,
      JSON.stringify(report.policy),
      JSON.stringify(report.summary),
      JSON.stringify(report.checks)
    );
  }
}

function persistArtifactAuditJobs(
  database: Database,
  jobs: ArtifactAuditJob[]
): void {
  const statement = database.query(
    `INSERT INTO artifact_audit_jobs (
       id, project_id, version_id, requested_by, status, priority, attempts,
       max_attempts, next_run_at, locked_by, locked_until, artifact_checksum,
       engine_version, policy_json, report_id, error_code, error_message,
       created_at, updated_at, started_at, completed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       project_id = excluded.project_id,
       version_id = excluded.version_id,
       requested_by = excluded.requested_by,
       status = excluded.status,
       priority = excluded.priority,
       attempts = excluded.attempts,
       max_attempts = excluded.max_attempts,
       next_run_at = excluded.next_run_at,
       locked_by = excluded.locked_by,
       locked_until = excluded.locked_until,
       artifact_checksum = excluded.artifact_checksum,
       engine_version = excluded.engine_version,
       policy_json = excluded.policy_json,
       report_id = excluded.report_id,
       error_code = excluded.error_code,
       error_message = excluded.error_message,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       started_at = excluded.started_at,
       completed_at = excluded.completed_at`
  );
  for (const job of jobs) {
    statement.run(
      job.id,
      job.projectId,
      job.versionId,
      job.requestedBy,
      job.status,
      job.priority,
      job.attempts,
      job.maxAttempts,
      job.nextRunAt,
      job.lockedBy,
      job.lockedUntil,
      job.artifactChecksum,
      job.engineVersion,
      JSON.stringify(job.policy),
      job.reportId,
      job.errorCode,
      job.errorMessage,
      job.createdAt,
      job.updatedAt,
      job.startedAt,
      job.completedAt
    );
  }
}

function persistVersions(database: Database, projects: Project[]): void {
  const statement = database.query(
    `INSERT INTO versions (
       id, project_id, name, description, created_at, size, file_count,
       source_type, status, published_at, published_by, checksum,
       integrity_status, integrity_checked_at, sort_order
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       project_id = excluded.project_id,
       name = excluded.name,
       description = excluded.description,
       created_at = excluded.created_at,
       size = excluded.size,
       file_count = excluded.file_count,
       source_type = excluded.source_type,
       status = excluded.status,
       published_at = excluded.published_at,
       published_by = excluded.published_by,
       checksum = excluded.checksum,
       integrity_status = excluded.integrity_status,
       integrity_checked_at = excluded.integrity_checked_at,
       sort_order = excluded.sort_order`
  );
  for (const project of projects) {
    project.versions.forEach((version, index) => {
      statement.run(
        version.id,
        project.id,
        version.name,
        version.description,
        version.createdAt,
        version.size,
        version.fileCount,
        version.sourceType,
        version.status,
        version.publishedAt,
        version.publishedBy,
        version.checksum,
        version.integrityStatus,
        version.integrityCheckedAt,
        index
      );
    });
  }
}

function persistMembers(
  database: Database,
  projects: Project[],
  knownUserIds: Set<string>
): void {
  const statement = database.query(
    `INSERT INTO project_members (
       project_id, user_id, role, invited_at, sort_order
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id, user_id) DO UPDATE SET
       role = excluded.role,
       invited_at = excluded.invited_at,
       sort_order = excluded.sort_order`
  );
  for (const project of projects) {
    project.members.forEach((member, index) => {
      if (!knownUserIds.has(member.userId)) return;
      statement.run(
        project.id,
        member.userId,
        member.role,
        member.invitedAt,
        index
      );
    });
  }
}

function insertAuditEvent(database: Database, event: HistoryEvent): void {
  database
    .query(
      `INSERT OR IGNORE INTO audit_events (
         id, action, project_id, project_name, version_id, version_name,
         occurred_at, actor_id, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      event.id,
      event.action,
      event.projectId,
      event.projectName,
      event.versionId,
      event.versionName,
      event.timestamp,
      event.actorId,
      event.metadata ? JSON.stringify(event.metadata) : null
    );

  if (
    event.action === 'version.publish' ||
    event.action === 'version.activate' ||
    event.action === 'version.rollback'
  ) {
    const previousVersionId = event.metadata?.previousActiveVersionId;
    database
      .query(
        `INSERT OR IGNORE INTO releases (
           id, project_id, project_name, version_id, version_name,
           previous_version_id, action, actor_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.id,
        event.projectId,
        event.projectName,
        event.versionId,
        event.versionName,
        typeof previousVersionId === 'string' ? previousVersionId : null,
        event.action,
        event.actorId,
        event.timestamp
      );
  }
}

function importLegacyData(legacyDataFile: string): Data {
  copyFileSync(legacyDataFile, `${legacyDataFile}.sqlite-migration.bak`);
  return createJsonProjectRepository(legacyDataFile).load();
}
