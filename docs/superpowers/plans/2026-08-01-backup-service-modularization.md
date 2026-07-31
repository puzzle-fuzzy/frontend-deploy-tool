# Backup Service Modularization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 3,549-line backup/restore service with a thin public facade and explicit snapshot, verification, and restore-transaction modules without changing any observable backup or restore behavior.

**Architecture:** `backupService.ts` remains the only production entry point and keeps the existing `createBackupService()` API. Shared server-private types move to a leaf `backupTypes.ts`; snapshot code never imports verification, verification may import snapshot primitives, and the restore transaction may import both. The mutable restore binding, move progress, compensation, quarantine, and cleanup state stay together in one module.

**Tech Stack:** Bun 1.3.14, TypeScript 6 strict mode, `bun:sqlite`, Node filesystem APIs, Biome, `bun:test`.

## Global Constraints

- This is a behavior-preserving refactor. Do not add product features, routes, UI, dependencies, backup-format fields, migrations, or new operational commands.
- Preserve the public import and call surface from `services/backupService.ts`: `createBackupService`, `BackupService`, `BackupManifest`, `BackupVerificationReport`, and `BackupRestoreReport`.
- Keep `BackupServiceDependencies` internal. Existing tests may continue to derive it with `Parameters<typeof createBackupService>[1]`; do not expose fault-injection hooks as a package API.
- Do not import any backup module into `services/contracts.ts`, `src/api.ts`, shared packages, or the Bun-free Hono type graph.
- Preserve manifest format version 1, property order, two-space JSON formatting, database basename, fixed `storage` directory name, counts, warning/error text, and stable bracketed error codes.
- Preserve creation order exactly: runtime-layout preflight → `VACUUM INTO` → storage copy → database/tree inspection → manifest write → full verify → atomic destination rename; failure removes only the unpublished temporary snapshot.
- Preserve restore order exactly: initial verify without ownership → `afterInitialBackupVerified` hook → operation-layout preflight → acquire runtime ownership → repeat preflight → bind/capture stages → first exact staged verification → `afterRestorePayloadStaged` hook → second staged verification/fingerprint check → move DB/three auxiliaries/storage to rollback → write rollback manifest → install DB → install storage → clean stages → final live digest/auxiliary check → commit binding → release ownership.
- Keep `O_NOFOLLOW`, single-link checks, dev/inode/size/time revalidation, framed fingerprints, sidecar rejection, EXDEV publish-before-source-removal, rename commit classification, quarantine evidence, and primary-error authority unchanged.
- Keep all mutable restore state in one module. Do not split control binding, move progress, rollback recovery, or cleanup into separately importing modules in this phase.
- Do not add brittle source-text or line-count tests. The existing 105 backup/restore characterization tests plus TypeScript/Biome are the refactor contract.
- Use `apply_patch` for edits, preserve unrelated changes, and commit each reviewed task separately.

## Verified Baseline

At `7ab468e3eeee772d50ab1586ba86f0ce37b4be1e`:

```bash
bun test apps/server/tests/services/backupService.test.ts \
  apps/server/tests/services/backupRestoreSafety.test.ts
bun --filter @deploykit/server typecheck
```

Expected baseline: `105 pass / 0 fail / 780 assertions`; server typecheck exits 0.

## Explicit Follow-up Boundaries

The read-only architecture audit found two correctness decisions that this mechanical refactor must not silently resolve:

1. `VACUUM INTO` and storage copy currently represent two capture moments and `backup` does not acquire runtime ownership. A later product decision must choose enforced offline backup or a real online quiescence/snapshot protocol.
2. Backup verification does not yet prove every historical audit-event row and release-ledger row semantically valid. A later correctness plan must add full-row verification and exact production round-trip assertions.

Keeping these outside this plan prevents a module move from being mixed with an operational behavior change. The new boundaries must make both follow-ups easier without pretending they are already solved.

---

### Task 1: Extract the Server-Private Backup Type Leaf

**Files:**

- Create: `apps/server/src/services/backupTypes.ts`
- Modify: `apps/server/src/services/backupService.ts`
- Test: `apps/server/tests/services/backupService.test.ts`
- Test: `apps/server/tests/services/backupRestoreSafety.test.ts`

**Interfaces:**

- Produces `BackupManifest`, `BackupVerificationReport`, `BackupRestoreReport`, `BackupService`, `BackupServiceConfig`, `BackupServiceDependencies`, `RestoreFileSystem`, `RuntimeOwnership`, `VerifiedBackupPayload`, `DATABASE_AUXILIARY_SUFFIXES`, and `DatabaseAuxiliarySuffix` from one app-private leaf.
- `backupService.ts` re-exports only the four existing public DTO/service types and continues exporting `createBackupService()`.
- No runtime import from `backupTypes.ts` may point to `backupService.ts`.

