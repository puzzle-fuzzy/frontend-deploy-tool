# Storage Recovery, Quota, and Operations Implementation Plan

> **Execution:** Use the `executing-plans` workflow. Every destructive storage
> action must first create a recoverable state. Do not start observability/CI
> work until the backup-restore drill and full verification pass.

**Goal:** Make artifact storage resilient to failed deletions, bounded by
transactional capacity limits, automatically maintainable through conservative
garbage collection, verifiable by checksum, and recoverable with tested backup
and restore commands.

**Architecture:** Keep SQLite metadata authoritative and artifacts on one local
storage volume. Destructive project/version operations first atomically rename
artifacts into `.recovery/trash/{operationId}`, then commit metadata; failure
rolls the rename back. Committed trash, staging, and orphan quarantine have
separate retention windows and are deleted only by an explicit/startup GC
policy. Upload quota checks happen inside the same SQLite `IMMEDIATE` mutation
that inserts version metadata. Backup uses SQLite `VACUUM INTO` plus a copied
artifact tree and manifest; restore validates before replacing and preserves
the current state in a rollback directory.

**Non-goals:** No S3/object store, distributed locks, multi-node uploads,
background queue, incremental backup, billing, or artifact SEO analysis.

## Invariants

- A metadata deletion is never committed while the corresponding artifact
  exists only in an untracked location.
- If metadata mutation fails after staging deletion, artifacts return to their
  original path.
- Successful deletion leaves committed trash recoverable until retention
  expires.
- Fresh staging, trash, and orphan entries are never removed by startup GC.
- Global, accountable-user, and project quotas are rechecked transactionally
  immediately before version metadata is inserted.
- Backup output is self-describing and validated before restore.
- Restore never overwrites the current database/storage without first moving
  them into a rollback directory.

---

## Task 1: Two-phase recoverable project/version deletion

**Files:**
- Create: `apps/server/src/services/artifactRecovery.ts`
- Modify: `apps/server/src/services/contracts.ts`
- Modify: `apps/server/src/services/projectService.ts`
- Modify: `apps/server/src/services/versionService.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/api.ts`
- Modify: `apps/server/src/routes/projects.ts`
- Create: `apps/server/tests/services/artifactRecovery.test.ts`
- Modify: `apps/server/tests/services/versionService.test.ts`
- Modify: `apps/server/tests/api/contracts.test.ts`

- [x] Add failing tests for stage → rollback, stage → commit, missing source,
  and target collision behavior.
- [x] Add injected metadata-failure tests proving project/version artifacts are
  restored and no committed trash marker exists.
- [x] Implement same-volume rename into an operation directory with a JSON
  manifest and `COMMITTED` marker.
- [x] Move project deletion orchestration from the route callback into
  `ProjectService`; move version deletion through the same recovery service.
- [x] On successful metadata commit, mark trash committed but retain bytes for
  GC. On mutation failure, restore before rethrowing.
- [x] Run:
  `bun --filter @deploykit/server test tests/services/artifactRecovery.test.ts tests/services/versionService.test.ts tests/api/contracts.test.ts`

## Task 2: Transactional global/user/project storage quotas

**Files:**
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/.env.example`
- Modify: `packages/shared/src/errors.ts`
- Create: `apps/server/src/domain/storageQuota.ts`
- Modify: `apps/server/src/services/versionService.ts`
- Modify: `apps/server/tests/services/config.test.ts`
- Create: `apps/server/tests/services/storageQuota.test.ts`
- Modify: `apps/server/tests/services/versionService.test.ts`

- [x] Add configuration defaults and validation for
  `MAX_STORAGE_SIZE`, `MAX_STORAGE_SIZE_PER_USER`, and
  `MAX_STORAGE_SIZE_PER_PROJECT`.
- [x] Define the accountable user as `project.createdBy` for this phase and
  document that ownership/billing reassignment is a future explicit operation;
  do not double-count collaborators.
- [x] Add pure usage calculation and exact-boundary tests.
- [x] Inside the final repository mutation of upload, re-read current usage and
  reject the pending version with `STORAGE_QUOTA_EXCEEDED` (413) before
  appending metadata/history.
- [x] Confirm rejection removes the already-staged final artifact and does not
  create a version/history row.
- [x] Run:
  `bun --filter @deploykit/server test tests/services/storageQuota.test.ts tests/services/versionService.test.ts tests/services/config.test.ts`

## Task 3: Retention-aware staging/recovery garbage collection

**Files:**
- Create: `apps/server/src/services/storageGarbageCollector.ts`
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/services/storageReconciler.ts`
- Modify: `apps/server/src/app.ts`
- Create: `apps/server/tests/services/storageGarbageCollector.test.ts`
- Modify: `apps/server/tests/services/storageReconciler.test.ts`

