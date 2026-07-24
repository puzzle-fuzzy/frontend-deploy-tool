# History Cursor, Storage Recovery, and CI Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add stable bounded history pagination, crash-safe artifact staging and startup reconciliation, and retained CI evidence without introducing an unnecessary background worker.

**Architecture:** Keep DeployKit's single-process, single-node model and the existing 200-event audit retention limit. Use an opaque event cursor so new head events do not duplicate older pages, stage uploads on the same filesystem before an atomic rename, and reconcile metadata against artifacts before the server begins serving requests. CI remains one `bun run verify` gate and uploads its log plus the verified Web bundle.

**Tech Stack:** Bun, TypeScript, Hono, React, Electron IPC, SQLite, Vitest/Bun test, GitHub Actions.

## Global Constraints

- Do not introduce a queue, worker, heartbeat, ORM, or second database abstraction.
- Keep `project.activeVersionId` as the only live-version source of truth.
- Keep history capped at 200 events; a cursor may expire when its event leaves that window.
- Cursor values are opaque transport tokens and must never expose filesystem paths or credentials.
- Stage and final artifact directories must remain on the same filesystem so `renameSync` is atomic.
- Missing active artifacts must deactivate the project; never auto-promote another version.
- Runtime reconciliation may delete only DeployKit-owned staging; unreferenced final artifacts must move into `.recovery/orphans/`.
- `bun run verify` remains the local and CI source of truth.

---

## Task 1: Checkpoint the completed architecture foundation

**Files:**

- Stage: all existing requested redesign and architecture-hardening changes
- Include: `docs/superpowers/plans/2026-07-24-history-cursor-storage-recovery-ci-artifacts.md`

**Interfaces:**

- Consumes: the already-passing `bun run verify` foundation state
- Produces: a clean Git checkpoint before the next behavior changes

- [x] Confirm the remote `origin` exists, `main` matches `origin/main`, and GitHub authentication can push.
- [x] Inspect `git status --short`, `git diff --check`, and ignored runtime paths so no database, credential, cache, or generated output is staged.
- [x] Stage the foundation changes and create:

```bash
git commit -m "feat: redesign DeployKit and harden its foundation"
```

- [x] Confirm the checkpoint commit contains no runtime database, `.env`, `.voasx`, `dist`, or Electron output.

## Task 2: Define and test opaque history pagination

**Files:**

- Modify: `packages/shared/src/domain.ts`
- Modify: `packages/shared/src/errors.ts`
- Modify: `apps/server/src/domain/history.ts`
- Modify: `apps/server/src/services/contracts.ts`
- Modify: `apps/server/src/services/projectService.ts`
- Modify: `apps/server/src/routes/history.ts`
- Modify: `apps/server/tests/services/projectDomain.test.ts`
- Modify: `apps/server/tests/api/contracts.test.ts`

**Interfaces:**

- Produces:

```ts
export interface HistoryPage {
  items: HistoryEvent[];
  nextCursor: string | null;
}

export interface HistoryPageQuery {
  limit?: number;
  cursor?: string;
}

export function paginateHistory(
  events: HistoryEvent[],
  limit?: string,
  cursor?: string
): HistoryPage | undefined;
```

- `undefined` from `paginateHistory` means a malformed or expired cursor.
- Server service methods return `HistoryPage` and translate `undefined` into `ApiError('INVALID_HISTORY_CURSOR', ..., 400)`.

- [x] Add domain tests proving a first page returns exactly `limit` items and a cursor only when older events exist.
- [x] Add domain tests proving a second page starts after the cursor even when a newer event is prepended.
- [x] Add domain tests proving malformed, unknown, and expired cursors are rejected.
- [x] Add API tests for the page envelope, `nextCursor`, no duplicate IDs across pages, project scoping, and `INVALID_HISTORY_CURSOR`.
- [x] Run the focused tests and confirm the old array response fails the new expectations.
- [x] Add `historyPageSchema`, `HistoryPage`, `HistoryPageQuery`, and `INVALID_HISTORY_CURSOR`.
- [x] Implement a versioned Base64URL cursor containing only the event ID; validate its exact object shape before use.
- [x] Update both history routes and service methods to accept `limit` plus `cursor` and return the page envelope.
- [x] Run the focused server tests until they pass.

## Task 3: Move Web and Electron history clients to append-only pages

**Files:**

- Modify: `packages/client/src/api/ApiClient.ts`
- Modify: `packages/client/src/api/fetchApiClient.ts`
- Modify: `packages/client/src/features/history/ProjectHistoryTimeline.tsx`
- Modify: `packages/client/src/shared/error-messages.ts`
- Modify: `packages/client/tests/unit/ProjectHistoryTimeline.test.tsx`
- Modify: `packages/client/tests/unit/api.test.ts`
- Modify: `packages/client/tests/unit/apiClientShape.test.ts`
- Modify: `apps/desktop/src/shared/bridge.ts`
- Modify: `apps/desktop/src/preload.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/renderer/ipcApiClient.ts`
- Modify: `apps/desktop/tests/ipcApiClient.test.ts`

