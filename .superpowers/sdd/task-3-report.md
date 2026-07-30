# Task 3 Implementation Report

## Scope

Replace aggregate artifact-audit queue polling with a dedicated repository that
owns the complete durable queue state machine. Production SQLite must use
row-level transactions and must never fall back to aggregate persistence.

## Phase A — SQLite v5, concurrent claim, live takeover, idle polling

### RED

Command:

```bash
bun test apps/server/tests/services/sqliteArtifactAuditJobRepository.test.ts
```

Initial result: `0 pass / 5 fail`. After adding a compile-only repository
skeleton, failures reached the intended assertions:

- missing v5 active/index definitions;
- unsupported enqueue;
- unsupported recover-and-claim.

### Implementation

- Raised the relational schema to v5.
- Added an explicit backed-up v4-to-v5 migration.
- Added the active partial unique, claim, list, filtered-list, expired-lease and
  terminal-retention indexes.
- Extracted the audit-job SQL row mapper so the aggregate loader and dedicated
  repository share one decoder without an import cycle.
- Added row-level SQLite enqueue and recover-and-claim operations. Each action
  opens one connection and owns one `BEGIN IMMEDIATE` transaction.
- Kept an idle poll read-only after beginning the transaction: no update,
  aggregate hydration or domain upsert occurs when there is no recovery, stale
  transition or claim.

### Evidence

Command:

```bash
bun test apps/server/tests/services/sqliteArtifactAuditJobRepository.test.ts
bun --filter @deploykit/server typecheck
```

Result: repository `5 pass / 0 fail / 39 assertions`; server typecheck passed.

The claim race uses two independent Bun child processes pointing at the same
SQLite file. Each writes a distinct ready marker; the parent waits for both and
then writes one shared start marker. Exactly one process claims the queued job,
and the durable row ends `running` with `attempts = 1`.

Live takeover is performed by a later `recoverAndClaim` poll without restarting
the surviving repository/worker. Twenty empty polls preserve all domain-row
snapshots and the sentinel connection's WAL frame count.

The v4 duplicate-active migration test leaves both legacy rows and migration
version 4 intact while retaining the pre-v5 backup, proving fail-closed rollback.

`bun:sqlite` supports the required mechanics: `transaction(...).immediate()`
wraps each operation in one immediate transaction, and guarded
`UPDATE ... RETURNING` returns the claimed row without a second aggregate load.

## Phase B — admission, lease guards and atomic completion

### RED

The SQLite repository skeleton exposed six intended failures across get/cancel,
heartbeat/fail and completion. The existing aggregate implementation also
rewrote the JSON file during an empty claim, and the worker still invoked the
startup-only lease sweep.

### Implementation

- Added global/requester/project projected admission counts with deduplication
  before limits and net-zero replacement accounting.
- Added scoped get, transactional cancel, guarded heartbeat, fail-or-retry and
  completion to the dedicated repository.
- Added pure transition and completion-record builders shared with the JSON
  aggregate adapter.
- Completion hashes outside SQLite, then validates the lease and current
  project/version checksum, engine and policy before report upsert, history
  append and job success in one immediate transaction.
- Added the aggregate adapter with matching results. Its empty claim performs a
  load-only precheck and skips `mutate`.
- Removed the worker startup sweep. Every poll now calls
  `recoverAndClaim`, which performs live lease recovery and at most one claim.
- Rewired production composition to choose the SQLite job repository explicitly
  and JSON tests to choose the aggregate adapter. SQLite errors have no
  aggregate fallback.

### Evidence

```bash
bun test apps/server/tests/services/sqliteArtifactAuditJobRepository.test.ts \
  apps/server/tests/services/artifactAuditJobService.test.ts \
  apps/server/tests/services/artifactAuditWorker.test.ts
bun --filter @deploykit/server typecheck
```

Result: `27 pass / 0 fail / 121 assertions`; server typecheck passed.

Two concurrent enqueue processes produce one `enqueued` and one `reused`
result. Global, requester and project admission rejections are independently
covered. Replacement at exact capacity succeeds while a rejected replacement
leaves the old active row unchanged.

Cancellation prevents late heartbeat, completion and failure. Retry backoff,
max-attempt and non-retryable failure paths are covered.

