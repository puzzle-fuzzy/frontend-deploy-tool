# Offline Consistent Backup Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `subagent-driven-development` to implement this plan one reviewed task at a
> time. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every supported DeployKit backup a fail-closed, single-host
offline capture in which the SQLite snapshot and artifact tree are copied,
verified, and published while the same runtime ownership pair excludes all
other managed writers.

**Architecture:** Keep `backupService.ts` as the use-case boundary and give its
`createBackup` path an explicit backup-local acquire/capture/cleanup/release
lifecycle; do not hide it inside a generic callback shared with the server or
restore transaction. Reuse the existing two-sidecar ownership protocol, close
the only known production CLI writer bypass (`ops gc`), and reject backup
destinations that overlap live runtime resources. Preserve the initiating
backup error while recording temporary-cleanup or ownership-release failures
through one server-private backup-failure leaf.

**Tech Stack:** Bun 1.3, TypeScript, `bun:sqlite`, Node filesystem primitives,
Bun test, Biome, GitHub Actions.

## Global Constraints

- The delivered contract is **single-host and cooperative**. It covers the
  production server, `BackupService`, restore, and repository-owned operational
  commands that use the same canonical `DATABASE_FILE` / `STORAGE_DIR` pair.
- Do not describe this as hot/online backup, a cross-resource atomic
  transaction, a network-filesystem/multi-host lock, or power-loss-durable
  publication.
- `createBackup` must acquire both runtime ownership locks before opening the
  live SQLite database or creating a backup temporary tree, and hold them
  through SQLite snapshot, storage copy, manifest construction, internal
  verification, destination publication, and failed temporary-tree cleanup.
- A live runtime, restore, backup, GC, inspect, or audit-prune command owning
  either resource must make another managed operation fail immediately with
  `RUNTIME_OWNERSHIP_HELD`. Backup has no `--force` or `--online` bypass.
- The final backup destination and its temporary sibling must not equal,
  contain, or be contained by any database, storage, SQLite auxiliary, or
  ownership-sidecar runtime resource. A dangling destination symlink counts as
  an existing destination.
- An initiating snapshot/copy/verify/publish failure remains the exact thrown
  value. Temporary cleanup and ownership release are still attempted; on an
  extensible `Error`, their failures are attached as best-effort secondary
  metadata. Frozen/hostile Errors and primitive thrown values may not accept
  metadata, and metadata failure may never replace the initiating failure. If
  the backup itself succeeded and only ownership release fails, the release
  failure remains authoritative.
- Do not change `BackupService`, backup manifest version/shape, verification
  rules, restore ordering, HTTP/Hono/shared/client/desktop contracts, or the
  successful CLI JSON shape.
- `createApp()` and direct repository/service construction remain explicit
  test/internal seams and are not part of this production ownership promise.
  This phase documents that boundary rather than adding ownership capabilities
  to every repository method.
- Raw SQLite clients, shell scripts, cron/rsync, external backup agents,
  another container/host, or an actor that removes/replaces sidecars remain
  unmanaged writers. Operators must stop them; otherwise this contract does
  not claim consistency.
- Full row-level semantic validation of `releases` and `audit_events`, plus the
  exact production backup -> restore -> boot round trip, remains the next
  independent phase.

---

## Scope and preflight evidence

### Included

1. Backup-local runtime ownership from before the live database open through
   final publish or failed temporary cleanup.
2. Backup destination no-follow existence and runtime-resource overlap
   preflight, repeated after ownership acquisition.
3. Stable primary/secondary failure semantics for backup temp cleanup and
   ownership release.
4. Runtime ownership for both dry-run and destructive `ops gc` command
   lifecycles.
5. Strict `backup [destination]` CLI arity: zero or one positional destination,
   no flags, no silently ignored arguments.
6. Real service-process proof that a live server rejects backup and that a
   graceful stop permits an immediate successful retry.
7. Architecture, development, roadmap, README, and CLI help updates.

### Explicitly excluded

- No online quiescing endpoint, admin pause state, IPC/RPC coordination, queued
  writer drain protocol, or automatic server shutdown/restart.
- No ownership token added to every repository/service method and no runtime
  ban on the existing test-only `createApp()` composition seam.
- No refactor of `backupRestoreTransaction.ts` or its restore secondary-failure
  protocol.
- No filesystem snapshot, `fsfreeze`, volume snapshot, distributed lock,
  destination-parent identity binding, or new `fsync` durability protocol.
- No change to existing backup contents, schema support, table counts,
  migration dry-run, artifact checks, or rollback behavior.
- No historical implementation-plan rewrite. Only current product and
  architecture documentation changes.

### Baseline evidence

- Starting base: `2ce6a05e2111b566dd4c1d5648d7c17882e0873b` on clean
  `main`, equal to `origin/main`.
- `.codegraph/` exists, but neither the CodeGraph CLI nor a callable CodeGraph
  MCP tool is available. Inspection uses `rg` and direct source reads without
  initializing or modifying the index.
- Focused backup characterization:

  ```bash
  bun --filter @deploykit/server test \
    tests/services/backupService.test.ts \
    tests/services/backupRestoreSafety.test.ts
  ```

  Baseline: `107 pass`, `0 fail`.
- `bun run --filter @deploykit/server typecheck` passes.
- `apps/server/tests/services/ops.test.ts` baseline: `2 pass`, `0 fail`.
- Read-only ownership audit ran runtime, backup, and ops tests together:
  `80 pass`, `0 fail`.
- Audit found one managed production writer bypass: `ops gc` calls
  `collectStorageGarbage` without runtime ownership. Production server startup
  reconciliation already runs under `createDeployKitRuntime` ownership.

## File responsibility map

- `apps/server/src/services/backupFailure.ts`: server-private representation
  and best-effort attachment of backup cleanup/release secondary failures.
- `apps/server/src/services/backupSnapshot.ts`: destination safety, SQLite
  snapshot, artifact-tree copy, manifest creation, prepared verification,
  atomic publish, and temporary-tree cleanup.
- `apps/server/src/services/backupService.ts`: public facade and explicit
  backup ownership orchestration; restore remains delegated unchanged.
- `apps/server/src/services/backupTypes.ts`: server-private deterministic
  backup temporary-path ID and cleanup fault-injection seams; public service
  contracts stay unchanged.
- `apps/server/src/services/runtimeOwnership.ts`: existing lock protocol and
  stable contention diagnostic only.
- `apps/server/src/cli/ops.ts`: command grammar and managed operational
  ownership participation.
- `apps/server/tests/services/backupFailure.test.ts`: direct frozen/extensible
  error metadata contract.
- `apps/server/tests/services/backupService.test.ts`: real ownership and
  destination/lifecycle behavior.
- `apps/server/tests/services/ops.test.ts`: real subprocess CLI grammar and
  ownership contention.
- `apps/server/tests/api/ciProductionProcessSmoke.test.ts`: live production
  server rejects backup; stopped server accepts the same operation.

---

## Task 1: Enforce the backup ownership lifecycle and destination boundary

**Files:**