- [ ] **Step 1: Confirm the characterization baseline and clean tree**

```bash
git status --short --branch
bun test apps/server/tests/services/backupService.test.ts \
  apps/server/tests/services/backupRestoreSafety.test.ts
```

Expected: clean `main`, 105 passing tests.

- [ ] **Step 2: Move the exact type and constant declarations**

Create the leaf with the existing declarations and no behavior:

```ts
export const DATABASE_AUXILIARY_SUFFIXES = [
  '-journal',
  '-wal',
  '-shm',
] as const;

export type DatabaseAuxiliarySuffix =
  (typeof DATABASE_AUXILIARY_SUFFIXES)[number];

export interface BackupManifest {
  formatVersion: 1;
  createdAt: string;
  schemaVersion: number;
  databaseFile: string;
  storageDirectory: 'storage';
  metadataCounts: {
    users: number;
    projects: number;
    versions: number;
    artifactAudits: number;
    artifactAuditJobs: number;
    auditEvents: number;
    releases: number;
    sessions: number;
    apiTokens?: number;
    apiTokenSecurityEvents?: number;
    ciIdempotencyRecords?: number;
  };
  artifactCounts: {
    files: number;
    bytes: number;
    deployableVersions: number;
  };
}
```

Move the remaining interfaces byte-for-byte from `backupService.ts`; do not redesign hook parameters or filesystem adapter options.

- [ ] **Step 3: Re-export the unchanged public facade types**

`backupService.ts` must retain this source compatibility:

```ts
export type {
  BackupManifest,
  BackupRestoreReport,
  BackupService,
  BackupVerificationReport,
} from './backupTypes';
```

Import the internal config/dependency types with `import type`; do not export them from the facade.

- [ ] **Step 4: Run the task gates**

```bash
bun test apps/server/tests/services/backupService.test.ts \
  apps/server/tests/services/backupRestoreSafety.test.ts
bun --filter @deploykit/server typecheck
bun biome check apps/server/src/services apps/server/tests/services
git diff --check
```

Expected: 105 passing tests, typecheck/Biome/diff-check pass, no runtime behavior diff.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/backupTypes.ts \
  apps/server/src/services/backupService.ts
git commit -m "refactor: extract backup service contracts"
```

---

### Task 2: Extract Snapshot Creation and Safe Payload Capture

**Files:**

- Create: `apps/server/src/services/backupSnapshot.ts`
- Modify: `apps/server/src/services/backupService.ts`
- Test: `apps/server/tests/services/backupService.test.ts`
- Test: `apps/server/tests/services/backupRestoreSafety.test.ts`

**Interfaces:**

- Produces `createBackupSnapshotAt(input): BackupManifest`. Its input contains the resolved `RuntimeResourceLayout`, destination, clock, and a `verifyPreparedBackup(path)` callback. The callback inversion keeps snapshot code independent from verification while preserving verify-before-publish cleanup.
- Produces internal primitives needed by later modules: `captureBackupPayload`, `assertDatabaseAuxiliariesAbsent`, `inspectDatabase`, `inspectTree`, `countDeployableVersions`, `parseManifest`, and `ensureRollbackManifest`.
- Consumes only `backupTypes.ts`, repository/schema inspection dependencies, artifact checksum/path helpers, and filesystem/SQLite APIs. It must not import `backupService.ts` or `backupVerification.ts`.

- [ ] **Step 1: Record the creation/capture contract before moving code**

Confirm that the existing tests cover self-describing creation, source/stage swaps, symlink/hard-link rejection, sidecars, cleanup, and target non-publication:

```bash
bun test apps/server/tests/services/backupService.test.ts \
  apps/server/tests/services/backupRestoreSafety.test.ts
```

Expected: 105 passing tests.

- [ ] **Step 2: Move snapshot creation behind one callback boundary**

Use this exact orchestration contract:

```ts
export function createBackupSnapshotAt(input: {
  destination: string;
  layout: RuntimeResourceLayout;
  now: () => Date;
  verifyPreparedBackup: (backupPath: string) => BackupVerificationReport;
}): BackupManifest;
```

The function owns destination-exists rejection, parent creation, temporary path creation, SQLite `VACUUM INTO`, storage copy, manifest construction/write, verification callback, atomic rename, and unpublished temporary cleanup. Preserve the existing field order, error strings, and synchronous ordering.

- [ ] **Step 3: Move safe capture and shared payload inspection verbatim**

Move the current no-follow file/directory capture functions, single-link and identity checks, auxiliary rejection, manifest parsing, SQLite/tree inspection/count helpers, and rollback-manifest writer. Export only the named primitives required by verification/restore; keep raw FD/hash-independent helpers private.

- [ ] **Step 4: Rewire `createBackupService().createBackup`**

The facade still resolves and validates the runtime layout first, then calls `createBackupSnapshotAt` with:

```ts
verifyPreparedBackup: (path) => verifyBackupAt(path, dependencies),
```

At this checkpoint `verifyBackupAt` may still live in `backupService.ts`; no reverse import is allowed.

- [ ] **Step 5: Run the task gates and inspect the dependency direction**

```bash
bun test apps/server/tests/services/backupService.test.ts \
  apps/server/tests/services/backupRestoreSafety.test.ts
