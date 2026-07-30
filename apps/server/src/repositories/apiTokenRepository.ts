import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type ApiTokenMetadata,
  type ApiTokenSecurityEvent,
  apiTokenScopeSchema,
  apiTokenSecurityEventSchema,
} from '@deploykit/shared';
import type {
  ApiTokenLookup,
  ApiTokenRecord,
  CreateApiTokenRecordInput,
  RecordApiTokenAuthenticationFailureInput,
  RotateApiTokenRecordInput,
} from '../domain/apiToken';
import { API_TOKEN_HASH_VERSION } from '../domain/apiToken';
import { createId } from '../utils/id';
import { configureSqlite, hasTable } from './sqliteSchema';

export interface RevokeApiTokenInput {
  projectId: string;
  projectName: string;
  tokenId: string;
  actorId: string;
  revokedAt: string;
}

export interface TouchApiTokenInput {
  tokenId: string;
  usedAt: string;
  onlyIfBefore: string;
}

export interface ApiTokenRepository {
  create(input: CreateApiTokenRecordInput): ApiTokenMetadata;
  list(projectId: string): ApiTokenMetadata[];
  findById(id: string): ApiTokenLookup | null;
  rotate(input: RotateApiTokenRecordInput): ApiTokenMetadata | null;
  revoke(input: RevokeApiTokenInput): ApiTokenMetadata | null;
  touchLastUsed(input: TouchApiTokenInput): boolean;
  recordAuthenticationFailure(
    input: RecordApiTokenAuthenticationFailureInput
  ): void;
  listSecurityEvents(
    projectId: string,
    limit?: number
  ): ApiTokenSecurityEvent[];
}

interface ApiTokenRow {
  id: string;
  project_id: string;
  name: string;
  hash_version: number;
  secret_digest: string;
  prefix: string;
  scopes_json: string;
  created_at: string;
  created_by: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  replaced_by_token_id: string | null;
}

interface ApiTokenSecurityEventRow {
  id: string;
  project_id: string;
  project_name: string;
  token_id: string | null;
  token_prefix: string | null;
  action: ApiTokenSecurityEvent['action'];
  outcome: ApiTokenSecurityEvent['outcome'];
  actor_id: string | null;
  reason: string | null;
  occurred_at: string;
}

export function createMemoryApiTokenRepository(): ApiTokenRepository {
  const tokens = new Map<string, ApiTokenRecord>();
  const events: ApiTokenSecurityEvent[] = [];

  return {
    create(input) {
      assertTokenRecord(input.token);
      if (tokens.has(input.token.id)) {
        throw new Error('API token id already exists');
      }
      tokens.set(input.token.id, cloneRecord(input.token));
      events.unshift(
        createSecurityEvent({
          projectId: input.token.projectId,
          projectName: input.projectName,
          tokenId: input.token.id,
          tokenPrefix: input.token.prefix,
          action: 'api_token.create',
          outcome: 'succeeded',
          actorId: input.token.createdBy,
          reason: null,
          occurredAt: input.token.createdAt,
        })
      );
      return toMetadata(input.token);
    },
    list(projectId) {
      return [...tokens.values()]
        .filter((token) => token.projectId === projectId)
        .sort(compareNewestToken)
        .map(toMetadata);
    },
    findById(id) {
      const token = tokens.get(id);
      return token ? toLookup(token) : null;
    },
    rotate(input) {
      assertTokenRecord(input.replacement);
      const current = tokens.get(input.currentTokenId);
      if (
        !current ||
        current.projectId !== input.replacement.projectId ||
        current.revokedAt !== null ||
        current.replacedByTokenId !== null ||
        tokens.has(input.replacement.id)
      ) {
        return null;
      }
      current.expiresAt = input.previousExpiresAt;
      current.revokedAt = input.revokePrevious ? input.rotatedAt : null;
      current.replacedByTokenId = input.replacement.id;
      tokens.set(input.replacement.id, cloneRecord(input.replacement));
      events.unshift(
        createSecurityEvent({
          projectId: current.projectId,
          projectName: input.projectName,
          tokenId: current.id,
          tokenPrefix: current.prefix,
          action: 'api_token.rotate',
          outcome: 'succeeded',
          actorId: input.actorId,
          reason: null,
          occurredAt: input.rotatedAt,
        })
      );
      return toMetadata(input.replacement);
    },
    revoke(input) {
      const token = tokens.get(input.tokenId);
      if (!token || token.projectId !== input.projectId) return null;
      if (token.revokedAt === null) {
        token.revokedAt = input.revokedAt;
        events.unshift(
          createSecurityEvent({
            projectId: token.projectId,
            projectName: input.projectName,
            tokenId: token.id,
            tokenPrefix: token.prefix,
            action: 'api_token.revoke',
            outcome: 'succeeded',
            actorId: input.actorId,
            reason: null,
            occurredAt: input.revokedAt,
          })
        );
      }
      return toMetadata(token);
    },
    touchLastUsed(input) {
      const token = tokens.get(input.tokenId);
      if (
        !token ||
        (token.lastUsedAt !== null && token.lastUsedAt >= input.onlyIfBefore)
      ) {
        return false;
      }
      token.lastUsedAt = input.usedAt;
      return true;
    },
    recordAuthenticationFailure(input) {
      events.unshift(
        createSecurityEvent({
          projectId: input.token.projectId,
          projectName: input.projectName,
          tokenId: input.token.id,
          tokenPrefix: input.token.prefix,
          action: 'api_token.authentication_failed',
          outcome: 'denied',
          actorId: null,
          reason: input.reason,
          occurredAt: input.occurredAt,
        })
      );
    },
    listSecurityEvents(projectId, limit = 100) {
      return events
        .filter((event) => event.projectId === projectId)
        .slice(0, clampEventLimit(limit))
        .map((event) => ({ ...event }));
    },
  };
}