- Create: `apps/server/src/services/backupFailure.ts`
- Create: `apps/server/tests/services/backupFailure.test.ts`
- Modify: `apps/server/src/services/backupSnapshot.ts`
- Modify: `apps/server/src/services/backupService.ts`
- Modify: `apps/server/src/services/backupTypes.ts`
- Modify: `apps/server/tests/services/backupService.test.ts`
- Modify: `apps/server/tests/services/backupRestoreSafety.test.ts` (only the
  five stale post-fixture sidecar assertions described below)

**Ownership:** The implementer owns only these seven files. Other agents may be
reviewing the same checkout; do not revert or overwrite their work.

**Interfaces:**

- Consumes: `BackupServiceDependencies.acquireOwnership`,
  `acquireRuntimeOwnership(databaseFile, storageDir)`,
  `RuntimeResourceLayout`, `canonicalizeResourcePath`,
  `runtimePathsOverlap`, and `pathEntryExistsNoFollow`.
- Produces:

  ```ts
  export interface BackupSecondaryFailure {
    step: 'cleanup-temporary' | 'release';
    resource: string;
    error: unknown;
  }

  export function attachBackupSecondaryFailures(
    primaryError: unknown,
    newFailures: readonly BackupSecondaryFailure[]
  ): void;

  export const BACKUP_OUTPUT_LAYOUT_UNSAFE =
    'BACKUP_OUTPUT_LAYOUT_UNSAFE';

  export function assertBackupDestinationSafe(
    destination: string,
    layout: RuntimeResourceLayout
  ): void;

  // Add only to server-private BackupServiceDependencies.
  createBackupTemporaryId?: () => string;
  removeBackupTemporaryPath?: (temporaryPath: string) => void;
  ```

- `backupFailure.ts` and the destination helper remain server-private and are
  not re-exported by `backupService.ts`, package exports, shared contracts, or
  Hono types.

- [ ] **Step 1: Write direct and lifecycle failing tests first**

Create `backupFailure.test.ts` with four direct cases:

1. an extensible initiating `Error` retains its identity and previous `cause`,
   receives ordered `backupSecondaryFailures`, and gets an `AggregateError`
   cause containing the underlying secondary errors;
2. a second attachment appends rather than replaces the first failure;
3. a frozen initiating `Error` and a primitive thrown value never cause the
   attachment helper itself to throw;
4. hostile pre-existing metadata whose same-name property is non-array, whose
   getter throws, or whose element has a throwing `error` getter never escapes
   the helper or masks the initiating error.

Add these real behavior cases to `backupService.test.ts`:

1. a held real `acquireRuntimeOwnership` makes `createBackup` throw
   `RUNTIME_OWNERSHIP_HELD`, creates neither destination nor `.tmp-*`, and the
   same backup succeeds after the holder releases;
2. a custom `createTemporaryRoot` attempts a second real ownership acquisition
   during prepared-backup verification and observes `RUNTIME_OWNERSHIP_HELD`;
   after final publish, a new acquisition succeeds;
3. a `now()` callback that throws after snapshot/copy proves the real ownership
   wrapper releases exactly once on failure and leaves no final/temp backup;
4. a successful backup whose injected `release()` throws reports that release
   error while retaining the already-published destination;
5. a backup whose `now()` throws a known initiating Error, whose narrow backup
   temporary remover throws, and whose release also throws rethrows the
   identical initiating Error; ordered `backupSecondaryFailures` must be
   `cleanup-temporary` then `release`, release runs once, destination is absent,
   and the test manually removes the intentionally retained temp tree;
6. a destination below live storage fails with
   `BACKUP_OUTPUT_LAYOUT_UNSAFE` before ownership or target mutation;
7. a dangling destination symlink is rejected as an existing destination and
   is neither followed nor replaced;
8. an injected real `acquireOwnership` creates the destination entry only after
   obtaining both locks; the lock-internal recheck rejects before snapshot/temp
   creation, releases exactly once, and preserves the injected destination for
   explicit test cleanup;
9. a fixed `createBackupTemporaryId` makes the derived temporary sibling equal
   a configured runtime resource; the temporary-path check rejects with
   `BACKUP_OUTPUT_LAYOUT_UNSAFE` before `mkdirSync` or source open;
10. a temporary ID containing `/`, `\\`, or `..` is rejected with
    `BACKUP_OUTPUT_LAYOUT_UNSAFE` before any output mutation.

Use a helper that lists `dirname(destination)` and matches
`${basename(destination)}.tmp-` to prove no temporary sibling remains. Do not
use fixed sleeps or timing races. For release-failure cases, wrap a real
`acquireRuntimeOwnership` result, call its real `release()` first, then throw
the injected release error; assert a fresh real acquisition succeeds afterward
so the tests cannot pass with a leaked kernel lock. Make case 9 deterministic
by allowing the test fixture helper an optional storage-directory override,
setting destination to `join(tempDir, 'backup-output')`, storage to
`${destination}.tmp-fixed`, and temporary ID to `fixed`, then removing that
populated storage directory before invoking backup. The final destination is a
sibling of the configured missing storage path, while the derived temporary
path equals that runtime resource and must fail the overlap check.

Add `lstatSync` and `readdirSync` to the existing `node:fs` import, change the
existing path import to `{ basename, dirname, join }`, and import
`BACKUP_OUTPUT_LAYOUT_UNSAFE` directly from the private snapshot module. Change
only the fixture signature to
`createFixture(tempDir: string, storageDir = join(tempDir, 'storage'))` and
remove its old inner `const storageDir = ...` declaration; retain the rest of
the established fixture body. Then add these executable shared helpers:

```ts
function backupTemporarySiblings(destination: string): string[] {
  const parent = dirname(destination);
  if (!existsSync(parent)) return [];
  const prefix = `${basename(destination)}.tmp-`;
  return readdirSync(parent).filter((name) => name.startsWith(prefix));
}

function captureThrown(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to throw');
}
```

Create `backupFailure.test.ts` from this executable contract:

```ts
import { expect, test } from 'bun:test';
import {
  attachBackupSecondaryFailures,
  type BackupSecondaryFailure,
} from '../../src/services/backupFailure';

const cleanupFailure: BackupSecondaryFailure = {
  step: 'cleanup-temporary',
  resource: '/backup.tmp-test',
  error: new Error('cleanup failed'),
};
const releaseFailure: BackupSecondaryFailure = {
  step: 'release',
  resource: 'runtime-ownership',
  error: new Error('release failed'),
};

test('attaches ordered backup secondary failures without replacing identity or prior cause', () => {
  const priorCause = new Error('prior cause');
  const primary = new Error('primary', { cause: priorCause }) as Error & {
    backupSecondaryFailures?: BackupSecondaryFailure[];
  };
  attachBackupSecondaryFailures(primary, [cleanupFailure, releaseFailure]);
  expect(primary.backupSecondaryFailures).toEqual([
    cleanupFailure,
    releaseFailure,
  ]);
  expect(primary.cause).toBeInstanceOf(AggregateError);
  expect((primary.cause as AggregateError).errors).toEqual([
    cleanupFailure.error,
    releaseFailure.error,
  ]);
  expect((primary.cause as AggregateError & { cause?: unknown }).cause).toBe(
    priorCause
  );
});

test('appends a later backup secondary failure', () => {
  const primary = new Error('primary') as Error & {
    backupSecondaryFailures?: BackupSecondaryFailure[];
  };
  attachBackupSecondaryFailures(primary, [cleanupFailure]);
  attachBackupSecondaryFailures(primary, [releaseFailure]);
  expect(primary.backupSecondaryFailures).toEqual([
    cleanupFailure,
    releaseFailure,
  ]);
});

test('does not throw for frozen errors or primitive initiating values', () => {
  expect(() =>
    attachBackupSecondaryFailures(Object.freeze(new Error('frozen')), [
      cleanupFailure,
    ])
  ).not.toThrow();
  expect(() =>
    attachBackupSecondaryFailures('primitive-primary', [cleanupFailure])
  ).not.toThrow();
});

test('does not escape hostile existing backup metadata', () => {
  const nonArray = new Error('non-array');
  Object.defineProperty(nonArray, 'backupSecondaryFailures', {
    configurable: true,
    writable: true,
    value: 'hostile',
  });
  const throwingGetter = new Error('throwing getter');
  Object.defineProperty(throwingGetter, 'backupSecondaryFailures', {
    get() {
      throw new Error('metadata getter failed');
    },
  });
  const throwingElement = new Error('throwing element');
  Object.defineProperty(throwingElement, 'backupSecondaryFailures', {
    configurable: true,
    writable: true,
    value: [
      Object.defineProperty({}, 'error', {
        get() {
          throw new Error('element getter failed');
        },
      }),
    ],
  });
  for (const primary of [nonArray, throwingGetter, throwingElement]) {
    expect(() =>
      attachBackupSecondaryFailures(primary, [cleanupFailure])
    ).not.toThrow();
  }
});
```

The ten service regressions must use these exact test names and assertion
contracts; the full bodies below intentionally reuse the file's established
`mkdtempSync` plus `try/finally rmSync(tempDir)` pattern:

```ts
test('backup refuses a live owner and succeeds immediately after release', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-backup-owner-'));
  try {
    const fixture = createFixture(tempDir);
    const destination = join(tempDir, 'backup-output');
    const service = createBackupService(fixture);
    const holder = acquireRuntimeOwnership(
      fixture.databaseFile,
      fixture.storageDir
    );
    try {
      expect(() => service.createBackup(destination)).toThrow(
        'RUNTIME_OWNERSHIP_HELD'
      );
      expect(existsSync(destination)).toBe(false);
      expect(backupTemporarySiblings(destination)).toEqual([]);
    } finally {
      holder.release();
    }
    expect(service.createBackup(destination).formatVersion).toBe(1);
    expect(existsSync(destination)).toBe(true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('backup owns runtime through prepared verification and publish', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-backup-interval-'));
  try {
    const fixture = createFixture(tempDir);
    const destination = join(tempDir, 'backup-output');
    let verificationObservedContention = false;
    const service = createBackupService(fixture, {
      createTemporaryRoot(prefix) {
        expect(() =>
          acquireRuntimeOwnership(fixture.databaseFile, fixture.storageDir)
        ).toThrow('RUNTIME_OWNERSHIP_HELD');
        verificationObservedContention = true;
        return mkdtempSync(join(tempDir, prefix));
      },
    });
    service.createBackup(destination);
    expect(verificationObservedContention).toBe(true);
    const afterPublish = acquireRuntimeOwnership(
      fixture.databaseFile,
      fixture.storageDir
    );
    afterPublish.release();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('backup releases ownership and removes output after a primary failure', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-backup-primary-'));
  try {
    const fixture = createFixture(tempDir);
    const destination = join(tempDir, 'backup-output');
    const primary = new Error('injected now failure');
    let releases = 0;
    const service = createBackupService(fixture, {
      now() {
        throw primary;
      },
      acquireOwnership(databaseFile, storageDir) {
        const real = acquireRuntimeOwnership(databaseFile, storageDir);
        return {
          release() {
            releases += 1;
            real.release();
          },
        };
      },
    });
    expect(captureThrown(() => service.createBackup(destination))).toBe(primary);
    expect(releases).toBe(1);
    expect(existsSync(destination)).toBe(false);
    expect(backupTemporarySiblings(destination)).toEqual([]);
    const retry = acquireRuntimeOwnership(
      fixture.databaseFile,
      fixture.storageDir
    );
    retry.release();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('successful backup reports release failure after publishing destination', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-backup-release-'));
  try {
    const fixture = createFixture(tempDir);
    const destination = join(tempDir, 'backup-output');
    const releaseError = new Error('injected release failure');
    let releases = 0;
    const service = createBackupService(fixture, {
      acquireOwnership(databaseFile, storageDir) {
        const real = acquireRuntimeOwnership(databaseFile, storageDir);
        return {
          release() {
            releases += 1;
            real.release();
            throw releaseError;
          },
        };
      },
    });
    expect(captureThrown(() => service.createBackup(destination))).toBe(
      releaseError
    );
    expect(releases).toBe(1);
    expect(existsSync(destination)).toBe(true);
    const retry = acquireRuntimeOwnership(
      fixture.databaseFile,
      fixture.storageDir
    );
    retry.release();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('backup preserves primary error and orders cleanup then release failures', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-backup-secondary-'));
  try {
    const fixture = createFixture(tempDir);
    const destination = join(tempDir, 'backup-output');
    const primary = new Error('primary failure') as Error & {
      backupSecondaryFailures?: Array<{ step: string; error: unknown }>;
    };
    const cleanupError = new Error('cleanup failure');
    const releaseError = new Error('release failure');
    let releases = 0;
    const service = createBackupService(fixture, {
      now() {
        throw primary;
      },
      removeBackupTemporaryPath() {
        throw cleanupError;
      },
      acquireOwnership(databaseFile, storageDir) {
        const real = acquireRuntimeOwnership(databaseFile, storageDir);
        return {
          release() {
            releases += 1;
            real.release();
            throw releaseError;
          },
        };
      },
    });
    expect(captureThrown(() => service.createBackup(destination))).toBe(primary);
    expect(releases).toBe(1);
    expect(primary.backupSecondaryFailures?.map((failure) => failure.step)).toEqual([
      'cleanup-temporary',
      'release',
    ]);
    expect(primary.backupSecondaryFailures?.map((failure) => failure.error)).toEqual([
      cleanupError,
      releaseError,
    ]);
    expect(existsSync(destination)).toBe(false);
    const retained = backupTemporarySiblings(destination);
    expect(retained).toHaveLength(1);
    rmSync(join(dirname(destination), retained[0]), {
      recursive: true,
      force: true,
    });
    const retry = acquireRuntimeOwnership(
      fixture.databaseFile,
      fixture.storageDir
    );
    retry.release();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
```

Continue the same code block with cases 6-10:

```ts
test('backup destination cannot be inside artifact storage', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-backup-overlap-'));
  try {
    const fixture = createFixture(tempDir);
    const destination = join(fixture.storageDir, 'backup-output');
    let acquisitions = 0;
    const service = createBackupService(fixture, {
      acquireOwnership() {
        acquisitions += 1;
        throw new Error('overlap must fail before ownership');
      },
    });
    expect(() => service.createBackup(destination)).toThrow(
      BACKUP_OUTPUT_LAYOUT_UNSAFE
    );
    expect(acquisitions).toBe(0);
    expect(existsSync(destination)).toBe(false);
    expect(backupTemporarySiblings(destination)).toEqual([]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('backup rejects and preserves a dangling destination symlink', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-backup-symlink-'));
  try {
    const fixture = createFixture(tempDir);
    const destination = join(tempDir, 'backup-output');
    symlinkSync(join(tempDir, 'missing-target'), destination);
    expect(() =>
      createBackupService(fixture).createBackup(destination)
    ).toThrow('Backup destination already exists');
    expect(lstatSync(destination).isSymbolicLink()).toBe(true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('backup rechecks destination after ownership acquisition', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-backup-recheck-'));
  try {
    const fixture = createFixture(tempDir);
    const destination = join(tempDir, 'backup-output');
    let releases = 0;
    const service = createBackupService(fixture, {
      acquireOwnership(databaseFile, storageDir) {
        const real = acquireRuntimeOwnership(databaseFile, storageDir);
        mkdirSync(destination);
        return {
          release() {
            releases += 1;
            real.release();
          },
        };
      },
    });
    expect(() => service.createBackup(destination)).toThrow(
      'Backup destination already exists'
    );
    expect(releases).toBe(1);
    expect(existsSync(destination)).toBe(true);
    expect(backupTemporarySiblings(destination)).toEqual([]);
    const retry = acquireRuntimeOwnership(
      fixture.databaseFile,
      fixture.storageDir
    );
    retry.release();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('backup rejects a derived temporary path that equals a runtime resource', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-backup-temp-overlap-'));
  try {
    const destination = join(tempDir, 'backup-output');
    const storageDir = `${destination}.tmp-fixed`;
    const fixture = createFixture(tempDir, storageDir);
    rmSync(storageDir, { recursive: true, force: true });
    const service = createBackupService(fixture, {
      createBackupTemporaryId: () => 'fixed',
    });
    expect(() => service.createBackup(destination)).toThrow(
      BACKUP_OUTPUT_LAYOUT_UNSAFE
    );
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(storageDir)).toBe(false);
    const retry = acquireRuntimeOwnership(
      fixture.databaseFile,
      fixture.storageDir
    );
    retry.release();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('backup rejects unsafe temporary identifiers before output mutation', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-backup-temp-id-'));
  try {
    const fixture = createFixture(tempDir);
    const destination = join(tempDir, 'backup-output');
    for (const temporaryId of ['nested/path', 'windows\\path', '..']) {
      const service = createBackupService(fixture, {
        createBackupTemporaryId: () => temporaryId,
      });
      expect(() => service.createBackup(destination)).toThrow(
        BACKUP_OUTPUT_LAYOUT_UNSAFE
      );
      expect(existsSync(destination)).toBe(false);
      expect(backupTemporarySiblings(destination)).toEqual([]);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
```

**GREEN-phase characterization correction:** `createRestoreFixture()` creates
its backup through the production `createBackup`, so this task intentionally
leaves the two released SQLite ownership sidecar files available for reuse.
The focused restore-safety gate previously had five stale assertions that those
fixture sidecars did not exist. Do not unlink them: unlinking a released lock
database would create a sidecar replacement race. In only these tests, replace
the original-pair absence assertions with `true` and then prove the pair can be
reacquired and released immediately:

- `restore rejects rollback control roots equal to or above live storage before mutation`;
- `restore rejects a live-storage ancestor of the rollback root without mutation`;
- `restore rejects dangling control symlinks before ownership or mutation`;
- `verify and restore reject a symlinked backup database before ownership or mutation`;
- `restore revalidates and cleans a replaced database stage before moving live state`.

Add this helper and call it at each replaced assertion site:

```ts
import { acquireRuntimeOwnership } from '../../src/services/runtimeOwnership';

function assertRuntimeOwnershipAvailable(fixture: {
  databaseFile: string;
  storageDir: string;
}): void {
  expect(existsSync(`${fixture.databaseFile}.runtime-lock.sqlite`)).toBe(true);
  expect(existsSync(`${fixture.storageDir}.runtime-lock.sqlite`)).toBe(true);
  const ownership = acquireRuntimeOwnership(
    fixture.databaseFile,
    fixture.storageDir
  );
  ownership.release();
}
```

Keep assertions for sidecars derived from deliberately unsafe alternate
`storageDir` values as `false`; only the original fixture pair is persistent.
This correction changes no restore implementation or restore failure ordering.

- [ ] **Step 2: Run the new tests and confirm RED**

```bash
bun test apps/server/tests/services/backupFailure.test.ts \
  apps/server/tests/services/backupService.test.ts
```

Expected failures: `backupFailure.ts` and `BACKUP_OUTPUT_LAYOUT_UNSAFE` do not
exist; live ownership still permits
the current backup path.

- [ ] **Step 3: Add the server-private backup failure leaf**

Implement `attachBackupSecondaryFailures` with the same primary-authority
discipline already used by restore, but with backup-specific metadata:

```ts
export interface BackupSecondaryFailure {
  step: 'cleanup-temporary' | 'release';
  resource: string;
  error: unknown;
}

type ErrorWithBackupSecondaryFailures = Error & {
  cause?: unknown;
  backupSecondaryFailures?: BackupSecondaryFailure[];
};

export function attachBackupSecondaryFailures(
  primaryError: unknown,
  newFailures: readonly BackupSecondaryFailure[]
): void {
  try {
    if (!(primaryError instanceof Error) || newFailures.length === 0) return;
    const target = primaryError as ErrorWithBackupSecondaryFailures;
    let existingValue: unknown;
    let previousCause: unknown;
    try {
      existingValue = target.backupSecondaryFailures;
    } catch {
      // The initiating error remains authoritative.
    }
    try {
      previousCause = target.cause;
    } catch {
      // The initiating error remains authoritative.
    }
    const existing = Array.isArray(existingValue) ? existingValue : [];
    const failures = [...existing, ...newFailures];
    try {
      target.backupSecondaryFailures = failures;
    } catch {
      // Metadata is best effort for frozen/hostile Error objects.
    }
    const secondaryErrors: unknown[] = [];
    for (const failure of failures) {
      try {
        secondaryErrors.push(failure?.error);
      } catch (metadataError) {
        secondaryErrors.push(metadataError);
      }
    }
    const aggregate = new AggregateError(
      secondaryErrors,
      'Backup encountered secondary cleanup failures'
    );
    if (previousCause !== undefined) {
      (aggregate as AggregateError & { cause?: unknown }).cause = previousCause;
    }
    try {
      target.cause = aggregate;
    } catch {
      // Never replace the initiating failure with metadata assignment.
    }
  } catch {
    // All bookkeeping is best effort; the initiating error stays authoritative.
  }
}
```

- [ ] **Step 4: Add no-follow destination safety and cleanup authority**

In `backupSnapshot.ts`, implement `assertBackupDestinationSafe` before any
backup directory creation:

```ts
export const BACKUP_OUTPUT_LAYOUT_UNSAFE = 'BACKUP_OUTPUT_LAYOUT_UNSAFE';

export function assertBackupDestinationSafe(
  destination: string,
  layout: RuntimeResourceLayout
): void {
  if (pathEntryExistsNoFollow(destination)) {
    throw new Error(`Backup destination already exists: ${destination}`);
  }
  assertBackupOutputDoesNotOverlap(destination, 'destination', layout);
}

function assertBackupTemporaryPathSafe(
  temporaryPath: string,
  layout: RuntimeResourceLayout
): void {
  if (pathEntryExistsNoFollow(temporaryPath)) {
    throw new Error(`Backup temporary path already exists: ${temporaryPath}`);
  }
  assertBackupOutputDoesNotOverlap(temporaryPath, 'temporary path', layout);
}

function assertBackupOutputDoesNotOverlap(
  outputPath: string,
  outputLabel: 'destination' | 'temporary path',
  layout: RuntimeResourceLayout
): void {
  const canonicalOutput = canonicalizeResourcePath(outputPath);
  const overlap = layout.resources.find((resource) =>
    runtimePathsOverlap(canonicalOutput, resource.path)
  );
  if (overlap) {
    throw new Error(
      `[${BACKUP_OUTPUT_LAYOUT_UNSAFE}] Backup ${outputLabel} overlaps runtime resource ${overlap.name}`
    );
  }
}
```

Call it both from the facade's lock-free preflight and again at the beginning
of `createBackupSnapshotAt` after ownership acquisition. Add one optional
internal temporary-ID input and one optional temporary-remover input to the
snapshot function. Wire them from `BackupServiceDependencies`, default the ID
to `createId()` and removal to the current recursive force removal. Immediately
after deriving `${destination}.tmp-${temporaryId}`, call
`assertBackupTemporaryPathSafe` before `mkdirSync` or source database open.
These seams exist only for deterministic failure testing and are not a
`BackupService`/CLI/API export. Replace the snapshot catch block with
primary-preserving cleanup:

```ts
interface CreateBackupSnapshotInput {
  destination: string;
  layout: RuntimeResourceLayout;
  now: () => Date;
  createTemporaryId?: () => string;
  removeTemporaryPath?: (temporaryPath: string) => void;
  verifyPreparedBackup: (backupPath: string) => BackupVerificationReport;
}
```

Use that exact input shape on the existing function declaration as
`createBackupSnapshotAt(input: CreateBackupSnapshotInput): BackupManifest`,
derive and validate the temporary path with:

```ts
const temporaryId = input.createTemporaryId?.() ?? createId();
if (!/^[A-Za-z0-9_-]+$/.test(temporaryId)) {
  throw new Error(
    `[${BACKUP_OUTPUT_LAYOUT_UNSAFE}] Backup temporary identifier must be a safe path segment`
  );
}
const temporaryPath = `${destination}.tmp-${temporaryId}`;
assertBackupTemporaryPathSafe(temporaryPath, layout);
```

Then replace its catch block with:

```ts
} catch (error) {
  try {
    (
      input.removeTemporaryPath ??
      ((path: string) => rmSync(path, { recursive: true, force: true }))
    )(temporaryPath);
  } catch (cleanupError) {
    attachBackupSecondaryFailures(error, [
      {
        step: 'cleanup-temporary',
        resource: temporaryPath,
        error: cleanupError,
      },
    ]);
  }
  throw error;
}
```

- [ ] **Step 5: Add the explicit backup-local ownership lifecycle**

In `backupService.ts`, keep pure preflight before acquisition, then use the
existing dependency seam or production function. Re-check leaves, database
existence, and destination inside ownership before snapshot creation.

Use a discriminated outcome so an `undefined` thrown value is still a real
failure and `release()` is called exactly once. Add `BackupManifest` to the
existing type-only import from `backupTypes.ts`:

```ts
type BackupOutcome =
  | { kind: 'success'; manifest: BackupManifest }
  | { kind: 'failure'; error: unknown };

createBackup(destination) {
  const layout = resolveRuntimeResourceLayout(
    config.databaseFile,
    config.storageDir
  );
  assertRuntimeResourceLeavesSafe(layout);
  if (!existsSync(layout.databaseFile)) {
    throw new Error(`Database does not exist: ${layout.databaseFile}`);
  }
  assertBackupDestinationSafe(destination, layout);

  const ownership = (
    dependencies.acquireOwnership ?? acquireRuntimeOwnership
  )(layout.databaseFile, layout.storageDir);
  let outcome: BackupOutcome;
  try {
    assertRuntimeResourceLeavesSafe(layout);
    if (!existsSync(layout.databaseFile)) {
      throw new Error(`Database does not exist: ${layout.databaseFile}`);
    }
    assertBackupDestinationSafe(destination, layout);
    outcome = {
      kind: 'success',
      manifest: createBackupSnapshotAt({
        destination,
        layout,
        now,
        createTemporaryId: dependencies.createBackupTemporaryId,
        removeTemporaryPath: dependencies.removeBackupTemporaryPath,
        verifyPreparedBackup: (path) => verifyBackupAt(path, dependencies),
      }),
    };
  } catch (error) {
    outcome = { kind: 'failure', error };
  }

  try {
    ownership.release();
  } catch (releaseError) {
    if (outcome.kind === 'success') throw releaseError;
    attachBackupSecondaryFailures(outcome.error, [
      {
        step: 'release',
        resource: 'runtime-ownership',
        error: releaseError,
      },
    ]);
  }

  if (outcome.kind === 'failure') throw outcome.error;
  return outcome.manifest;
}
```

Do not introduce a shared `withRuntimeOwnership` orchestration helper and do
not touch restore. Server shutdown intentionally retains locks on failed drain;
restore releases only after compensation; backup has a different synchronous
cleanup sequence.

- [ ] **Step 6: Run focused implementation gates**

```bash
bun test apps/server/tests/services/backupFailure.test.ts
bun --filter @deploykit/server test \
  tests/services/backupService.test.ts \
  tests/services/backupRestoreSafety.test.ts
bun run --filter @deploykit/server typecheck
bun x biome check \
  apps/server/src/services/backupFailure.ts \
  apps/server/src/services/backupSnapshot.ts \
  apps/server/src/services/backupService.ts \
  apps/server/src/services/backupTypes.ts \
  apps/server/tests/services/backupFailure.test.ts \
  apps/server/tests/services/backupService.test.ts
git diff --check
```

Expected: direct failure tests and every backup/restore characterization pass;
no public export or restore-order change.

- [ ] **Step 7: Independent review and commit**

Review the exact acquire/recheck/open/snapshot/copy/verify/publish/cleanup/
release order, no-follow destination behavior, primary identity, frozen Error
behavior, real lock contention, and server-private export surface. Fix every
Critical/Important finding before commit.

```bash
git add apps/server/src/services/backupFailure.ts \
  apps/server/src/services/backupSnapshot.ts \
  apps/server/src/services/backupService.ts \
  apps/server/src/services/backupTypes.ts \
  apps/server/tests/services/backupFailure.test.ts \
  apps/server/tests/services/backupService.test.ts \
  apps/server/tests/services/backupRestoreSafety.test.ts
git commit -m "feat: enforce offline backup ownership"
```

