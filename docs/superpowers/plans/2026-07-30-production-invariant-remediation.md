# Production Invariant Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three remaining production-blocking foundation gaps before
adding CI tokens, CLI publishing, webhooks, or further artifact-analysis
features: cross-origin cookie writes, crash-incomplete storage deletion, and
lease/queue operations that depend on full-aggregate SQLite polling.

**Architecture:** Keep the supported single-node Bun/Hono + SQLite + local
filesystem deployment model. Enforce the trusted management origin for unsafe
browser requests, add an exclusive runtime/storage ownership lease plus
manifest-driven recovery for interrupted file operations, and move high-rate
audit queue maintenance to a dedicated SQLite repository that can atomically
recover and claim work without hydrating or rewriting the complete domain
aggregate. Durable project history, release pointers, artifact reports, and
manual rollback semantics remain unchanged.

**Tech Stack:** Bun 1.3, TypeScript 6, Hono 4, Zod 4, `bun:sqlite`, local
filesystem atomic rename, Bun test, Hono `app.request()`, shell black-box tests.

## Global Constraints

- Preserve the explicit invariant that upload creates preview only; publish and
  rollback remain separate user actions with an expected-active-version
  precondition.
- Do not add Redis, PostgreSQL, an ORM, a message broker, or another application
  service.
- Production keeps two browser origins. Uploaded artifacts must never be able
  to mutate management state through the management session cookie.
- Bearer-authenticated desktop and future CI clients remain usable without
  browser-only CSRF headers.
- Only one server process may own either a database resource or a storage
  resource. Same-database/different-storage and different-database/same-storage
  combinations must both fail closed. Multi-host shared SQLite or local
  artifact storage remains unsupported.
- Recovery must never auto-publish another version. It may restore an
  interrupted deletion only when metadata still references the exact artifact.
- Queue lease recovery and claiming must be one atomic persistence operation.
  An idle poll must not upsert users, projects, versions, reports, or jobs.
- Terminal job cleanup may remove transport/job details after retention, but it
  must not remove the current artifact report, release ledger, or append-only
  project history.
- Keep all API additions backward compatible and use stable shared error codes.
- Every task starts with a failing regression test, ends with focused tests,
  and updates this plan before its commit.
- Preserve unrelated user changes. Fetch and compare `origin/main` before the
  final push; push only after `bun run verify` and production smoke tests pass.

---

### Task 1: Reject cross-origin cookie-authenticated writes

