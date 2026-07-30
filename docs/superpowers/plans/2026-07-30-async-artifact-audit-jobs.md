# Async Artifact Audit Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move expensive artifact inspection behind a durable, recoverable,
observable job state machine without breaking the existing synchronous audit
endpoint or requiring an external queue.

**Architecture:** SQLite/JSON metadata stores immutable job input snapshots and
lease-based task state. A single scheduler in the server process atomically
claims work, but the audit engine runs in a short-lived Bun subprocess with
bounded time and output; completion persists the report, job transition, and
history event in one repository mutation. The queue and executor are interfaces,
so a separate worker service can replace the local scheduler later.

**Tech Stack:** Bun 1.3, TypeScript 6, Hono 4, Zod 4, `bun:sqlite`,
`Bun.spawn`, Bun test, Prometheus text exposition.

## Global Constraints

- Keep the existing `POST /api/projects/:id/versions/:versionId/audit`
  synchronous response for compatibility; new clients use additive job routes.
- Do not add Redis, PostgreSQL, a message broker, or a new npm dependency.
- Never execute uploaded JavaScript or permit the audit subprocess to mutate
  project metadata.
- Only one non-terminal audit job may exist for the same version, checksum,
  engine version, and policy snapshot.
- Claim, lease renewal, retry, cancellation, final report persistence, and
  terminal transitions must be atomic repository mutations.
- A worker may only finish a job when `status=running`, `lockedBy` matches, and
  the lease has not been superseded.
- Retry infrastructure failures with bounded exponential backoff; stale
  artifact/policy snapshots are terminal and never retried.
- Stop claiming before graceful shutdown and wait for the active subprocess
  before the final SQLite checkpoint.
- Preserve every unrelated user change and push verified commits to `main`.

---

### Task 1: Shared job model and schema migration

**Files:**
- Modify: `packages/shared/src/domain.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/errors.ts`
- Modify: `apps/server/src/domain/schema.ts`
- Modify: `apps/server/src/repositories/sqliteSchema.ts`
- Modify: `apps/server/src/repositories/sqliteProjectRepository.ts`
- Modify: `apps/server/src/services/backupService.ts`
- Test: `apps/server/tests/services/schemaMigration.test.ts`
- Test: `apps/server/tests/services/sqliteProjectRepository.test.ts`
- Test: `apps/server/tests/services/backupService.test.ts`

**Interfaces:**
- Produces:

```ts
type ArtifactAuditJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled';

interface ArtifactAuditJob {
  id: string;
  projectId: string;
  versionId: string;
  requestedBy: string;
  status: ArtifactAuditJobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  nextRunAt: string;
  lockedBy: string | null;
  lockedUntil: string | null;
  artifactChecksum: string;
  engineVersion: number;
  policy: ArtifactAuditPolicy;
  reportId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}
```

- Extends `Data` with `artifactAuditJobs: ArtifactAuditJob[]`.
- Advances document schema from v7 to v8 and relational schema from v3 to v4.

- [x] **Step 1: Write migration and round-trip tests**

Add tests proving v7/relational-v3 data receives an empty job list, creates a
`.pre-relational-v4.bak`, and round-trips every nullable and JSON policy field.

- [x] **Step 2: Run focused tests and observe the missing schema**

Run:

```bash
bun test apps/server/tests/services/schemaMigration.test.ts \
  apps/server/tests/services/sqliteProjectRepository.test.ts
```

Expected: failures because `artifactAuditJobs` and relational v4 do not exist.

- [x] **Step 3: Add strict shared schemas and stable errors**

Add Zod schemas for the status and job shape. Export them through
`@deploykit/shared`. Add `AUDIT_JOB_NOT_FOUND`, `AUDIT_JOB_CONFLICT`, and
`AUDIT_JOB_FAILED` to the stable error code set.

- [x] **Step 4: Implement document and relational migrations**

Create `artifact_audit_jobs` with project/version foreign keys, strict status
checks, policy JSON, lock fields, and these indexes:

```sql
CREATE INDEX artifact_audit_jobs_claim_idx
  ON artifact_audit_jobs(status, next_run_at, priority DESC, created_at);
CREATE INDEX artifact_audit_jobs_version_created_idx
  ON artifact_audit_jobs(project_id, version_id, created_at DESC);
```

Backfill document data with an empty array, include jobs in aggregate parsing,
delete job rows before their referenced versions, include the table in verified
backup counts, and preserve the v3-to-v4 database backup before any DDL.

- [x] **Step 5: Re-run focused tests**

Expected: the migration and repository tests pass.

- [x] **Step 6: Commit**

