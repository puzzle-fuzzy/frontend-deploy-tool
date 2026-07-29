# Artifact audit and release-policy implementation plan

> Status: completed on 2026-07-30
> Scope: backend contracts, persistence, audit execution, API, release gating,
> backup/restore, documentation, and verification. A management UI for these
> endpoints is intentionally deferred while backend behavior is stabilized.

## Product contract

DeployKit accepts an artifact into a preview version first. Artifact auditing is
an explicit, repeatable operation and never deletes or silently promotes an
upload. Each project owns its audit policy:

- `advisory` (default): publish remains available; findings are visible to API
  clients and the history timeline.
- `blocking`: publish/activate/rollback require a current audit for the exact
  artifact checksum and reject reports with error findings.

This preserves the existing upload and manual rollback workflow while allowing
owners to opt into stricter production controls. Audit findings are evidence,
not automatic repair instructions.

## Architecture decisions

1. Keep policy on `Project`; keep audit reports in a separate top-level
   collection so project/version list responses do not carry large findings.
2. Retain one current detailed report per version. Append a compact
   `version.audit` history event for each run so timeline history remains
   durable without unbounded report blobs.
3. Persist policies and reports in both relational SQLite and the JSON
   compatibility store. Advance document schema to v7 and relational schema to
   v3 with a recoverable pre-v3 backup.
4. Bind each report to the version checksum. A changed, missing, or corrupted
   artifact makes the report stale and therefore unusable by blocking policy.
5. Use static analysis only: filesystem inventory plus `index.html`, metadata,
   heading, robots, sitemap, Open Graph, and JSON-LD checks. No crawler, network
   fetch, JavaScript rendering, or external SEO score is implied.
6. Classify structural/limit failures as errors and optimization findings as
   warnings. Only errors block release.
7. Authorize audit reads/runs for project members; restrict audit-policy changes
   to project owners. Preserve the release compare-and-set check.

## Phase A — shared domain and migrations

- Add Zod schemas and shared types for policy, findings, file inventory, report,
  and report status.
- Add project policy plus top-level current reports to `Data`.
- Add `version.audit` and `project.update_audit_policy` history actions and
  stable error codes.
- Migrate JSON data v6 → v7 with advisory defaults and no reports.
- Migrate relational schema v2 → v3:
  - project policy columns;
  - `artifact_audits` table keyed by version id with project/checksum indexes;
  - sequential migration support and `.pre-relational-v3.bak`.
- Update normalized load/upsert/delete/replace paths and migration tests.

Acceptance:

- legacy v6 JSON and relational v2 databases open without data loss;
- new policy/report data survives reopen;
- deleting a project/version cascades its report;
- a pre-v3 SQLite backup is created once.

## Phase B — deterministic audit engine

- Implement a symlink-safe artifact inventory with total bytes, file count,
  extension totals, and largest files.
- Parse `index.html` with Bun `HTMLRewriter`; validate:
  title, description, canonical, robots/noindex, viewport, language, H1 count,
  Open Graph essentials, parseable JSON-LD, `robots.txt`, and `sitemap.xml`.
- Enforce the project total/file/count budgets.
- Produce stable check ids, severities, status, score, checksum, actor, and
  timestamp.
- Unit-test clean, warning, error, malformed HTML/JSON-LD, stale checksum,
  budget, and symlink cases.

Acceptance:

- identical input and policy produce identical findings and score aside from
  identity/timestamp;
- unsafe or unreadable artifacts return a stable API error, not a partial
  success;
- no network access occurs during an audit.

## Phase C — service and HTTP API

- Add `ArtifactAuditService` and route composition:
  - `POST /api/projects/:id/versions/:versionId/audit`
  - `GET /api/projects/:id/versions/:versionId/audit`
  - `PATCH /api/projects/:id/audit-policy`
- Return the current report and policy in machine-readable shared shapes.
- Persist an audit report and compact timeline metadata after a successful run.
- Add member/owner authorization, malformed-input, not-found, and cross-project
  isolation tests.

Acceptance:

- unauthorized callers learn no project/version details;
- members can inspect/run; only owners/admins can change policy;
- repeated runs replace the detailed report but add a new timeline event.

## Phase D — release gate and operational completeness

- Check policy/report/checksum before filesystem release validation and repeat
  the gate inside the metadata transaction.
- Return `409 AUDIT_REQUIRED` for absent/stale reports and
  `409 AUDIT_BLOCKED` for current failed reports.
- Include policy/report rows in verified backup metadata counts and restore
  coverage.
- Add audit outcome Prometheus counters without project/version labels.
- Document API semantics, default thresholds, status meanings, and the static
  audit boundary.

Acceptance:

- advisory mode preserves current publishing behavior;
- blocking mode cannot publish absent, stale, or failed reports;
- warning/passed current reports may publish;
- manual rollback obeys the same project policy and compare-and-set safety;
- backup verification detects report-count drift.

## Phase E — release gate

Run:

```sh
bun run verify
bun audit --audit-level=high
```

Then run an isolated production smoke test with separate management/deploy
origins covering: upload, audit, blocking rejection, policy update, publish,
rollback, report retrieval, metrics, graceful shutdown, and restart
persistence. Commit by cohesive phase, merge to `main`, push, and wait for CI
and CodeQL success.

## Pause points and prohibitions

- Do not make audit success a requirement for upload.
- Do not auto-publish, auto-rollback, delete, or rewrite artifacts.
- Do not present static checks as a Lighthouse/runtime crawl.
- Do not introduce user-controlled regular expressions or arbitrary external
  URLs.
- Stop and redesign if report persistence would make upload/release metadata
  non-atomic or if a migration cannot produce a verified backup.

## Completion evidence

- Document schema v7 and relational SQLite v3 migrate from deployed v2 with a
  one-time `.pre-relational-v3.bak`; policy/report round trips and backup restore
  are covered.
- The static engine inventories the tree, rejects symlinks, binds checksum,
  caps parsed HTML at 2MB, and emits stable structure/size/SEO checks.
- API authorization, repeated current-report replacement, timeline history,
  policy validation, advisory compatibility, missing/stale/failed blocking, and
  warning-report release are covered by integration tests.
- `bun run verify` passed with server 266, client 40, and desktop 23 tests plus
  typecheck, Biome, secret scan, and production build.
- An isolated production process using distinct management/deploy origins
  completed upload, audit gate rejection, two publishes, manual rollback,
  Prometheus audit metrics, two graceful shutdowns, and restart persistence.