bun --filter @deploykit/server typecheck
bun biome check apps/server/src/services apps/server/tests/services
! rg -n "from './(backupService|backupVerification)'" \
  apps/server/src/services/backupSnapshot.ts
git diff --check
```

Expected: 105 passing tests; the final `rg` emits no matches.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/services/backupSnapshot.ts \
  apps/server/src/services/backupService.ts
git commit -m "refactor: extract backup snapshot boundary"
```

---

### Task 3: Extract Backup Verification and Migration Preflight

**Files:**

- Create: `apps/server/src/services/backupVerification.ts`
- Modify: `apps/server/src/services/backupService.ts`
- Test: `apps/server/tests/services/backupService.test.ts`
- Test: `apps/server/tests/api/ciProductionProcessSmoke.test.ts`

**Interfaces:**

- Produces `verifyBackupAt(path, dependencies): BackupVerificationReport`.
- Produces `verifyBackupDetailedAt(path, dependencies): VerifiedBackupPayload`.
- Produces `verifyStagedBackupPayload(manifestPath, databaseFile, storageDir, dependencies): VerifiedBackupPayload` and `fingerprintBackupPayload(...)` for restore.
- Imports safe capture/parse/inspection primitives from `backupSnapshot.ts`; neither `backupSnapshot.ts` nor `backupTypes.ts` may import it.

- [ ] **Step 1: Lock the verification ordering with existing characterization tests**

```bash
bun test apps/server/tests/services/backupService.test.ts
```

Expected: all backup service tests pass, including v5/v6 migration dry-run, v7 domain hydration, cleanup fail-closed, and corruption cases.

- [ ] **Step 2: Move verification entry points and helpers verbatim**

Move the detailed verifier, staged verifier, migration temporary-root lifecycle, production schema upgrade/hydration, integrity/foreign-key/count/artifact checks, framed fingerprinting, version checks, and count comparison. Preserve the current validation order and exact errors/warnings. Do not broaden manifest compatibility or add full release/audit verification in this task.

- [ ] **Step 3: Rewire the facade and restore imports**

`backupService.ts` imports `verifyBackupAt` and `verifyBackupDetailedAt`. Restore code still in the facade file imports `verifyStagedBackupPayload` and `fingerprintBackupPayload` until Task 4 moves the transaction.

- [ ] **Step 4: Run focused and production gates**

```bash
bun test apps/server/tests/services/backupService.test.ts \
  apps/server/tests/services/backupRestoreSafety.test.ts \
  apps/server/tests/api/ciProductionProcessSmoke.test.ts
bun --filter @deploykit/server typecheck
bun biome check apps/server/src/services apps/server/tests/services \
  apps/server/tests/api/ciProductionProcessSmoke.test.ts
! rg -n "from './backupVerification'" \
  apps/server/src/services/backupSnapshot.ts \
  apps/server/src/services/backupTypes.ts
git diff --check
```

Expected: all focused tests pass; the dependency-direction `rg` emits no matches.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/backupVerification.ts \
  apps/server/src/services/backupService.ts
git commit -m "refactor: extract backup verification boundary"
```

---

### Task 4: Extract the Cohesive Restore Transaction

**Files:**

- Create: `apps/server/src/services/backupRestoreTransaction.ts`
- Modify: `apps/server/src/services/backupService.ts`
- Test: `apps/server/tests/services/backupService.test.ts`
- Test: `apps/server/tests/services/backupRestoreSafety.test.ts`

**Interfaces:**

- Produces one operational entry point, `restoreVerifiedBackup(input): BackupRestoreReport`.
- Input carries `backupPath`, resolved layout, current verification report, expected fingerprint, clock, and the unchanged dependency object.
- The function owns operation ID/layout/preflight, ownership acquisition/release, stage binding/capture, final verification, live move/install, rollback/compensation, cleanup, quarantine, and secondary-failure attachment.
- All binding/progress/recovery types remain private to this module.

- [ ] **Step 1: Re-run the restore safety baseline**

```bash
bun test apps/server/tests/services/backupService.test.ts \
  apps/server/tests/services/backupRestoreSafety.test.ts