## Task 2: Close managed CLI bypasses and make backup grammar fail closed

**Files:**

- Modify: `apps/server/src/services/runtimeOwnership.ts`
- Modify: `apps/server/src/cli/ops.ts`
- Modify: `apps/server/tests/services/ops.test.ts`
- Test: `apps/server/tests/services/runtime.test.ts`

**Ownership:** The implementer owns only the three modified files and may run
the existing runtime tests read-only. Do not edit backup internals, process
smoke, or documentation in this task.

**Interfaces:**

- Consumes: Task 1's `BackupService.createBackup` ownership behavior and the
  existing `withOperationalOwnership` function.
- Produces: `backup` accepts exactly zero or one non-flag positional argument;
  `gc` and `gc --dry-run` both execute inside `withOperationalOwnership`; the
  stable `RUNTIME_OWNERSHIP_HELD` diagnostic includes a stop-and-retry action.

- [ ] **Step 1: Write CLI subprocess regressions first**

In `ops.test.ts`, keep command execution in the per-test temporary directory so
an intentionally failing parser test cannot create a `--force` path in the
repository. Add tests that prove:

1. held real ownership rejects `backup <temp-destination>`, leaves stdout empty,
   includes `RUNTIME_OWNERSHIP_HELD` and `Stop the DeployKit server and other
   operational commands before retrying` in stderr, and creates no destination;
2. held ownership rejects both `gc --dry-run` and `gc` with the same stable
   contention code;
3. `backup --force`, `backup <destination> --force`, and
   `backup <destination> extra` all exit non-zero with stdout empty and the
   exact usage message
   `backup accepts zero or one destination path and no flags`;
4. after release, offline backup retains the existing successful JSON keys
   `command`, `destination`, and `manifest`, and a new ownership acquisition
   succeeds after process exit.

Apply these exact test helpers and bodies. `spawnOps` uses the database's
temporary parent as `cwd`, so invalid relative destinations cannot escape the
fixture. Prove zero-argument grammar by running it against a held runtime and
requiring the ownership diagnostic; this reaches backup execution without
publishing into the shared default `apps/server/.voasx/backups` root. Prove the
successful JSON shape with a one-positional destination wholly inside the test
root.

```ts
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const repositoryRoot = join(import.meta.dir, '..', '..', '..', '..');

function createOpsFixture(name: string): {
  databaseFile: string;
  storageDir: string;
} {
  const caseDir = join(tempDir, name);
  const databaseFile = join(caseDir, 'deploykit.sqlite');
  const storageDir = join(caseDir, 'storage');
  createSqliteProjectRepository({ databaseFile }).load();
  return { databaseFile, storageDir };
}

function backupTemporarySiblings(destination: string): string[] {
  const parent = dirname(destination);
  if (!existsSync(parent)) return [];
  const prefix = `${basename(destination)}.tmp-`;
  return readdirSync(parent).filter((name) => name.startsWith(prefix));
}

function expectOwnershipContention(
  result: ReturnType<typeof spawnOps>
): void {
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout.toString()).toBe('');
  expect(result.stderr.toString()).toContain(RUNTIME_OWNERSHIP_HELD);
  expect(result.stderr.toString()).toContain(
    'Stop the DeployKit server and other operational commands before retrying'
  );
}

function expectBackupJson(
  result: ReturnType<typeof spawnOps>,
  expectedDestination?: string
): Record<string, unknown> {
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe('');
  const body = JSON.parse(result.stdout.toString()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual([
    'command',
    'destination',
    'manifest',
  ]);
  expect(body.command).toBe('backup');
  if (expectedDestination) expect(body.destination).toBe(expectedDestination);
  expect(body.manifest).toEqual(expect.any(Object));
  return body;
}

test('backup rejects held runtime ownership without writing its destination', () => {
  const { databaseFile, storageDir } = createOpsFixture('held-backup');
  const destination = join(tempDir, 'held-backup-output');
  const ownership = acquireRuntimeOwnership(databaseFile, storageDir);
  try {
    expectOwnershipContention(spawnOps(databaseFile, 'backup', destination));
    expect(existsSync(destination)).toBe(false);
    expect(backupTemporarySiblings(destination)).toEqual([]);
  } finally {
    ownership.release();
  }
});

for (const arguments_ of [['gc', '--dry-run'], ['gc']] as const) {
  test(`${arguments_.join(' ')} rejects held runtime ownership`, () => {
    const { databaseFile, storageDir } = createOpsFixture(arguments_.join('-'));
    const ownership = acquireRuntimeOwnership(databaseFile, storageDir);
    try {
      expectOwnershipContention(spawnOps(databaseFile, ...arguments_));
    } finally {
      ownership.release();
    }
  });
}

test('backup rejects flags and extra positional arguments before output', () => {
  const { databaseFile } = createOpsFixture('backup-grammar');
  const destination = join(tempDir, 'backup-grammar-output');
  for (const [arguments_, wouldBeDestination] of [
    [['backup', '--force'], join(dirname(databaseFile), '--force')],
    [['backup', destination, '--force'], destination],
    [['backup', destination, 'extra'], destination],
  ] as const) {
    const result = spawnOps(databaseFile, ...arguments_);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString()).toContain(
      'backup accepts zero or one destination path and no flags'
    );
    expect(existsSync(wouldBeDestination)).toBe(false);
    expect(backupTemporarySiblings(wouldBeDestination)).toEqual([]);
  }
});

test('backup accepts zero positional arguments before ownership validation', () => {
  const { databaseFile, storageDir } = createOpsFixture('default-backup');
  const ownership = acquireRuntimeOwnership(databaseFile, storageDir);
  try {
    expectOwnershipContention(spawnOps(databaseFile, 'backup'));
  } finally {
    ownership.release();
  }
});

test('backup accepts one positional destination and releases ownership', () => {
  const { databaseFile, storageDir } = createOpsFixture('explicit-backup');
  const destination = join(tempDir, 'explicit-backup-output');
  expectBackupJson(spawnOps(databaseFile, 'backup', destination), destination);
  expect(existsSync(destination)).toBe(true);
  const ownership = acquireRuntimeOwnership(databaseFile, storageDir);
  ownership.release();
});

function spawnOps(databaseFile: string, ...args: string[]) {
  return Bun.spawnSync({
    cmd: [
      process.execPath,
      join(repositoryRoot, 'apps', 'server', 'src', 'cli', 'ops.ts'),
      ...args,
    ],
    cwd: dirname(databaseFile),
    env: {
      ...process.env,
      DEPLOYKIT_ENV: 'test',
      DATABASE_FILE: databaseFile,
      DATA_FILE: join(dirname(databaseFile), 'data.json'),
      STORAGE_DIR: join(dirname(databaseFile), 'storage'),
      PUBLIC_DIR: join(dirname(databaseFile), 'public'),
      ARTIFACT_AUDIT_JOB_RETENTION_HOURS: '24',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}
```