export function createSqliteApiTokenRepository(
  databaseFile: string
): ApiTokenRepository {
  const withDatabase = <T>(work: (database: Database) => T): T => {
    mkdirSync(dirname(databaseFile), { recursive: true });
    const database = new Database(databaseFile, { create: true });
    try {
      configureSqlite(database);
      if (
        !hasTable(database, 'project_api_tokens') ||
        !hasTable(database, 'api_token_security_events')
      ) {
        throw new Error(
          'API token storage requires an initialized relational database'
        );
      }
      return work(database);
    } finally {
      database.close();
    }
  };

  return {
    create(input) {
      return withDatabase((database) => {
        const create = database.transaction(
          (nextInput: CreateApiTokenRecordInput) => {
            insertToken(database, nextInput.token);
            insertSecurityEvent(
              database,
              createSecurityEvent({
                projectId: nextInput.token.projectId,
                projectName: nextInput.projectName,
                tokenId: nextInput.token.id,
                tokenPrefix: nextInput.token.prefix,
                action: 'api_token.create',
                outcome: 'succeeded',
                actorId: nextInput.token.createdBy,
                reason: null,
                occurredAt: nextInput.token.createdAt,
              })
            );
            return toMetadata(nextInput.token);
          }
        );
        return create.immediate(input);
      });
    },
    list(projectId) {
      return withDatabase((database) =>
        database
          .query<ApiTokenRow, [string]>(
            `${TOKEN_SELECT}
             WHERE project_id = ?
             ORDER BY created_at DESC, id DESC`
          )
          .all(projectId)
          .map(rowToMetadata)
      );
    },
    findById(id) {
      return withDatabase((database) => {
        const row = database
          .query<ApiTokenRow, [string]>(`${TOKEN_SELECT} WHERE id = ?`)
          .get(id);
        return row ? rowToLookup(row) : null;
      });
    },
    rotate(input) {
      return withDatabase((database) => {
        const rotate = database.transaction(
          (nextInput: RotateApiTokenRecordInput) => {
            const current = database
              .query<ApiTokenRow, [string, string]>(
                `${TOKEN_SELECT}
                 WHERE id = ? AND project_id = ?`
              )
              .get(nextInput.currentTokenId, nextInput.replacement.projectId);
            const replacementExists = database
              .query<{ present: number }, [string]>(
                `SELECT 1 AS present
                 FROM project_api_tokens
                 WHERE id = ?
                 LIMIT 1`
              )
              .get(nextInput.replacement.id);
            if (
              !current ||
              current.revoked_at !== null ||
              current.replaced_by_token_id !== null ||
              replacementExists
            ) {
              return null;
            }

            const updated = database
              .query(
                `UPDATE project_api_tokens
                 SET expires_at = ?, revoked_at = ?,
                     replaced_by_token_id = ?
                 WHERE id = ? AND project_id = ?
                   AND revoked_at IS NULL
                   AND replaced_by_token_id IS NULL`
              )
              .run(
                nextInput.previousExpiresAt,
                nextInput.revokePrevious ? nextInput.rotatedAt : null,
                nextInput.replacement.id,
                current.id,
                current.project_id
              );
            if (updated.changes !== 1) return null;
            insertToken(database, nextInput.replacement);
            insertSecurityEvent(
              database,
              createSecurityEvent({
                projectId: current.project_id,
                projectName: nextInput.projectName,
                tokenId: current.id,
                tokenPrefix: current.prefix,
                action: 'api_token.rotate',
                outcome: 'succeeded',
                actorId: nextInput.actorId,
                reason: null,
                occurredAt: nextInput.rotatedAt,
              })
            );
            return toMetadata(nextInput.replacement);
          }
        );
        return rotate.immediate(input);
      });
    },
    revoke(input) {
      return withDatabase((database) => {
        const revoke = database.transaction(
          (nextInput: RevokeApiTokenInput) => {
            const row = database
              .query<ApiTokenRow, [string, string]>(
                `${TOKEN_SELECT}
               WHERE id = ? AND project_id = ?`
              )
              .get(nextInput.tokenId, nextInput.projectId);
            if (!row) return null;
            if (row.revoked_at === null) {
              database
                .query(
                  `UPDATE project_api_tokens
                 SET revoked_at = ?
                 WHERE id = ? AND project_id = ? AND revoked_at IS NULL`
                )
                .run(
                  nextInput.revokedAt,
                  nextInput.tokenId,
                  nextInput.projectId
                );
              insertSecurityEvent(
                database,
                createSecurityEvent({
                  projectId: row.project_id,
                  projectName: nextInput.projectName,
                  tokenId: row.id,
                  tokenPrefix: row.prefix,
                  action: 'api_token.revoke',
                  outcome: 'succeeded',
                  actorId: nextInput.actorId,
                  reason: null,
                  occurredAt: nextInput.revokedAt,
                })
              );
              row.revoked_at = nextInput.revokedAt;
            }
            return rowToMetadata(row);
          }
        );
        return revoke.immediate(input);
      });
    },
    touchLastUsed(input) {
      return withDatabase(
        (database) =>
          database
            .query(
              `UPDATE project_api_tokens
               SET last_used_at = ?
               WHERE id = ?
                 AND (last_used_at IS NULL OR last_used_at < ?)`
            )
            .run(input.usedAt, input.tokenId, input.onlyIfBefore).changes > 0
      );
    },
    recordAuthenticationFailure(input) {
      withDatabase((database) => {
        insertSecurityEvent(
          database,
          createSecurityEvent({
            projectId: input.token.projectId,
            projectName: input.projectName,
            tokenId: input.token.id,
            tokenPrefix: input.token.prefix,
            action: 'api_token.authentication_failed',
            outcome: 'denied',
            actorId: null,
            reason: input.reason,
            occurredAt: input.occurredAt,
          })
        );
      });
    },
    listSecurityEvents(projectId, limit = 100) {
      return withDatabase((database) =>
        database
          .query<ApiTokenSecurityEventRow, [string, number]>(
            `SELECT id, project_id, project_name, token_id, token_prefix,
                    action, outcome, actor_id, reason, occurred_at
             FROM api_token_security_events
             WHERE project_id = ?
             ORDER BY sequence DESC
             LIMIT ?`
          )
          .all(projectId, clampEventLimit(limit))
          .map(rowToSecurityEvent)
      );
    },
  };
}

