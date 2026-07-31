# Backup Internal Primitives Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use
> `subagent-driven-development` and execute one reviewed task at a time.

**Goal:** Remove the restore transaction's dead initial-verification transport
and consolidate the duplicated backup file-safety and SQLite-inspection
primitives without changing any public API, error semantics, verification
order, restore ordering, or recovery behavior.

**Architecture:** Keep `backupService.ts` as the only public facade and keep
`backupRestoreTransaction.ts` as one cohesive mutable transaction. Add two
server-private leaf modules with deliberately narrow responsibilities:
`backupFileSafety.ts` owns no-follow file identity and missing-path semantics;
`backupDatabaseInspection.ts` owns the shared SQLite metadata query. Snapshot,
verification, and restore may import those leaves, but the leaves never import
workflow modules or the facade. This avoids both a grab-bag helper module and a
workflow module becoming the owner of lower-level safety rules.

**Tech Stack:** Bun 1.3, TypeScript, `bun:sqlite`, Node filesystem primitives,
Bun test, Biome, GitHub Actions.

**Starting base:** `65d5a7d88a304dc7d826ae7aeddcf86a6ab8c883`

---

## Scope and invariants

### Included

1. Remove the unused `verification` input from `restoreVerifiedBackup`.
2. Consolidate these duplicated file-safety entities into
   `backupFileSafety.ts`:
   - `BACKUP_DATABASE_SNAPSHOT_UNSAFE`
   - `BACKUP_SOURCE_UNSAFE`
   - `assertSingleLinkRegularFile`
   - `sameCapturedIdentity`
   - `lstatIfPresent`
   - `pathEntryExistsNoFollow`
   - `isMissingPathError`
3. Consolidate `VersionIntegrityRow`, `inspectOpenDatabase`, and the thin
   `inspectDatabase` wrapper into `backupDatabaseInspection.ts`.
4. Add direct regression tests for the shared file-safety boundary.
5. Update the architecture documentation and the completed modularization
   plan's follow-up note.

### Explicitly excluded

- No public `BackupService`, CLI, HTTP, Hono, shared-package, client, or desktop
  contract change.
- No change to manifest format, SQL text, table-count set, row ordering,
  supported schema range, migration behavior, error strings, or error codes.
- No change to the initial verify/hook/ownership/staging/two-stage verify/move/
  install/compensation/cleanup/release sequence.
- No split of `backupRestoreTransaction.ts` and no change to its mutable control
  binding or progress state.
- No attempt to solve the separately documented online backup consistency or
  full release/audit semantic verification work.
- Do not merge `captureRegularFileNoFollow` with `hashFileFrame`, or
  `captureDirectoryNoFollow` with `hashDirectory`; their write/hash timing and
  failure semantics are intentionally different.
- Do not absorb `runtimeOwnership.ts`'s private missing-path helper. It belongs
  to a separate ownership boundary and is not part of the duplicated
  snapshot/verifier contract.

### Required behavior invariants

- Only `ENOENT` means a path is missing. `ENOTDIR`, `EACCES`, and other
  filesystem errors must continue to propagate.
- Symlinks and multiply-linked regular files remain rejected with the same
  stable backup error codes and messages.
- Captured identity continues to compare `dev`, `ino`, `size`, `mtimeNs`, and
  `ctimeNs` exactly.
- SQLite inspection continues to query the same version columns ordered by
  `project_id, sort_order`, the same eight base counts, and the same three
  schema-v6 counts.
- The initial detailed verification in the facade still gates the
  `afterInitialBackupVerified` hook and provides the expected fingerprint.
  Only the unused report transport into the transaction is removed.
- All new modules remain server-private: they are not exported by
  `apps/server/package.json`, `src/index.ts`, `src/api.ts`, `contracts.ts`, or
  `@deploykit/shared`.

## Preflight evidence

- `.codegraph/` exists, but neither the CodeGraph CLI nor a callable CodeGraph
  MCP tool is available in this environment. Source inspection therefore uses
  `rg` and direct file reads without initializing or modifying the index.
- Baseline branch: clean `main`, equal to `origin/main` at the starting base.
- Baseline focused suite:

  ```bash
  bun --filter @deploykit/server test \
    tests/services/backupService.test.ts \
    tests/services/backupRestoreSafety.test.ts
  ```

  Expected baseline: `107 pass`, `0 fail`.
- Read-only audits established that the initial `verification` argument is
  overwritten before any read, and that exactly nine top-level entities are
  duplicated across snapshot and verification. The nine entities are split
  across two leaves by responsibility rather than combined into one generic
  helper file.

