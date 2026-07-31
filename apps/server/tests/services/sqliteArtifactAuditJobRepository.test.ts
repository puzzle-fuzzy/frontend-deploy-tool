import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactAuditPolicy } from '@deploykit/shared';
import { createArtifactAuditJobCursorCodec } from '../../src/domain/artifactAuditJobCursor';
import { createSqliteArtifactAuditJobRepository } from '../../src/repositories/sqliteArtifactAuditJobRepository';
import { createSqliteProjectRepository } from '../../src/repositories/sqliteProjectRepository';
import {
  configureSqlite,
  createRelationalSchema,
  RELATIONAL_SCHEMA_VERSION,
} from '../../src/repositories/sqliteSchema';

const NOW = '2026-07-30T00:00:00.000Z';
const CURSOR_SECRET = 'sqlite-audit-job-repository-test-secret';
const CURSOR_CODEC = createArtifactAuditJobCursorCodec(CURSOR_SECRET);
const POLICY: ArtifactAuditPolicy = {
  enforcement: 'advisory',
  maxTotalBytes: 50 * 1024 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
  maxFileCount: 1_000,
  maxJavaScriptBytes: 10 * 1024 * 1024,
  maxStylesheetBytes: 2 * 1024 * 1024,
  maxFontBytes: 10 * 1024 * 1024,
};
const LIMITS = { global: 10, requester: 10, project: 10 };