const TOKEN_SELECT = `SELECT id, project_id, name, hash_version, secret_digest,
                             prefix, scopes_json, created_at, created_by,
                             expires_at, last_used_at, revoked_at,
                             replaced_by_token_id
                      FROM project_api_tokens`;

function insertToken(database: Database, token: ApiTokenRecord): void {
  assertTokenRecord(token);
  database
    .query(
      `INSERT INTO project_api_tokens (
         id, project_id, name, hash_version, secret_digest, prefix, scopes_json,
         created_at, created_by, expires_at, last_used_at, revoked_at,
         replaced_by_token_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      token.id,
      token.projectId,
      token.name,
      token.hashVersion,
      token.secretDigest,
      token.prefix,
      JSON.stringify(token.scopes),
      token.createdAt,
      token.createdBy,
      token.expiresAt,
      token.lastUsedAt,
      token.revokedAt,
      token.replacedByTokenId
    );
}

function insertSecurityEvent(
  database: Database,
  event: ApiTokenSecurityEvent
): void {
  database
    .query(
      `INSERT INTO api_token_security_events (
         id, project_id, project_name, token_id, token_prefix, action, outcome,
         actor_id, reason, occurred_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      event.id,
      event.projectId,
      event.projectName,
      event.tokenId,
      event.tokenPrefix,
      event.action,
      event.outcome,
      event.actorId,
      event.reason,
      event.occurredAt
    );
}

function rowToMetadata(row: ApiTokenRow): ApiTokenMetadata {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    prefix: row.prefix,
    scopes: parseScopes(row.scopes_json),
    createdAt: row.created_at,
    createdBy: row.created_by,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    replacedByTokenId: row.replaced_by_token_id,
  };
}