---

## Task 1: Remove the dead restore verification transport

**Files:**

- Modify: `apps/server/src/services/backupService.ts`
- Modify: `apps/server/src/services/backupRestoreTransaction.ts`

**Ownership:** The implementer owns only these two files for this task. Other
agents may be reviewing the repository; do not revert or overwrite their work.

- [x] **Step 1: Preserve the facade's initial verification gate**

Keep `initialVerification.report` in `backupService.ts` for the existing
validity, manifest, error, and fingerprint checks. Keep the
`afterInitialBackupVerified` hook in the same position.

- [x] **Step 2: Remove only the unused transport**

Delete `verification` from the `restoreVerifiedBackup` call and input type. In
the transaction, replace the reassignment with a new local:

```ts
const verification = prepareRestorePayload({
  backupPath,
  controlBinding,
  dependencies,
  expectedFingerprint,
  operation,
});
```

Pass that prepared report unchanged to `executeRestore`. Keep
`BackupVerificationReport` imported because `executeRestore` still uses the
type and its final staged verification still replaces the local report.

- [x] **Step 3: Run focused gates**

```bash
bun --filter @deploykit/server test \
  tests/services/backupService.test.ts \
  tests/services/backupRestoreSafety.test.ts
bun run --filter @deploykit/server typecheck
bun x biome check \
  apps/server/src/services/backupService.ts \
  apps/server/src/services/backupRestoreTransaction.ts
git diff --check
```

Expected: 107 focused tests and typecheck/Biome/diff-check all pass.

- [x] **Step 4: Independent review and commit**

Review specifically for hook/ownership/operation-ID ordering and any remaining
read of the removed input. Fix all Critical/Important findings before commit.

```bash
git add apps/server/src/services/backupService.ts \
  apps/server/src/services/backupRestoreTransaction.ts
git commit -m "refactor: remove redundant restore verification input"
```

## Task 2: Extract the shared file-safety leaf

**Files:**

- Create: `apps/server/src/services/backupFileSafety.ts`
- Create: `apps/server/tests/services/backupFileSafety.test.ts`
- Modify: `apps/server/src/services/backupSnapshot.ts`
- Modify: `apps/server/src/services/backupVerification.ts`
- Modify: `apps/server/src/services/backupRestoreTransaction.ts`

**Ownership:** The implementer owns the five files above for this task. Do not
edit the database-inspection leaf or documentation in this task, and do not
revert concurrent work.

- [x] **Step 1: Write direct boundary regressions first**

Add focused tests that prove:

1. a genuinely absent path returns `undefined` from `lstatIfPresent` and
   `false` from `pathEntryExistsNoFollow`;
2. `isMissingPathError` accepts a synthetic `ENOENT`, but rejects synthetic
   `ENOTDIR` and `EACCES` errors;
3. a child under a regular-file parent preserves real `ENOTDIR` from both
   helpers;
4. a dangling symlink is still a present path entry under no-follow semantics;
5. a multiply-linked regular file is rejected with
   `BACKUP_SOURCE_UNSAFE`;
6. equal captured identities compare equal, while a table-driven change to
   each of `dev`, `ino`, `size`, `mtimeNs`, and `ctimeNs` compares unequal.

Run the new test before implementation and confirm it fails because the new
module does not exist:

```bash
bun test apps/server/tests/services/backupFileSafety.test.ts
```

- [x] **Step 2: Add the dependency-free filesystem leaf**

Move the seven listed file-safety entities verbatim into
`backupFileSafety.ts`. It may import filesystem types/functions only. Preserve
the `ENOENT`-only missing-path predicate and exact error text.

The server-private export surface is intentionally explicit so the three
workflow consumers and the direct boundary test use one contract:

```ts
export const BACKUP_DATABASE_SNAPSHOT_UNSAFE: string;
export const BACKUP_SOURCE_UNSAFE: string;
export interface CapturedFileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}
export function assertSingleLinkRegularFile(
  path: string,
  stats: ReturnType<typeof fstatSync> & { nlink: bigint },
  unsafeCode: string
): void;
export function sameCapturedIdentity(
  left: CapturedFileIdentity,
  right: CapturedFileIdentity
): boolean;
export function lstatIfPresent(
  path: string
): ReturnType<typeof lstatSync> | undefined;
export function pathEntryExistsNoFollow(path: string): boolean;
export function isMissingPathError(error: unknown): boolean;
```

- [x] **Step 3: Rewire all three consumers**