- [ ] **Step 2: Run the CLI test and confirm RED**

```bash
bun test apps/server/tests/services/ops.test.ts
```

Expected after Task 1: backup contention already exits non-zero, but the new
actionable stop/retry sentence assertion is RED; GC still bypasses ownership,
and invalid backup arguments are still accepted or silently ignored.

- [ ] **Step 3: Make operational command ownership and grammar explicit**

Add this parser and use it only for the backup command:

```ts
function parseBackupDestination(arguments_: string[]): string | undefined {
  if (
    arguments_.length > 1 ||
    arguments_.some((argument) => argument.startsWith('-'))
  ) {
    throw new Error('backup accepts zero or one destination path and no flags');
  }
  return arguments_[0];
}
```

The first `args` element is the command name. Call the parser at the exact
`case 'backup'` boundary with the command removed, and preserve the existing
default only when the parser returns `undefined`:

```ts
case 'backup': {
  const explicitDestination = parseBackupDestination(args.slice(1));
  const destination =
    explicitDestination ??
    join(
      appDir,
      '.voasx',
      'backups',
      `backup-${formatTimestamp(new Date())}`
    );
  output({
    command,
    destination,
    manifest: backupService.createBackup(destination),
  });
  break;
}
```

Wrap the complete GC report/output lifecycle, including dry-run, in
`withOperationalOwnership`. This is required because `collectStorageGarbage`
always creates the storage root and dry-run still needs a stable managed view.

Extend the existing contention error without changing its stable code or path
diagnostics:

```ts
`[${RUNTIME_OWNERSHIP_HELD}] Runtime resource is already owned: "${path}" for database "${layout.databaseFile}" and storage "${layout.storageDir}". Stop the DeployKit server and other operational commands before retrying.`
```

Update CLI help to say backup, restore, GC, inspect, and audit-prune require an
offline managed resource pair; verify only reads a completed backup. Do not add
automatic stop, wait, retry, `--force`, or `--online` behavior.

- [ ] **Step 4: Run focused ownership and CLI gates**

```bash
bun test apps/server/tests/services/ops.test.ts
bun test apps/server/tests/services/runtime.test.ts
bun run --filter @deploykit/server typecheck
bun x biome check \
  apps/server/src/services/runtimeOwnership.ts \
  apps/server/src/cli/ops.ts \
  apps/server/tests/services/ops.test.ts
git diff --check
```

Expected: all CLI subprocess and existing runtime ownership tests pass; no
successful command JSON shape changes.

- [ ] **Step 5: Independent review and commit**

Review argument indexing, relative path behavior, active-owner exit/stdout/
stderr contract, GC dry-run semantics, release after successful commands, and
unchanged restore `--force` confirmation.

```bash
git add apps/server/src/services/runtimeOwnership.ts \
  apps/server/src/cli/ops.ts \
  apps/server/tests/services/ops.test.ts
git commit -m "fix: close operational ownership bypasses"
```

## Task 3: Prove the production process contract and document operations

**Files:**