function rowToLookup(row: ApiTokenRow): ApiTokenLookup {
  if (row.hash_version !== API_TOKEN_HASH_VERSION) {
    throw new Error(`Unsupported API token hash version: ${row.hash_version}`);
  }
  return {
    id: row.id,
    projectId: row.project_id,
    hashVersion: row.hash_version,
    secretDigest: row.secret_digest,
    scopes: parseScopes(row.scopes_json),
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    prefix: row.prefix,
  };
}

function rowToSecurityEvent(
  row: ApiTokenSecurityEventRow
): ApiTokenSecurityEvent {
  return apiTokenSecurityEventSchema.parse({
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    tokenId: row.token_id,
    tokenPrefix: row.token_prefix,
    action: row.action,
    outcome: row.outcome,
    actorId: row.actor_id,
    reason: row.reason,
    occurredAt: row.occurred_at,
  });
}

function parseScopes(value: string) {
  return apiTokenScopeSchema.array().parse(JSON.parse(value));
}

function assertTokenRecord(token: ApiTokenRecord): void {
  if (token.hashVersion !== API_TOKEN_HASH_VERSION) {
    throw new Error(`Unsupported API token hash version: ${token.hashVersion}`);
  }
  if (!/^[0-9a-f]{64}$/.test(token.secretDigest)) {
    throw new Error('API token digest must be a lowercase SHA-256 digest');
  }
  apiTokenScopeSchema.array().parse(token.scopes);
}

function toMetadata(token: ApiTokenRecord): ApiTokenMetadata {
  return {
    id: token.id,
    projectId: token.projectId,
    name: token.name,
    prefix: token.prefix,
    scopes: [...token.scopes],
    createdAt: token.createdAt,
    createdBy: token.createdBy,
    expiresAt: token.expiresAt,
    lastUsedAt: token.lastUsedAt,
    revokedAt: token.revokedAt,
    replacedByTokenId: token.replacedByTokenId,
  };
}

function toLookup(token: ApiTokenRecord): ApiTokenLookup {
  return {
    id: token.id,
    projectId: token.projectId,
    hashVersion: token.hashVersion,
    secretDigest: token.secretDigest,
    scopes: [...token.scopes],
    expiresAt: token.expiresAt,
    revokedAt: token.revokedAt,
    prefix: token.prefix,
  };
}

function cloneRecord(token: ApiTokenRecord): ApiTokenRecord {
  return { ...token, scopes: [...token.scopes] };
}

function compareNewestToken(
  left: ApiTokenRecord,
  right: ApiTokenRecord
): number {
  return (
    right.createdAt.localeCompare(left.createdAt) ||
    right.id.localeCompare(left.id)
  );
}

function createSecurityEvent(
  input: Omit<ApiTokenSecurityEvent, 'id'>
): ApiTokenSecurityEvent {
  return apiTokenSecurityEventSchema.parse({ id: createId(), ...input });
}

function clampEventLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) return 100;
  return Math.min(limit, 100);
}
