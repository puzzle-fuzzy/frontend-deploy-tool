import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import type { ArtifactAuditJob, ArtifactAuditPolicy } from '@deploykit/shared';
import {
  hasSameArtifactAuditPolicy,
  hasSameArtifactAuditSnapshot,
  isActiveArtifactAuditJob,
  isArtifactAuditLeaseOwned,
} from '../domain/artifactAuditJob';
import type { ArtifactAuditJobCursorCodec } from '../domain/artifactAuditJobCursor';
import {
  createArtifactAuditCompletionRecords,
  decideArtifactAuditFailure,
} from '../domain/artifactAuditJobTransitions';
import {
  ARTIFACT_AUDIT_JOB_SELECT_COLUMNS,
  type ArtifactAuditJobRow,
  rowToArtifactAuditJob,
} from './artifactAuditJobMapper';
import type {
  ArtifactAuditJobRepository,
  CancelArtifactAuditJobInput,
  CompleteArtifactAuditJobInput,
  EnqueueArtifactAuditJobInput,
  FailArtifactAuditJobInput,
  HeartbeatArtifactAuditJobInput,
  RecoverAndClaimArtifactAuditJobInput,
  ScopedArtifactAuditJobKey,
} from './artifactAuditJobRepository';
import {
  getRelationalSchemaVersion,
  RELATIONAL_SCHEMA_VERSION,
} from './sqliteSchema';

export interface SqliteArtifactAuditJobRepositoryOptions {
  databaseFile: string;
  cursorCodec: ArtifactAuditJobCursorCodec;
}

