import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Data } from '@deploykit/shared';
import { createEmptyData, migrate } from '../domain/schema';
import { createJsonProjectRepository } from './jsonProjectRepository';
import type { ProjectRepository } from './projectRepository';

interface SqliteStateRow {
  payload: string;
  schema_version: number;
}

export interface SqliteProjectRepositoryOptions {
  databaseFile: string;
  legacyDataFile?: string;
}

const CREATE_STATE_TABLE = `
  CREATE TABLE IF NOT EXISTS deploykit_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version INTEGER NOT NULL,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

/**
 * SQLite-backed document repository.
 *
 * The domain still owns one versioned `Data` document. Every state-changing
 * service operation enters through `mutate()`, which acquires an IMMEDIATE
 * transaction before reading so a second process cannot commit from a stale
 * snapshot. A later relational migration can happen behind the same interface
 * when query volume or multi-instance requirements justify it.
 */
export function createSqliteProjectRepository({
  databaseFile,
  legacyDataFile,
}: SqliteProjectRepositoryOptions): ProjectRepository {
  const withDatabase = <T>(work: (database: Database) => T): T => {
    mkdirSync(dirname(databaseFile), { recursive: true });
    const database = new Database(databaseFile, { create: true });
    try {
      database.exec('PRAGMA journal_mode = WAL');
      database.exec('PRAGMA synchronous = NORMAL');
      database.exec('PRAGMA busy_timeout = 5000');
      database.exec(CREATE_STATE_TABLE);
      return work(database);
    } finally {
      database.close();
    }
  };

  const saveRow = (database: Database, data: Data): void => {
    database
      .query(
        `INSERT INTO deploykit_state
            (id, schema_version, payload, updated_at)
           VALUES (1, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             schema_version = excluded.schema_version,
             payload = excluded.payload,
             updated_at = excluded.updated_at`
      )
      .run(data.schemaVersion, JSON.stringify(data), new Date().toISOString());
  };

  const loadWithDatabase = (database: Database): Data => {
    const row = database
      .query<SqliteStateRow, []>(
        `SELECT schema_version, payload
         FROM deploykit_state
         WHERE id = 1`
      )
      .get();

    if (!row) {
      const initialData =
        legacyDataFile && existsSync(legacyDataFile)
          ? importLegacyData(legacyDataFile)
          : createEmptyData();
      saveRow(database, initialData);
      return initialData;
    }

    const raw = JSON.parse(row.payload) as unknown;
    const { data, migrated } = migrate(raw);
    if (migrated || row.schema_version !== data.schemaVersion) {
      saveRow(database, data);
    }
    return data;
  };

  return {
    load(): Data {
      return withDatabase(loadWithDatabase);
    },

    save(data: Data): void {
      withDatabase((database) => {
        const persist = database.transaction((nextData: Data) => {
          saveRow(database, nextData);
        });
        persist.immediate(data);
      });
    },

    mutate<T>(operation: (data: Data) => T): T {
      return withDatabase((database) => {
        const applyMutation = database.transaction(
          (nextOperation: (data: Data) => T) => {
            const data = loadWithDatabase(database);
            const result = nextOperation(data);
            saveRow(database, data);
            return result;
          }
        );
        return applyMutation.immediate(operation);
      });
    },
  };
}

function importLegacyData(legacyDataFile: string): Data {
  copyFileSync(legacyDataFile, `${legacyDataFile}.sqlite-migration.bak`);
  return createJsonProjectRepository(legacyDataFile).load();
}
