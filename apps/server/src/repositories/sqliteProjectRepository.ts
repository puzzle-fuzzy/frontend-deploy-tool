import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Data,
  HistoryAction,
  HistoryEvent,
  Project,
  ProjectMember,
  User,
  Version,
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
  hasRelationalMigration,
  hasTable,
  RELATIONAL_SCHEMA_VERSION,
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

  const hasAnyRelationalTable = [
    'users',
    'projects',
    'versions',
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
    database
      .query(
        `INSERT INTO schema_migrations (version, applied_at)
         VALUES (?, ?)`
      )
      .run(RELATIONAL_SCHEMA_VERSION, new Date().toISOString());
  });
  migrateDatabase.immediate(initialData);
}

function createDatabaseBackup(database: Database, databaseFile: string): void {
  const backupFile = `${databaseFile}.pre-relational-v1.bak`;
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
              active_version_id, spa_mode, routing_type, created_by
       FROM projects
       ORDER BY sort_order ASC`
    )
    .all();
  const versionRows = database
    .query<VersionRow, []>(
      `SELECT id, project_id, name, description, created_at, size, file_count,
              source_type, status, published_at, published_by, checksum
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

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projects,
    users,
    history,
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
    DELETE FROM versions;
    DELETE FROM projects;
    DELETE FROM users;
    DELETE FROM releases;
    DELETE FROM audit_events;
  `);
  persistUsers(database, data.users);
  persistProjects(database, data.projects);
  persistVersions(database, data.projects);
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
       spa_mode, routing_type, created_by, sort_order
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       slug = excluded.slug,
       description = excluded.description,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       active_version_id = excluded.active_version_id,
       spa_mode = excluded.spa_mode,
       routing_type = excluded.routing_type,
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
      project.createdBy,
      index
    );
  });
}

function persistVersions(database: Database, projects: Project[]): void {
  const statement = database.query(
    `INSERT INTO versions (
       id, project_id, name, description, created_at, size, file_count,
       source_type, status, published_at, published_by, checksum, sort_order
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