**Files:**
- Create: `apps/server/src/middleware/requestOrigin.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `packages/shared/src/errors.ts`
- Modify: `apps/server/tests/api/securityBoundary.test.ts`
- Modify: `apps/server/tests/api/sessions.test.ts`
- Modify: `docs/architecture.md`
- Modify: `docs/backend-hardening-roadmap.md`

**Contract:**

```ts
createRequestOriginProtection({
  managementBaseURL,
}): MiddlewareHandler
```

- Safe methods (`GET`, `HEAD`, `OPTIONS`) are unaffected.
- When `MANAGEMENT_BASE_URL` is configured, every unsafe `/api/*` request with
  an `Origin` header must exactly match that origin.
- Any unsafe request carrying the session Cookie without `Origin` fails closed,
  even when an Authorization bearer header is also present; bearer-only clients
  remain compatible.
- `Sec-Fetch-Site: same-site|cross-site` is rejected for unsafe management API
  requests even when another header is inconsistent.
- Bearer requests without browser origin/fetch metadata remain supported.
- Rejections return `403 CSRF_VALIDATION_FAILED` before route body parsing or
  mutation.

- [x] **Step 1: Add failing trust-boundary regressions**

  Use a real seeded browser session cookie and distinct
  `console.example.test` / `deploy.example.test` origins. Prove that the deploy
  origin cannot call logout-all, upload, or enqueue an audit job; prove the
  session remains valid after rejection. Add missing-origin cookie and
  same-origin success cases, plus bearer-without-Origin compatibility.

- [x] **Step 2: Run focused tests and observe the vulnerability**

  ```bash
  bun test apps/server/tests/api/securityBoundary.test.ts \
    apps/server/tests/api/sessions.test.ts
  ```

  Expected before implementation: cross-origin or missing-origin cookie writes
  return a success/business response instead of
  `403 CSRF_VALIDATION_FAILED`.

- [x] **Step 3: Implement the origin middleware and stable error**

  Add `CSRF_VALIDATION_FAILED` to the shared error registry. Mount the middleware
  after target-host trust-boundary validation and before the typed API routes.
  Compare serialized origins exactly; reject `Origin: null`, malformed or
  mismatched values. Detect bearer/cookie transport from the request headers
  without exposing the token.

- [x] **Step 4: Re-run focused API and contract tests**

  ```bash
  bun test apps/server/tests/api/securityBoundary.test.ts \
    apps/server/tests/api/sessions.test.ts \
    apps/server/tests/api/contracts.test.ts \
    apps/server/tests/api/desktopAuth.test.ts
  ```

  Expected: all pass; browser attacks are rejected, normal management-origin
  cookie requests and non-browser bearer clients still work.

- [x] **Step 5: Document the initiator-origin boundary**

  Explain why target-host separation and CORS alone are insufficient for
  same-site sibling origins, and record the unsafe-method policy and bearer
  exception.

- [x] **Step 6: Commit**

  ```bash
  git add apps/server/src/middleware/requestOrigin.ts apps/server/src/app.ts \
    packages/shared/src/errors.ts apps/server/tests/api \
    docs/architecture.md docs/backend-hardening-roadmap.md \
    docs/superpowers/plans/2026-07-30-production-invariant-remediation.md
  git commit -m "fix: reject cross-origin management writes"
  ```

### Task 2: Make storage deletion recoverable across process death

**Files:**
- Create: `apps/server/src/services/runtimeOwnership.ts`
- Create: `apps/server/src/utils/runtimeResourcePath.ts`
- Modify: `apps/server/src/services/artifactRecovery.ts`
- Modify: `apps/server/src/services/storagePathSafety.ts`
- Modify: `apps/server/src/services/storageReconciler.ts`
- Modify: `apps/server/src/services/backupService.ts`
- Modify: `apps/server/src/services/versionService.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/runtime.ts`
- Modify: `apps/server/src/serverEntry.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/.env.example`
- Modify: `apps/server/tests/services/artifactRecovery.test.ts`
- Modify: `apps/server/tests/services/storageReconciler.test.ts`
- Create: `apps/server/tests/api/storageCrashRecovery.test.ts`
- Modify: `apps/server/tests/services/runtime.test.ts`
- Create: `apps/server/tests/services/runtimeResourcePath.test.ts`
- Modify: `docs/architecture.md`
- Modify: `docs/development.md`
- Modify: `docs/backend-hardening-roadmap.md`

**Contracts:**

```ts
interface RuntimeOwnership {
  release(): void;
}

acquireRuntimeOwnership(databaseFile: string, storageDir: string):
  RuntimeOwnership;

recoverInterruptedArtifactOperations(
  repo: ProjectRepository,
  storageDir: string
): {
  restored: number;
  committed: number;
  conflicts: number;
};
```

- Two sorted SQLite sidecars outside the owned resources hold open exclusive
  transactions for the database and storage paths independently. PID/token
  fields are diagnostic only.
- A second live process sharing either resource fails startup before
  reconciliation or HTTP serving. Process death releases both kernel locks.
- Version 4 trash manifests include operation kind, project/version target,
  the complete target version ID set, original path, recovery path, committed
  state, artifact identity and durable version checksums; deployed version
  1/2/3 manifests remain readable for unambiguous recovery.
- At startup, metadata still referencing an interrupted target restores it;
  metadata no longer referencing it finalizes the committed marker; conflicting
  paths, symlinks, malformed commit state and unproven ambiguous cleanup are
  quarantined and make readiness fail. If any valid durable checksum exists,
  its version ID set must exactly match the complete target set and every hash
  must match; partial checksum evidence cannot fall back to identity. Identity
  is only a fallback when zero valid checksums exist, and old version 3
  manifests fail closed in the ambiguous cleanup branch. A single
  storage-root-relative ancestor guard protects source, operation, upload
  staging/final, trash and conflict paths, and conflicts freeze destructive GC
  for that startup pass.
- Database journal/WAL/SHM, storage, both sidecars and each sidecar's
  journal/WAL/SHM are resolved once and must be pairwise distinct with no
  ancestor collisions. Darwin uses Unicode NFD plus conservative case-folding
  for missing suffixes; Windows conservatively case-folds them. Database and
  storage leaf symlinks, wrong primary resource types, database hard-link
  aliases, and primary/sidecar auxiliary symlink/non-regular/multi-link or
  dev/inode aliases are rejected before any mkdir or SQLite open. Sidecars then
  force and verify DELETE journal mode. Config, runtime, backup and restore
  enforce the same layout invariant. Backup payloads exclude SQLite
  auxiliaries. Restore records presence for the database, storage and every
  primary auxiliary before moving them. Once installation starts, any failure
  clears all installed targets and reinstates only resources present in that
  snapshot; pre-existing absence remains absence, while pre-install failures
  do not clear live state.
- Ownership is released only after HTTP and worker cleanup are both confirmed.
  Timeout, rejection or non-settling force-stop paths retain it until process
  death. Upload storage conflicts use path-free
  `503 STORAGE_CONTROL_CONFLICT` API responses.

- [x] **Step 1: Add failing process-death and double-start tests**

  Spawn a real server fixture that exits immediately after the artifact rename
  for active-version and project deletion. Restart against the same SQLite and
  storage paths and assert the production artifact remains available, the
  active pointer is unchanged, and history is not duplicated. Start a second
  live process and assert it fails closed with a stable ownership diagnostic.

- [x] **Step 2: Run focused tests and capture the current half-commit**

  ```bash
  bun test apps/server/tests/services/artifactRecovery.test.ts \
    apps/server/tests/services/storageReconciler.test.ts \
    apps/server/tests/api/storageCrashRecovery.test.ts
  ```

  Expected before implementation: restart marks the referenced version failed
  or quarantines its artifact instead of restoring the interrupted rename.

- [x] **Step 3: Implement ownership and manifest recovery**

  Acquire both sorted SQLite sidecar transaction locks before storage
  reconciliation and release them on connection close/process death. Extend
  version 4 recovery manifests with complete target IDs and durable artifact
  identity/checksum proof, reject symlinks through one storage-root-relative
  guard covering upload staging/final, recovery, trash, conflicts, and orphans,
  and run interrupted-operation recovery before orphan reconciliation or GC.

- [x] **Step 4: Harden readiness and restore operations**

  Readiness must fail when recovery reports unresolved conflicts, and that
  startup pass must freeze GC, orphan quarantine, and metadata repair.
  Operational restore must refuse to run while runtime ownership is active;
  keep `--force` as destructive-intent confirmation, not as a lock bypass.
  Reject all primary/SQLite-auxiliary layout collisions, database
  and storage leaf/type aliases, database hard-link aliases, and unsafe
  existing primary/sidecar auxiliary leaves before ownership sidecars or
  backup mutations. Backup payloads contain only the verified SQLite snapshot,
  while failed restore uses an explicit pre-state presence snapshot: failures
  after installation begins clear all targets and restore only resources that
  originally existed; pre-install failures never blanket-delete live state.
  Release ownership only after confirmed cleanup; fatal shutdown retains it
  until process exit. Runtime resource parents are a trusted service-account
  boundary because Bun SQLite cannot atomically combine leaf preflight with a
  no-follow open.

- [x] **Step 5: Re-run service, black-box, backup and runtime tests**

  ```bash
  bun test apps/server/tests/services/artifactRecovery.test.ts \
    apps/server/tests/services/storageReconciler.test.ts \
    apps/server/tests/services/backupService.test.ts \
    apps/server/tests/services/runtime.test.ts \
    apps/server/tests/api/storageCrashRecovery.test.ts
  ```

  Expected: all pass, including real process termination and idempotent restart.

- [x] **Step 6: Commit**

  ```bash
  git add apps/server/src apps/server/tests apps/server/.env.example \
    docs/architecture.md docs/development.md \
    docs/backend-hardening-roadmap.md \
    docs/superpowers/plans/2026-07-30-production-invariant-remediation.md
  git commit -m "fix: recover interrupted artifact operations"
  ```

### Task 3: Replace aggregate polling with an atomic audit-job store

**Files:**
- Create: `apps/server/src/repositories/artifactAuditJobRepository.ts`
- Create: `apps/server/src/repositories/sqliteArtifactAuditJobRepository.ts`
- Create: `apps/server/src/repositories/aggregateArtifactAuditJobRepository.ts`
- Create: `apps/server/src/repositories/artifactAuditJobMapper.ts`
- Create: `apps/server/src/domain/artifactAuditJobTransitions.ts`
- Modify: `apps/server/src/repositories/sqliteSchema.ts`
- Modify: `apps/server/src/repositories/sqliteProjectRepository.ts`
- Modify: `apps/server/src/services/artifactAuditJobService.ts`
- Modify: `apps/server/src/services/artifactAuditWorker.ts`
- Modify: `apps/server/src/services/contracts.ts`
- Modify: `apps/server/src/services/metrics.ts`
- Modify: `apps/server/src/routes/artifactAudits.ts`
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/cli/ops.ts`
- Modify: `apps/server/.env.example`
- Modify: `packages/shared/src/domain.ts`
- Modify: `packages/shared/src/errors.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/server/tests/services/artifactAuditJobService.test.ts`
- Modify: `apps/server/tests/services/artifactAuditWorker.test.ts`
- Create: `apps/server/tests/services/sqliteArtifactAuditJobRepository.test.ts`
- Modify: `apps/server/tests/api/artifactAudit.test.ts`
- Modify: `apps/server/tests/services/metrics.test.ts`
- Modify: `apps/server/tests/services/config.test.ts`
- Modify: `apps/server/tests/services/schemaMigration.test.ts`
- Modify: `apps/server/tests/services/schemas.test.ts`
- Modify: `apps/server/tests/services/sqliteProjectRepository.test.ts`
- Modify: `docs/architecture.md`
- Modify: `docs/backend-hardening-roadmap.md`
- Modify: `README.md`

**Contracts:**

```ts
interface ArtifactAuditJobRepository {
  enqueue(input: EnqueueInput): EnqueueResult;
  get(input: ScopedJobKey): ScopedJobResult;
  list(input: ListInput): ListResult;
  cancel(input: CancelInput): CancelResult;
  recoverAndClaim(input: RecoverAndClaimInput): RecoverAndClaimResult;
  heartbeat(input: HeartbeatInput): ArtifactAuditJob | null;
  complete(input: CompleteInput): LeaseTransitionResult;
  fail(input: FailOrRetryInput): LeaseTransitionResult;
  health(input: { now: string }): ArtifactAuditQueueHealth;
  pruneTerminal(input: PruneTerminalInput): PruneTerminalResult;
}
```

- The dedicated repository owns the complete queue state machine, including
  enqueue, get/list, cancel, lease recovery/claim, heartbeat, completion,
  fail/retry, health and prune. Leaving enqueue, cancel, complete, fail or
  health on `ProjectRepository.mutate` would retain the aggregate rewrite path,
  permit nested transaction ownership and make the queue's admission/lease
  invariants impossible to enforce atomically.
- Each top-level repository action owns exactly one connection/transaction.
  Never call `ProjectRepository` inside an audit-job transaction or call the
  audit-job repository inside `ProjectRepository.mutate`.
- Enqueue uses one `BEGIN IMMEDIATE`: revalidate project/version snapshot,
  deduplicate before limits, project replacement occupancy, and atomically
  cancel/insert only on acceptance. Rejection has no partial writes.
- `recoverAndClaim` uses one `BEGIN IMMEDIATE` transaction to transition
  expired `running` rows and claim at most one eligible `queued` row per poll.
  No transition or claim means no update, upsert, full `Data` hydration or
  business WAL frame. Live workers recover expired work without a startup-only
  sweep.
- Heartbeat, cancel, complete and fail are lease guarded. Late workers cannot
  persist a transition, report or history after lease loss/cancellation.
- Completion hashes outside the transaction, then atomically validates the
  current lease and project/version checksum/policy/engine snapshot, upserts
  the report, appends one history event and marks the job succeeded in one
  `BEGIN IMMEDIATE`.
- Enqueue checks deduplication before applying global, requester and project
  active-job limits; rejection returns stable `429 AUDIT_QUEUE_FULL`.
- SQLite schema v5 is an explicit backed-up v4-to-v5 migration with a partial
  unique active-job index plus claim, list, filtered-list, expired-lease and
  terminal-retention indexes. Legacy duplicate active jobs fail closed; the
  repository constructor never installs indexes opportunistically.
- Terminal rows have a configurable retention period and batch-bounded prune.
  Reports, history and releases survive pruning.
- The collection GET orders by `created_at DESC, id DESC` and supports a strict
  Base64URL keyset cursor bound to project/version, anchor job and optional
  status. Invalid, tampered, cross-scope, filter-mismatched or pruned-anchor
  cursors return stable `400 INVALID_AUDIT_JOB_CURSOR`.
- JSON fixtures use an aggregate adapter with the same transition semantics;
  empty claim performs a read-only precheck and preserves the JSON mtime.
- Queue metrics use only fixed labels: lease recovery `retried|failed`,
  admission rejection `global|requester|project`, and terminal job status.

- [x] **Step 1: Add failing SQLite v5, concurrency, takeover and idle tests**

  Cover explicit v4-to-v5 backup/index migration and duplicate-active
  fail-closed behavior. Use independent connections/processes with a real
  barrier to prove one claim, live expired-lease takeover and same-snapshot
  enqueue uniqueness. Repeated idle polling must change no domain row and add
  no business WAL frames.

- [x] **Step 2: Implement SQLite v5 and the complete repository port**

  Extract cycle-free row mapping and pure transition/payload rules shared by
  the SQLite and aggregate adapters. Implement every queue action with row SQL;
  SQLite errors never fall back to aggregate persistence.

- [x] **Step 3: Add failing admission, lease and atomic completion tests**

  Cover duplicate reuse before all limits, global/requester/project rejection,
  replacement at capacity, no-write rejection, cancel followed by late
  heartbeat/complete/fail, retry/max-attempt/non-retryable failure, and a
  temporary failing history trigger that rolls completion back without changing
  job, report or history. Cover JSON atomic completion and idle mtime.

- [x] **Step 4: Rewire service and worker without nested transactions**

  Hash and execute outside repository transactions. Remove the startup-only
  recovery sweep and make every poll call `recoverAndClaim`. Preserve stable
  errors and existing GET-by-ID/DELETE behavior through repository result
  unions.

- [x] **Step 5: Add failing pagination, retention, API and config tests**

  Cover equal-timestamp/new-head keyset pagination, status-bound invalid
  cursor, dry-run/cutoff/batch prune preserving report/history/release rows,
  config defaults/overrides/invalid values/manual limit relations, POST
  headers, collection GET and operational prune.

- [x] **Step 6: Wire configuration, HTTP collection and operational prune**

  Add strict positive configuration for global/requester/project active limits
  and terminal retention; requester/project limits may not exceed global. Add:

  ```text
  GET /api/projects/:id/versions/:versionId/audit-jobs
  bun run ops -- audit-jobs-prune [--dry-run]
  ```

  Preserve existing POST/GET-by-ID/DELETE contracts. Return `Location` and a
  conservative `Retry-After = ceil(pollIntervalMs / 1000)` hint from POST.

- [x] **Step 7: Add queue health metrics**

  Add low-cardinality gauges/counters for oldest queued age, expired lease
  recovery, admission rejection and terminal counts. Do not use project,
  version, user, job or error text as labels.

- [x] **Step 8: Run focused repository, worker, API, migration and metrics tests**

  ```bash
  bun test apps/server/tests/services/sqliteArtifactAuditJobRepository.test.ts \
    apps/server/tests/services/artifactAuditJobService.test.ts \
    apps/server/tests/services/artifactAuditWorker.test.ts \
    apps/server/tests/api/artifactAudit.test.ts \
    apps/server/tests/services/metrics.test.ts \
    apps/server/tests/services/config.test.ts \
    apps/server/tests/services/schemaMigration.test.ts \
    apps/server/tests/services/schemas.test.ts \
    apps/server/tests/services/sqliteProjectRepository.test.ts
  bun --filter @deploykit/shared typecheck
  git diff --check
  ```

  Expected: all pass; expired work is reclaimed live, idle polling stays on the
  dedicated job path, v5 migration is explicit, and shared list contracts
  remain Bun-free.

- [x] **Step 9: Run server/full gates, document and commit**

  Run the complete server tests plus `bun run check`, `bun run typecheck` and
  `bun run test`. Update architecture, hardening roadmap, README and the Task 3
  implementation report. Perform a per-file self-review before committing.

  ```bash
  git add apps/server/src apps/server/tests apps/server/.env.example \
    packages/shared/src README.md docs/architecture.md \
    docs/backend-hardening-roadmap.md \
    docs/superpowers/plans/2026-07-30-production-invariant-remediation.md \
    .superpowers/sdd/task-3-report.md
  git commit -m "refactor: isolate durable audit queue persistence"
  ```

### Task 4: Full release gates and next-phase handoff

**Files:**
- Modify: `docs/superpowers/plans/2026-07-30-production-invariant-remediation.md`
- Modify: `docs/backend-hardening-roadmap.md`
- Modify: `docs/enterprise-frontend-deploy-plan.md`

- [x] **Step 1: Run the unified local gate**

  ```bash
  bun run verify
  git diff --check
  ```

  Expected: format/lint, secret scan, all package typechecks/tests and
  production Web packaging pass.

- [x] **Step 2: Run real production-process smoke tests**

  With two distinct loopback hostnames and isolated SQLite/storage:

  ```text
  login -> upload v1 -> audit -> publish v1
  cross-origin cookie write from deploy origin -> 403
  kill during v1 deletion rename -> restart -> v1 still serves
  enqueue audit -> kill worker owner -> surviving worker reclaims after lease
  manual rollback -> active ETag and release ledger change once
  backup -> verify -> restore rehearsal -> integrity_check=ok
  ```

  The single-host ownership invariant deliberately prevents two complete
  servers from sharing either the SQLite database or artifact storage.
  Therefore this gate separates three kinds of evidence instead of weakening
  that invariant:

  - one real production server at a time proves the complete HTTP, worker,
    release, restart, backup and restore path;
  - a real SIGKILL fault-injection child process proves recovery after the
    artifact deletion rename;
  - two independent Bun repository processes prove one-winner queue claims,
    while a live repository instance proves expired-lease takeover without a
    worker restart.

- [x] **Step 3: Review the next feature boundary**

  Record API tokens/CI upload as the next product phase only after the three
  production invariants pass. The next design must use hashed project-scoped
  tokens with explicit preview/staging/production scopes, expiry, rotation,
  revocation, idempotency keys and security audit events; it must not reuse
  seven-day browser/desktop sessions.

- [x] **Step 4: Commit delivery evidence**

  ```bash
  git add docs
  git commit -m "docs: record production invariant release gates"
  ```

  Delivery evidence recorded on 2026-07-31:

  - `bun run verify` passed after the final remediation commits: Biome checked
    277 files; the secret scanner passed 2 tests; all 5 workspace typechecks
    passed; server passed 427 tests / 1730 assertions, client passed 40 tests,
    desktop passed 23 tests; Vite transformed 2252 modules and packaged the
    production Web bundle into `apps/server/public`. `git diff --check` also
    passed.
  - The CI-equivalent dependency gate
    `npm_config_registry=https://registry.npmjs.org bun run security:audit`
    reported no high or critical dependency vulnerability.
  - An isolated production process with
    `console.localhost`/`deploy.localhost`, a temporary SQLite database and
    temporary storage completed: login, cookie-origin rejection, blocking
    release rejection before audit, three succeeded durable audit jobs, v1/v2
    publish, one manual v1 rollback, stale rollback rejection, three graceful
    shutdowns, same-secret restart and verified backup restore.
  - The deploy origin returned 404 for management API access, the management
    origin returned 404 for deployed artifacts, and a deploy-origin cookie
    write against the management API returned
    `403 CSRF_VALIDATION_FAILED` without revoking the session.
  - The active ETag changed for v2 and again for the manual rollback. The exact
    release ledger after rejecting the stale repeat was
    `version.publish, version.publish, version.rollback`; restore removed the
    deliberate post-backup fourth release and recovered the v1 active pointer.
  - A signed audit-job cursor issued before restart remained valid after both
    a production restart and backup restore. Final relational evidence was
    schema v5, `integrity_check=ok`, zero foreign-key violations, three
    succeeded jobs, two current reports and three release rows. Metrics exposed
    the bounded queue series and contained no project, version or job ID.
  - Focused fault gates passed independently: one real SIGKILL deletion/restart
    test (9 assertions), plus the two-Bun-process claim barrier and live
    expired-lease takeover tests (8 assertions).
  - Independent Task 3 contract and transaction re-reviews both concluded
    `Spec PASS` and `Quality APPROVED`, with no remaining
    Critical/Important/Minor finding.

- [x] **Step 5: Synchronize main**

  ```bash
  git fetch origin
  git rev-list --left-right --count origin/main...main
  git push origin main
  git status --short --branch
  ```

  Expected: local and remote `main` reference the same verified commit and the
  worktree is clean.

  Implementation and delivery evidence SHA
  `b739f46c223c0fc4744111bfa6291b7e60af2cbe` was pushed directly to
  `main`. GitHub
  [CI run 30564320421](https://github.com/puzzle-fuzzy/frontend-deploy-tool/actions/runs/30564320421)
  and
  [CodeQL run 30564320411](https://github.com/puzzle-fuzzy/frontend-deploy-tool/actions/runs/30564320411)
  both concluded `success` for that exact SHA. CI included the high/critical
  dependency audit, unified verify, verification-log artifact and packaged Web
  bundle artifact.
