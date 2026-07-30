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
- The canonical database path must remain outside storage. An existing database
  with multiple hard links is rejected before sidecar creation. Backup and
  restore enforce the same containment invariant.
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
  Reject database/storage containment and database hard-link aliases before
  ownership sidecars or backup mutations. Release ownership only after
  confirmed cleanup; fatal shutdown retains it until process exit.

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
- Modify: `apps/server/src/repositories/sqliteProjectRepository.ts`
- Modify: `apps/server/src/services/artifactAuditJobService.ts`
- Modify: `apps/server/src/services/artifactAuditWorker.ts`
- Modify: `apps/server/src/services/contracts.ts`
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/cli/ops.ts`
- Modify: `apps/server/.env.example`
- Modify: `packages/shared/src/domain.ts`
- Modify: `packages/shared/src/errors.ts`
- Modify: `apps/server/tests/services/artifactAuditJobService.test.ts`
- Modify: `apps/server/tests/services/artifactAuditWorker.test.ts`
- Create: `apps/server/tests/services/sqliteArtifactAuditJobRepository.test.ts`
- Modify: `apps/server/tests/api/artifactAudit.test.ts`
- Modify: `apps/server/tests/services/metrics.test.ts`
- Modify: `docs/architecture.md`
- Modify: `docs/backend-hardening-roadmap.md`
- Modify: `README.md`

**Contracts:**

```ts
interface ArtifactAuditJobRepository {
  recoverAndClaim(input: ClaimInput): ClaimResult;
  heartbeat(input: HeartbeatInput): ArtifactAuditJob | null;
  list(input: ArtifactAuditJobListInput): ArtifactAuditJobPage;
  countActive(): { queued: number; running: number };
  pruneTerminal(input: PruneInput): { matched: number; removed: number };
}

type ArtifactAuditJobPage = {
  items: ArtifactAuditJob[];
  nextCursor: string | null;
};
```

- `recoverAndClaim` uses one `BEGIN IMMEDIATE` transaction to transition
  expired `running` rows and claim at most one eligible `queued` row.
- No eligible job means no domain-table upsert and no full `Data` hydration.
- Enqueue checks deduplication before applying global, requester and project
  active-job limits; rejection returns stable `429 AUDIT_QUEUE_FULL`.
- Terminal rows have a configurable retention period and batch-bounded prune.
  Reports and audit events survive pruning.
- The collection GET supports an opaque ID cursor, bounded page size and
  optional stable status filter, so clients can reconnect after refresh.

- [ ] **Step 1: Add failing concurrent claim, takeover and idle-write tests**

  Use two repository/worker instances against one SQLite file. Prove only one
  owner claims a job, a surviving worker reclaims an expired lease without
  restart, and repeated empty polls do not update domain rows or enlarge the
  WAL materially.

- [ ] **Step 2: Add failing admission, pagination and retention tests**

  Cover duplicate reuse at capacity, global/requester/project rejection,
  status-filtered opaque pagination, invalid cursor, terminal dry-run prune and
  real prune preserving reports/history.

- [ ] **Step 3: Implement the dedicated SQLite store and aggregate fallback**

  Keep JSON fixtures working through the low-throughput aggregate adapter.
  Production SQLite uses indexed SQL transitions and row mapping. Completion
  remains an atomic job/report/history commit, but idle polling, heartbeat,
  failure/retry and maintenance must not rewrite unrelated aggregates.

- [ ] **Step 4: Wire configuration, HTTP list and operational prune**

  Add strict positive configuration for global/requester/project active limits
  and terminal retention. Add:

  ```text
  GET /api/projects/:id/versions/:versionId/audit-jobs
  bun run ops -- audit-jobs-prune [--dry-run]
  ```

  Preserve existing POST/GET-by-ID/DELETE contracts. Return `Location` and a
  conservative `Retry-After` hint from POST.

- [ ] **Step 5: Add queue health metrics**

  Add low-cardinality gauges/counters for oldest queued age, expired lease
  recovery, admission rejection and terminal counts. Do not use project,
  version, user, job or error text as labels.

- [ ] **Step 6: Run focused repository, worker, API and metrics tests**

  ```bash
  bun test apps/server/tests/services/sqliteArtifactAuditJobRepository.test.ts \
    apps/server/tests/services/artifactAuditJobService.test.ts \
    apps/server/tests/services/artifactAuditWorker.test.ts \
    apps/server/tests/api/artifactAudit.test.ts \
    apps/server/tests/services/metrics.test.ts
  ```

  Expected: all pass; expired work is reclaimed live and idle polling stays on
  the dedicated job path.

- [ ] **Step 7: Commit**

  ```bash
  git add apps/server/src apps/server/tests apps/server/.env.example \
    packages/shared/src README.md docs/architecture.md \
    docs/backend-hardening-roadmap.md \
    docs/superpowers/plans/2026-07-30-production-invariant-remediation.md
  git commit -m "refactor: isolate durable audit queue persistence"
  ```

### Task 4: Full release gates and next-phase handoff

**Files:**
- Modify: `docs/superpowers/plans/2026-07-30-production-invariant-remediation.md`
- Modify: `docs/backend-hardening-roadmap.md`
- Modify: `docs/enterprise-frontend-deploy-plan.md`

- [ ] **Step 1: Run the unified local gate**

  ```bash
  bun run verify
  git diff --check
  ```

  Expected: format/lint, secret scan, all package typechecks/tests and
  production Web packaging pass.

- [ ] **Step 2: Run real production-process smoke tests**

  With two distinct loopback hostnames and isolated SQLite/storage:

  ```text
  login -> upload v1 -> audit -> publish v1
  cross-origin cookie write from deploy origin -> 403
  kill during v1 deletion rename -> restart -> v1 still serves
  enqueue audit -> kill worker owner -> surviving worker reclaims after lease
  manual rollback -> active ETag and release ledger change once
  backup -> verify -> restore rehearsal -> integrity_check=ok
  ```

- [ ] **Step 3: Review the next feature boundary**

  Record API tokens/CI upload as the next product phase only after the three
  production invariants pass. The next design must use hashed project-scoped
  tokens with explicit preview/staging/production scopes, expiry, rotation,
  revocation, idempotency keys and security audit events; it must not reuse
  seven-day browser/desktop sessions.

- [ ] **Step 4: Commit delivery evidence**

  ```bash
  git add docs
  git commit -m "docs: record production invariant release gates"
  ```

- [ ] **Step 5: Synchronize main**

  ```bash
  git fetch origin
  git rev-list --left-right --count origin/main...main
  git push origin main
  git status --short --branch
  ```

  Expected: local and remote `main` reference the same verified commit and the
  worktree is clean.