Import the shared constants/helpers into snapshot and verification, delete
their duplicate definitions, and change restore's three low-level helper
imports from `backupVerification` to `backupFileSafety`. Keep fingerprint and
staged-verification imports pointed at `backupVerification`.

- [x] **Step 4: Run regression and duplicate checks**

```bash
bun test apps/server/tests/services/backupFileSafety.test.ts
bun --filter @deploykit/server test \
  tests/services/backupService.test.ts \
  tests/services/backupRestoreSafety.test.ts
bun run --filter @deploykit/server typecheck
bun x biome check \
  apps/server/src/services/backupFileSafety.ts \
  apps/server/src/services/backupSnapshot.ts \
  apps/server/src/services/backupVerification.ts \
  apps/server/src/services/backupRestoreTransaction.ts \
  apps/server/tests/services/backupFileSafety.test.ts
git diff --check
```

Expected: the new direct suite passes, all 107 characterization tests pass,
and each extracted filesystem entity has exactly one production definition.

- [x] **Step 5: Independent review and commit**

Review for `ENOENT`/`ENOTDIR` drift, symlink/hard-link semantics, identity-field
loss, import cycles, and accidental verifier/restore ordering changes.

```bash
git add apps/server/src/services/backupFileSafety.ts \
  apps/server/src/services/backupSnapshot.ts \
  apps/server/src/services/backupVerification.ts \
  apps/server/src/services/backupRestoreTransaction.ts \
  apps/server/tests/services/backupFileSafety.test.ts
git commit -m "refactor: centralize backup file safety primitives"
```

## Task 3: Extract the shared database-inspection leaf

**Files:**

- Create: `apps/server/src/services/backupDatabaseInspection.ts`
- Create: `apps/server/tests/services/backupDatabaseInspection.test.ts`
- Modify: `apps/server/src/services/backupSnapshot.ts`
- Modify: `apps/server/src/services/backupVerification.ts`

**Ownership:** The implementer owns only these four files for this task. Do
not touch restore control flow or public exports, and do not revert concurrent
work.

- [ ] **Step 1: Write a direct SQL-contract test first**

Before editing, run the focused suites and retain their 107-pass baseline. In
particular, existing tests cover schema v5/v6/v7 hydration and end-to-end
manifest verification, but they cannot by themselves catch a shared SQL alias
bug that makes snapshot creation and verification agree on the same wrong
result.

Create two in-memory tests using minimal queried table shapes and deliberately
distinct counts:

1. schema 6 uses counts `1..11` for `users`, `projects`, `versions`,
   `artifact_audits`, `artifact_audit_jobs`, `audit_events`, `releases`,
   `sessions`, `project_api_tokens`, `api_token_security_events`, and
   `ci_idempotency_records`; assert the exact alias-to-count object and seed
   version rows out of order so the result must be ordered by
   `project_id, sort_order`;
2. schema 5 creates only the eight base tables and asserts the exact eight-key
   result plus absence of all three v6 keys. This proves the conditional branch
   does not query missing v6 tables.

After `inspectOpenDatabase` returns, run `SELECT 1` on the caller-owned
database to prove the open-database helper does not close it. Keep the
file-wrapper's readonly/finally behavior covered by existing create/rollback
integration because observing close semantics portably would add brittle test
machinery.

Run the direct test before adding the leaf and confirm it fails because the
module does not exist:

```bash
bun test apps/server/tests/services/backupDatabaseInspection.test.ts
```

- [ ] **Step 2: Move the shared database inspection verbatim**

Create a leaf that owns:

```ts
export interface VersionIntegrityRow { /* unchanged fields */ }
export interface BackupDatabaseInspection {
  schemaVersion: number;
  versions: VersionIntegrityRow[];
  counts: BackupManifest['metadataCounts'];
}
export function inspectOpenDatabase(
  database: Database
): BackupDatabaseInspection;
export function inspectDatabase(
  databaseFile: string
): BackupDatabaseInspection;
```

The wrapper must remain readonly and must close the database in `finally`.
Move the existing SQL literally: do not rename aliases, reorder queries, add
tables, or change the `schemaVersion >= 6` branch.

- [ ] **Step 3: Rewire snapshot and verification**

Import the inspection functions/type from the new leaf, remove the duplicate
`VersionIntegrityRow` and `inspectOpenDatabase` definitions, and remove the
old snapshot-local wrapper. Keep `Database` imports in both workflow modules
because snapshot still runs `VACUUM INTO` and verification still runs SQLite
integrity/foreign-key checks and migration validation.

