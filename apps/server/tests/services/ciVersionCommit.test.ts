import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Data, Project, Version } from '@deploykit/shared';
import { API_TOKEN_HASH_VERSION } from '../../src/domain/apiToken';
import { appendHistoryEvent } from '../../src/domain/history';
import { createSqliteApiTokenRepository } from '../../src/repositories/apiTokenRepository';
import { createJsonProjectRepository } from '../../src/repositories/jsonProjectRepository';
import type { CommitVersionUploadInput } from '../../src/repositories/projectRepository';
import { createSqliteProjectRepository } from '../../src/repositories/sqliteProjectRepository';

const NOW = '2026-07-31T00:00:00.000Z';
const EXPIRES_AT = '2026-08-01T00:00:00.000Z';
const TOKEN_EXPIRES_AT = '2026-08-30T00:00:00.000Z';

let tempDir: string;
let databaseFile: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'deploykit-ci-commit-'));
  databaseFile = join(tempDir, 'deploykit.sqlite');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test('atomically creates, replays, conflicts, and preserves the result snapshot', () => {
  const repo = createFixture();
  const uploaded = version('version-1', 'version');
  const input = commitInput(uploaded);

  const created = repo.commitVersionUpload?.(input, (data) => {
    appendUpload(data, uploaded);
  });
  expect(created).toEqual({
    outcome: 'created',
    version: { id: uploaded.id, name: uploaded.name },
  });

  let replayMutationCalled = false;
  const restarted = createSqliteProjectRepository({ databaseFile });
  expect(
    restarted.commitVersionUpload?.(input, () => {
      replayMutationCalled = true;
    })
  ).toEqual({
    outcome: 'replayed',
    version: { id: uploaded.id, name: uploaded.name },
  });
  expect(replayMutationCalled).toBe(false);

  expect(
    restarted.commitVersionUpload?.(
      { ...input, requestDigest: 'b'.repeat(64) },
      () => {
        throw new Error('conflict must not mutate');
      }
    )
  ).toEqual({ outcome: 'conflict' });

  restarted.mutate((data) => {
    data.projects[0].versions = [];
  });
  expect(restarted.commitVersionUpload?.(input, () => {})).toEqual({
    outcome: 'replayed',
    version: { id: uploaded.id, name: uploaded.name },
  });

  const database = new Database(databaseFile, { readonly: true });
  try {
    expect(count(database, 'ci_idempotency_records')).toBe(1);
    expect(count(database, 'audit_events')).toBe(1);
    expect(count(database, 'versions')).toBe(0);
  } finally {
    database.close();
  }
});

test('rolls back version, history, and idempotency when the mutation fails', () => {
  const repo = createFixture();
  const uploaded = version('version-failed', 'failed');

  expect(() =>
    repo.commitVersionUpload?.(commitInput(uploaded), (data) => {
      appendUpload(data, uploaded);
      throw new Error('injected commit failure');
    })
  ).toThrow('injected commit failure');

  const database = new Database(databaseFile, { readonly: true });
  try {
    expect(count(database, 'versions')).toBe(0);
    expect(count(database, 'audit_events')).toBe(0);
    expect(count(database, 'ci_idempotency_records')).toBe(0);
  } finally {
    database.close();
  }
});

test('rolls back metadata when the idempotency snapshot insert fails', () => {
  const repo = createFixture();
  const persistedVersion = version('persisted-version', 'persisted');
  const mismatchedSnapshot = version('missing-snapshot-version', 'snapshot');

  expect(() =>
    repo.commitVersionUpload?.(commitInput(mismatchedSnapshot), (data) => {
      appendUpload(data, persistedVersion);
    })
  ).toThrow('CI idempotency version project mismatch');

  const database = new Database(databaseFile, { readonly: true });
  try {
    expect(count(database, 'versions')).toBe(0);
    expect(count(database, 'audit_events')).toBe(0);
    expect(count(database, 'ci_idempotency_records')).toBe(0);
  } finally {
    database.close();
  }
});

test('expires an idempotency key after twenty-four-hour retention', () => {
  const repo = createFixture();
  const firstVersion = version('version-old', 'old');
  const firstInput = commitInput(firstVersion);
  repo.commitVersionUpload?.(firstInput, (data) => {
    appendUpload(data, firstVersion);
  });

  const database = new Database(databaseFile);
  try {
    database
      .query('UPDATE ci_idempotency_records SET expires_at = ?')
      .run('2026-07-30T23:59:59.999Z');
  } finally {
    database.close();
  }

  const replacement = version('version-new', 'new');
  const replacementInput = {
    ...commitInput(replacement),
    requestDigest: 'e'.repeat(64),
  };
  expect(
    repo.commitVersionUpload?.(replacementInput, (data) => {
      appendUpload(data, replacement);
    })
  ).toEqual({
    outcome: 'created',
    version: { id: replacement.id, name: replacement.name },
  });

  const readOnly = new Database(databaseFile, { readonly: true });
  try {
    expect(
      readOnly
        .query<{ version_id: string; expires_at: string }, []>(
          'SELECT version_id, expires_at FROM ci_idempotency_records'
        )
        .get()
    ).toEqual({
      version_id: replacement.id,
      expires_at: EXPIRES_AT,
    });
  } finally {
    readOnly.close();
  }
});