- [x] Add configurable `STAGING_RETENTION_HOURS` (default 24) and
  `RECOVERY_RETENTION_HOURS` (default 168).
- [x] Add timestamp-controlled tests proving fresh entries survive, expired
  staging is removed, only committed expired trash is removed, and orphan
  quarantine observes recovery retention.
- [x] Replace unconditional startup staging deletion with the conservative
  collector and include its counts in reconciliation reporting.
- [x] Leave uncommitted trash untouched for operator inspection/recovery.
- [x] Run:
  `bun --filter @deploykit/server test tests/services/storageGarbageCollector.test.ts tests/services/storageReconciler.test.ts tests/services/config.test.ts`

## Task 4: Explicit artifact integrity inspection

**Files:**
- Create: `apps/server/src/services/artifactIntegrityService.ts`
- Create: `apps/server/tests/services/artifactIntegrityService.test.ts`
- Modify: `packages/shared/src/domain.ts`
- Modify: `apps/server/src/repositories/sqliteSchema.ts`
- Modify: `apps/server/src/repositories/sqliteProjectRepository.ts`

- [ ] Add a persisted `integrityStatus` (`unknown|verified|missing|corrupted`)
  and `integrityCheckedAt` to versions with a reversible relational migration.
- [ ] Add tests for valid checksum, missing entrypoint, checksum mismatch, and
  legacy empty-checksum backfill.
- [ ] Implement an explicit inspector that computes checksums outside the
  metadata transaction, then applies results transactionally; a damaged active
  version is unpublished, never replaced.
- [ ] Record `version.reconcile` audit metadata with a stable reason and never
  run full-tree hashing on every server startup.
- [ ] Run:
  `bun --filter @deploykit/server test tests/services/artifactIntegrityService.test.ts tests/services/schemaMigration.test.ts tests/services/sqliteProjectRepository.test.ts`

## Task 5: Tested backup, verify, and restore operations

**Files:**
- Create: `apps/server/src/services/backupService.ts`
- Create: `apps/server/src/cli/ops.ts`
- Create: `apps/server/tests/services/backupService.test.ts`
- Modify: `apps/server/package.json`
- Modify: `package.json`
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `apps/server/README.md`
- Modify: `docs/architecture.md`

- [ ] Define a versioned backup manifest with creation time, schema version,
  database filename, storage directory, and metadata/artifact counts.
- [ ] Use `VACUUM INTO` for a transactionally consistent SQLite snapshot and
  copy artifacts into a temporary backup directory before atomic rename.
- [ ] Verify `integrity_check`, `foreign_key_check`, manifest shape, expected
  paths, version entrypoints, and checksums.
- [ ] Restore only with an explicit `--force`; validate the backup first, move
  the current database/storage to a timestamped rollback directory, then move
  restored files into place.
- [ ] Inject restore failure and prove the rollback state remains available.
- [ ] Add `bun run ops -- backup|verify|restore|gc|inspect`.
- [ ] Run:
  `bun --filter @deploykit/server test tests/services/backupService.test.ts`

## Task 6: Phase gate and remote checkpoint

- [ ] Run `bun run verify`.
- [ ] Run a backup → mutate → restore drill and compare projects, versions,
  active release, audit events, and sessions.
- [ ] Run `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, artifact
  integrity inspection, and GC dry-run/real-run fixtures.
- [ ] Update `docs/backend-hardening-roadmap.md`, `AGENTS.md`, `CLAUDE.md`, and
  environment documentation.
- [ ] Commit independently verified slices, push `main`, and confirm
  `origin/main` matches.
