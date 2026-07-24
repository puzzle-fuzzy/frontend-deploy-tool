# Foundation Architecture Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate lost updates at the persistence boundary, make production startup fail safely, and give every request a health and trace surface before adding more deployment features.

**Architecture:** Keep the current Bun/Hono/React/Electron workspace and single-record project-state model, but move every state-changing business operation behind one repository-level atomic mutation contract. SQLite owns the transaction and lock; services own domain decisions. Runtime configuration remains centralized in `config.ts`, while health and request identity are public transport concerns composed in the Hono application.

**Tech Stack:** Bun, TypeScript, Hono, `bun:sqlite`, React, Vitest-compatible Bun tests, Biome, GitHub Actions.

## Global Constraints

- Preserve existing public API behavior unless a safety fix requires a documented change.
- Do not add a second persistence abstraction or ORM.
- Domain services must not depend on SQLite-specific APIs.
- Production must fail closed for missing secrets; development remains easy to start.
- Tests must be written or tightened before each implementation change.
- `bun run verify` is the final source of truth.

---

## Task 1: Define and test the atomic repository contract

**Files:**

- Modify: `apps/server/src/repositories/projectRepository.ts`
- Modify: `apps/server/tests/services/jsonProjectRepository.test.ts`
- Modify: `apps/server/tests/services/sqliteProjectRepository.test.ts`

- [x] Add contract tests proving that `mutate()` returns the callback result and persists its in-memory changes.
- [x] Add rollback tests proving that a thrown mutation leaves the stored state unchanged.
- [x] Add a two-instance SQLite test proving that sequential mutations observe the latest committed state instead of replacing a stale snapshot.
- [x] Run the two repository test files and confirm the new tests fail because `mutate()` does not exist.
- [x] Add the generic synchronous `mutate<T>(operation: (data: Data) => T): T` contract.

## Task 2: Implement atomic JSON and SQLite mutations

**Files:**

- Modify: `apps/server/src/repositories/jsonProjectRepository.ts`
- Modify: `apps/server/src/repositories/sqliteProjectRepository.ts`
- Test: `apps/server/tests/services/jsonProjectRepository.test.ts`
- Test: `apps/server/tests/services/sqliteProjectRepository.test.ts`

- [x] Implement JSON mutation as one load, callback, and atomic file write; do not write on callback failure.
- [x] Split SQLite row loading and row persistence into transaction-safe internal helpers.
- [x] Implement SQLite mutation with `database.transaction(...).immediate()` so read, domain change, and save share one write transaction.
- [x] Ensure callbacks that throw roll back and propagate their original error.
- [x] Run repository tests and confirm all mutation/rollback cases pass.

## Task 3: Move all business writes behind `mutate()`

**Files:**

- Modify: `apps/server/src/services/projectService.ts`
- Modify: `apps/server/src/services/versionService.ts`
- Modify: `apps/server/src/services/userService.ts`
- Modify: `apps/server/tests/services/projectDomain.test.ts`
- Modify: `apps/server/tests/services/versionService.test.ts`
- Modify: `apps/server/tests/api/authRegister.test.ts`

- [x] Cover concurrent-safe slug uniqueness, member changes, and duplicate user registration decisions through the existing API contract suite plus repository mutation tests.
- [x] Refactor project create/update/delete, member changes, and ownership transfer to re-read and decide within one repository mutation.
- [x] Refactor version metadata creation/deletion to mutate atomically and clean up newly written artifacts if the transaction fails.
- [x] Refactor user creation and admin seeding to use mutation boundaries; enforce email uniqueness inside the mutation instead of relying only on a route pre-check.
- [x] Run all server service and API tests.

## Task 4: Harden production configuration

**Files:**

- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/tests/services/config.test.ts`
- Modify: `apps/server/README.md`
- Modify: `apps/server/.env.example`

- [x] Add tests for explicit `development`, `test`, and `production` runtime modes.
- [x] Add production tests that reject a missing `SESSION_SECRET`, reject a missing initial `ADMIN_PASSWORD`, and default public registration to disabled.
- [x] Add URL and numeric configuration validation tests with clear variable-specific messages.
- [x] Implement pure config parsing/validation and run it before repository or server startup.
- [x] Document production-required values and the safe development defaults.

## Task 5: Add request identity and health surfaces

**Files:**

- Modify: `apps/server/src/services/contracts.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/api.ts`
- Modify: `apps/server/tests/api/app.test.ts`
- Modify: `apps/server/tests/api/contracts.test.ts`

- [x] Add tests for `X-Request-Id` generation and propagation.
- [x] Add tests for `GET /health/live` returning `204` without authentication.
- [x] Add tests for `GET /health/ready` returning repository readiness and a non-success response when the repository cannot load.
- [x] Register Hono request-ID middleware before API/session middleware.
- [x] Add minimal public liveness/readiness endpoints without exposing project or filesystem data.
- [x] Preserve request IDs in error responses through the response header.

## Task 6: Unify the cross-surface error contract

**Files:**

- Add: `packages/shared/src/errors.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/server/src/errors.ts`
- Modify: `packages/client/src/api/errors.ts`
- Modify: `packages/client/src/api/fetchApiClient.ts`
- Modify: `packages/client/src/shared/error-messages.ts`
- Modify: `apps/desktop/src/main/serverRequest.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/renderer/ipcApiClient.ts`
- Modify: `packages/client/tests/unit/api.test.ts`
- Modify: `apps/desktop/tests/serverRequest.test.ts`
- Modify: `apps/server/tests/api/contracts.test.ts`

- [x] Define stable shared error codes and the API error-envelope type.
- [x] Add client tests showing localization prefers error codes and preserves the request ID for support/debugging.
- [x] Add desktop request tests showing status, code, and request ID survive HTTP and IPC transport parsing.
- [x] Make server `ApiError` use the shared code type without changing HTTP status behavior.
- [x] Introduce an `ApiClientError` and parse both web and desktop error responses into it.
- [x] Keep message-string fallback only for compatibility with older servers.

## Task 7: Complete the architecture gate

**Files:**

- Modify if required: `package.json`
- Modify if required: `.github/workflows/ci.yml`
- Modify: `docs/architecture.md`
- Modify: `docs/development.md`

- [x] Document repository mutation ownership, runtime modes, error codes, request IDs, and health endpoints.
- [x] Run focused repository, service, API, client, and desktop tests.
- [x] Run `bun run verify`.
- [x] Start the server with development settings and verify `/`, `/health/live`, `/health/ready`, and an API error response with `X-Request-Id`.
- [x] Re-check the dirty working tree and ensure no runtime database, build output, credentials, or unrelated user changes are included.

## Task 8: Resume feature iteration only after the gate passes

**Files:**

- Modify: `packages/client/src/features/history/ProjectHistoryTimeline.tsx`
- Modify: `packages/client/src/features/projects/ProjectWorkspace.tsx`
- Modify: `packages/client/src/features/settings/ProjectSettingsForm.tsx`
- Modify: corresponding focused tests

- [x] Replace remaining native confirmation UI with the existing non-layout-shifting dialog primitive.
- [x] Audit history pagination, empty/loading/error states, and responsive behavior against the current design system.
- [x] Split the production bundle at stable framework, UI, and avatar dependency boundaries; keep feature source ownership cohesive.
- [x] Re-run `bun run verify` and visually inspect the served application at desktop and mobile widths.