A permanent SQLite trigger aborts the `version.audit` history insert. The
exception reaches the trigger and the immediate transaction rolls back: the job
remains running with no report ID, and report/history counts stay zero.

A post-review regression also makes the final lease-guarded job `UPDATE` return
no row via `BEFORE UPDATE ... RAISE(IGNORE)`. The repository now throws an
internal sentinel inside the immediate transaction to force rollback, then maps
it to public `lease-lost` outside the transaction. The job, report and history
all remain unchanged.

The aggregate adapter preserves an explicitly old JSON mtime across an empty
poll. An injected persistence rejection after completion mutation leaves the
durable JSON job running and report/history empty.

## Phase C — pagination, retention, API, configuration and metrics

### RED

The three contract groups first failed independently:

- API: `5 pass / 3 fail` for POST headers, admission limits and collection GET.
- Repository: `12 pass / 2 fail` for list/cursor and retention prune.
- Config/ops: `10 pass / 6 fail`.
- Metrics: `1 pass / 1 fail`.

### Implementation

- Added strict canonical Base64URL keyset cursors bound to project, version,
  optional status filter and an anchor job ID. A post-review remediation signs
  the canonical payload with HMAC-SHA256 using a purpose-separated key derived
  from the same effective `SESSION_SECRET` as sessions. Semantic re-encoding,
  cross-scope/status, payload and signature tampering are invalid. The anchor is
  resolved by scope only after authentication, so pagination continues when
  its current status changes; a missing or pruned anchor is invalid.
- Added the collection GET, relative `Location`, and integer ceiling
  `Retry-After`. Project authorization runs before cursor parsing.
- Added strict global/requester/project active limits and terminal retention
  configuration, stable queue-full/cursor errors and Bun-free shared page
  contracts.
- Added batch-bounded terminal prune and `audit-jobs-prune [--dry-run]`.
  Operational prune initializes/upgrades the project database before opening
  the v5-only queue repository.
- Added oldest queued age and retained terminal gauges plus fixed-label lease
  recovery (`retried|failed`) and admission rejection
  (`global|requester|project`) counters. All SQLite health fields now come from
  one conditional-aggregate query and therefore one read snapshot.
- Updated the environment example, README, architecture and hardening roadmap.

### Evidence

Repository/API coverage includes equal timestamps, new list heads, an anchor
status transition, a real `queued -> running` claim transition, filter mismatch,
same-scope real-anchor re-encoding, scope/status/payload/signature tampering,
cross-layer invalid-cursor mapping, auth-before-cursor, pruned anchors,
cutoff/batch and dry-run behavior, preserved reports/history/releases,
missing-artifact no-write, and `2501ms -> Retry-After: 3`.

The focused nine-file gate completed with `91 pass / 0 fail / 436 assertions`
before the final coverage additions. The final full server gate includes those
additions and is recorded below.

## Phase D — final verification and review

### Self-review

- Replaced duplicated SQLite completion/history and failure decisions with the
  same pure builders used by the aggregate adapter.
- Verified SQLite never falls back to aggregate persistence and every
  top-level queue action owns its own connection boundary.
- Compared aggregate and SQLite transitions, completion atomicity, pagination,
  pruning and health output. No behavior drift remains for valid queue state.
- Verified metric labels are finite enums and contain no project, version,
  requester, job or error text.
- The initial read-only review's coverage suggestions were added before the
  original final gates. A later adversarial review found that canonical
  Base64URL alone did not authenticate cursor semantics; the HMAC codec and
  explicit production/CLI/test repository wiring close that gap. The same
  review found a final-update rollback gap and a split health snapshot; both
  now have deterministic regressions and single-transaction/single-query fixes.

### Final gates

```bash
bun run check
git diff --check
bun run typecheck
bun run test
```

Results:

- Biome checked 276 files with no findings.
- All 5 workspace typecheck tasks passed.
- All 7 workspace test/build tasks passed.
- Server: `421 pass / 0 fail / 1692 assertions`.
- Client: `40 pass / 0 fail`.
- Desktop: `23 pass / 0 fail`.

No frontend style file was changed and no remote push was performed.
