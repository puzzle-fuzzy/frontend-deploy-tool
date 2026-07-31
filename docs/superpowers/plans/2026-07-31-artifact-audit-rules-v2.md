# Artifact Audit Rules v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `subagent-driven-development` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deepen DeployKit's existing static artifact audit with explicit
freshness semantics, stable rule metadata, type-specific bundle budgets,
bounded local-link/image checks, and typed worker failures without creating a
second queue or weakening manual release control.

**Architecture:** Keep the existing SQLite `artifact_audit_jobs` queue,
single-slot subprocess worker, current-report table, and release CAS. Separate
the scan-affecting rule configuration from the release-only `enforcement`
switch, snapshot project routing context with each job/report, and make one
pure assessment function authoritative for API freshness and release gates.
Engine v2 remains deterministic and offline: it reads only the extracted
artifact tree, emits aggregate findings, and never executes JavaScript or
fetches a URL.

**Tech Stack:** Bun, TypeScript, Hono, Zod, Bun SQLite, Bun `HTMLRewriter`,
Turbo, Biome.

**Standards calibration:** Rule wording and scope follow current primary
guidance from
[Google Search Central](https://developers.google.com/search/docs/fundamentals/get-started-developers),
[Google image guidance](https://developers.google.com/search/docs/appearance/google-images),
[MDN `<img>` guidance](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/img),
and [web.dev performance budgets](https://web.dev/articles/your-first-performance-budget).
These sources support descriptive metadata, crawlable links, present `alt`
attributes, and project-specific budgets; they do not justify turning generic
title-length or bundle-size heuristics into universal blocking rules.

## Global Constraints

- Reuse the existing `artifact_audit_jobs` queue and worker; do not introduce a
  second queue, Redis, PostgreSQL, a browser worker, or a new service.
- Upload and audit remain preview-only operations. Only an authenticated
  explicit publish/activate/rollback command may change production.
- `enforcement` is a release mode, not a scan input. Changing only
  `advisory`/`blocking` must not cancel, deduplicate differently, or stale an
  otherwise current scan.
- Scan freshness is determined by artifact checksum, engine/ruleset version,
  normalized rule configuration, and project routing context.
- Engine v2 invalidates engine v1 reports for blocking release, but historic
  reports remain readable.
- `engineVersion` is the persisted freshness token for both implementation and
  ruleset semantics. Every catalog ID/version/meaning change or engine semantic
  change must bump `ARTIFACT_AUDIT_ENGINE_VERSION`; per-rule versions alone are
  descriptive and never substitute for that bump.
- Detailed reports remain current-only. A succeeded job whose `reportId` is
  later set to `null` means its detailed report was superseded; compact history
  remains durable.
- New checks are aggregate-only. Do not emit one check/finding per URL or file.
  Keep protocol checks below 1,000 and cap extension summaries.
- Never execute uploaded JavaScript, crawl a site, fetch canonical/OG/asset
  URLs, parse CSS `url()`, run Playwright/Lighthouse, or inspect rendered DOM.
- The legacy synchronous `POST /audit` remains an authenticated compatibility
  exception to the background worker's single-slot subprocess boundary. It is
  still preview-only and must share the exact engine input, 2 MiB HTML,
  bounded-check, and bounded-summary limits. This stage does not silently
  change its response into an asynchronous job contract.
- Local paths from HTML must be resolved through the existing safe-path
  boundary after query/fragment removal and percent-decoding. Symlinks remain
  forbidden.
- `alt=""` is valid for decorative images. Only a missing `alt` attribute is a
  warning.
- Static internal-link existence is checked only when `spaMode=false`, and only
  for root/index, trailing-slash directory indexes, or paths with a file
  extension. Extensionless SPA/dynamic routes are not guessed.
- Existing checksum, total-size, file-count, largest-file, parser-budget, and
  SEO rules keep their IDs and meanings.
- Existing title/description/H1/canonical/social heuristics remain warnings.
  Project profiles are deferred until there is a separate product contract;
  engine v2 adds only high-confidence offline checks and explicit budgets.
- Default asset budgets are advisory until an owner explicitly enables
  blocking: JavaScript 10 MiB, stylesheets 2 MiB, fonts 10 MiB.
- Asset-specific budgets may be greater than `maxTotalBytes`; in that case the
  total budget is the effective upper bound. This preserves existing projects
  with deliberately small total budgets and avoids migration-time rejection.
- SQLite migration is fail-closed, backed up before DDL, and advances relational
  schema v6 to v7. JSON compatibility data advances document schema v8 to v9.
- Backup verification must dry-run every supported old schema through the same
  production migration before live ownership or mutation.
- Every task starts with a failing focused test, ends with its focused tests,
  server typecheck, Biome, `git diff --check`, an independent task review, and
  one intentional commit.

---

### Task 1: Normalize Audit Snapshot and Persistence

**Files:**
- Modify: `packages/shared/src/domain.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/server/src/domain/project.ts`
- Modify: `apps/server/src/domain/schema.ts`
- Modify: `apps/server/src/domain/artifactAuditJob.ts`
- Modify: `apps/server/src/domain/artifactAuditJobTransitions.ts`
- Modify: `apps/server/src/services/projectService.ts`
- Modify: `apps/server/src/services/contracts.ts`
- Modify: `apps/server/src/services/artifactAuditEngine.ts`
- Modify: `apps/server/src/services/artifactAuditService.ts`
- Modify: `apps/server/src/services/artifactAuditProtocol.ts`
- Modify: `apps/server/src/routes/projects.ts`
- Modify: `apps/server/src/repositories/sqliteSchema.ts`
- Modify: `apps/server/src/repositories/sqliteProjectRepository.ts`
- Modify: `apps/server/src/repositories/artifactAuditJobMapper.ts`
- Modify: `apps/server/src/repositories/sqliteArtifactAuditJobRepository.ts`
- Modify: `apps/server/src/repositories/aggregateArtifactAuditJobRepository.ts`
- Modify: `apps/server/src/repositories/jsonProjectRepository.ts`
- Modify: `apps/server/src/services/artifactAuditWorker.ts`
- Modify: `apps/server/src/services/runtimeOwnership.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/cli/ops.ts`
- Test: `packages/shared/tests/domain-types.test-d.ts`
- Test: `apps/server/tests/services/projectDomain.test.ts`
- Test: `apps/server/tests/services/schemaMigration.test.ts`
- Test: `apps/server/tests/services/sqliteProjectRepository.test.ts`
- Test: `apps/server/tests/services/sqliteArtifactAuditJobRepository.test.ts`
- Test: `apps/server/tests/services/artifactAuditWorker.test.ts`
- Test: `apps/server/tests/services/runtime.test.ts`
- Test: `apps/server/tests/services/ops.test.ts`
- Test: `apps/server/tests/api/artifactAudit.test.ts`
- Test: `packages/client/tests/unit/useProjects.test.tsx`
- Test: `packages/client/tests/unit/ProjectSettingsForm.test.tsx`

**Interfaces:**
- Produces:

```ts
interface ArtifactAuditContext {
  spaMode: boolean;
  routingType: 'hash' | 'path';
}

interface ArtifactAuditRuleConfig {
  maxTotalBytes: number;
  maxFileBytes: number;
  maxFileCount: number;
  maxJavaScriptBytes: number;
  maxStylesheetBytes: number;
  maxFontBytes: number;
}

interface ArtifactAuditPolicyUpdate {
  enforcement: 'advisory' | 'blocking';
  maxTotalBytes: number;
  maxFileBytes: number;
  maxFileCount: number;
  maxJavaScriptBytes?: number;
  maxStylesheetBytes?: number;
  maxFontBytes?: number;
}

function getArtifactAuditRuleConfig(
  policy: ArtifactAuditPolicy
): ArtifactAuditRuleConfig;

function hasSameArtifactAuditRuleConfig(
  left: ArtifactAuditPolicy,
  right: ArtifactAuditPolicy
): boolean;
```

- `ArtifactAuditReport` and `ArtifactAuditJob` gain `context`.
- `ArtifactAuditCheck` gains `ruleVersion`, defaulting to `1` while hydrating
  old reports.
- `ArtifactAuditSummary` gains bounded `assetBytes` totals for
  `javascript`, `stylesheet`, `font`, and `image`, defaulting to zero for old
  reports.
- Existing flat `ArtifactAuditPolicy` remains API-compatible and gains three
  required normalized budget fields after parsing. `enforcement` is omitted
  only when deriving `ArtifactAuditRuleConfig`.
- The existing audit-policy PATCH accepts the original four required fields
  plus optional new asset fields. The service merges omitted asset fields with
  the stored policy inside its repository mutation before validating, so an
  older client cannot silently reset a previously customized asset budget.

- [ ] **Step 1: Add failing shared/domain tests**

Assert that omitted v8 asset budgets/context/rule versions hydrate to defaults,
an old policy with `maxTotalBytes` below the new defaults remains valid, and
extracting rule config omits `enforcement`. Add a service/API regression in
which a legacy four-field PATCH preserves custom stored asset budgets. Update
the existing client `Project` fixtures and assertions so the new required
normalized policy fields are exercised by consumers rather than hidden behind
casts.

- [ ] **Step 2: Run the shared/domain tests and confirm failure**

Run:

```bash
bun --filter @deploykit/shared typecheck
bun test apps/server/tests/services/projectDomain.test.ts \
  apps/server/tests/services/schemaMigration.test.ts
```

Expected: failures for the missing v9 fields and helpers.

- [ ] **Step 3: Implement the normalized shared contract**

Use these defaults:

```ts
export const DEFAULT_ARTIFACT_AUDIT_POLICY = {
  enforcement: 'advisory',
  maxTotalBytes: 50 * 1024 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
  maxFileCount: 1_000,
  maxJavaScriptBytes: 10 * 1024 * 1024,
  maxStylesheetBytes: 2 * 1024 * 1024,
  maxFontBytes: 10 * 1024 * 1024,
} as const;
```

Implement rule-config extraction with object rest so future policy fields are
not silently omitted:

```ts
export function getArtifactAuditRuleConfig(
  policy: ArtifactAuditPolicy
): ArtifactAuditRuleConfig {
  const { enforcement: _enforcement, ...ruleConfig } = policy;
  return ruleConfig;
}
```

Keep persistence hydration and PATCH parsing separate: the full shared policy
schema fills historic defaults, while `ArtifactAuditPolicyUpdate` preserves
the distinction between an omitted new field and a caller explicitly setting
that field. Keep the existing engine type-correct by emitting
`ruleVersion: 1` and zero-valued `assetBytes` in Task 1; Task 2 replaces those
compatibility values with catalog-derived versions and measured asset totals.

- [ ] **Step 4: Add relational v7 and document v9 migration tests**

Create a real v6-shaped SQLite database containing a project, report, and job;
then assert startup:

- writes `.pre-relational-v7.bak`;
- backfills the three project budgets;
- backfills report/job `context_json`;
- preserves a pre-v7 project whose `maxTotalBytes` is below one or more new
  default asset budgets;
- reaches schema v7 with `integrity_check=ok` and no FK violations;
- preserves engine v1 reports/jobs as readable historic data.

For the document v8→v9 migration, assert that an existing malformed/unreadable
JSON file fails startup instead of becoming an empty repository, and that a
backup copy failure aborts before any v9 write while preserving the source
bytes. Only an actually absent data file may create empty document data.
Current v9 persistence validation must be strict and must not reuse
default-bearing legacy hydration schemas: a v9 payload missing any current
required field is invalid. The persisted-v9 validator must be complete and
drift-resistant (for example, reject any parse that would default, strip, or
otherwise transform the decoded JSON), with one-at-a-time missing-field tests
for every migration-defaulted field. Validate legacy JSON files and
`deploykit_state` payloads through the complete in-memory migration before
creating a backup, enabling WAL on the migration target, or making any other
filesystem/database mutation. SQLite preflight runs against an isolated copy
of the main/WAL/SHM snapshot so it cannot create source auxiliary files.
Backups are created from the exact bytes/snapshot that was validated, and the
source identity is revalidated under runtime single-writer ownership before
any migration mutation.

Capture every migration source through one `O_NOFOLLOW` file descriptor with
`fstat`/read/`fstat` stability checks and a final path-to-FD identity check;
never bind validation to separate path opens. Install JSON and SQLite backups
through a same-directory `O_EXCL`, mode-0600 staging file plus atomic rename so
pre-existing symlinks or hardlinks are replaced, never followed or written
through.

Relational upgrades and legacy imports require an active
`RuntimeMigrationGuard` issued by the existing runtime ownership layer and
bound to the same database path. The guard registry is module-private,
runtime-validated, and permanently revoked on release; a cast or plain object
cannot forge it. `createDeployKitRuntime()` passes its held guard into
composition. `createApp()` may open current/fresh test data but must fail before
any historical migration when it has no guard. CLI `inspect` and
`audit-jobs-prune` hold real runtime ownership for the whole write-capable
operation and release it in `finally`.

- [ ] **Step 5: Implement persistence and snapshot comparison**

Fresh schema and v6→v7 migration add:

```sql
ALTER TABLE projects ADD COLUMN audit_max_javascript_bytes INTEGER NOT NULL
  DEFAULT 10485760 CHECK (audit_max_javascript_bytes > 0);
ALTER TABLE projects ADD COLUMN audit_max_stylesheet_bytes INTEGER NOT NULL
  DEFAULT 2097152 CHECK (audit_max_stylesheet_bytes > 0);
ALTER TABLE projects ADD COLUMN audit_max_font_bytes INTEGER NOT NULL
  DEFAULT 10485760 CHECK (audit_max_font_bytes > 0);
ALTER TABLE artifact_audits ADD COLUMN context_json TEXT NOT NULL
  DEFAULT '{"spaMode":false,"routingType":"path"}';
ALTER TABLE artifact_audit_jobs ADD COLUMN context_json TEXT NOT NULL
  DEFAULT '{"spaMode":false,"routingType":"path"}';
```

All enqueue/claim/complete comparisons use
`hasSameArtifactAuditRuleConfig()` plus exact context comparison. They must not
compare `enforcement`. The worker passes the claimed job's exact `context`
through `ArtifactAuditExecutionInput`; it never re-reads mutable project
settings outside the queue transaction.

- [ ] **Step 6: Run focused persistence gates**

Run:

```bash
bun --filter @deploykit/shared typecheck
bun test apps/server/tests/services/projectDomain.test.ts \
  apps/server/tests/services/schemaMigration.test.ts \
  apps/server/tests/services/sqliteProjectRepository.test.ts \
  apps/server/tests/services/sqliteArtifactAuditJobRepository.test.ts \
  apps/server/tests/services/artifactAuditWorker.test.ts \
  apps/server/tests/api/artifactAudit.test.ts
bun --filter @deploykit/client test -- \
  tests/unit/useProjects.test.tsx \
  tests/unit/ProjectSettingsForm.test.tsx
bun --filter @deploykit/server typecheck
bun --filter @deploykit/client typecheck
bun biome check .
git diff --check
```

- [ ] **Step 7: Commit**

```bash
git add packages/shared packages/client/tests apps/server/src apps/server/tests
git commit -m "feat: version artifact audit snapshots"
```

### Task 2: Add Stable Rule Catalog and Bounded Engine v2 Checks

**Files:**
- Modify: `apps/server/package.json`
- Modify: `bun.lock`
- Create: `apps/server/src/domain/artifactAuditRules.ts`
- Modify: `apps/server/src/services/artifactAuditEngine.ts`
- Modify: `apps/server/src/services/artifactAuditProtocol.ts`
- Modify: `apps/server/src/services/artifactAuditService.ts`
- Modify: `apps/server/src/services/artifactAuditJobService.ts`
- Modify: `apps/server/src/services/artifactAuditWorker.ts`
- Modify: `apps/server/src/workers/artifactAuditProcess.ts`
- Test: `apps/server/tests/services/artifactAuditEngine.test.ts`
- Test: `apps/server/tests/services/artifactAuditService.test.ts`
- Test: `apps/server/tests/services/artifactAuditJobService.test.ts`
- Test: `apps/server/tests/api/artifactAudit.test.ts`

**Interfaces:**
- Produces:

```ts
export const ARTIFACT_AUDIT_RULESET_ID = 'deploykit-static';
export const ARTIFACT_AUDIT_ENGINE_VERSION = 2;

export const ARTIFACT_AUDIT_RULES = {
  'structure.checksum': {
    version: 1,
    category: 'structure',
    failureSeverity: 'error',
  },
  // Existing IDs plus the new IDs below.
} as const;
```

- New stable rule IDs:
  - `assets.javascript_budget`
  - `assets.stylesheet_budget`
  - `assets.font_budget`
  - `assets.script_target`
  - `assets.stylesheet_target`
  - `links.javascript_url`
  - `links.local_target`
  - `images.source`
  - `images.alt_attribute`
  - `images.local_target`

- [ ] **Step 1: Write failing rule-catalog and engine tests**

Cover:

- every emitted ID exists in the catalog;
- emitted version/category/failure severity matches the catalog;
- rule IDs are unique;
- asset totals and the three configurable budgets;
- local script/style/image references with query/fragment;
- encoded traversal cannot escape the artifact root;
- malformed percent-encoding/URL input is counted by the applicable aggregate
  target warning without throwing or leaking the artifact path;
- `alt=""` passes while an absent `alt` warns;
- `javascript:` anchors warn;
- browser-equivalent entity/control encodings of `javascript:` also warn, and
  entity-encoded external base URLs remain external;
- static file/directory links warn only when missing;
- SPA and extensionless routes are skipped;
- 100,000 distinct extensions collapse into a deterministic Top-50 plus
  `(other)` summary;
- thousands of bad references still emit one aggregate check per rule.

- [ ] **Step 2: Run engine tests and confirm failure**

Run:

```bash
bun test apps/server/tests/services/artifactAuditEngine.test.ts
```

- [ ] **Step 3: Implement the catalog and engine v2**

`createCheck()` accepts only a catalog ID and derives `ruleVersion`,
`category`, and failed severity from that catalog. Passed checks remain
`severity: 'info'`.

Decode collected URL attributes with the standards-compatible `entities`
HTML-attribute decoder before any scheme/base classification; declare it as a
direct server dependency rather than relying on its existing transitive lock
entry.

Reference resolution:

1. trim;
2. skip `#`, `data:`, `blob:`, protocol-relative URLs, every syntactically
   absolute HTTP(S) URL, and non-HTTP schemes except that `javascript:`
   increments its dedicated warning;
3. resolve against an inert same-origin base while honoring the document's
   first `<base href>`; an external base makes relative references external and
   therefore not locally verifiable;
4. after resolution, skip any HTTP(S) URL whose origin differs from the inert
   origin; never map an external URL's pathname into local artifact storage;
5. percent-decode the pathname;
6. remove query/fragment through URL parsing;
7. map root-relative paths into the artifact root with `safeJoin`;
8. require a non-symlink regular file.

No path, URL, or file list is returned in a check; only aggregate counts.
Malformed URL or percent-encoding is treated as one unverifiable target for the
applicable aggregate rule; it must not escape as an engine crash.

- [ ] **Step 4: Validate executor results against the catalog**

The protocol accepts historic persisted checks through the shared schema, but
new subprocess output must reject duplicate IDs, unknown IDs, wrong
`ruleVersion`, wrong category, or a failed severity inconsistent with the
catalog.

- [ ] **Step 5: Run focused engine/service gates**

Run:

```bash
bun test apps/server/tests/services/artifactAuditEngine.test.ts \
  apps/server/tests/services/artifactAuditService.test.ts \
  apps/server/tests/services/artifactAuditJobService.test.ts
bun --filter @deploykit/server typecheck
bun biome check .
git diff --check
```

- [ ] **Step 6: Commit**

```bash
git add apps/server/src apps/server/tests
git commit -m "feat: deepen static artifact audit rules"
```

### Task 3: Type the Audit Subprocess Failure Protocol

**Files:**
- Modify: `apps/server/src/services/artifactAuditProtocol.ts`
- Modify: `apps/server/src/services/artifactAuditEngine.ts`
- Modify: `apps/server/src/services/artifactAuditExecutor.ts`
- Modify: `apps/server/src/services/artifactAuditService.ts`
- Modify: `apps/server/src/workers/artifactAuditProcess.ts`
- Modify: `apps/server/src/services/artifactAuditJobService.ts`
- Modify: `apps/server/src/services/artifactAuditWorker.ts`
- Modify: `apps/server/src/repositories/artifactAuditJobRepository.ts`
- Modify: `apps/server/src/repositories/aggregateArtifactAuditJobRepository.ts`
- Modify: `apps/server/src/repositories/sqliteArtifactAuditJobRepository.ts`
- Modify: `apps/server/src/domain/artifactAuditJobTransitions.ts`
- Test: `apps/server/tests/services/artifactAuditExecutor.test.ts`
- Test: `apps/server/tests/services/artifactAuditService.test.ts`
- Test: `apps/server/tests/services/artifactAuditWorker.test.ts`
- Test: `apps/server/tests/services/sqliteArtifactAuditJobRepository.test.ts`
- Test: `apps/server/tests/api/artifactAudit.test.ts`

**Interfaces:**
- Produces a strict child envelope:

```ts
type ArtifactAuditProcessEnvelope =
  | { ok: true; result: ArtifactAuditExecutionResult }
  | {
      ok: false;
      error: {
        code:
          | 'AUDIT_REQUIRED'
          | 'AUDIT_ARTIFACT_UNSAFE'
          | 'AUDIT_ARTIFACT_UNREADABLE'
          | 'AUDIT_ENGINE_FAILED'
          | 'AUDIT_ENGINE_OUTPUT_INVALID';
        message: string;
        retryable: false;
      };
    };
```

- `ArtifactAuditExecutionError` gains stable `code`, redacted `message`, and
  `retryable`.
- `FailArtifactAuditJobInput` carries `errorCode` and `errorMessage`, persisted
  identically by SQLite and JSON adapters.

- [ ] **Step 1: Write failing executor/repository tests**

Assert known engine failures exit through a valid envelope and become terminal
without retry; process startup failure/crash/timeout remains retryable; an
explicit Bun stdout-buffer overflow, a validated envelope larger than the
protocol limit, or malformed output is terminal with
`AUDIT_ENGINE_OUTPUT_INVALID`; no absolute artifact path reaches stdout,
stderr-derived messages, or job rows.

Read stdout/stderr as bounded raw byte streams; never materialize an unbounded
string before enforcing the limit. Configure Bun's defensive `maxBuffer`
slightly above the logical protocol limit so the parent reader can observe the
first excess byte on Bun versions that expose only a killed child. Decode
retained stdout as strict UTF-8. Process-only success schemas are deep-strict
at every nested object and reject unknown keys without tightening historic
shared persistence schemas.
Subprocess termination uses a separate synchronous `killRequested` latch so
overflow, abort, timeout, and reader/exit rejection races request at most one
signal before all streams and exit settle.

After all stdout, stderr, and exit promises settle, classification precedence
is deterministic: a real caller abort remains an abort; otherwise confirmed
stdout overflow remains `AUDIT_ENGINE_OUTPUT_INVALID` even when stderr reading
or the exit promise also rejects or a timeout fires during cleanup; remaining
timeout, stream, and exit failures are retryable infrastructure failures. The
fake child process must not mutate the caller's `AbortController` as a side
effect of `kill()`. Trigger abort and timeout independently, and cover overflow
combined with stderr-reader rejection and exit rejection while still proving
one kill and complete settlement.

- [ ] **Step 2: Run the tests and confirm failure**

Run:

```bash
bun test apps/server/tests/services/artifactAuditExecutor.test.ts \
  apps/server/tests/services/artifactAuditWorker.test.ts \
  apps/server/tests/services/sqliteArtifactAuditJobRepository.test.ts
```

- [ ] **Step 3: Implement typed failures**

Known engine exceptions produce a JSON envelope. Unexpected child crashes keep
the non-zero process path and are retryable infrastructure failures. The
parent validates every envelope before returning a result or constructing
`ArtifactAuditExecutionError`. The engine must not retain its current
catch-all conversion of arbitrary exceptions into a known `AUDIT_FAILED`:
explicit checksum/tree/path failures use a typed inspection error; recognized
filesystem read failures become `AUDIT_ARTIFACT_UNREADABLE`; all other
exceptions escape to the child crash path. A process startup failure, timeout,
or non-zero/unknown child exit is retryable. A Bun `maxBuffer` rejection that
explicitly identifies stdout overflow is deterministic protocol invalidity and
terminal with `AUDIT_ENGINE_OUTPUT_INVALID`; do not infer overflow from a
generic child failure. A schema-invalid or oversized successful envelope is
also terminal with the same code.

The synchronous compatibility `POST /audit` catches only known
`ArtifactAuditInspectionError` values and maps them to the existing safe
`AUDIT_FAILED` API contract. Unexpected engine exceptions still reach the
generic crash handler.

- [ ] **Step 4: Persist stable job reasons**

Both repositories use the caller-supplied stable code and safe message for
retry and terminal rows. Lease expiry retains the existing
`AUDIT_JOB_FAILED` classification.

- [ ] **Step 5: Run focused gates and commit**

```bash
bun test apps/server/tests/services/artifactAuditExecutor.test.ts \
  apps/server/tests/services/artifactAuditWorker.test.ts \
  apps/server/tests/services/artifactAuditJobService.test.ts \
  apps/server/tests/services/sqliteArtifactAuditJobRepository.test.ts
bun --filter @deploykit/server typecheck
bun biome check .
git diff --check
git add apps/server/src apps/server/tests
git commit -m "fix: classify artifact audit worker failures"
```

### Task 4: Add One Freshness Assessment Contract

**Files:**
- Modify: `packages/shared/src/domain.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/server/src/domain/artifactAudit.ts`
- Modify: `apps/server/src/services/artifactAuditService.ts`
- Modify: `apps/server/src/services/contracts.ts`
- Modify: `apps/server/src/routes/artifactAudits.ts`
- Test: `apps/server/tests/services/artifactAuditService.test.ts`
- Test: `apps/server/tests/api/artifactAudit.test.ts`
- Test: `apps/server/tests/services/versionService.test.ts`
- Test: `packages/client/tests/apiRoutes.test-d.ts`

**Interfaces:**
- Produces:

```ts
type ArtifactAuditStaleReason =
  | 'checksum_changed'
  | 'engine_changed'
  | 'rule_config_changed'
  | 'context_changed';

type ArtifactAuditReleaseAssessment =
  | { allowed: true; reason: 'advisory' | 'current_report' }
  | { allowed: false; reason: 'audit_required' | 'audit_blocked' };

interface ArtifactAuditAssessmentBase {
  currentEngineVersion: number;
  release: ArtifactAuditReleaseAssessment;
}

type ArtifactAuditAssessment =
  | (ArtifactAuditAssessmentBase & {
      report: null;
      freshness: 'missing';
      staleReasons: [];
    })
  | (ArtifactAuditAssessmentBase & {
      report: ArtifactAuditReport;
      freshness: 'stale';
      staleReasons: [
        ArtifactAuditStaleReason,
        ...ArtifactAuditStaleReason[],
      ];
    })
  | (ArtifactAuditAssessmentBase & {
      report: ArtifactAuditReport;
      freshness: 'current';
      staleReasons: [];
    });
```

- Additive authenticated endpoint:
  `GET /api/projects/:id/versions/:versionId/audit-assessment`.
- Existing `GET /audit`, sync `POST /audit`, and job APIs remain unchanged.
- Freshness reason order is stable:
  `checksum_changed`, `engine_changed`, `rule_config_changed`,
  `context_changed`.
- Missing means `report: null` and no stale reasons; stale means a report and
  at least one stale reason; current means a report and no stale reasons.
- Advisory mode always allows release with reason `advisory`. Blocking mode
  maps missing or stale (including a stale failed report) to
  `audit_required`, a current failed report to `audit_blocked`, and a current
  passed or warning report to `current_report`.

- [ ] **Step 1: Write the freshness matrix tests**

Cover missing report, checksum change, engine v1, each budget change, routing
context change, enforcement-only change, warning/passed/failed reports, and
advisory/blocking mode. Enforcement-only change must remain current. Add a
multi-mismatch case that locks the canonical stale-reason order and a
stale-plus-failed case that proves `audit_required` takes precedence over
`audit_blocked`.

- [ ] **Step 2: Implement one pure assessment function**

`assertArtifactAuditAllowsRelease()` delegates to the assessment instead of
reimplementing freshness comparisons. The pure function accepts already-loaded
`Data`, `Project`, and `Version` (or equivalent immutable inputs), returns the
discriminated contract above, and never reloads or mutates data; this preserves
the release service's second assessment inside `repo.mutate()` as its
compare-and-swap guard. Select a report by both project and version ID.
Compare checksum, the engine token imported directly from
`domain/artifactAuditRules.ts`, `hasSameArtifactAuditRuleConfig()` across all
six scan fields while excluding enforcement, and the exact routing context.

- [ ] **Step 3: Add and test the Hono route**

Authorize project read before revealing version or report existence. Only
after authorization, validate version membership and read the current detailed
report table by both project and version ID; missing report is a successful
assessment and must not reuse the throwing `getArtifactAudit()` path or derive
state from job history. Test 401, authenticated non-member 403, authorized
project A with project B's version/report as `VERSION_NOT_FOUND` 404, valid
scoped missing as 200, stale, current, and engine-v1 responses through
`app.request()`. Add a compile-only `hc<ApiApp>` assertion that reaches the
exact `audit-assessment` path and proves its 200 `InferResponseType` equals
`ArtifactAuditAssessment`, not merely that `$get` exists. The endpoint is
intentionally not added to the transport-neutral `ApiClient` until a browser
or desktop feature consumes it, but the exported Hono route contract must
remain type-visible.

- [ ] **Step 4: Run focused gates and commit**

```bash
bun test apps/server/tests/services/artifactAuditService.test.ts \
  apps/server/tests/api/artifactAudit.test.ts \
  apps/server/tests/services/versionService.test.ts
bun --filter @deploykit/server typecheck
bun --filter @deploykit/client typecheck
bun biome check .
git diff --check
git add packages/shared packages/client/tests apps/server/src apps/server/tests
git commit -m "feat: expose artifact audit freshness"
```

### Task 5: Prove Historical Recovery and Production Behavior

**Files:**
- Modify: `apps/server/src/services/backupService.ts`
- Modify: `apps/server/src/repositories/artifactAuditJobMapper.ts`
- Modify: `apps/server/src/repositories/sqliteProjectRepository.ts`
- Modify: `apps/server/tests/api/ciProductionProcessSmoke.test.ts`
- Modify: `apps/server/tests/services/backupService.test.ts`
- Modify: `apps/server/tests/services/backupRestoreSafety.test.ts`
- Modify: `apps/server/tests/services/sqliteProjectRepository.test.ts`
- Modify: `apps/server/tests/fixtures/schema-v5-backup/README.md`
- Modify: `README.md`
- Modify: `TODO.md`
- Modify: `docs/architecture.md`
- Modify: `docs/development.md`
- Modify: `docs/backend-hardening-roadmap.md`

**Interfaces:**
- No new HTTP or domain interface. The production relational data hydrator may
  become an internal reusable export so startup and backup validation cannot
  drift.
- The frozen schema-v5 fixture remains unchanged except documentation; tests
  keep its existing verify→restore→v7 startup proof focused on the backup path.
- Generated v6 and current-v7 databases with real report/job JSON prove exact
  migration, domain hydration, staged restore validation, and fail-closed
  cleanup. Task 4 is a hard prerequisite for the production assessment/gate
  assertions.
- Execute Task 5 in two sequential review checkpoints: **5A** owns relational
  hydration, backup staging/validation, cleanup, and focused recovery tests;
  after an independent security review passes, **5B** owns the restart/gate
  production smoke and documentation. Do not combine both risk surfaces into
  one unreviewed commit.

- [ ] **Step 1: Add failing historical and production smoke assertions**

Prove:

- v5 and generated-v6 backup verification use the exact production migrations
  before any live mutation; Task 1's direct repository migration tests are not
  duplicated;
- a drifted v6 target column fails through `verifyBackup()` and restore before
  ownership, while the existing frozen-v5 production smoke remains the
  backup-path compatibility proof;
- both invalid JSON syntax and valid-JSON/domain-invalid values fail for report
  and job `policy_json`, report and job `context_json`, report `summary_json`,
  and report `checks_json`;
- that corruption matrix runs against generated v6→v7 and current-v7 backup
  verification, proving source database/manifest bytes unchanged, ownership
  acquisition count zero for the initial invalid source, and no live mutation;
- v6 report/job rows gain context and all rule-budget defaults when verified
  through the backup path;
- current-v7 project assembly passes through `projectSchema`, so domain-invalid
  project/version fields also fail before restore;
- a source-swap injection between initial verify and restore cannot change the
  installed payload: restore re-captures into a control-owned stage, revalidates
  that exact staged payload, and leaves live state untouched on mismatch;
- an observable injected temporary-root records that the root and database
  `-wal`, `-shm`, and `-journal` files disappear after both successful and
  failed validation; cleanup failure makes verification invalid;
- engine v1 report is readable but stale;
- with the worker disabled, enqueue one advisory job, switch enforcement only
  to blocking, and prove the same queued job remains without cancel, enqueue,
  or re-scan;
- after restart with the worker enabled, poll that same job to engine-v2
  completion; restart again and prove the job, current report, and assessment
  persist;
- blocking treats that current warning report as releasable, while
  missing/stale/failed reports reject release and leave active version, preview
  status, artifact bytes, and job/report counts unchanged;
- no audit operation publishes or deletes the preview; if warning acceptance is
  tested by publishing, production changes only at the explicit publish call.

- [ ] **Step 2: Run migration/smoke tests and confirm failures**

```bash
bun test apps/server/tests/services/sqliteProjectRepository.test.ts \
  apps/server/tests/services/backupService.test.ts \
  apps/server/tests/services/backupRestoreSafety.test.ts \
  apps/server/tests/api/ciProductionProcessSmoke.test.ts
```

- [ ] **Step 3: Complete compatibility fixes**

Use production migration and backup code only; do not add test-only migration
logic to runtime. Export or reuse `loadRelationalData()` as the one production
validation path, make assembled projects pass through `projectSchema`, and run
it against every verified database: directly for v7 and after the exact
production migration for v5/v6. Reuse the production report and job mappers;
SQLite `integrity_check`, foreign-key checks, and table counts alone are
insufficient because valid TEXT columns may contain invalid JSON or invalid
domain values.

Close verify→restore TOCTOU by retaining the fast initial validation, then
capturing the manifest, database, and storage payload with Task 1's
control-owned, no-follow boundary into a restore stage and re-running complete
verification against that exact staged payload before moving live state. Never
re-copy a previously verified mutable source path directly into place.
Introduce only an internal injectable temporary-root factory needed to assert
cleanup. Preserve source database/manifest bytes and remove the full temporary
root plus WAL/SHM/journal files on success and failure; cleanup failure is a
verification failure.

- [ ] **Step 4: Update documentation**

Document:

- ruleset/engine v2 and stable rule-ID policy;
- current-only detailed reports and superseded job semantics;
- assessment freshness reasons;
- all six configurable scan budgets, with enforcement-only changes remaining
  fresh;
- offline/static limitations and profile/rendered-DOM deferral;
- the distinction between job execution failure and a successful report with
  failed findings.
- the synchronous `POST /audit` compatibility exception, including that it is
  preview-only, in-process, bounded by the same static engine limits, and not
  governed by the background worker's single-slot lease.
- relational v5/v6→v7 domain-validating backup preflight, direct current-v7
  domain validation, exact staged restore revalidation, and cleanup behavior;
- `GET /audit-assessment`, engine-v2 asset/context fields, and the persisted
  restart/enforcement-toggle flow.

Update roadmap/TODO only for functionality proven by tests.

- [ ] **Step 5: Run full local gates**

```bash
bun run check:fix
bun run verify
npm_config_registry=https://registry.npmjs.org bun run security:audit
git diff --check
git status -sb
```

- [ ] **Step 6: Commit at the two review checkpoints**

```bash
git add apps/server/src/services/backupService.ts \
  apps/server/src/repositories/artifactAuditJobMapper.ts \
  apps/server/src/repositories/sqliteProjectRepository.ts \
  apps/server/tests/services/backupService.test.ts \
  apps/server/tests/services/backupRestoreSafety.test.ts \
  apps/server/tests/services/sqliteProjectRepository.test.ts
git commit -m "fix: validate staged backup restores"
```

Independently review and fix 5A before continuing. Then:

```bash
git add apps/server/tests/api/ciProductionProcessSmoke.test.ts \
  apps/server/tests/fixtures/schema-v5-backup/README.md \
  README.md TODO.md docs
git commit -m "test: prove artifact audit rules v2 recovery"
```

### Task 6: Final Review, Push, and Remote Gates

**Files:**
- Review all changes since the starting commit recorded before Task 1.

- [ ] **Step 1: Generate one whole-range review package**

Use the recorded base commit, not `HEAD~1`.

- [ ] **Step 2: Independent final review**

Require separate spec-compliance and code-quality verdicts. Fix every Critical
or Important finding and re-review.

- [ ] **Step 3: Re-run full gates after all review fixes**

```bash
bun run verify
npm_config_registry=https://registry.npmjs.org bun run security:audit
git diff --check
git status -sb
```

- [ ] **Step 4: Fetch and push main without force**

```bash
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
git push origin main
```

- [ ] **Step 5: Wait for CI and CodeQL**

Confirm both workflows complete successfully for the exact pushed SHA, then
verify local `HEAD`, `origin/main`, and `git ls-remote` agree.