let tempDir: string;
let databaseFile: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'deploykit-audit-job-repo-'));
  databaseFile = join(tempDir, 'deploykit.sqlite');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('SQLite artifact audit queue', () => {
  test('migrates v4 to v7 with a backup and the complete queue index set', () => {
    const database = new Database(databaseFile, { create: true });
    configureSqlite(database);
    createRelationalSchema(database);
    downgradeSchemaToV6(database);
    database.exec(`
      DROP TABLE ci_idempotency_records;
      DROP TABLE api_token_security_events;
      DROP TABLE project_api_tokens;
      DROP INDEX artifact_audit_jobs_active_version_unique_idx;
      DROP INDEX artifact_audit_jobs_claim_idx;
      DROP INDEX artifact_audit_jobs_version_created_idx;
      DROP INDEX artifact_audit_jobs_version_status_created_idx;
      DROP INDEX artifact_audit_jobs_expired_lease_idx;
      DROP INDEX artifact_audit_jobs_terminal_retention_idx;
      CREATE INDEX artifact_audit_jobs_claim_idx
        ON artifact_audit_jobs(status, next_run_at, priority DESC, created_at);
      CREATE INDEX artifact_audit_jobs_version_created_idx
        ON artifact_audit_jobs(project_id, version_id, created_at DESC);
      DELETE FROM schema_migrations;
      INSERT INTO schema_migrations (version, applied_at)
      VALUES
        (1, '${NOW}'),
        (2, '${NOW}'),
        (3, '${NOW}'),
        (4, '${NOW}');
    `);
    database.close();

    createSqliteProjectRepository({ databaseFile }).load();

    const verify = new Database(databaseFile);
    const version = verify
      .query<{ version: number | null }, []>(
        'SELECT MAX(version) AS version FROM schema_migrations'
      )
      .get()?.version;
    const indexes = verify
      .query<{ name: string; sql: string }, []>(
        `SELECT name, sql
         FROM sqlite_master
         WHERE type = 'index' AND tbl_name = 'artifact_audit_jobs'
         ORDER BY name`
      )
      .all();
    verify.close();

    expect(RELATIONAL_SCHEMA_VERSION).toBe(7);
    expect(version).toBe(7);
    expect(existsSync(`${databaseFile}.pre-relational-v7.bak`)).toBe(true);
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        'artifact_audit_jobs_active_version_unique_idx',
        'artifact_audit_jobs_claim_idx',
        'artifact_audit_jobs_expired_lease_idx',
        'artifact_audit_jobs_terminal_retention_idx',
        'artifact_audit_jobs_version_created_idx',
        'artifact_audit_jobs_version_status_created_idx',
      ])
    );
    expect(
      indexes.find(
        (index) =>
          index.name === 'artifact_audit_jobs_active_version_unique_idx'
      )?.sql
    ).toContain("WHERE status IN ('queued', 'running')");
  });

  test('fails v4 migration closed when duplicate active jobs already exist', () => {
    const database = new Database(databaseFile, { create: true });
    configureSqlite(database);
    createRelationalSchema(database);
    downgradeSchemaToV6(database);
    seedProject(database);
    database.exec(`
      DROP TABLE ci_idempotency_records;
      DROP TABLE api_token_security_events;
      DROP TABLE project_api_tokens;
      DROP INDEX artifact_audit_jobs_active_version_unique_idx;
      DELETE FROM schema_migrations;
      INSERT INTO schema_migrations (version, applied_at)
      VALUES
        (1, '${NOW}'),
        (2, '${NOW}'),
        (3, '${NOW}'),
        (4, '${NOW}');
    `);
    insertJob(database, {
      id: 'job-a',
      status: 'queued',
      requestedBy: 'user-1',
    });
    insertJob(database, {
      id: 'job-b',
      status: 'running',
      requestedBy: 'user-2',
      lockedBy: 'worker-2',
      lockedUntil: '2026-07-30T00:01:00.000Z',
    });
    database.close();

    expect(() =>
      createSqliteProjectRepository({ databaseFile }).load()
    ).toThrow();
    expect(existsSync(`${databaseFile}.pre-relational-v7.bak`)).toBe(true);

    const verify = new Database(databaseFile);
    expect(
      verify
        .query<{ count: number }, []>(
          'SELECT COUNT(*) AS count FROM artifact_audit_jobs'
        )
        .get()?.count
    ).toBe(2);
    expect(
      verify
        .query<{ version: number | null }, []>(
          'SELECT MAX(version) AS version FROM schema_migrations'
        )
        .get()?.version
    ).toBe(4);
    verify.close();
  });

  test('claims once across two independent processes released by one barrier', async () => {
    const repository = createFixture();
    expect(repository.enqueue(enqueueInput('job-1')).kind).toBe('enqueued');
    const goFile = join(tempDir, 'go');
    const fixture = join(
      import.meta.dir,
      '..',
      'fixtures',
      'artifactAuditJobRepositoryProcess.ts'
    );
    const processes = ['worker-1', 'worker-2'].map((workerId) => {
      const readyFile = join(tempDir, `${workerId}.ready`);
      return {
        readyFile,
        process: Bun.spawn({
          cmd: [
            process.execPath,
            fixture,
            'claim',
            databaseFile,
            workerId,
            readyFile,
            goFile,
            CURSOR_SECRET,
          ],
          stdout: 'pipe',
          stderr: 'pipe',
        }),
      };
    });
    await waitUntil(() =>
      processes.every(({ readyFile }) => existsSync(readyFile))
    );
    writeFileSync(goFile, 'go');
    const results = await Promise.all(
      processes.map(async ({ process: child }) => {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(stderr).toBe('');
        expect(exitCode).toBe(0);
        return JSON.parse(stdout) as {
          identity: string;
          jobId: string | null;
        };
      })
    );

    expect(results.filter((result) => result.jobId === 'job-1')).toHaveLength(
      1
    );
    expect(readJobs()).toEqual([
      expect.objectContaining({
        id: 'job-1',
        status: 'running',
        attempts: 1,
      }),
    ]);
  });

  test('recovers an expired lease and claims it without worker restart', () => {
    const repository = createFixture();
    repository.enqueue(enqueueInput('job-1'));
    repository.recoverAndClaim(claimInput('dead-worker', 1_000));

    const takeover = repository.recoverAndClaim({
      ...claimInput('survivor'),
      now: '2026-07-30T00:00:01.001Z',
    });
    expect(takeover).toMatchObject({
      recovered: { retried: 1, failed: 0 },
      job: {
        id: 'job-1',
        status: 'running',
        attempts: 2,
        lockedBy: 'survivor',
      },
    });
  });

  test('empty polls change no domain row and append no WAL business frame', () => {
    const repository = createFixture();
    const sentinel = new Database(databaseFile);
    configureSqlite(sentinel);
    sentinel.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const beforeRows = snapshotDomainRows(sentinel);
    const beforeFrames = walFrames(sentinel);

    for (let index = 0; index < 20; index += 1) {
      expect(repository.recoverAndClaim(claimInput(`worker-${index}`))).toEqual(
        {
          job: null,
          recovered: { retried: 0, failed: 0 },
          stale: 0,
        }
      );
    }

    expect(snapshotDomainRows(sentinel)).toEqual(beforeRows);
    expect(walFrames(sentinel)).toBe(beforeFrames);
    sentinel.close();
  });

  test('rejects a missing artifact without changing any queue row', () => {
    const repository = createFixture();
    const before = readJobs();

    expect(
      repository.enqueue({
        ...enqueueInput('job-missing'),
        artifactPresent: false,
      })
    ).toEqual({ kind: 'artifact-missing' });
    expect(readJobs()).toEqual(before);
  });

  test('deduplicates concurrent same-snapshot enqueue before every limit', async () => {
    createFixture();
    const results = await runBarrierProcesses('enqueue', [
      'request-a',
      'request-b',
    ]);

    expect(results.map((result) => result.kind).sort()).toEqual([
      'enqueued',
      'reused',
    ]);
    expect(new Set(results.map((result) => result.jobId)).size).toBe(1);
    expect(readJobs()).toHaveLength(1);

    const repository = createSqliteArtifactAuditJobRepository({
      databaseFile,
      cursorCodec: CURSOR_CODEC,
    });
    expect(
      repository.enqueue({
        ...enqueueInput('job-third'),
        limits: { global: 1, requester: 1, project: 1 },
      }).kind
    ).toBe('reused');
  });

  test('deduplicates enforcement-only changes but replaces routing-context changes', () => {
    const repository = createFixture();
    expect(repository.enqueue(enqueueInput('job-1'))).toMatchObject({
      kind: 'enqueued',
      job: {
        id: 'job-1',
        context: { spaMode: false, routingType: 'path' },
      },
    });

    updateProjectPolicy({ ...POLICY, enforcement: 'blocking' });
    expect(repository.enqueue(enqueueInput('job-2'))).toMatchObject({
      kind: 'reused',
      job: { id: 'job-1' },
    });

    updateProjectContext({ spaMode: true, routingType: 'hash' });
    expect(repository.enqueue(enqueueInput('job-3'))).toMatchObject({
      kind: 'enqueued',
      replacedJobCount: 1,
      job: {
        id: 'job-3',
        context: { spaMode: true, routingType: 'hash' },
      },
    });
  });

  test('rejects global, requester, and project capacity independently', () => {
    {
      const repository = createFixture();
      seedOtherActive({
        projectId: 'project-2',
        versionId: 'version-2',
        jobId: 'global-existing',
        requestedBy: 'user-2',
      });
      expect(
        repository.enqueue({
          ...enqueueInput('global-rejected'),
          limits: { global: 1, requester: 10, project: 10 },
        })
      ).toEqual({ kind: 'rejected', scope: 'global' });
    }

    resetDatabase();
    {
      const repository = createFixture();
      seedOtherActive({
        projectId: 'project-2',
        versionId: 'version-2',
        jobId: 'requester-existing',
        requestedBy: 'user-1',
      });
      expect(
        repository.enqueue({
          ...enqueueInput('requester-rejected'),
          limits: { global: 10, requester: 1, project: 10 },
        })
      ).toEqual({ kind: 'rejected', scope: 'requester' });
    }

    resetDatabase();
    {
      const repository = createFixture();
      seedOtherActive({
        projectId: 'project-1',
        versionId: 'version-2',
        jobId: 'project-existing',
        requestedBy: 'user-2',
      });
      expect(
        repository.enqueue({
          ...enqueueInput('project-rejected'),
          limits: { global: 10, requester: 10, project: 1 },
        })
      ).toEqual({ kind: 'rejected', scope: 'project' });
    }
  });

  test('replacement at capacity is net-zero and rejection has no partial writes', () => {
    const repository = createFixture();
    expect(repository.enqueue(enqueueInput('job-1')).kind).toBe('enqueued');
    updateProjectPolicy({ ...POLICY, maxFileCount: 999 });
    expect(
      repository.enqueue({
        ...enqueueInput('job-2'),
        limits: { global: 1, requester: 1, project: 1 },
      })
    ).toMatchObject({ kind: 'enqueued', replacedJobCount: 1 });
    expect(repository.get(scoped('job-1'))).toMatchObject({
      kind: 'found',
      job: { status: 'canceled' },
    });

    seedOtherActive({
      projectId: 'project-2',
      versionId: 'version-2',
      jobId: 'other-job',
      requestedBy: 'user-2',
    });
    updateProjectPolicy({ ...POLICY, maxFileCount: 998 });
    const before = readJobs();
    expect(
      repository.enqueue({
        ...enqueueInput('job-3'),
        limits: { global: 1, requester: 10, project: 10 },
      })
    ).toEqual({ kind: 'rejected', scope: 'global' });
    expect(readJobs()).toEqual(before);
  });

  test('cancel prevents late heartbeat, completion, and failure persistence', () => {
    const repository = createFixture();
    repository.enqueue(enqueueInput('job-1'));
    repository.recoverAndClaim(claimInput('worker-1'));
    expect(
      repository.cancel({
        ...scoped('job-1'),
        now: '2026-07-30T00:00:01.000Z',
      })
    ).toMatchObject({
      kind: 'found',
      changed: true,
      job: { status: 'canceled' },
    });
    expect(
      repository.heartbeat({
        jobId: 'job-1',
        workerId: 'worker-1',
        now: '2026-07-30T00:00:02.000Z',
        leaseMs: 90_000,
      })
    ).toBeNull();
    expect(repository.complete(completeInput())).toEqual({
      kind: 'lease-lost',
    });
    expect(repository.fail(failInput(true))).toEqual({
      kind: 'lease-lost',
    });
    expect(readReports()).toEqual([]);
    expect(readHistory()).toEqual([]);
  });

  test('retries with backoff, then stops at max attempts or for non-retryable errors', () => {
    const repository = createFixture();
    repository.enqueue({ ...enqueueInput('job-1'), maxAttempts: 2 });
    repository.recoverAndClaim(claimInput('worker-1'));
    expect(repository.fail(failInput(true))).toMatchObject({
      kind: 'transitioned',
      outcome: 'retried',
      job: {
        status: 'queued',
        nextRunAt: '2026-07-30T00:00:03.000Z',
      },
    });
    expect(
      repository.recoverAndClaim({
        ...claimInput('worker-1'),
        now: '2026-07-30T00:00:03.000Z',
      }).job
    ).toMatchObject({ attempts: 2 });
    expect(
      repository.fail({
        ...failInput(true),
        now: '2026-07-30T00:00:04.000Z',
      })
    ).toMatchObject({
      kind: 'transitioned',
      outcome: 'failed',
      job: { status: 'failed' },
    });

    expect(
      repository.enqueue({
        ...enqueueInput('job-2'),
        now: '2026-07-30T00:00:05.000Z',
      }).kind
    ).toBe('enqueued');
    repository.recoverAndClaim({
      ...claimInput('worker-2'),
      now: '2026-07-30T00:00:05.000Z',
    });
    expect(
      repository.fail({
        ...failInput(false),
        jobId: 'job-2',
        workerId: 'worker-2',
        now: '2026-07-30T00:00:06.000Z',
      })
    ).toMatchObject({
      kind: 'transitioned',
      outcome: 'failed',
      job: { status: 'failed', attempts: 1 },
    });
  });

  test('completes report, history, and job in one successful transaction', () => {
    const repository = createFixture();
    repository.enqueue(enqueueInput('job-1'));
    repository.recoverAndClaim(claimInput('worker-1'));

    expect(repository.complete(completeInput())).toMatchObject({
      kind: 'transitioned',
      outcome: 'succeeded',
      job: {
        status: 'succeeded',
        reportId: 'report-1',
      },
    });
    expect(readReports()).toEqual([
      expect.objectContaining({
        id: 'report-1',
        project_id: 'project-1',
        version_id: 'version-1',
      }),
    ]);
    expect(readHistory()).toEqual([
      expect.objectContaining({
        id: 'history-1',
        action: 'version.audit',
        project_id: 'project-1',
        version_id: 'version-1',
      }),
    ]);
  });

  test('completion ignores enforcement but fails closed on routing-context drift', () => {
    const repository = createFixture();
    repository.enqueue(enqueueInput('job-1'));
    repository.recoverAndClaim(claimInput('worker-1'));
    updateProjectPolicy({ ...POLICY, enforcement: 'blocking' });

    expect(repository.complete(completeInput())).toMatchObject({
      kind: 'transitioned',
      outcome: 'succeeded',
      job: { status: 'succeeded' },
    });
    expect(readReports()).toEqual([
      expect.objectContaining({
        context_json: JSON.stringify({
          spaMode: false,
          routingType: 'path',
        }),
      }),
    ]);

    updateProjectPolicy(POLICY);
    expect(
      repository.enqueue({
        ...enqueueInput('job-2'),
        now: '2026-07-30T00:00:02.000Z',
      })
    ).toMatchObject({ kind: 'enqueued' });
    repository.recoverAndClaim({
      ...claimInput('worker-2'),
      now: '2026-07-30T00:00:02.000Z',
    });
    updateProjectContext({ spaMode: true, routingType: 'hash' });
    expect(
      repository.complete({
        ...completeInput(),
        jobId: 'job-2',
        workerId: 'worker-2',
        now: '2026-07-30T00:00:03.000Z',
        reportId: 'report-2',
        historyEventId: 'history-2',
      })
    ).toMatchObject({
      kind: 'transitioned',
      outcome: 'failed',
      job: { status: 'failed', errorCode: 'AUDIT_REQUIRED' },
    });
  });

  test('rolls completion back when the history append trigger fails', () => {
    const repository = createFixture();
    repository.enqueue(enqueueInput('job-1'));
    repository.recoverAndClaim(claimInput('worker-1'));
    const jobBeforeCompletion = repository.get(scoped('job-1'));
    const database = new Database(databaseFile);
    database.exec(`
      CREATE TRIGGER fail_audit_history
      BEFORE INSERT ON audit_events
      WHEN NEW.action = 'version.audit'
      BEGIN
        SELECT RAISE(ABORT, 'history unavailable');
      END;
    `);
    database.close();

    expect(() => repository.complete(completeInput())).toThrow(
      'history unavailable'
    );
    expect(repository.get(scoped('job-1'))).toEqual(jobBeforeCompletion);
    expect(readReports()).toEqual([]);
    expect(readHistory()).toEqual([]);
  });

  test('rolls report and history back when the final lease update is ignored', () => {
    const repository = createFixture();
    repository.enqueue(enqueueInput('job-1'));
    repository.recoverAndClaim(claimInput('worker-1'));
    const jobBeforeCompletion = repository.get(scoped('job-1'));
    const database = new Database(databaseFile);
    database.exec(`
      CREATE TRIGGER ignore_audit_job_success
      BEFORE UPDATE OF status ON artifact_audit_jobs
      WHEN OLD.id = 'job-1' AND NEW.status = 'succeeded'
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);
    database.close();

    expect(repository.complete(completeInput())).toEqual({
      kind: 'lease-lost',
    });
    expect(repository.get(scoped('job-1'))).toEqual(jobBeforeCompletion);
    expect(readReports()).toEqual([]);
    expect(readHistory()).toEqual([]);
  });

  test('reads every queue health field from one consistent SQL snapshot', () => {
    const repository = createFixture();
    const database = new Database(databaseFile);
    insertJob(database, {
      id: 'job-queued',
      status: 'queued',
      requestedBy: 'user-1',
      createdAt: '2026-07-29T23:59:50.000Z',
    });
    for (const status of ['succeeded', 'failed', 'canceled'] as const) {
      insertJob(database, {
        id: `job-${status}`,
        status,
        requestedBy: 'user-1',
      });
    }
    database.close();
    const querySpy = spyOn(Database.prototype, 'query');

    try {
      expect(repository.health({ now: NOW })).toEqual({
        queued: 1,
        running: 0,
        oldestQueuedAt: '2026-07-29T23:59:50.000Z',
        oldestQueuedAgeSeconds: 10,
        terminal: {
          succeeded: 1,
          failed: 1,
          canceled: 1,
        },
      });
      expect(
        querySpy.mock.calls
          .map(([sql]) => sql)
          .filter((sql) => sql.includes('FROM artifact_audit_jobs'))
      ).toHaveLength(1);
    } finally {
      querySpy.mockRestore();
    }
  });

  test('paginates equal timestamps stably across new heads and anchor transitions', () => {
    const repository = createFixture();
    const database = new Database(databaseFile);
    for (const id of ['job-a', 'job-b', 'job-c', 'job-d']) {
      insertJob(database, {
        id,
        status: 'failed',
        requestedBy: 'user-1',
      });
    }
    database.close();

    const first = repository.list({
      projectId: 'project-1',
      versionId: 'version-1',
      status: 'failed',
      limit: 2,
    });
    if (first.kind !== 'page' || !first.page.nextCursor) {
      throw new Error('first audit job page fixture is incomplete');
    }
    const firstCursor = first.page.nextCursor;
    expect(first).toMatchObject({
      kind: 'page',
      page: {
        items: [{ id: 'job-d' }, { id: 'job-c' }],
        nextCursor: expect.any(String),
      },
    });

    const mutate = new Database(databaseFile);
    insertJob(mutate, {
      id: 'job-new-head',
      status: 'failed',
      requestedBy: 'user-1',
      createdAt: '2026-07-30T00:00:01.000Z',
    });
    mutate
      .query(
        `UPDATE artifact_audit_jobs
         SET status = 'succeeded'
         WHERE id = 'job-c'`
      )
      .run();
    mutate.close();

    expect(
      repository.list({
        projectId: 'project-1',
        versionId: 'version-1',
        status: 'failed',
        limit: 2,
        cursor: firstCursor,
      })
    ).toMatchObject({
      kind: 'page',
      page: {
        items: [{ id: 'job-b' }, { id: 'job-a' }],
        nextCursor: null,
      },
    });
    expect(
      repository.list({
        projectId: 'project-1',
        versionId: 'version-1',
        status: 'canceled',
        limit: 2,
        cursor: firstCursor,
      })
    ).toEqual({ kind: 'invalid-cursor' });
    expect(
      repository.list({
        projectId: 'project-1',
        versionId: 'version-1',
        status: 'failed',
        limit: 2,
        cursor: `${firstCursor}x`,
      })
    ).toEqual({ kind: 'invalid-cursor' });
  });

  test('rejects re-encoded cursor payloads even when they name real scoped anchors', () => {
    const repository = createFixture();
    const database = new Database(databaseFile);
    for (const id of ['job-a', 'job-b', 'job-c']) {
      insertJob(database, {
        id,
        status: 'failed',
        requestedBy: 'user-1',
      });
    }
    database.close();

    const first = repository.list({
      projectId: 'project-1',
      versionId: 'version-1',
      limit: 1,
    });
    if (first.kind !== 'page' || !first.page.nextCursor) {
      throw new Error('authenticated cursor fixture is incomplete');
    }
    const cursor = first.page.nextCursor;
    const list = (nextCursor: string, status?: 'failed' | 'canceled') =>
      repository.list({
        projectId: 'project-1',
        versionId: 'version-1',
        limit: 1,
        cursor: nextCursor,
        ...(status ? { status } : {}),
      });

    expect(
      list(
        rewriteCursorPayload(cursor, (payload) => ({
          ...payload,
          anchorJobId: 'job-b',
        }))
      )
    ).toEqual({ kind: 'invalid-cursor' });
    expect(
      list(
        rewriteCursorPayload(cursor, (payload) => ({
          ...payload,
          status: 'failed',
        })),
        'failed'
      )
    ).toEqual({ kind: 'invalid-cursor' });
    expect(
      list(
        rewriteCursorPayload(cursor, (payload) => ({
          ...payload,
          projectId: 'other-project',
        }))
      )
    ).toEqual({ kind: 'invalid-cursor' });
    expect(
      list(
        rewriteCursorPayload(cursor, (payload) => ({
          ...payload,
          unexpected: true,
        }))
      )
    ).toEqual({ kind: 'invalid-cursor' });
    expect(list(rewriteCursorSignature(cursor))).toEqual({
      kind: 'invalid-cursor',
    });
  });

  test('continues an unfiltered cursor after a queued anchor is claimed', () => {
    const repository = createFixture();
    const database = new Database(databaseFile);
    for (const id of ['job-a', 'job-b']) {
      insertJob(database, {
        id,
        status: 'failed',
        requestedBy: 'user-1',
      });
    }
    insertJob(database, {
      id: 'job-z',
      status: 'queued',
      requestedBy: 'user-1',
    });
    database.close();

    const first = repository.list({
      projectId: 'project-1',
      versionId: 'version-1',
      limit: 1,
    });
    if (first.kind !== 'page' || !first.page.nextCursor) {
      throw new Error('queued transition cursor fixture is incomplete');
    }
    expect(first.page.items).toEqual([
      expect.objectContaining({ id: 'job-z', status: 'queued' }),
    ]);
    const cursor = first.page.nextCursor;

    expect(repository.recoverAndClaim(claimInput('worker-1'))).toMatchObject({
      job: { id: 'job-z', status: 'running' },
    });
    expect(
      repository.list({
        projectId: 'project-1',
        versionId: 'version-1',
        limit: 2,
        cursor,
      })
    ).toMatchObject({
      kind: 'page',
      page: {
        items: [{ id: 'job-b' }, { id: 'job-a' }],
        nextCursor: null,
      },
    });
  });

  test('prunes terminal jobs by cutoff and batch while preserving durable records', () => {
    const repository = createFixture();
    const database = new Database(databaseFile);
    for (const id of ['job-a', 'job-b', 'job-c']) {
      insertJob(database, {
        id,
        status: 'failed',
        requestedBy: 'user-1',
      });
    }
    database
      .query(
        `INSERT INTO artifact_audits (
           id, project_id, version_id, artifact_checksum, status, score,
           created_at, created_by, engine_version, policy_json, summary_json,
           checks_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'report-current',
        'project-1',
        'version-1',
        'checksum-1',
        'passed',
        100,
        NOW,
        'user-1',
        1,
        JSON.stringify(POLICY),
        JSON.stringify({
          totalBytes: 1,
          fileCount: 1,
          largestFiles: [],
          extensions: [],
        }),
        '[]'
      );
    database
      .query(
        `INSERT INTO audit_events (
           id, action, project_id, project_name, version_id, version_name,
           occurred_at, actor_id, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'history-current',
        'version.audit',
        'project-1',
        'Project',
        'version-1',
        'v1',
        NOW,
        'user-1',
        JSON.stringify({ reportId: 'report-current' })
      );
    database
      .query(
        `INSERT INTO releases (
           id, project_id, project_name, version_id, version_name,
           previous_version_id, action, actor_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'release-current',
        'project-1',
        'Project',
        'version-1',
        'v1',
        null,
        'version.publish',
        'user-1',
        NOW
      );
    database.close();

    const page = repository.list({
      projectId: 'project-1',
      versionId: 'version-1',
      limit: 1,
    });
    if (page.kind !== 'page' || !page.page.nextCursor) {
      throw new Error('terminal prune cursor fixture is incomplete');
    }
    const cursor = page.page.nextCursor;

    expect(
      repository.pruneTerminal({
        cutoff: '2026-07-31T00:00:00.000Z',
        batchSize: 2,
        dryRun: true,
      })
    ).toEqual({ matched: 2, removed: 0 });
    expect(readJobs()).toHaveLength(3);
    expect(
      repository.pruneTerminal({
        cutoff: '2026-07-31T00:00:00.000Z',
        batchSize: 2,
        dryRun: false,
      })
    ).toEqual({ matched: 2, removed: 2 });
    expect(readJobs()).toHaveLength(1);
    expect(readReports()).toHaveLength(1);
    expect(readHistory()).toHaveLength(1);
    expect(tableCount('releases')).toBe(1);

    repository.pruneTerminal({
      cutoff: '2026-07-31T00:00:00.000Z',
      batchSize: 10,
      dryRun: false,
    });
    expect(
      repository.list({
        projectId: 'project-1',
        versionId: 'version-1',
        limit: 1,
        cursor,
      })
    ).toEqual({ kind: 'invalid-cursor' });
    expect(readReports()).toHaveLength(1);
    expect(readHistory()).toHaveLength(1);
    expect(tableCount('releases')).toBe(1);
  });
});