export function createSqliteArtifactAuditJobRepository(
  options: SqliteArtifactAuditJobRepositoryOptions
): ArtifactAuditJobRepository {
  const withDatabase = <T>(work: (database: Database) => T): T => {
    if (!existsSync(options.databaseFile)) {
      throw new Error(
        'Artifact audit queue database is not initialized; create the project repository first'
      );
    }
    const database = new Database(options.databaseFile);
    try {
      // Schema initialization owns the WAL-mode transition. Repeating
      // `PRAGMA journal_mode = WAL` on every high-rate queue connection can
      // contend with another process before busy_timeout is installed.
      database.exec('PRAGMA busy_timeout = 5000');
      database.exec('PRAGMA foreign_keys = ON');
      database.exec('PRAGMA synchronous = NORMAL');
      const version = getRelationalSchemaVersion(database);
      if (version !== RELATIONAL_SCHEMA_VERSION) {
        throw new Error(
          `Artifact audit queue requires relational schema v${RELATIONAL_SCHEMA_VERSION}; found v${version}`
        );
      }
      return work(database);
    } finally {
      database.close();
    }
  };

  return {
    enqueue(input: EnqueueArtifactAuditJobInput) {
      return withDatabase((database) => {
        const enqueue = database.transaction(
          (
            nextInput: EnqueueArtifactAuditJobInput
          ): ReturnType<ArtifactAuditJobRepository['enqueue']> => {
            const project = readProjectSnapshot(
              database,
              nextInput.projectId,
              nextInput.versionId
            );
            if (project.kind !== 'found') return project;
            if (!nextInput.artifactPresent) {
              return { kind: 'artifact-missing' };
            }

            const activeRows = database
              .query<ArtifactAuditJobRow, [string, string]>(
                `SELECT ${ARTIFACT_AUDIT_JOB_SELECT_COLUMNS}
                 FROM artifact_audit_jobs
                 WHERE project_id = ? AND version_id = ?
                   AND status IN ('queued', 'running')
                 ORDER BY created_at ASC, id ASC`
              )
              .all(nextInput.projectId, nextInput.versionId);
            const activeJobs = activeRows.map(rowToArtifactAuditJob);
            const snapshot = {
              artifactChecksum: project.checksum,
              engineVersion: nextInput.engineVersion,
              policy: project.policy,
            };
            const duplicate = activeJobs.find((job) =>
              hasSameArtifactAuditSnapshot(job, snapshot)
            );
            if (duplicate) return { kind: 'reused', job: duplicate };

            const replacement = activeJobs[0] ?? null;
            const activeCounts = readProjectedActiveCounts(
              database,
              nextInput,
              replacement
            );
            if (activeCounts.global > nextInput.limits.global) {
              return { kind: 'rejected', scope: 'global' };
            }
            if (activeCounts.requester > nextInput.limits.requester) {
              return { kind: 'rejected', scope: 'requester' };
            }
            if (activeCounts.project > nextInput.limits.project) {
              return { kind: 'rejected', scope: 'project' };
            }

            if (replacement) {
              database
                .query(
                  `UPDATE artifact_audit_jobs
                   SET status = 'canceled', locked_by = NULL,
                       locked_until = NULL, error_code = 'AUDIT_REQUIRED',
                       error_message = ?,
                       updated_at = ?, completed_at = ?
                   WHERE id = ? AND status IN ('queued', 'running')`
                )
                .run(
                  'Artifact or audit policy changed before the job started',
                  nextInput.now,
                  nextInput.now,
                  replacement.id
                );
            }

            database
              .query(
                `INSERT INTO artifact_audit_jobs (
                   id, project_id, version_id, requested_by, status, priority,
                   attempts, max_attempts, next_run_at, locked_by, locked_until,
                   artifact_checksum, engine_version, policy_json, report_id,
                   error_code, error_message, created_at, updated_at, started_at,
                   completed_at
                 ) VALUES (
                   ?, ?, ?, ?, 'queued', ?, 0, ?, ?, NULL, NULL, ?, ?, ?, NULL,
                   NULL, NULL, ?, ?, NULL, NULL
                 )`
              )
              .run(
                nextInput.jobId,
                nextInput.projectId,
                nextInput.versionId,
                nextInput.requestedBy,
                nextInput.priority,
                nextInput.maxAttempts,
                nextInput.now,
                project.checksum,
                nextInput.engineVersion,
                JSON.stringify(project.policy),
                nextInput.now,
                nextInput.now
              );
            const job = readJobById(database, nextInput.jobId);
            if (!job) {
              throw new Error(
                'Artifact audit job insert could not be read back'
              );
            }
            return {
              kind: 'enqueued',
              job,
              replacedJobCount: replacement ? 1 : 0,
            };
          }
        );
        return enqueue.immediate(input);
      });
    },
    recoverAndClaim(input: RecoverAndClaimArtifactAuditJobInput) {
      return withDatabase((database) => {
        const recoverAndClaim = database.transaction(
          (
            nextInput: RecoverAndClaimArtifactAuditJobInput
          ): ReturnType<ArtifactAuditJobRepository['recoverAndClaim']> => {
            const recovered = { retried: 0, failed: 0 };
            let stale = 0;
            const expired = database
              .query<
                { id: string; attempts: number; max_attempts: number },
                [string]
              >(
                `SELECT id, attempts, max_attempts
                 FROM artifact_audit_jobs
                 WHERE status = 'running'
                   AND locked_until IS NOT NULL
                   AND locked_until <= ?
                 ORDER BY locked_until ASC, id ASC`
              )
              .all(nextInput.now);
            for (const job of expired) {
              if (job.attempts < job.max_attempts) {
                database
                  .query(
                    `UPDATE artifact_audit_jobs
                     SET status = 'queued', next_run_at = ?,
                         locked_by = NULL, locked_until = NULL,
                         error_code = 'AUDIT_JOB_FAILED',
                         error_message = 'Artifact audit worker lease expired',
                         updated_at = ?, completed_at = NULL
                     WHERE id = ? AND status = 'running'
                       AND locked_until IS NOT NULL AND locked_until <= ?`
                  )
                  .run(nextInput.now, nextInput.now, job.id, nextInput.now);
                recovered.retried += 1;
              } else {
                database
                  .query(
                    `UPDATE artifact_audit_jobs
                     SET status = 'failed', locked_by = NULL,
                         locked_until = NULL,
                         error_code = 'AUDIT_JOB_FAILED',
                         error_message = 'Artifact audit worker lease expired',
                         updated_at = ?, completed_at = ?
                     WHERE id = ? AND status = 'running'
                       AND locked_until IS NOT NULL AND locked_until <= ?`
                  )
                  .run(nextInput.now, nextInput.now, job.id, nextInput.now);
                recovered.failed += 1;
              }
            }

            for (;;) {
              const candidateRow = database
                .query<ArtifactAuditJobRow, [string]>(
                  `SELECT ${ARTIFACT_AUDIT_JOB_SELECT_COLUMNS}
                   FROM artifact_audit_jobs
                   WHERE status = 'queued' AND next_run_at <= ?
                   ORDER BY priority DESC, created_at ASC, id ASC
                   LIMIT 1`
                )
                .get(nextInput.now);
              if (!candidateRow) return { job: null, recovered, stale };

              let candidate: ArtifactAuditJob;
              try {
                candidate = rowToArtifactAuditJob(candidateRow);
              } catch {
                terminateStaleJob(
                  database,
                  candidateRow.id,
                  nextInput.now,
                  'Artifact audit job payload is invalid'
                );
                stale += 1;
                continue;
              }
              const current = readProjectSnapshot(
                database,
                candidate.projectId,
                candidate.versionId
              );
              if (
                current.kind !== 'found' ||
                candidate.artifactChecksum !== current.checksum ||
                candidate.engineVersion !== nextInput.engineVersion ||
                !hasSameArtifactAuditPolicy(candidate.policy, current.policy)
              ) {
                terminateStaleJob(
                  database,
                  candidate.id,
                  nextInput.now,
                  'Artifact or audit policy changed before the job was claimed'
                );
                stale += 1;
                continue;
              }

              const lockedUntil = new Date(
                Date.parse(nextInput.now) + nextInput.leaseMs
              ).toISOString();
              const claimedRow = database
                .query<
                  ArtifactAuditJobRow,
                  [string, string, string, string, string, string]
                >(
                  `UPDATE artifact_audit_jobs
                   SET status = 'running', attempts = attempts + 1,
                       locked_by = ?, locked_until = ?, updated_at = ?,
                       started_at = COALESCE(started_at, ?),
                       error_code = NULL, error_message = NULL
                   WHERE id = ? AND status = 'queued' AND next_run_at <= ?
                   RETURNING ${ARTIFACT_AUDIT_JOB_SELECT_COLUMNS}`
                )
                .get(
                  nextInput.workerId,
                  lockedUntil,
                  nextInput.now,
                  nextInput.now,
                  candidate.id,
                  nextInput.now
                );
              if (!claimedRow) continue;
              return {
                job: rowToArtifactAuditJob(claimedRow),
                recovered,
                stale,
              };
            }
          }
        );
        return recoverAndClaim.immediate(input);
      });
    },
    get(_input: ScopedArtifactAuditJobKey) {
      return withDatabase((database) => readScopedJob(database, _input));
    },
    cancel(input: CancelArtifactAuditJobInput) {
      return withDatabase((database) => {
        const cancel = database.transaction(
          (
            nextInput: CancelArtifactAuditJobInput
          ): ReturnType<ArtifactAuditJobRepository['cancel']> => {
            const current = readScopedJob(database, nextInput);
            if (current.kind !== 'found') return current;
            if (!isActiveArtifactAuditJob(current.job)) {
              return { ...current, changed: false };
            }
            const row = database
              .query<ArtifactAuditJobRow, [string, string, string]>(
                `UPDATE artifact_audit_jobs
                 SET status = 'canceled', locked_by = NULL,
                     locked_until = NULL, error_code = NULL,
                     error_message = NULL, updated_at = ?, completed_at = ?
                 WHERE id = ? AND status IN ('queued', 'running')
                 RETURNING ${ARTIFACT_AUDIT_JOB_SELECT_COLUMNS}`
              )
              .get(nextInput.now, nextInput.now, nextInput.jobId);
            if (!row) {
              const latest = readScopedJob(database, nextInput);
              return latest.kind === 'found'
                ? { ...latest, changed: false }
                : latest;
            }
            return {
              kind: 'found',
              job: rowToArtifactAuditJob(row),
              changed: true,
            };
          }
        );
        return cancel.immediate(input);
      });
    },
    heartbeat(input: HeartbeatArtifactAuditJobInput) {
      return withDatabase((database) => {
        const lockedUntil = new Date(
          Date.parse(input.now) + input.leaseMs
        ).toISOString();
        const row = database
          .query<ArtifactAuditJobRow, [string, string, string, string, string]>(
            `UPDATE artifact_audit_jobs
             SET locked_until = ?, updated_at = ?
             WHERE id = ? AND status = 'running' AND locked_by = ?
               AND locked_until IS NOT NULL AND locked_until > ?
             RETURNING ${ARTIFACT_AUDIT_JOB_SELECT_COLUMNS}`
          )
          .get(lockedUntil, input.now, input.jobId, input.workerId, input.now);
        return row ? rowToArtifactAuditJob(row) : null;
      });
    },
    complete(input: CompleteArtifactAuditJobInput) {
      return withDatabase((database) => {
        const complete = database.transaction(
          (
            nextInput: CompleteArtifactAuditJobInput
          ): ReturnType<ArtifactAuditJobRepository['complete']> => {
            const job = readJobById(database, nextInput.jobId);
            if (!job) return { kind: 'job-not-found' };
            if (
              !isArtifactAuditLeaseOwned(
                job,
                nextInput.workerId,
                new Date(nextInput.now)
              )
            ) {
              return { kind: 'lease-lost' };
            }
            const current = readProjectSnapshot(
              database,
              job.projectId,
              job.versionId
            );
            if (
              current.kind !== 'found' ||
              nextInput.currentArtifactChecksum !== job.artifactChecksum ||
              nextInput.result.artifactChecksum !== job.artifactChecksum ||
              current.checksum !== job.artifactChecksum ||
              job.engineVersion !== nextInput.engineVersion ||
              !hasSameArtifactAuditPolicy(current.policy, job.policy)
            ) {
              const stale = transitionJobFailed(
                database,
                job.id,
                nextInput.now,
                'AUDIT_REQUIRED',
                'Artifact or audit policy changed while the job was running'
              );
              if (!stale) return { kind: 'lease-lost' };
              return {
                kind: 'transitioned',
                job: stale,
                outcome: 'failed',
              };
            }
            const records = createArtifactAuditCompletionRecords({
              job,
              result: nextInput.result,
              now: nextInput.now,
              reportId: nextInput.reportId,
              historyEventId: nextInput.historyEventId,
              projectName: current.projectName,
              versionName: current.versionName,
            });

            database
              .query(
                `INSERT INTO artifact_audits (
                   id, project_id, version_id, artifact_checksum, status, score,
                   created_at, created_by, engine_version, policy_json,
                   summary_json, checks_json
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
              )
              .run(
                records.report.id,
                records.report.projectId,
                records.report.versionId,
                records.report.artifactChecksum,
                records.report.status,
                records.report.score,
                records.report.createdAt,
                records.report.createdBy,
                records.report.engineVersion,
                JSON.stringify(records.report.policy),
                JSON.stringify(records.report.summary),
                JSON.stringify(records.report.checks)
              );
            database
              .query(
                `INSERT INTO audit_events (
                   id, action, project_id, project_name, version_id,
                   version_name, occurred_at, actor_id, metadata_json
                 ) VALUES (?, 'version.audit', ?, ?, ?, ?, ?, ?, ?)`
              )
              .run(
                records.history.id,
                records.history.projectId,
                records.history.projectName,
                records.history.versionId,
                records.history.versionName,
                records.history.timestamp,
                records.history.actorId,
                JSON.stringify(records.history.metadata)
              );
            const completedRow = database
              .query<
                ArtifactAuditJobRow,
                [string, string, string, string, string, string]
              >(
                `UPDATE artifact_audit_jobs
                 SET status = 'succeeded', report_id = ?,
                     locked_by = NULL, locked_until = NULL,
                     error_code = NULL, error_message = NULL,
                     updated_at = ?, completed_at = ?
                 WHERE id = ? AND status = 'running' AND locked_by = ?
                   AND locked_until IS NOT NULL AND locked_until > ?
                 RETURNING ${ARTIFACT_AUDIT_JOB_SELECT_COLUMNS}`
              )
              .get(
                records.report.id,
                nextInput.now,
                nextInput.now,
                job.id,
                nextInput.workerId,
                nextInput.now
              );
            if (!completedRow) return { kind: 'lease-lost' };
            return {
              kind: 'transitioned',
              job: rowToArtifactAuditJob(completedRow),
              outcome: 'succeeded',
            };
          }
        );
        return complete.immediate(input);
      });
    },
    fail(input: FailArtifactAuditJobInput) {
      return withDatabase((database) => {
        const fail = database.transaction(
          (
            nextInput: FailArtifactAuditJobInput
          ): ReturnType<ArtifactAuditJobRepository['fail']> => {
            const job = readJobById(database, nextInput.jobId);
            if (!job) return { kind: 'job-not-found' };
            if (
              !isArtifactAuditLeaseOwned(
                job,
                nextInput.workerId,
                new Date(nextInput.now)
              )
            ) {
              return { kind: 'lease-lost' };
            }
            const decision = decideArtifactAuditFailure(job, nextInput);
            const row = database
              .query<
                ArtifactAuditJobRow,
                [
                  ArtifactAuditJob['status'],
                  string,
                  string,
                  string | null,
                  string,
                  string,
                  string,
                ]
              >(
                `UPDATE artifact_audit_jobs
                 SET status = ?, next_run_at = ?, locked_by = NULL,
                     locked_until = NULL, error_code = 'AUDIT_JOB_FAILED',
                     error_message = 'Artifact audit worker failed',
                     updated_at = ?, completed_at = ?
                 WHERE id = ? AND status = 'running' AND locked_by = ?
                   AND locked_until IS NOT NULL AND locked_until > ?
                 RETURNING ${ARTIFACT_AUDIT_JOB_SELECT_COLUMNS}`
              )
              .get(
                decision.status,
                decision.nextRunAt,
                nextInput.now,
                decision.completedAt,
                job.id,
                nextInput.workerId,
                nextInput.now
              );
            if (!row) return { kind: 'lease-lost' };
            return {
              kind: 'transitioned',
              job: rowToArtifactAuditJob(row),
              outcome: decision.outcome,
            };
          }
        );
        return fail.immediate(input);
      });
    },
    health(input) {
      return withDatabase((database) => {
        const counts = database
          .query<{ status: ArtifactAuditJob['status']; count: number }, []>(
            `SELECT status, COUNT(*) AS count
             FROM artifact_audit_jobs
             GROUP BY status`
          )
          .all();
        const byStatus = new Map(
          counts.map((entry) => [entry.status, entry.count])
        );
        const oldestQueuedAt =
          database
            .query<{ created_at: string }, []>(
              `SELECT created_at
               FROM artifact_audit_jobs
               WHERE status = 'queued'
               ORDER BY created_at ASC, id ASC
               LIMIT 1`
            )
            .get()?.created_at ?? null;
        return {
          queued: byStatus.get('queued') ?? 0,
          running: byStatus.get('running') ?? 0,
          oldestQueuedAt,
          oldestQueuedAgeSeconds: calculateQueueAge(oldestQueuedAt, input.now),
          terminal: {
            succeeded: byStatus.get('succeeded') ?? 0,
            failed: byStatus.get('failed') ?? 0,
            canceled: byStatus.get('canceled') ?? 0,
          },
        };
      });
    },
    list(input) {
      return withDatabase((database) => {
        const current = readProjectSnapshot(
          database,
          input.projectId,
          input.versionId
        );
        if (current.kind !== 'found') return current;
        const status = input.status ?? null;
        let anchor: { created_at: string; id: string } | null = null;
        if (input.cursor) {
          const cursor = options.cursorCodec.decode(input.cursor);
          if (
            !cursor ||
            cursor.projectId !== input.projectId ||
            cursor.versionId !== input.versionId ||
            cursor.status !== status
          ) {
            return { kind: 'invalid-cursor' };
          }
          anchor = database
            .query<
              { created_at: string; id: string },
              [string, string, string]
            >(
              `SELECT created_at, id
               FROM artifact_audit_jobs
               WHERE id = ? AND project_id = ? AND version_id = ?`
            )
            .get(cursor.anchorJobId, input.projectId, input.versionId);
          if (!anchor) return { kind: 'invalid-cursor' };
        }
        const limit = normalizeListLimit(input.limit);
        const bindings: Array<string | number> = [
          input.projectId,
          input.versionId,
        ];
        const statusClause = status ? ' AND status = ?' : '';
        if (status) bindings.push(status);
        const anchorClause = anchor
          ? ' AND (created_at < ? OR (created_at = ? AND id < ?))'
          : '';
        if (anchor) {
          bindings.push(anchor.created_at, anchor.created_at, anchor.id);
        }
        bindings.push(limit + 1);
        const rows = database
          .query<ArtifactAuditJobRow, Array<string | number>>(
            `SELECT ${ARTIFACT_AUDIT_JOB_SELECT_COLUMNS}
             FROM artifact_audit_jobs
             WHERE project_id = ? AND version_id = ?
               ${statusClause}${anchorClause}
             ORDER BY created_at DESC, id DESC
             LIMIT ?`
          )
          .all(...bindings)
          .map(rowToArtifactAuditJob);
        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;
        const lastItem = items.at(-1);
        return {
          kind: 'page',
          page: {
            items,
            nextCursor:
              hasMore && lastItem
                ? options.cursorCodec.encode({
                    projectId: input.projectId,
                    versionId: input.versionId,
                    anchorJobId: lastItem.id,
                    status,
                  })
                : null,
          },
        };
      });
    },
    pruneTerminal(input) {
      return withDatabase((database) => {
        const prune = database.transaction(() => {
          const rows = database
            .query<{ id: string }, [string, number]>(
              `SELECT id
               FROM artifact_audit_jobs
               WHERE status IN ('succeeded', 'failed', 'canceled')
                 AND completed_at IS NOT NULL
                 AND completed_at < ?
               ORDER BY completed_at ASC, id ASC
               LIMIT ?`
            )
            .all(input.cutoff, input.batchSize);
          if (input.dryRun || rows.length === 0) {
            return { matched: rows.length, removed: 0 };
          }
          const placeholders = rows.map(() => '?').join(', ');
          const result = database
            .query(
              `DELETE FROM artifact_audit_jobs
               WHERE id IN (${placeholders})
                 AND status IN ('succeeded', 'failed', 'canceled')`
            )
            .run(...rows.map((row) => row.id));
          return {
            matched: rows.length,
            removed: result.changes,
          };
        });
        return prune.immediate();
      });
    },
  };
}

type ProjectSnapshotResult =
  | {
      kind: 'found';
      checksum: string;
      policy: ArtifactAuditPolicy;
      projectName: string;
      versionName: string;
    }
  | { kind: 'project-not-found' }
  | { kind: 'version-not-found' };

function readProjectSnapshot(
  database: Database,
  projectId: string,
  versionId: string
): ProjectSnapshotResult {
  const project = database
    .query<
      {
        checksum: string | null;
        project_name: string;
        version_name: string | null;
        audit_enforcement: ArtifactAuditPolicy['enforcement'];
        audit_max_total_bytes: number;
        audit_max_file_bytes: number;
        audit_max_file_count: number;
      },
      [string, string]
    >(
      `SELECT versions.checksum, projects.name AS project_name,
              versions.name AS version_name, projects.audit_enforcement,
              projects.audit_max_total_bytes, projects.audit_max_file_bytes,
              projects.audit_max_file_count
       FROM projects
       LEFT JOIN versions
         ON versions.project_id = projects.id AND versions.id = ?
       WHERE projects.id = ?`
    )
    .get(versionId, projectId);
  if (!project) return { kind: 'project-not-found' };
  if (project.checksum === null) return { kind: 'version-not-found' };
  return {
    kind: 'found',
    checksum: project.checksum,
    projectName: project.project_name,
    versionName: project.version_name ?? '',
    policy: {
      enforcement: project.audit_enforcement,
      maxTotalBytes: project.audit_max_total_bytes,
      maxFileBytes: project.audit_max_file_bytes,
      maxFileCount: project.audit_max_file_count,
    },
  };
}

function readProjectedActiveCounts(
  database: Database,
  input: EnqueueArtifactAuditJobInput,
  replacement: ArtifactAuditJob | null
): ArtifactAuditAdmissionCounts {
  const active = "status IN ('queued', 'running')";
  const global =
    database
      .query<{ count: number }, []>(
        `SELECT COUNT(*) AS count
         FROM artifact_audit_jobs
         WHERE ${active}`
      )
      .get()?.count ?? 0;
  const requester =
    database
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count
         FROM artifact_audit_jobs
         WHERE ${active} AND requested_by = ?`
      )
      .get(input.requestedBy)?.count ?? 0;
  const project =
    database
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count
         FROM artifact_audit_jobs
         WHERE ${active} AND project_id = ?`
      )
      .get(input.projectId)?.count ?? 0;
  return {
    global: global - (replacement ? 1 : 0) + 1,
    requester:
      requester - (replacement?.requestedBy === input.requestedBy ? 1 : 0) + 1,
    project: project - (replacement ? 1 : 0) + 1,
  };
}

interface ArtifactAuditAdmissionCounts {
  global: number;
  requester: number;
  project: number;
}

function readJobById(
  database: Database,
  jobId: string
): ArtifactAuditJob | null {
  const row = database
    .query<ArtifactAuditJobRow, [string]>(
      `SELECT ${ARTIFACT_AUDIT_JOB_SELECT_COLUMNS}
       FROM artifact_audit_jobs
       WHERE id = ?`
    )
    .get(jobId);
  return row ? rowToArtifactAuditJob(row) : null;
}

function readScopedJob(
  database: Database,
  input: ScopedArtifactAuditJobKey
): ReturnType<ArtifactAuditJobRepository['get']> {
  const snapshot = readProjectSnapshot(
    database,
    input.projectId,
    input.versionId
  );
  if (snapshot.kind !== 'found') return snapshot;
  const row = database
    .query<ArtifactAuditJobRow, [string, string, string]>(
      `SELECT ${ARTIFACT_AUDIT_JOB_SELECT_COLUMNS}
       FROM artifact_audit_jobs
       WHERE id = ? AND project_id = ? AND version_id = ?`
    )
    .get(input.jobId, input.projectId, input.versionId);
  return row
    ? { kind: 'found', job: rowToArtifactAuditJob(row) }
    : { kind: 'job-not-found' };
}

function transitionJobFailed(
  database: Database,
  jobId: string,
  now: string,
  errorCode: string,
  errorMessage: string
): ArtifactAuditJob | null {
  const row = database
    .query<ArtifactAuditJobRow, [string, string, string, string, string]>(
      `UPDATE artifact_audit_jobs
       SET status = 'failed', locked_by = NULL, locked_until = NULL,
           error_code = ?, error_message = ?, updated_at = ?, completed_at = ?
       WHERE id = ? AND status = 'running'
       RETURNING ${ARTIFACT_AUDIT_JOB_SELECT_COLUMNS}`
    )
    .get(errorCode, errorMessage, now, now, jobId);
  return row ? rowToArtifactAuditJob(row) : null;
}

function terminateStaleJob(
  database: Database,
  jobId: string,
  now: string,
  message: string
): void {
  database
    .query(
      `UPDATE artifact_audit_jobs
       SET status = 'canceled', locked_by = NULL, locked_until = NULL,
           error_code = 'AUDIT_REQUIRED', error_message = ?,
           updated_at = ?, completed_at = ?
       WHERE id = ? AND status = 'queued'`
    )
    .run(message, now, now, jobId);
}

function normalizeListLimit(limit: number | undefined): number {
  return Number.isSafeInteger(limit) && (limit ?? 0) > 0
    ? Math.min(limit ?? 50, 200)
    : 50;
}

function calculateQueueAge(oldestQueuedAt: string | null, now: string): number {
  if (!oldestQueuedAt) return 0;
  return Math.max(0, (Date.parse(now) - Date.parse(oldestQueuedAt)) / 1_000);
}