**Interfaces:**

- Consumes:

```ts
listProjectHistory(
  projectId: string,
  query?: HistoryPageQuery
): Promise<HistoryPage>;
```

- Produces: initial replacement, older-page append, next-cursor state, and retry behavior without re-fetching all previously rendered rows.

- [x] Rewrite timeline tests to expect `{ items, nextCursor }`.
- [x] Add a test proving “load older” sends the previous `nextCursor` and appends unique rows.
- [x] Add a test proving a refresh key resets the cursor and replaces stale rows.
- [x] Add a test proving a load-more failure keeps already rendered events and offers a retry.
- [x] Run focused client and desktop tests and confirm signatures fail before implementation.
- [x] Update the transport-neutral client contract, Hono client, preload bridge, IPC handler, and renderer adapter.
- [x] URL-encode the desktop cursor and omit it when absent.
- [x] Replace growing-limit refetches with one initial page and cursor-driven append requests.
- [x] Keep an inline footer error for load-more failures while retaining the full-page initial error state.
- [x] Run focused client and desktop tests until they pass.

## Task 4: Make uploads crash-safe and reconcile storage at startup

**Files:**

- Create: `apps/server/src/services/storageReconciler.ts`
- Modify: `apps/server/src/services/versionService.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `packages/shared/src/domain.ts`
- Modify: `apps/server/src/domain/history.ts`
- Modify: `apps/server/tests/services/versionService.test.ts`
- Create: `apps/server/tests/services/storageReconciler.test.ts`
- Modify: `apps/server/tests/api/app.test.ts`

**Interfaces:**

- Produces:

```ts
export interface StorageReconciliationReport {
  removedStagingEntries: number;
  quarantinedOrphanVersions: number;
  markedFailedVersions: number;
  deactivatedProjects: number;
}

export function reconcileStorage(
  repo: ProjectRepository,
  storageDir: string
): StorageReconciliationReport;
```

- Upload lifecycle:

```text
validate project → write .staging/<versionId> → validate and checksum
→ rename into <projectId>/<versionId> → atomic metadata mutation
→ remove final directory if metadata commit fails
```

- [x] Add upload tests proving success leaves only the final directory and failure leaves neither staging nor final artifacts.
- [x] Add reconciliation tests for stale staging entries, orphan version directories, missing inactive artifacts, and missing active artifacts.
- [x] Add a test proving reconciliation is idempotent and does not append duplicate recovery history.
- [x] Run focused tests and confirm they fail before implementation.
- [x] Refactor uploads to process inside `.staging/<versionId>`, keep ZIP temporary data inside staging, and rename only after all validation and checksum work succeeds.
- [x] Implement startup reconciliation:
  - delete `.staging`;
  - quarantine project/version directories absent from metadata under `.recovery/orphans/`;
  - mark referenced versions without `index.html` as `failed`;
  - clear `activeVersionId` when its artifact is missing;
  - append `version.reconcile` history as actor `system` once per newly failed version.
- [x] Call reconciliation during app composition before services begin handling requests and log only non-empty reports.
- [x] Run focused service and API tests until they pass.

## Task 5: Retain CI evidence and document the recovery model

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `docs/architecture.md`
- Modify: `docs/development.md`
- Modify: `README.md`

**Interfaces:**

- Produces:
  - `deploykit-verify-${{ github.sha }}` containing `verify.log` on every CI outcome;
  - `deploykit-web-${{ github.sha }}` containing `apps/web/dist` and `apps/server/public` after a successful build;
  - 14-day artifact retention.

- [x] Change the CI Verify step to:

```yaml
- name: Verify
  shell: bash
  run: |
    set -o pipefail
    bun run verify 2>&1 | tee verify.log
```

- [x] Add an `if: always()` verification-log upload and an `if: success()` Web-bundle upload using `actions/upload-artifact@v6`, `if-no-files-found: error`, and `retention-days: 14`.
- [x] Document cursor expiry, staging/final ownership, startup reconciliation, failed artifact behavior, and CI artifact names.
- [x] Run formatting/check commands and inspect the workflow diff for valid indentation and expressions.

## Task 6: Complete validation and publish main

**Files:**

- Verify: all changed source, tests, docs, and workflow files

**Interfaces:**

- Produces: a verified `main` branch pushed to `origin/main`.

- [x] Run focused server, client, and desktop tests.
- [x] Run `bun run verify`.
- [x] Restart the local development server from the new code.
- [x] Verify `/`, `/health/live`, `/health/ready`, a paginated history request, and an API error preserving `X-Request-Id`.
- [x] Inspect the history timeline at desktop and mobile widths, including loading older events and a load-more error state.
- [x] Run `git diff --check` and confirm runtime data/build output remain ignored.
- [x] Commit the next-stage changes:

```bash
git commit -m "feat: add recoverable deploy storage and cursor history"
```

- [x] Rebase only if `origin/main` advanced; otherwise push the verified `main` directly.
- [x] Push `main` to `origin` and inspect the resulting GitHub Actions run until it completes or exposes an actionable failure.