```bash
git add packages/shared/src apps/server/src/domain/schema.ts \
  apps/server/src/repositories apps/server/tests/services
git commit -m "feat: persist artifact audit jobs"
```

### Task 2: Atomic queue state machine

**Files:**
- Create: `apps/server/src/domain/artifactAuditJob.ts`
- Create: `apps/server/src/services/artifactAuditJobService.ts`
- Modify: `apps/server/src/services/contracts.ts`
- Modify: `apps/server/src/services/artifactAuditService.ts`
- Modify: `apps/server/src/services/projectService.ts`
- Modify: `apps/server/src/services/versionService.ts`
- Test: `apps/server/tests/services/artifactAuditJobService.test.ts`
- Test: `apps/server/tests/services/artifactAuditService.test.ts`

**Interfaces:**
- Produces:

```ts
interface ClaimedArtifactAuditJob {
  job: ArtifactAuditJob;
  artifactDir: string;
}

interface ArtifactAuditJobService {
  enqueue(projectId: string, versionId: string, actorId: string):
    { job: ArtifactAuditJob; reused: boolean };
  get(projectId: string, versionId: string, jobId: string): ArtifactAuditJob;
  cancel(projectId: string, versionId: string, jobId: string, actorId: string):
    ArtifactAuditJob;
  claim(workerId: string, leaseMs: number): ClaimedArtifactAuditJob | null;
  heartbeat(jobId: string, workerId: string, leaseMs: number):
    ArtifactAuditJob | null;
  complete(jobId: string, workerId: string, result: ArtifactAuditResult):
    ArtifactAuditJob;
  fail(jobId: string, workerId: string, error: unknown): ArtifactAuditJob;
  sweepExpired(): number;
}
```

- [x] **Step 1: Write state-machine tests**

Cover deduplicated enqueue, priority/FIFO claim, lease ownership, expired lease
recovery, heartbeat, retry backoff, max-attempt failure, queued/running
cancellation, stale checksum/policy completion, atomic report/history success,
and project/version cascade cleanup.

- [x] **Step 2: Run the new test and observe missing service**

Run:

```bash
bun test apps/server/tests/services/artifactAuditJobService.test.ts
```

Expected: failure because the service module is absent.

- [x] **Step 3: Implement pure transition helpers**

Keep time comparison, exponential backoff, claim eligibility, fingerprint
comparison, and lock ownership in `domain/artifactAuditJob.ts`. Use injected
`now()` and `createId()` dependencies in the service.

- [x] **Step 4: Implement transactional queue operations**

Every transition uses one synchronous `repo.mutate`. Completion validates the
current version checksum and project policy again, replaces the current report,
appends `version.audit`, and marks the job succeeded in the same mutation.
Canceled or superseded jobs discard executor output.

- [x] **Step 5: Remove jobs during project/version deletion**

Filter associated job records in the same mutations that remove reports and
metadata. SQLite foreign keys remain the second line of defense.

- [x] **Step 6: Run service tests**

Expected: queue and existing synchronous audit tests pass.

- [x] **Step 7: Commit**

```bash
git add apps/server/src/domain apps/server/src/services \
  apps/server/tests/services
git commit -m "feat: add durable artifact audit queue"
```

### Task 3: Isolated subprocess executor

**Files:**
- Create: `apps/server/src/services/artifactAuditExecutor.ts`
- Create: `apps/server/src/workers/artifactAuditProcess.ts`
- Test: `apps/server/tests/services/artifactAuditExecutor.test.ts`

**Interfaces:**
- Produces:

```ts
interface ArtifactAuditExecutionInput {
  artifactDir: string;
  expectedChecksum: string;
  policy: ArtifactAuditPolicy;
}

interface ArtifactAuditExecutor {
  execute(
    input: ArtifactAuditExecutionInput,
    signal: AbortSignal
  ): Promise<ArtifactAuditResult>;
}
```

- [x] **Step 1: Write executor protocol tests**

Cover valid output, non-zero exit, invalid/oversized JSON, stderr sanitization,
timeout, and abort. Use a fixture runner injection for failure cases and one
real subprocess test for the production entrypoint.

- [x] **Step 2: Run the executor test and observe missing adapter**

Run:

```bash
bun test apps/server/tests/services/artifactAuditExecutor.test.ts
```

Expected: failure because the executor module is absent.

- [x] **Step 3: Implement the child entrypoint**

Read exactly one JSON request from stdin, validate it, call
`auditArtifactDirectory`, validate the result schema, write exactly one JSON
object to stdout, and send diagnostics only to stderr. Exit non-zero on any
uncaught error.

- [x] **Step 4: Implement the parent adapter**

Use:

```ts
Bun.spawn({
  cmd: [process.execPath, processEntry],
  stdin: JSON.stringify(input),
  stdout: 'pipe',
  stderr: 'pipe',
  signal,
  timeout: timeoutMs,
  killSignal: 'SIGKILL',
  maxBuffer: 4 * 1024 * 1024,
});
```

Require exit code zero, cap diagnostic text, parse and validate stdout, and
convert infrastructure errors to stable retryable failures without exposing
absolute paths.

- [x] **Step 5: Run executor and engine tests**

Expected: executor and existing engine tests pass.

- [x] **Step 6: Commit**

```bash
git add apps/server/src/services/artifactAuditExecutor.ts \
  apps/server/src/workers apps/server/tests/services/artifactAuditExecutor.test.ts
git commit -m "feat: isolate artifact audits in subprocesses"
```

### Task 4: Scheduler and graceful runtime lifecycle

**Files:**
- Create: `apps/server/src/services/artifactAuditWorker.ts`
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/runtime.ts`
- Test: `apps/server/tests/services/artifactAuditWorker.test.ts`
- Test: `apps/server/tests/services/config.test.ts`
- Test: `apps/server/tests/services/runtime.test.ts`

**Interfaces:**
- Produces:

```ts
interface ArtifactAuditWorker {
  start(): void;
  runOnce(): Promise<boolean>;
  stop(): Promise<void>;
  cancel(jobId: string): void;
}

interface DeployKitRuntime {
  app: ReturnType<typeof createApp>;
  artifactAuditWorker: ArtifactAuditWorker;
}
```

- [x] **Step 1: Write worker and lifecycle tests**

Cover one-at-a-time execution, periodic heartbeat, retry/final failure,
cancellation abort, no new claim after stop, startup expired-lease sweep, and
shutdown waiting for `worker.stop()` before checkpoint.

- [x] **Step 2: Add strict worker configuration**

Parse:

```text
ARTIFACT_AUDIT_WORKER_ENABLED=true
ARTIFACT_AUDIT_POLL_INTERVAL_MS=1000
ARTIFACT_AUDIT_TIMEOUT_MS=60000
ARTIFACT_AUDIT_LEASE_MS=90000
ARTIFACT_AUDIT_MAX_ATTEMPTS=3
```

Reject a lease not greater than the execution timeout and cap attempts at 10.

- [x] **Step 3: Implement scheduler**

Use one active `AbortController`, an unref'd poll timer, and an injected
executor. `runOnce()` claims atomically, renews the lease while executing, then
completes or fails through the queue service. `stop()` clears the timer, stops
claiming, and aborts/awaits the active execution.

- [x] **Step 4: Split app composition from runtime startup**

Keep `createApp(config)` returning an unstarted Hono app for tests. Add
`createDeployKitRuntime(config)` that returns the same app plus its scheduler.
Only `index.ts` starts the worker.

- [x] **Step 5: Extend graceful shutdown**

Include `artifactAuditWorker.stop()` in the bounded drain sequence after HTTP
acceptance stops and before SQLite checkpoint.

- [x] **Step 6: Run worker, config, and runtime tests**

Expected: all focused tests pass.

- [x] **Step 7: Commit**

```bash
git add apps/server/src/config.ts apps/server/src/app.ts \
  apps/server/src/index.ts apps/server/src/runtime.ts \
  apps/server/src/services/artifactAuditWorker.ts apps/server/tests/services
git commit -m "feat: run durable artifact audit worker"
```

### Task 5: Additive Hono job API and metrics

**Files:**
- Modify: `apps/server/src/routes/artifactAudits.ts`
- Modify: `apps/server/src/api.ts`
- Modify: `apps/server/src/services/contracts.ts`
- Modify: `apps/server/src/services/metrics.ts`
- Test: `apps/server/tests/api/artifactAudit.test.ts`
- Test: `apps/server/tests/services/metrics.test.ts`

**Interfaces:**
- Produces:

```text
POST   /api/projects/:id/versions/:versionId/audit-jobs
GET    /api/projects/:id/versions/:versionId/audit-jobs/:jobId
DELETE /api/projects/:id/versions/:versionId/audit-jobs/:jobId
```

The POST response is `202 { job, reused }`. GET returns current persisted state.
DELETE returns the canceled state. Reads require project visibility; enqueue and
cancel require developer/admin plus project membership.

- [x] **Step 1: Write API authorization and lifecycle tests**

Cover 202 enqueue, active deduplication, polling success, project scoping,
member write access, viewer rejection, cancellation, malformed IDs, and the
unchanged synchronous route.

- [x] **Step 2: Add chained routes and typed contracts**

Keep Hono route definitions chained. Parse every path ID with
`parseIdParam`; never trust a job's project/version relation from request data.

- [x] **Step 3: Add bounded metrics**

Expose:

```text
deploykit_artifact_audit_jobs_total{outcome="succeeded|failed|canceled|retried"}
deploykit_artifact_audit_jobs_active{status="queued|running"}
```

No project, version, job, user, path, or error string may become a label.

- [x] **Step 4: Run API and metrics tests**

Expected: focused tests pass and existing synchronous API assertions remain
unchanged.

- [x] **Step 5: Commit**

```bash
git add apps/server/src/routes apps/server/src/api.ts \
  apps/server/src/services/contracts.ts apps/server/src/services/metrics.ts \
  apps/server/tests/api apps/server/tests/services/metrics.test.ts