test('revalidates token state inside the write transaction', () => {
  const repo = createFixture();
  const tokenRepo = createSqliteApiTokenRepository(databaseFile);
  tokenRepo.revoke({
    projectId: 'project-1',
    projectName: 'Demo',
    tokenId: 'token-1',
    actorId: 'owner-1',
    revokedAt: NOW,
  });

  let mutationCalled = false;
  expect(
    repo.commitVersionUpload?.(
      commitInput(version('version-revoked', 'revoked')),
      () => {
        mutationCalled = true;
      }
    )
  ).toEqual({ outcome: 'token-inactive', reason: 'revoked' });
  expect(mutationCalled).toBe(false);

  const database = new Database(databaseFile);
  try {
    database
      .query(
        `UPDATE project_api_tokens
         SET revoked_at = NULL, expires_at = ?
         WHERE id = ?`
      )
      .run('2026-07-30T00:00:00.000Z', 'token-1');
  } finally {
    database.close();
  }
  expect(
    repo.commitVersionUpload?.(
      commitInput(version('version-expired', 'expired')),
      () => {
        mutationCalled = true;
      }
    )
  ).toEqual({ outcome: 'token-inactive', reason: 'expired' });
  expect(mutationCalled).toBe(false);
});

test('keeps equivalent in-process idempotency semantics in the JSON adapter', () => {
  const repo = createJsonProjectRepository(join(tempDir, 'data.json'));
  const data = repo.load();
  data.projects.push(project());
  repo.save(data);
  const uploaded = version('json-version', 'json');
  const input = commitInput(uploaded);

  expect(
    repo.commitVersionUpload?.(input, (current) => {
      appendUpload(current, uploaded);
    })
  ).toEqual({
    outcome: 'created',
    version: { id: uploaded.id, name: uploaded.name },
  });
  expect(repo.commitVersionUpload?.(input, () => {})).toEqual({
    outcome: 'replayed',
    version: { id: uploaded.id, name: uploaded.name },
  });
  expect(
    repo.commitVersionUpload?.(
      { ...input, requestDigest: 'd'.repeat(64) },
      () => {}
    )
  ).toEqual({ outcome: 'conflict' });
  expect(repo.load().projects[0].versions).toHaveLength(1);
});

function createFixture() {
  const repo = createSqliteProjectRepository({ databaseFile });
  const data = repo.load();
  data.projects.push(project());
  repo.save(data);
  createSqliteApiTokenRepository(databaseFile).create({
    projectName: 'Demo',
    token: {
      id: 'token-1',
      projectId: 'project-1',
      name: 'CI',
      hashVersion: API_TOKEN_HASH_VERSION,
      secretDigest: 'a'.repeat(64),
      prefix: 'dpk_v1.token-1',
      scopes: ['preview:upload'],
      createdAt: NOW,
      createdBy: 'owner-1',
      expiresAt: TOKEN_EXPIRES_AT,
      lastUsedAt: null,
      revokedAt: null,
      replacedByTokenId: null,
    },
  });
  return repo;
}

function commitInput(uploaded: Version): CommitVersionUploadInput {
  return {
    projectId: 'project-1',
    tokenId: 'token-1',
    requiredScope: 'preview:upload',
    idempotencyKey: 'build-1',
    requestDigest: 'a'.repeat(64),
    version: { id: uploaded.id, name: uploaded.name },
    committedAt: NOW,
    expiresAt: EXPIRES_AT,
  };
}

function appendUpload(data: Data, uploaded: Version): void {
  const target = data.projects[0];
  target.versions.push(uploaded);
  target.updatedAt = NOW;
  appendHistoryEvent(
    data,
    'version.upload',
    target,
    'api-token:token-1',
    uploaded
  );
}

function project(): Project {
  return {
    id: 'project-1',
    name: 'Demo',
    slug: 'demo',
    description: '',
    createdAt: NOW,
    updatedAt: NOW,
    versions: [],
    activeVersionId: null,
    settings: { spaMode: false, routingType: 'hash' },
    auditPolicy: {
      enforcement: 'advisory',
      maxTotalBytes: 50 * 1024 * 1024,
      maxFileBytes: 10 * 1024 * 1024,
      maxFileCount: 1_000,
    },
    createdBy: 'owner-1',
    members: [],
  };
}

function version(id: string, name: string): Version {
  return {
    id,
    name,
    description: 'CI upload',
    createdAt: NOW,
    size: 18,
    fileCount: 1,
    sourceType: 'folder',
    status: 'preview',
    publishedAt: null,
    publishedBy: null,
    checksum: 'c'.repeat(64),
    integrityStatus: 'unknown',
    integrityCheckedAt: null,
  };
}

function count(database: Database, table: string): number {
  return (
    database
      .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`)
      .get()?.count ?? 0
  );
}