- Modify: `apps/server/tests/api/ciProductionProcessSmoke.test.ts`
- Modify: `apps/server/src/app.ts` (documentation comment only)
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/development.md`
- Modify: `docs/backend-hardening-roadmap.md`

**Ownership:** The implementer owns only these six files. Do not change
production backup/ownership logic or historical plans.

**Interfaces:**

- Consumes: Tasks 1-2 stable `RUNTIME_OWNERSHIP_HELD` message, strict backup
  grammar, backup-held ownership, and offline success JSON.
- Produces: one real process smoke assertion and one consistent operational
  contract across current docs.

- [ ] **Step 1: Add a live-server rejection assertion before the existing stop**

Refactor the test-only ops runner into one common primitive that returns
`exitCode`, `stdout`, and `stderr`; keep the existing success wrapper asserting
exit code `0`, and add an expected-failure wrapper that asserts non-zero without
duplicating process lifecycle/timeout cleanup.

Use this exact test-only implementation, moving the exit-code assertions out of
the lifecycle owner while preserving the existing timeout, kill, drain, and
`finally` behavior:

```ts
interface OpsProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function executeOps(
  environment: Record<string, string | undefined>,
  arguments_: string[]
): Promise<OpsProcessResult> {
  const child = Bun.spawn({
    cmd: [process.execPath, 'run', 'ops', '--', ...arguments_],
    cwd: repositoryRoot,
    env: environment,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  activeOpsProcesses.add(child);
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  try {
    const exitCode = await withTimeout(
      child.exited,
      15_000,
      `ops ${arguments_[0] ?? 'unknown'}`
    );
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    return { exitCode, stdout, stderr };
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
    await Promise.allSettled([stdoutPromise, stderrPromise]);
    throw error;
  } finally {
    activeOpsProcesses.delete(child);
  }
}

async function runOps(
  environment: Record<string, string | undefined>,
  arguments_: string[]
): Promise<{ stdout: string; stderr: string }> {
  const result = await executeOps(environment, arguments_);
  expect(
    result.exitCode,
    `ops ${arguments_.join(' ')} failed\n${result.stdout}\n${result.stderr}`
  ).toBe(0);
  return result;
}

async function runOpsExpectFailure(
  environment: Record<string, string | undefined>,
  arguments_: string[]
): Promise<OpsProcessResult> {
  const result = await executeOps(environment, arguments_);
  expect(
    result.exitCode,
    `ops ${arguments_.join(' ')} unexpectedly succeeded\n${result.stdout}\n${result.stderr}`
  ).not.toBe(0);
  return result;
}
```

`executeOps` alone owns spawn registration, the 15-second timeout, stream
draining, kill-on-timeout, and `activeOpsProcesses` cleanup. The two wrappers
only assert exit-code polarity and format assertion context.

Immediately before the backup-adjacent `stopServer(server)` call that currently
precedes `const beforeBackup = inspectAutomationState(...)` in the production
smoke:

1. invoke `backup` against a separate `live-backup` destination while the real
   production server still owns the configured pair;
2. assert non-zero exit, empty stdout, stderr containing
   `RUNTIME_OWNERSHIP_HELD` and the actionable stop/retry sentence;
3. assert neither final destination nor a `.tmp-*` sibling exists;
4. then perform the existing graceful stop and unchanged successful backup,
   verify, restore, and boot sequence.

Add `basename` to the existing `node:path` import and declare this variable
immediately after the existing `backupDir` declaration:

```ts
import { basename, join } from 'node:path';

const liveBackupDir = join(temporaryRoot, 'live-backup');
```

Insert this exact assertion block at the backup-adjacent stop anchor described
above:

```ts
const liveBackup = await runOpsExpectFailure(environment, [
  'backup',
  liveBackupDir,
]);
expect(liveBackup.stdout).toBe('');
expect(liveBackup.stderr).toContain('RUNTIME_OWNERSHIP_HELD');
expect(liveBackup.stderr).toContain(
  'Stop the DeployKit server and other operational commands before retrying'
);
expect(existsSync(liveBackupDir)).toBe(false);
expect(
  readdirSync(temporaryRoot, { withFileTypes: true }).some((entry) =>
    entry.name.startsWith(`${basename(liveBackupDir)}.tmp-`)
  )
).toBe(false);

capturedLogs.push(await stopServer(server));
const beforeBackup = inspectAutomationState(databaseFile, projectId);
```

- [ ] **Step 2: Run the production process integration proof**

```bash
bun test apps/server/tests/api/ciProductionProcessSmoke.test.ts
```

Expected after Tasks 1-2: the live backup fails with the required ownership
diagnostic, then the existing stopped-server backup/verify/restore/boot path
passes. The preflight audit already recorded that the baseline implementation
does not reject the live backup; do not revert Tasks 1-2 merely to recreate RED.

- [ ] **Step 3: Tighten the supported-entry documentation boundary**

Change the `createApp()` JSDoc to state exactly:

```ts
/**
 * Test/internal composition seam. It does not acquire runtime ownership and is
 * unsupported as a production entrypoint. Production callers must use
 * createDeployKitRuntime() so migration, reconciliation, HTTP writes, workers,
 * and shutdown all share the database/storage ownership lifecycle.
 */
```

Do not add a runtime environment check or change its signature; existing Hono
tests deliberately use this seam without opening a production server.

- [ ] **Step 4: Update current product and operations documentation**

Make the following exact contract consistent across the four docs:

- `README.md`: backup requires stopping DeployKit and every unmanaged writer;
  contention is `RUNTIME_OWNERSHIP_HELD`; there is no force bypass; downtime
  ends when the internally verified backup command succeeds, after which the
  service may restart and a separate read-only `verify` may run online.
- `docs/architecture.md`: replace the two-capture-point warning with the
  ownership interval
  `acquire -> leaf/existence recheck -> VACUUM INTO -> storage copy -> manifest
  -> prepared verify/fingerprint -> (atomic destination rename | failed-temp
  cleanup) -> release`; call the result a quiescent, cooperative capture rather than a
  cross-resource atomic instant. Add `backupFailure` to the private backup DAG.
- `docs/development.md`: list backup and GC as ownership participants; describe
  single-host/canonical-pair scope, trusted parent directories, unmanaged writer
  exclusions, and the offline order stop writers -> stop server -> backup ->
  restart -> optional verify.
- `docs/backend-hardening-roadmap.md`: mark only the enforced-offline choice as
  complete. Keep row-level `releases`/`audit_events` validation and the exact
  production round trip pending as the next phase.

Do not claim backup is side-effect-free: ownership sidecars and destination
files are written, and opening a crashed WAL database may perform SQLite
recovery under the lock. Do not rewrite historical plan text.

- [ ] **Step 5: Run integration and documentation gates**

```bash
bun test apps/server/tests/api/ciProductionProcessSmoke.test.ts
bun --filter @deploykit/server test \
  tests/services/backupFailure.test.ts \
  tests/services/backupService.test.ts \
  tests/services/backupRestoreSafety.test.ts \
  tests/services/ops.test.ts \
  tests/services/runtime.test.ts \
  tests/api/storageCrashRecovery.test.ts
bun run --filter @deploykit/server typecheck
bun x biome check \
  apps/server/src/app.ts \
  apps/server/tests/api/ciProductionProcessSmoke.test.ts
if rg -n \
  'createBackup.*不获取 runtime ownership|这两个步骤是不同捕获时点' \
  README.md docs/architecture.md docs/development.md \
  docs/backend-hardening-roadmap.md; then
  exit 1
fi
rg -n 'RUNTIME_OWNERSHIP_HELD' \
  README.md docs/architecture.md docs/development.md \
  docs/backend-hardening-roadmap.md
rg -n 'unmanaged writer|非受管写入|未受管写入' \
  README.md docs/architecture.md docs/development.md
git diff --check
```

Expected: live process rejects backup, stopped process completes existing
backup/verify/restore/boot flow, all focused ownership/recovery tests pass, and
tracked docs contain no stale statement that `createBackup` lacks ownership.

- [ ] **Step 6: Independent review and commit**

Review real-process placement before shutdown, process cleanup/timeouts,
successful flow preservation, `createApp` boundary accuracy, the private DAG,
and every negative operational claim. Fix every Critical/Important finding.

```bash
git add apps/server/tests/api/ciProductionProcessSmoke.test.ts \
  apps/server/src/app.ts \
  README.md \
  docs/architecture.md \
  docs/development.md \
  docs/backend-hardening-roadmap.md
git commit -m "docs: define offline backup operations"
```

## Task 4: Complete validation, whole-range review, and delivery

**Files:**

- Modify: this plan (checkboxes and verified result evidence only)
- Modify: `.superpowers/sdd/progress.md` (ignored execution ledger only)

**Ownership:** The root agent owns plan/progress bookkeeping, final gates,
whole-range review, push, and exact-SHA remote verification. Review/fix agents
must not rewrite unrelated work.

- [ ] **Step 1: Run complete local gates**

```bash
bun run check
bun run verify
npm_config_registry=https://registry.npmjs.org bun run security:audit
git diff --check
git status --short --branch
```

Expected: formatting/lint, secret scan, all workspace typechecks/tests,
production build/package, high-severity dependency audit, and diff-check pass.
Record exact server/client/desktop test counts in this plan and progress ledger.

- [ ] **Step 2: Run two independent whole-range reviews**

From starting base `2ce6a05e2111b566dd4c1d5648d7c17882e0873b`, require:

1. spec-compliance review of every global constraint, exact lifecycle order,
   CLI/process contract, destination boundary, docs, and explicit exclusions;
2. code-quality/security review of lock coverage, primary/secondary failure
   behavior, no-follow paths, managed writer coverage, tests, public exports,
   and any deadlock/early-release/cleanup risk.

Fix every Critical/Important finding in one fix wave, re-run covering tests,
regenerate the review package, and require clean re-review.

- [ ] **Step 3: Commit the reviewed delivery candidate**

```bash
git add docs/superpowers/plans/2026-08-01-offline-consistent-backup-contract.md
git commit -m "docs: record offline backup validation"
```

- [ ] **Step 4: Push and verify the delivery-candidate commit**

```bash
git push origin main
git rev-parse HEAD
git rev-parse origin/main
git ls-remote origin refs/heads/main
```

Wait for both GitHub Actions CI and CodeQL for that exact candidate SHA. Do not
use an earlier commit's checks as evidence.

- [ ] **Step 5: Record remote evidence and commit final plan closure**

After candidate CI and CodeQL pass, update this plan with their exact run URLs,
candidate SHA, local test counts, review verdicts, and completed checkboxes.

```bash
git add docs/superpowers/plans/2026-08-01-offline-consistent-backup-contract.md
git commit -m "docs: close offline backup contract plan"
git push origin main
```

Wait again for both CI and CodeQL on this new plan-closure SHA; these are the
final exact-SHA checks reported to the user.

- [ ] **Step 6: Final cleanliness and next-phase handoff**

Confirm local `HEAD`, `origin/main`, and remote `main` are identical and the
tracked worktree is clean. Record the next phase without starting it here:
row-level `releases`/`audit_events` semantic validation plus exact
backup -> restore -> production boot state equality.