git commit -m "feat: expose asynchronous artifact audit jobs"
```

### Task 6: Operations, verification, production smoke, and delivery

**Files:**
- Modify: `README.md`
- Modify: `apps/server/README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/backend-hardening-roadmap.md`
- Modify: `docs/superpowers/plans/2026-07-30-async-artifact-audit-jobs.md`

- [x] **Step 1: Document lifecycle and recovery semantics**

Document configuration, job states, API polling, cancellation behavior,
subprocess isolation, retry/backoff, lease recovery, metrics, synchronous
compatibility, and the rule that release gating only trusts a completed current
report.

- [x] **Step 2: Run formatting and full verification**

Run:

```bash
bun run verify
```

Expected: Biome, secret scan, typecheck, every server/client/desktop test,
production build, and packaged web assets pass.

- [x] **Step 3: Run an isolated production smoke**

Start a real production server with separate management/deploy origins and a
temporary SQLite/storage root. Exercise:

```text
register/login -> create -> upload -> enqueue -> poll succeeded ->
enable blocking -> publish -> upload second version -> enqueue ->
SIGTERM during/after work -> restart -> recover/poll -> manual rollback
```

Verify the deploy origin serves only the chosen version, management deploy
access remains 404, metrics contain bounded job series, and job/report/release
state survives restart.

- [x] **Step 4: Complete plan evidence and commit docs**

Mark this plan completed only after recording exact test counts, smoke evidence,
and migration backup evidence.

Delivery evidence recorded on 2026-07-30:

- `bun run verify` passed: Biome checked 256 files; secret scanner passed 2
  tests and found no known credential patterns; all five workspaces passed
  typecheck; server passed 292 tests / 967 expectations, client passed 40 tests,
  desktop passed 23 tests; Vite transformed 2252 modules and the packaged Web
  assets were copied into `apps/server/public`.
- Focused migration verification passed 24 tests / 92 expectations. The exact
  deployed relational v3 -> v4 path asserts
  `deploykit.sqlite.pre-relational-v4.bak`; the exact document v7 -> v8 path
  asserts the original `data.json.bak` before `artifactAuditJobs` is added.
- A real production process with distinct management/deploy origins completed
  registration, project creation, v1 upload/audit, blocking publish, v2 upload,
  SIGTERM, same-SQLite restart/recovery, v2 publish, and manual v1 rollback.
  Both cross-origin trust violations returned 404. Final SQLite evidence was
  schema v4, `integrity_check=ok`, zero foreign-key violations, two succeeded
  jobs, two reports, and three release-ledger rows. Metrics showed one recovered
  success after restart, zero queued/running jobs, and no project/version/job ID
  in labels.

- [x] **Step 5: Push and verify remote gates**

Push `main`, then require both latest-sha GitHub CI and CodeQL to conclude
success. If either fails, inspect logs, fix, re-run local verification, and push
the corrective commit.

Implementation/delivery SHA `09e3e4f8f4ef81ffcae7a62366e3e8776bb73391`
was pushed directly to `main`. GitHub
[CI run 30529027216](https://github.com/puzzle-fuzzy/frontend-deploy-tool/actions/runs/30529027216)
and
[CodeQL run 30529027278](https://github.com/puzzle-fuzzy/frontend-deploy-tool/actions/runs/30529027278)
both concluded `success` for that exact SHA.

## Acceptance Criteria

- HTTP requests no longer need to host new asynchronous audit execution.
- New jobs survive restart and expired running jobs are claimable again.
- Concurrent workers cannot both own or complete the same lease.
- Audit engine crashes, hangs, and oversized output cannot crash the API process.
- Cancellation and shutdown never persist a late report from a superseded claim.
- The existing synchronous endpoint remains behaviorally compatible.
- Blocking release still requires a current completed report; queued/running
  jobs do not satisfy the gate.
- Relational v3 and document v7 upgrades are backed up, tested, and reversible.
- Full local verification, production smoke, CI, and CodeQL pass on the pushed
  `main` SHA.
