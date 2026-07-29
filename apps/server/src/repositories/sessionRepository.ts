import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SessionKind, SessionRecord } from '../domain/session';
import { configureSqlite, hasTable } from './sqliteSchema';

export type { SessionRecord } from '../domain/session';

export interface SessionRepository {
  create(session: SessionRecord): void;
  findActive(id: string, nowEpochSeconds: number): SessionRecord | null;
  listForUser(userId: string): SessionRecord[];
  revokeForUser(id: string, userId: string, revokedAt: string): boolean;
  revokeAllForUser(userId: string, revokedAt: string): number;
  deleteExpired(nowEpochSeconds: number): number;
}

interface SessionRow {
  id: string;
  user_id: string;
  kind: SessionKind;
  created_at: string;
  expires_at: number;
  revoked_at: string | null;
}

export function createMemorySessionRepository(): SessionRepository {
  const sessions = new Map<string, SessionRecord>();
  return {
    create(session) {
      sessions.set(session.id, { ...session });
    },
    findActive(id, nowEpochSeconds) {
      const session = sessions.get(id);
      if (
        !session ||
        session.revokedAt !== null ||
        session.expiresAt <= nowEpochSeconds
      ) {
        return null;
      }
      return { ...session };
    },
    listForUser(userId) {
      return [...sessions.values()]
        .filter((session) => session.userId === userId)
        .sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) ||
            right.id.localeCompare(left.id)
        )
        .map((session) => ({ ...session }));
    },
    revokeForUser(id, userId, revokedAt) {
      const session = sessions.get(id);
      if (!session || session.userId !== userId || session.revokedAt !== null) {
        return false;
      }
      session.revokedAt = revokedAt;
      return true;
    },
    revokeAllForUser(userId, revokedAt) {
      let revoked = 0;
      for (const session of sessions.values()) {
        if (session.userId === userId && session.revokedAt === null) {
          session.revokedAt = revokedAt;
          revoked += 1;
        }
      }
      return revoked;
    },
    deleteExpired(nowEpochSeconds) {
      let deleted = 0;
      for (const [id, session] of sessions) {
        if (session.expiresAt <= nowEpochSeconds) {
          sessions.delete(id);
          deleted += 1;
        }
      }
      return deleted;
    },
  };
}

export function createSqliteSessionRepository(
  databaseFile: string
): SessionRepository {
  const withDatabase = <T>(work: (database: Database) => T): T => {
    mkdirSync(dirname(databaseFile), { recursive: true });
    const database = new Database(databaseFile, { create: true });
    try {
      configureSqlite(database);
      if (!hasTable(database, 'sessions')) {
        throw new Error(
          'Session storage requires an initialized relational database'
        );
      }
      return work(database);
    } finally {
      database.close();
    }
  };

  return {
    create(session) {
      withDatabase((database) => {
        database
          .query(
            `INSERT INTO sessions (
               id, user_id, kind, created_at, expires_at, revoked_at
             ) VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            session.id,
            session.userId,
            session.kind,
            session.createdAt,
            session.expiresAt,
            session.revokedAt
          );
      });
    },
    findActive(id, nowEpochSeconds) {
      return withDatabase((database) => {
        const row = database
          .query<SessionRow, [string, number]>(
            `SELECT id, user_id, kind, created_at, expires_at, revoked_at
             FROM sessions
             WHERE id = ?
               AND revoked_at IS NULL
               AND expires_at > ?`
          )
          .get(id, nowEpochSeconds);
        return row ? rowToSession(row) : null;
      });
    },
    listForUser(userId) {
      return withDatabase((database) =>
        database
          .query<SessionRow, [string]>(
            `SELECT id, user_id, kind, created_at, expires_at, revoked_at
             FROM sessions
             WHERE user_id = ?
             ORDER BY created_at DESC, id DESC`
          )
          .all(userId)
          .map(rowToSession)
      );
    },
    revokeForUser(id, userId, revokedAt) {
      return withDatabase((database) => {
        const result = database
          .query(
            `UPDATE sessions
             SET revoked_at = ?
             WHERE id = ? AND user_id = ? AND revoked_at IS NULL`
          )
          .run(revokedAt, id, userId);
        return result.changes > 0;
      });
    },
    revokeAllForUser(userId, revokedAt) {
      return withDatabase((database) => {
        const result = database
          .query(
            `UPDATE sessions
             SET revoked_at = ?
             WHERE user_id = ? AND revoked_at IS NULL`
          )
          .run(revokedAt, userId);
        return result.changes;
      });
    },
    deleteExpired(nowEpochSeconds) {
      return withDatabase(
        (database) =>
          database
            .query('DELETE FROM sessions WHERE expires_at <= ?')
            .run(nowEpochSeconds).changes
      );
    },
  };
}

function rowToSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}