```

Expected: 105 passing tests.

- [ ] **Step 2: Move the complete restore state machine as one unit**

Use this facade boundary:

```ts
export function restoreVerifiedBackup(input: {
  backupPath: string;
  dependencies: BackupServiceDependencies;
  expectedFingerprint: string;
  layout: RuntimeResourceLayout;
  now: () => Date;
  verification: BackupVerificationReport;
}): BackupRestoreReport;
```

Inside it, preserve the current post-initial-verification sequence beginning with operation layout/preflight and ending with ownership release. Move every restore binding, stage, move/EXDEV, commit-classification, rollback/recovery, cleanup, digest, quarantine, and secondary-error helper with it. Do not expose `RestoreControlBinding`, `RuntimeMoveProgress`, or recovery helpers.

- [ ] **Step 3: Reduce `backupService.ts` to the public facade**

The facade retains force confirmation, runtime-layout validation, initial detailed verification, `afterInitialBackupVerified`, and delegation:

```ts
return restoreVerifiedBackup({
  backupPath,
  dependencies,
  expectedFingerprint: initialVerification.fingerprint,
  layout,
  now,
  verification: initialVerification.report,
});
```

Keep the initial verification before the restore module acquires ownership. `backupService.ts` must contain no restore binding, filesystem move, hash, migration, or SQLite implementation helpers after this step.

- [ ] **Step 4: Run safety, full-server, and dependency gates**

```bash
bun test apps/server/tests/services/backupService.test.ts \
  apps/server/tests/services/backupRestoreSafety.test.ts
bun test apps/server/tests
bun --filter @deploykit/server typecheck
bun biome check apps/server/src/services apps/server/tests/services
! rg -n "from './backupService'" \
  apps/server/src/services/backupTypes.ts \
  apps/server/src/services/backupSnapshot.ts \
  apps/server/src/services/backupVerification.ts \
  apps/server/src/services/backupRestoreTransaction.ts
git diff --check
```

Expected: 105 focused tests and the full server suite pass; the reverse-import `rg` emits no matches.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/backupRestoreTransaction.ts \
  apps/server/src/services/backupService.ts
git commit -m "refactor: extract backup restore transaction"
```

---

### Task 5: Document Boundaries, Review, and Deliver

**Files:**

- Modify: `docs/architecture.md`
- Modify: `docs/backend-hardening-roadmap.md`
- Modify: `docs/superpowers/plans/2026-08-01-backup-service-modularization.md`

**Interfaces:**

- Documents the facade/internal DAG and the reason restore control/recovery remain one transaction unit.
- Records the two deferred correctness decisions without claiming that module extraction solved them.

- [ ] **Step 1: Update architecture documentation**

In the backend service table and backup section, document:

```text
backupService facade
  -> backupSnapshot
  -> backupVerification -> backupSnapshot
  -> backupRestoreTransaction -> backupVerification + backupSnapshot
all internal modules -> backupTypes
```

State that these are server-private modules and do not enter the Bun-free API type graph.

- [ ] **Step 2: Record the correctness follow-ups**

Add concise roadmap entries for choosing an enforced offline or truly quiesced online backup contract, and for verifying every release/audit row plus exact round-trip state. Do not mark either complete.

- [ ] **Step 3: Run complete local gates**

```bash
bun run check
bun run verify
npm_config_registry=https://registry.npmjs.org bun run security:audit
git diff --check
git status --short --branch
```

Expected: all workspaces pass check, secret scan, typecheck, tests, build/package, and high-severity dependency audit.

- [ ] **Step 4: Run independent whole-range review**

Review from the recorded starting commit. Require both spec-compliance and code-quality approval, with special attention to import cycles, operation ordering, error identity, stage cleanup, and restore compensation. Fix all Critical/Important findings and re-run covering tests before re-review.

- [ ] **Step 5: Commit documentation and review fixes**

```bash
git add docs/architecture.md docs/backend-hardening-roadmap.md \
  docs/superpowers/plans/2026-08-01-backup-service-modularization.md \
  apps/server/src/services/backupService.ts \
  apps/server/src/services/backupTypes.ts \
  apps/server/src/services/backupSnapshot.ts \
  apps/server/src/services/backupVerification.ts \
  apps/server/src/services/backupRestoreTransaction.ts
git commit -m "docs: record backup service module boundaries"
```

- [ ] **Step 6: Fetch, push `main`, and wait for exact-SHA gates**

```bash
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
git push origin main
```

Wait for both CI and CodeQL to succeed for the exact pushed SHA, then verify local `HEAD`, `origin/main`, and `git ls-remote origin refs/heads/main` agree.
