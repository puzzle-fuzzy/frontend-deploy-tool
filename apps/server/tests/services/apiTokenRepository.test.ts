import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Data } from '@deploykit/shared';
import type { ApiTokenRecord } from '../../src/domain/apiToken';
import { CURRENT_SCHEMA_VERSION } from '../../src/domain/schema';
import {
  type ApiTokenRepository,
  createMemoryApiTokenRepository,
  createSqliteApiTokenRepository,
} from '../../src/repositories/apiTokenRepository';
import { createSqliteProjectRepository } from '../../src/repositories/sqliteProjectRepository';
import { configureSqlite } from '../../src/repositories/sqliteSchema';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'deploykit-api-token-repo-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('API token repositories', () => {
  test('memory repository keeps lifecycle metadata redacted', () => {
    exerciseLifecycle(createMemoryApiTokenRepository());
  });

  test('SQLite repository stores only a digest and persists lifecycle events', () => {
    const databaseFile = join(tempDir, 'deploykit.sqlite');
    const projectRepository = createSqliteProjectRepository({ databaseFile });
    projectRepository.save(createData());
    const repository = createSqliteApiTokenRepository(databaseFile);

    exerciseLifecycle(repository);

    const database = new Database(databaseFile);
    const stored = database
      .query<{ secret_digest: string; scopes_json: string }, []>(
        `SELECT secret_digest, scopes_json
         FROM project_api_tokens
         ORDER BY created_at`
      )
      .all();
    const rawColumns = database
      .query<{ name: string }, []>('PRAGMA table_info(project_api_tokens)')
      .all()
      .map((column) => column.name);
    database.close();

    expect(stored.map((row) => row.secret_digest)).toEqual([
      'a'.repeat(64),
      'b'.repeat(64),
    ]);
    expect(
      stored.every((row) => row.scopes_json === '["preview:upload"]')
    ).toBe(true);
    expect(rawColumns).not.toContain('secret');
    expect(rawColumns).not.toContain('plaintext_token');
  });

  test('SQLite lifecycle writes roll back when its security event cannot commit', () => {
    const databaseFile = join(tempDir, 'deploykit.sqlite');
    createSqliteProjectRepository({ databaseFile }).save(createData());
    const database = new Database(databaseFile);
    database.exec(`
      CREATE TRIGGER reject_token_security_event
      BEFORE INSERT ON api_token_security_events
      BEGIN
        SELECT RAISE(ABORT, 'injected security event failure');
      END;
    `);
    database.close();

    const repository = createSqliteApiTokenRepository(databaseFile);
    expect(() =>
      repository.create({
        token: createToken('token-1', 'a'.repeat(64)),
        projectName: 'Signal Desk',
      })
    ).toThrow('injected security event failure');

    const verify = new Database(databaseFile);
    const tokenCount = verify
      .query<{ count: number }, []>(
        'SELECT COUNT(*) AS count FROM project_api_tokens'
      )
      .get()?.count;
    verify.close();
    expect(tokenCount).toBe(0);
  });

  test('SQLite rotation and revocation roll back with their security events', () => {
    const databaseFile = join(tempDir, 'deploykit.sqlite');
    createSqliteProjectRepository({ databaseFile }).save(createData());
    const repository = createSqliteApiTokenRepository(databaseFile);
    const initial = createToken('token-1', 'a'.repeat(64));
    const replacement = createToken('token-2', 'b'.repeat(64), {
      createdAt: '2026-07-31T01:00:00.000Z',
    });
    repository.create({ token: initial, projectName: 'Signal Desk' });
    installRejectEventTrigger(databaseFile);

    expect(() =>
      repository.rotate({
        currentTokenId: initial.id,
        replacement,
        projectName: 'Signal Desk',
        actorId: 'user-1',
        rotatedAt: replacement.createdAt,
        previousExpiresAt: '2026-07-31T01:15:00.000Z',
        revokePrevious: false,
      })
    ).toThrow('injected security event failure');
    expect(repository.list('project-1')).toEqual([
      expect.objectContaining({
        id: initial.id,
        expiresAt: initial.expiresAt,
        replacedByTokenId: null,
      }),
    ]);

    removeRejectEventTrigger(databaseFile);
    repository.rotate({
      currentTokenId: initial.id,
      replacement,
      projectName: 'Signal Desk',
      actorId: 'user-1',
      rotatedAt: replacement.createdAt,
      previousExpiresAt: '2026-07-31T01:15:00.000Z',
      revokePrevious: false,
    });
    installRejectEventTrigger(databaseFile);

    expect(() =>
      repository.revoke({
        projectId: 'project-1',
        projectName: 'Signal Desk',
        tokenId: replacement.id,
        actorId: 'user-1',
        revokedAt: '2026-07-31T01:05:00.000Z',
      })
    ).toThrow('injected security event failure');
    expect(repository.findById(replacement.id)?.revokedAt).toBeNull();
  });

  test('memory and SQLite repositories reject a colliding replacement id', () => {
    const databaseFile = join(tempDir, 'deploykit.sqlite');
    createSqliteProjectRepository({ databaseFile }).save(createData());
    const repositories = [
      createMemoryApiTokenRepository(),
      createSqliteApiTokenRepository(databaseFile),
    ];

    for (const repository of repositories) {
      const initial = createToken('token-1', 'a'.repeat(64));
      const occupied = createToken('token-2', 'b'.repeat(64), {
        createdAt: '2026-07-31T00:01:00.000Z',
      });
      repository.create({ token: initial, projectName: 'Signal Desk' });
      repository.create({ token: occupied, projectName: 'Signal Desk' });

      expect(
        repository.rotate({
          currentTokenId: initial.id,
          replacement: createToken(occupied.id, 'c'.repeat(64)),
          projectName: 'Signal Desk',
          actorId: 'user-1',
          rotatedAt: '2026-07-31T01:00:00.000Z',
          previousExpiresAt: '2026-07-31T01:15:00.000Z',
          revokePrevious: false,
        })
      ).toBeNull();
      expect(repository.list('project-1')).toContainEqual(
        expect.objectContaining({
          id: initial.id,
          replacedByTokenId: null,
          expiresAt: initial.expiresAt,
        })
      );
    }
  });

  test('memory and SQLite repositories rotate each token at most once', () => {
    const databaseFile = join(tempDir, 'deploykit.sqlite');
    createSqliteProjectRepository({ databaseFile }).save(createData());
    const repositories = [
      createMemoryApiTokenRepository(),
      createSqliteApiTokenRepository(databaseFile),
    ];

    for (const repository of repositories) {
      const initial = createToken('token-1', 'a'.repeat(64));
      const firstReplacement = createToken('token-2', 'b'.repeat(64), {
        createdAt: '2026-07-31T01:00:00.000Z',
      });
      repository.create({ token: initial, projectName: 'Signal Desk' });
      expect(
        repository.rotate({
          currentTokenId: initial.id,
          replacement: firstReplacement,
          projectName: 'Signal Desk',
          actorId: 'user-1',
          rotatedAt: '2026-07-31T01:00:00.000Z',
          previousExpiresAt: '2026-07-31T01:15:00.000Z',
          revokePrevious: false,
        })
      ).toMatchObject({ id: firstReplacement.id });

      expect(
        repository.rotate({
          currentTokenId: initial.id,
          replacement: createToken('token-3', 'c'.repeat(64), {
            createdAt: '2026-07-31T01:01:00.000Z',
          }),
          projectName: 'Signal Desk',
          actorId: 'user-1',
          rotatedAt: '2026-07-31T01:01:00.000Z',
          previousExpiresAt: '2026-07-31T01:16:00.000Z',
          revokePrevious: false,
        })
      ).toBeNull();
      expect(repository.list('project-1').map((token) => token.id)).toEqual([
        firstReplacement.id,
        initial.id,
      ]);
      expect(
        repository
          .listSecurityEvents('project-1')
          .filter((event) => event.action === 'api_token.rotate')
      ).toHaveLength(1);
    }
  });

  test('SQLite idempotency rows reject cross-project token or version links', () => {
    const databaseFile = join(tempDir, 'deploykit.sqlite');
    const data = createData();
    data.projects.push(createSecondProject());
    createSqliteProjectRepository({ databaseFile }).save(data);
    const repository = createSqliteApiTokenRepository(databaseFile);
    repository.create({
      token: createToken('token-1', 'a'.repeat(64)),
      projectName: 'Signal Desk',
    });
    repository.create({
      token: createToken('token-2', 'b'.repeat(64), {
        projectId: 'project-2',
      }),
      projectName: 'Other Project',
    });

    const database = new Database(databaseFile);
    configureSqlite(database);
    const insert = database.query(
      `INSERT INTO ci_idempotency_records (
         project_id, token_id, idempotency_key, request_digest, version_id,
         version_name, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    expect(() =>
      insert.run(
        'project-1',
        'token-2',
        'wrong-token',
        'd'.repeat(64),
        'version-1',
        'version-1',
        '2026-07-31T00:00:00.000Z',
        '2026-08-01T00:00:00.000Z'
      )
    ).toThrow();
    expect(() =>
      insert.run(
        'project-1',
        'token-1',
        'wrong-version',
        'e'.repeat(64),
        'version-2',
        'version-2',
        '2026-07-31T00:00:00.000Z',
        '2026-08-01T00:00:00.000Z'
      )
    ).toThrow();
    database.close();
  });

  test('aggregate save can delete a creator account without deleting its token', () => {
    const databaseFile = join(tempDir, 'deploykit.sqlite');
    const projectRepository = createSqliteProjectRepository({ databaseFile });
    projectRepository.save(createData());
    const repository = createSqliteApiTokenRepository(databaseFile);
    repository.create({
      token: createToken('token-1', 'a'.repeat(64)),
      projectName: 'Signal Desk',
    });
    const withoutCreator = createData();
    withoutCreator.users = [];
    withoutCreator.projects[0].members = [];

    projectRepository.save(withoutCreator);

    expect(repository.list('project-1')).toEqual([
      expect.objectContaining({
        id: 'token-1',
        createdBy: 'user-1',
      }),
    ]);
  });

  test('version deletion retains an unexpired idempotency result snapshot', () => {
    const databaseFile = join(tempDir, 'deploykit.sqlite');
    const projectRepository = createSqliteProjectRepository({ databaseFile });
    projectRepository.save(createData());
    const repository = createSqliteApiTokenRepository(databaseFile);
    repository.create({
      token: createToken('token-1', 'a'.repeat(64)),
      projectName: 'Signal Desk',
    });
    const database = new Database(databaseFile);
    configureSqlite(database);
    database
      .query(
        `INSERT INTO ci_idempotency_records (
           project_id, token_id, idempotency_key, request_digest, version_id,
           version_name, created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'project-1',
        'token-1',
        'ci-run-1',
        'd'.repeat(64),
        'version-1',
        'version-1',
        '2026-07-31T00:00:00.000Z',
        '2026-08-01T00:00:00.000Z'
      );
    database.close();

    projectRepository.mutate((data) => {
      data.projects[0].versions = [];
    });

    const verify = new Database(databaseFile);
    const stored = verify
      .query<
        { version_id: string; version_name: string },
        [string, string, string]
      >(
        `SELECT version_id, version_name
         FROM ci_idempotency_records
         WHERE project_id = ? AND token_id = ? AND idempotency_key = ?`
      )
      .get('project-1', 'token-1', 'ci-run-1');
    verify.close();
    expect(stored).toEqual({
      version_id: 'version-1',
      version_name: 'version-1',
    });
  });

  test('project deletion removes live tokens but retains security evidence', () => {
    const databaseFile = join(tempDir, 'deploykit.sqlite');
    const projectRepository = createSqliteProjectRepository({ databaseFile });
    projectRepository.save(createData());
    const repository = createSqliteApiTokenRepository(databaseFile);
    repository.create({
      token: createToken('token-1', 'a'.repeat(64)),
      projectName: 'Signal Desk',
    });
    const database = new Database(databaseFile);
    database
      .query(
        `INSERT INTO ci_idempotency_records (
           project_id, token_id, idempotency_key, request_digest, version_id,
           version_name, created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'project-1',
        'token-1',
        'ci-run-1',
        'b'.repeat(64),
        'version-1',
        'version-1',
        '2026-07-31T00:00:00.000Z',
        '2026-08-01T00:00:00.000Z'
      );
    database.close();

    projectRepository.mutate((data) => {
      data.projects = [];
    });

    expect(repository.findById('token-1')).toBeNull();
    expect(repository.listSecurityEvents('project-1')).toHaveLength(1);
    const verify = new Database(databaseFile);
    const idempotencyCount = verify
      .query<{ count: number }, []>(
        'SELECT COUNT(*) AS count FROM ci_idempotency_records'
      )
      .get()?.count;
    verify.close();
    expect(idempotencyCount).toBe(0);
  });
});

function exerciseLifecycle(repository: ApiTokenRepository): void {
  const initial = createToken('token-1', 'a'.repeat(64));
  const replacement = createToken('token-2', 'b'.repeat(64), {
    createdAt: '2026-07-31T01:00:00.000Z',
    expiresAt: '2026-10-29T01:00:00.000Z',
    prefix: 'dpk_v1.token-2.beta',
  });

  const created = repository.create({
    token: initial,
    projectName: 'Signal Desk',
  });
  expect(created).not.toHaveProperty('secretDigest');
  expect(repository.findById(initial.id)).toEqual({
    id: initial.id,
    projectId: initial.projectId,
    hashVersion: 1,
    secretDigest: 'a'.repeat(64),
    scopes: ['preview:upload'],
    expiresAt: initial.expiresAt,
    revokedAt: null,
    prefix: initial.prefix,
  });

  const rotated = repository.rotate({
    currentTokenId: initial.id,
    replacement,
    projectName: 'Signal Desk',
    actorId: 'user-1',
    rotatedAt: replacement.createdAt,
    previousExpiresAt: '2026-07-31T01:15:00.000Z',
    revokePrevious: false,
  });
  expect(rotated).toMatchObject({ id: replacement.id });
  expect(repository.list('project-1')).toHaveLength(2);

  expect(
    repository.touchLastUsed({
      tokenId: replacement.id,
      usedAt: '2026-07-31T01:01:00.000Z',
      onlyIfBefore: '2026-07-31T00:56:00.000Z',
    })
  ).toBe(true);
  expect(
    repository.touchLastUsed({
      tokenId: replacement.id,
      usedAt: '2026-07-31T01:02:00.000Z',
      onlyIfBefore: '2026-07-31T00:57:00.000Z',
    })
  ).toBe(false);

  repository.recordAuthenticationFailure({
    token: replacement,
    projectName: 'Signal Desk',
    reason: 'digest_mismatch',
    occurredAt: '2026-07-31T01:03:00.000Z',
  });
  const revoked = repository.revoke({
    projectId: 'project-1',
    projectName: 'Signal Desk',
    tokenId: replacement.id,
    actorId: 'user-1',
    revokedAt: '2026-07-31T01:04:00.000Z',
  });
  expect(revoked?.revokedAt).toBe('2026-07-31T01:04:00.000Z');
  expect(
    repository.revoke({
      projectId: 'project-1',
      projectName: 'Signal Desk',
      tokenId: replacement.id,
      actorId: 'user-1',
      revokedAt: '2026-07-31T01:05:00.000Z',
    })
  ).toEqual(revoked);

  const events = repository.listSecurityEvents('project-1');
  expect(events.map((event) => event.action)).toEqual([
    'api_token.revoke',
    'api_token.authentication_failed',
    'api_token.rotate',
    'api_token.create',
  ]);
  expect(JSON.stringify(events)).not.toContain('a'.repeat(64));
  expect(JSON.stringify(events)).not.toContain('b'.repeat(64));
}

function createToken(
  id: string,
  secretDigest: string,
  overrides: Partial<ApiTokenRecord> = {}
): ApiTokenRecord {
  return {
    id,
    projectId: 'project-1',
    name: 'GitHub Actions',
    hashVersion: 1,
    secretDigest,
    prefix: `dpk_v1.${id}.alpha`,
    scopes: ['preview:upload'],
    createdAt: '2026-07-31T00:00:00.000Z',
    createdBy: 'user-1',
    expiresAt: '2026-10-29T00:00:00.000Z',
    lastUsedAt: null,
    revokedAt: null,
    replacedByTokenId: null,
    ...overrides,
  };
}

function createData(): Data {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    users: [
      {
        id: 'user-1',
        name: 'Owner',
        email: 'owner@example.test',
        passwordHash: 'hash',
        role: 'developer',
        createdAt: '2026-07-31T00:00:00.000Z',
        updatedAt: '2026-07-31T00:00:00.000Z',
      },
    ],
    projects: [
      {
        id: 'project-1',
        name: 'Signal Desk',
        slug: 'signal-desk',
        description: '',
        createdAt: '2026-07-31T00:00:00.000Z',
        updatedAt: '2026-07-31T00:00:00.000Z',
        versions: [
          {
            id: 'version-1',
            name: 'version-1',
            description: '',
            createdAt: '2026-07-31T00:00:00.000Z',
            size: 1,
            fileCount: 1,
            sourceType: 'folder',
            status: 'preview',
            publishedAt: null,
            publishedBy: null,
            checksum: 'c'.repeat(64),
            integrityStatus: 'verified',
            integrityCheckedAt: '2026-07-31T00:00:00.000Z',
          },
        ],
        activeVersionId: null,
        settings: { spaMode: false, routingType: 'path' },
        auditPolicy: {
          enforcement: 'advisory',
          maxTotalBytes: 50 * 1024 * 1024,
          maxFileBytes: 10 * 1024 * 1024,
          maxFileCount: 1_000,
          maxJavaScriptBytes: 10 * 1024 * 1024,
          maxStylesheetBytes: 2 * 1024 * 1024,
          maxFontBytes: 10 * 1024 * 1024,
        },
        createdBy: 'user-1',
        members: [
          {
            userId: 'user-1',
            role: 'owner',
            invitedAt: '2026-07-31T00:00:00.000Z',
          },
        ],
      },
    ],
    history: [],
    artifactAudits: [],
    artifactAuditJobs: [],
  };
}

function createSecondProject(): Data['projects'][number] {
  return {
    id: 'project-2',
    name: 'Other Project',
    slug: 'other-project',
    description: '',
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
    versions: [
      {
        id: 'version-2',
        name: 'version-2',
        description: '',
        createdAt: '2026-07-31T00:00:00.000Z',
        size: 1,
        fileCount: 1,
        sourceType: 'folder',
        status: 'preview',
        publishedAt: null,
        publishedBy: null,
        checksum: 'f'.repeat(64),
        integrityStatus: 'verified',
        integrityCheckedAt: '2026-07-31T00:00:00.000Z',
      },
    ],
    activeVersionId: null,
    settings: { spaMode: false, routingType: 'path' },
    auditPolicy: {
      enforcement: 'advisory',
      maxTotalBytes: 50 * 1024 * 1024,
      maxFileBytes: 10 * 1024 * 1024,
      maxFileCount: 1_000,
      maxJavaScriptBytes: 10 * 1024 * 1024,
      maxStylesheetBytes: 2 * 1024 * 1024,
      maxFontBytes: 10 * 1024 * 1024,
    },
    createdBy: 'user-1',
    members: [],
  };
}

function installRejectEventTrigger(databaseFile: string): void {
  const database = new Database(databaseFile);
  database.exec(`
    CREATE TRIGGER reject_token_security_event
    BEFORE INSERT ON api_token_security_events
    BEGIN
      SELECT RAISE(ABORT, 'injected security event failure');
    END;
  `);
  database.close();
}

function removeRejectEventTrigger(databaseFile: string): void {
  const database = new Database(databaseFile);
  database.exec('DROP TRIGGER reject_token_security_event');
  database.close();
}