function createFixture() {
  const projectRepository = createSqliteProjectRepository({ databaseFile });
  projectRepository.load();
  const database = new Database(databaseFile);
  seedProject(database);
  database.close();
  return createSqliteArtifactAuditJobRepository({
    databaseFile,
    cursorCodec: CURSOR_CODEC,
  });
}

function downgradeSchemaToV6(database: Database): void {
  for (const [table, column] of [
    ['projects', 'audit_max_javascript_bytes'],
    ['projects', 'audit_max_stylesheet_bytes'],
    ['projects', 'audit_max_font_bytes'],
    ['artifact_audits', 'context_json'],
    ['artifact_audit_jobs', 'context_json'],
  ] as const) {
    const present = database
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .some((candidate) => candidate.name === column);
    if (present) database.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
}

function seedProject(database: Database): void {
  database
    .query(
      `INSERT OR IGNORE INTO users (
         id, name, email, password_hash, role, created_at, updated_at, sort_order
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'user-1',
      'Owner',
      'owner@example.com',
      'hash',
      'developer',
      NOW,
      NOW,
      0
    );
  database
    .query(
      `INSERT OR IGNORE INTO projects (
         id, name, slug, description, created_at, updated_at, active_version_id,
         spa_mode, routing_type, audit_enforcement, audit_max_total_bytes,
         audit_max_file_bytes, audit_max_file_count, created_by, sort_order
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'project-1',
      'Project',
      'project',
      '',
      NOW,
      NOW,
      null,
      0,
      'path',
      POLICY.enforcement,
      POLICY.maxTotalBytes,
      POLICY.maxFileBytes,
      POLICY.maxFileCount,
      'user-1',
      0
    );
  database
    .query(
      `INSERT OR IGNORE INTO versions (
         id, project_id, name, description, created_at, size, file_count,
         source_type, status, published_at, published_by, checksum,
         integrity_status, integrity_checked_at, sort_order
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'version-1',
      'project-1',
      'v1',
      '',
      NOW,
      1,
      1,
      'folder',
      'preview',
      null,
      null,
      'checksum-1',
      'verified',
      NOW,
      0
    );
}

function enqueueInput(jobId: string) {
  return {
    projectId: 'project-1',
    versionId: 'version-1',
    requestedBy: 'user-1',
    priority: 0,
    maxAttempts: 3,
    now: NOW,
    jobId,
    engineVersion: 1,
    artifactPresent: true,
    limits: LIMITS,
  };
}

function claimInput(workerId: string, leaseMs = 90_000) {
  return {
    workerId,
    now: NOW,
    leaseMs,
    engineVersion: 1,
  };
}

function completeInput() {
  return {
    jobId: 'job-1',
    workerId: 'worker-1',
    now: '2026-07-30T00:00:01.000Z',
    currentArtifactChecksum: 'checksum-1',
    engineVersion: 1,
    reportId: 'report-1',
    historyEventId: 'history-1',
    result: {
      artifactChecksum: 'checksum-1',
      status: 'passed' as const,
      score: 100,
      summary: {
        totalBytes: 1,
        fileCount: 1,
        largestFiles: [{ path: 'index.html', size: 1 }],
        extensions: [{ extension: '.html', bytes: 1, count: 1 }],
        assetBytes: {
          javascript: 0,
          stylesheet: 0,
          font: 0,
          image: 0,
        },
      },
      checks: [],
    },
  };
}

function failInput(retryable: boolean) {
  return {
    jobId: 'job-1',
    workerId: 'worker-1',
    now: '2026-07-30T00:00:01.000Z',
    retryable,
    retryBaseDelayMs: 2_000,
  };
}

function scoped(jobId: string) {
  return {
    projectId: 'project-1',
    versionId: 'version-1',
    jobId,
  };
}

function rewriteCursorPayload(
  cursor: string,
  rewrite: (payload: Record<string, unknown>) => Record<string, unknown>
): string {
  const [encodedPayload, signature] = cursor.split('.');
  if (!encodedPayload) throw new Error('cursor payload is missing');
  const payload = JSON.parse(
    Buffer.from(encodedPayload, 'base64url').toString('utf8')
  ) as Record<string, unknown>;
  const rewritten = Buffer.from(JSON.stringify(rewrite(payload))).toString(
    'base64url'
  );
  return signature ? `${rewritten}.${signature}` : rewritten;
}

function rewriteCursorSignature(cursor: string): string {
  const [encodedPayload, signature] = cursor.split('.');
  if (!encodedPayload) throw new Error('cursor payload is missing');
  if (!signature) return `${encodedPayload}.AA`;
  const first = signature.at(0);
  return `${encodedPayload}.${first === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
}

function insertJob(
  database: Database,
  overrides: {
    id: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
    requestedBy: string;
    lockedBy?: string;
    lockedUntil?: string;
    projectId?: string;
    versionId?: string;
    checksum?: string;
    createdAt?: string;
  }
): void {
  database
    .query(
      `INSERT INTO artifact_audit_jobs (
         id, project_id, version_id, requested_by, status, priority, attempts,
         max_attempts, next_run_at, locked_by, locked_until, artifact_checksum,
         engine_version, policy_json, report_id, error_code, error_message,
         created_at, updated_at, started_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      overrides.id,
      overrides.projectId ?? 'project-1',
      overrides.versionId ?? 'version-1',
      overrides.requestedBy,
      overrides.status,
      0,
      overrides.status === 'queued' ? 0 : 1,
      3,
      NOW,
      overrides.lockedBy ?? null,
      overrides.lockedUntil ?? null,
      overrides.checksum ?? 'checksum-1',
      1,
      JSON.stringify(POLICY),
      null,
      null,
      null,
      overrides.createdAt ?? NOW,
      overrides.createdAt ?? NOW,
      overrides.status === 'running' ? NOW : null,
      ['succeeded', 'failed', 'canceled'].includes(overrides.status)
        ? (overrides.createdAt ?? NOW)
        : null
    );
}

function updateProjectPolicy(policy: typeof POLICY): void {
  const database = new Database(databaseFile);
  database
    .query(
      `UPDATE projects
       SET audit_enforcement = ?, audit_max_total_bytes = ?,
           audit_max_file_bytes = ?, audit_max_file_count = ?
       WHERE id = 'project-1'`
    )
    .run(
      policy.enforcement,
      policy.maxTotalBytes,
      policy.maxFileBytes,
      policy.maxFileCount
    );
  database.close();
}

function updateProjectContext(context: {
  spaMode: boolean;
  routingType: 'hash' | 'path';
}): void {
  const database = new Database(databaseFile);
  database
    .query(
      `UPDATE projects
       SET spa_mode = ?, routing_type = ?
       WHERE id = 'project-1'`
    )
    .run(context.spaMode ? 1 : 0, context.routingType);
  database.close();
}

function seedOtherActive(input: {
  projectId: string;
  versionId: string;
  jobId: string;
  requestedBy: string;
}): void {
  const database = new Database(databaseFile);
  if (input.projectId !== 'project-1') {
    database
      .query(
        `INSERT INTO projects (
           id, name, slug, description, created_at, updated_at,
           active_version_id, spa_mode, routing_type, audit_enforcement,
           audit_max_total_bytes, audit_max_file_bytes, audit_max_file_count,
           created_by, sort_order
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.projectId,
        input.projectId,
        input.projectId,
        '',
        NOW,
        NOW,
        null,
        0,
        'path',
        POLICY.enforcement,
        POLICY.maxTotalBytes,
        POLICY.maxFileBytes,
        POLICY.maxFileCount,
        'user-1',
        1
      );
  }
  database
    .query(
      `INSERT INTO versions (
         id, project_id, name, description, created_at, size, file_count,
         source_type, status, published_at, published_by, checksum,
         integrity_status, integrity_checked_at, sort_order
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.versionId,
      input.projectId,
      input.versionId,
      '',
      NOW,
      1,
      1,
      'folder',
      'preview',
      null,
      null,
      `checksum-${input.versionId}`,
      'verified',
      NOW,
      1
    );
  insertJob(database, {
    id: input.jobId,
    status: 'queued',
    requestedBy: input.requestedBy,
    projectId: input.projectId,
    versionId: input.versionId,
    checksum: `checksum-${input.versionId}`,
  });
  database.close();
}

function resetDatabase(): void {
  rmSync(databaseFile, { force: true });
  rmSync(`${databaseFile}-wal`, { force: true });
  rmSync(`${databaseFile}-shm`, { force: true });
  rmSync(`${databaseFile}.pre-relational-v7.bak`, { force: true });
}

function readJobs(): Array<Record<string, unknown>> {
  const database = new Database(databaseFile);
  const rows = database
    .query<Record<string, unknown>, []>(
      `SELECT id, project_id, version_id, requested_by, status, attempts,
              locked_by, locked_until, error_code, error_message,
              completed_at
       FROM artifact_audit_jobs
       ORDER BY id`
    )
    .all();
  database.close();
  return rows;
}

function readReports(): Array<Record<string, unknown>> {
  const database = new Database(databaseFile);
  const rows = database
    .query<Record<string, unknown>, []>(
      'SELECT * FROM artifact_audits ORDER BY id'
    )
    .all();
  database.close();
  return rows;
}

function readHistory(): Array<Record<string, unknown>> {
  const database = new Database(databaseFile);
  const rows = database
    .query<Record<string, unknown>, []>(
      'SELECT * FROM audit_events ORDER BY sequence'
    )
    .all();
  database.close();
  return rows;
}

function tableCount(table: 'releases'): number {
  const database = new Database(databaseFile);
  const count =
    database
      .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`)
      .get()?.count ?? 0;
  database.close();
  return count;
}

function snapshotDomainRows(database: Database): Record<string, unknown> {
  return {
    jobs: database
      .query<Record<string, unknown>, []>(
        'SELECT * FROM artifact_audit_jobs ORDER BY id'
      )
      .all(),
    projects: database
      .query<Record<string, unknown>, []>('SELECT * FROM projects ORDER BY id')
      .all(),
    versions: database
      .query<Record<string, unknown>, []>('SELECT * FROM versions ORDER BY id')
      .all(),
    audits: database
      .query<Record<string, unknown>, []>(
        'SELECT * FROM artifact_audits ORDER BY id'
      )
      .all(),
    history: database
      .query<Record<string, unknown>, []>(
        'SELECT * FROM audit_events ORDER BY sequence'
      )
      .all(),
  };
}

function walFrames(database: Database): number {
  return (
    database.query<{ log: number }, []>('PRAGMA wal_checkpoint(PASSIVE)').get()
      ?.log ?? 0
  );
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for audit repository process barrier');
    }
    await Bun.sleep(10);
  }
}

async function runBarrierProcesses(
  command: 'claim' | 'enqueue',
  identities: string[]
): Promise<Array<{ identity: string; kind: string; jobId: string | null }>> {
  const goFile = join(tempDir, `${command}.go`);
  const fixture = join(
    import.meta.dir,
    '..',
    'fixtures',
    'artifactAuditJobRepositoryProcess.ts'
  );
  const processes = identities.map((identity) => {
    const readyFile = join(tempDir, `${command}-${identity}.ready`);
    return {
      readyFile,
      process: Bun.spawn({
        cmd: [
          process.execPath,
          fixture,
          command,
          databaseFile,
          identity,
          readyFile,
          goFile,
          CURSOR_SECRET,
        ],
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    };
  });
  await waitUntil(() =>
    processes.every(({ readyFile }) => existsSync(readyFile))
  );
  writeFileSync(goFile, 'go');
  return await Promise.all(
    processes.map(async ({ process: child }) => {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe('');
      expect(exitCode).toBe(0);
      return JSON.parse(stdout) as {
        identity: string;
        kind: string;
        jobId: string | null;
      };
    })
  );
}