- [ ] **Step 4: Run characterization and structure gates**

```bash
bun test apps/server/tests/services/backupDatabaseInspection.test.ts
bun --filter @deploykit/server test \
  tests/services/backupService.test.ts \
  tests/services/backupRestoreSafety.test.ts
bun run --filter @deploykit/server typecheck
bun x biome check \
  apps/server/src/services/backupDatabaseInspection.ts \
  apps/server/src/services/backupSnapshot.ts \
  apps/server/src/services/backupVerification.ts \
  apps/server/tests/services/backupDatabaseInspection.test.ts
rg -n "interface VersionIntegrityRow|function inspectOpenDatabase|function inspectDatabase" \
  apps/server/src/services
git diff --check
```

Expected: the direct SQL-contract suite and all 107 focused tests pass; the two
database functions and the row interface have one production definition;
there are no circular
imports or public exports.

- [ ] **Step 5: Independent review and commit**

Review exact SQL/count parity, readonly close behavior, type compatibility,
and the private module DAG before committing.

```bash
git add apps/server/src/services/backupDatabaseInspection.ts \
  apps/server/src/services/backupSnapshot.ts \
  apps/server/src/services/backupVerification.ts \
  apps/server/tests/services/backupDatabaseInspection.test.ts
git commit -m "refactor: centralize backup database inspection"
```

## Task 4: Document, verify, review, and deliver

**Files:**

- Modify: `docs/architecture.md`
- Modify:
  `docs/superpowers/plans/2026-08-01-backup-service-modularization.md`
- Modify: this plan
- Modify: `.superpowers/sdd/progress.md` (ignored execution ledger only)

**Ownership:** Documentation implementer owns the tracked docs above. The root
agent owns the ignored progress ledger, release verification, and push.

- [ ] **Step 1: Update the private module DAG**

Document the two new server-private leaves and their consumers. State why the
filesystem and SQLite responsibilities are separated and that neither enters
the Bun-free API graph. Preserve the restore transaction cohesion warning.

- [ ] **Step 2: Resolve the prior follow-up record accurately**

Update the completed modularization plan so it no longer presents the dead
`verification` input as the current interface. Preserve its historical meaning
by linking the later cleanup plan/commit instead of pretending the original
extraction included this work.

- [ ] **Step 3: Run complete local gates**

```bash
bun run check
bun run verify
npm_config_registry=https://registry.npmjs.org bun run security:audit
git diff --check
git status --short --branch
```

Expected: formatting/lint, secret scan, all workspace typechecks/tests,
production builds/packages, and the high-severity dependency audit pass.

- [ ] **Step 4: Run two independent whole-range reviews**

From the recorded starting base, require separate spec-compliance and
code-quality/security reviews. Both must inspect the complete range, import
DAG, public export surface, exact SQL/error semantics, restore order, direct
tests, and documentation. Fix all Critical/Important findings and re-run every
covering gate before re-review.

- [ ] **Step 5: Commit documentation and review fixes**

```bash
git add docs/architecture.md \
  docs/superpowers/plans/2026-08-01-backup-service-modularization.md \
  docs/superpowers/plans/2026-08-01-backup-internal-primitives-cleanup.md
git commit -m "docs: record backup primitive boundaries"
```

- [ ] **Step 6: Fetch, push `main`, and wait for exact-SHA gates**

```bash
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
git push origin main
```

Wait for both CI and CodeQL to succeed for the exact pushed SHA. Then confirm
local `HEAD`, `origin/main`, and `git ls-remote origin refs/heads/main` agree,
the tracked worktree is clean, and report the exact commit and workflow URLs.

---

## Final acceptance criteria

- `restoreVerifiedBackup` no longer accepts a dead initial report, while the
  facade still performs the same initial gate and hook before ownership.
- The nine duplicated snapshot/verifier entities have one production
  definition each, divided into cohesive filesystem and SQLite leaves.
- Direct tests lock `ENOENT`, `ENOTDIR`, `EACCES`, dangling-symlink, hard-link,
  and captured-identity semantics.
- Direct SQLite tests lock every count alias, schema-v5/v6 key branching, and
  version-row ordering independently from snapshot/verifier agreement.
- All 107 pre-existing backup characterization tests still pass, and all new
  tests pass.
- No public API/package export, manifest, SQL, error, operation ordering, or
  restore state-machine behavior changes.
- Complete local verification and dependency audit pass.
- Two independent whole-range reviews approve the final range.
- Exact-SHA CI and CodeQL pass after `main` is pushed; local, tracking, and
  remote `main` agree.
