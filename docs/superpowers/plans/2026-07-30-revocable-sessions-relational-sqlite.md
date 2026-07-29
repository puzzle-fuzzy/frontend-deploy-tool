# Revocable Sessions and Relational SQLite Implementation Plan

> **Execution:** Follow the `executing-plans` workflow task by task. Use failing
> tests first, keep every database migration reversible, and do not begin
> storage-retention work until this phase gate passes.

**Goal:** Replace DeployKit's single JSON document inside SQLite and
non-revocable signed tokens with a durable relational metadata store,
append-only history pagination, a release ledger, and user-manageable sessions.

**Architecture:** Keep the current route → service → domain boundaries while
moving persistence behind relational tables. The repository hydrates the
existing domain aggregate for business operations, but persists row-level
upserts/deletes inside `BEGIN IMMEDIATE`; audit history uses a direct,
sequence-based SQL page query so it is never truncated or loaded wholesale.
Session tokens remain HMAC signed but include a random `jti` that must match an
active database session row. JSON-only test fixtures use an in-memory session
repository; configured SQLite instances survive restarts.

**Non-goals:** No PostgreSQL, Redis, external queue, OAuth provider, frontend
session-management screen, storage quotas, or artifact inspection in this
phase.

## Invariants

- The relational migration creates a consistent SQLite backup before changing
  a legacy database and keeps the legacy `deploykit_state` row readable for
  rollback analysis.
- Re-running initialization is idempotent and never re-imports legacy JSON or
  overwrites relational rows.
- A failed repository mutation leaves users, projects, members, versions,
  releases, and audit events unchanged.
- `audit_events` is append-only during normal mutations and is not capped at
  200 rows.
- Release audit events also produce an append-only `releases` ledger row.
- A signed token without a live, unexpired, non-revoked `sessions` row is not
  authenticated.
- Login/register create one browser session shared by the HttpOnly cookie and
  compatibility response token; desktop exchange creates a distinct desktop
  session.
- Logout revokes the current session before clearing the cookie. A user may
  list and revoke only their own sessions.

---

## Task 1: Establish the relational schema and reversible legacy import

**Files:**
- Create: `apps/server/src/repositories/sqliteSchema.ts`
- Replace: `apps/server/src/repositories/sqliteProjectRepository.ts`
- Modify: `apps/server/src/repositories/projectRepository.ts`
- Modify: `apps/server/tests/services/sqliteProjectRepository.test.ts`
- Modify: `apps/server/src/services/userService.ts`

- [x] Add failing tests that open an old `deploykit_state` database and assert
  creation of `users`, `projects`, `project_members`, `versions`, `releases`,
  `audit_events`, `sessions`, and `schema_migrations`.
- [x] Assert a consistent `*.pre-relational-v1.bak` database exists before the
  first conversion and that a second initialization does not replace it.
- [x] Assert legacy JSON imports once, retains its existing
  `.sqlite-migration.bak`, and produces the same hydrated `Data`.
- [x] Add schema initialization with foreign keys, WAL, busy timeout, unique
  email/slug constraints, deferred active-version reference, and migration
  version 1.
- [x] Import a migrated legacy `Data` snapshot in one transaction. Invalid
  legacy memberships are skipped rather than inventing login-capable users;
  admin seeding must check for an admin account, not merely a non-empty user
  table.
- [x] Run:
  `bun --filter @deploykit/server test tests/services/sqliteProjectRepository.test.ts tests/services/schemaMigration.test.ts`

## Task 2: Persist aggregate mutations as relational row diffs

**Files:**
- Modify: `apps/server/src/repositories/sqliteProjectRepository.ts`
- Modify: `apps/server/tests/services/sqliteProjectRepository.test.ts`
- Modify: `docs/architecture.md`

- [x] Add failing tests for row-level create/update/delete across users,
  projects, members, and versions, including a separate repository instance
  observing the latest commit.
- [x] Add a rollback test proving an injected callback failure changes no
  relational row.
- [x] Hydrate users/projects/members/versions from normalized rows.
- [x] In one `IMMEDIATE` transaction, upsert changed rows and delete removed
  rows in foreign-key-safe order. Do not serialize the aggregate back into a
  payload column.
- [x] Preserve `save()` only as a test/import replacement operation; runtime
  services continue to use transactional `mutate()`.
- [x] Run:
  `bun --filter @deploykit/server test tests/services/sqliteProjectRepository.test.ts tests/services/projectDomain.test.ts tests/services/versionService.test.ts`

## Task 3: Move history and releases to append-only SQL pagination

**Files:**
- Modify: `apps/server/src/domain/history.ts`
- Modify: `apps/server/src/repositories/projectRepository.ts`
- Modify: `apps/server/src/repositories/jsonProjectRepository.ts`
- Modify: `apps/server/src/repositories/sqliteProjectRepository.ts`
- Modify: `apps/server/src/services/projectService.ts`
- Modify: `apps/server/tests/services/historyDomain.test.ts`
- Modify: `apps/server/tests/services/sqliteProjectRepository.test.ts`
- Modify: `apps/server/tests/api/contracts.test.ts`

- [x] Expose cursor encode/decode helpers while preserving the current opaque
  event-id contract.
- [x] Add `listHistoryPage({ projectIds, limit, cursor })` to the repository;
  JSON delegates to the domain paginator, SQLite resolves the cursor to an
  auto-increment sequence and queries `ORDER BY sequence DESC LIMIT n+1`.
- [x] Persist only newly appended audit events during aggregate mutation and
  never delete older SQL events when the in-memory compatibility window trims.
- [x] Insert publish/activate/rollback events into `releases` in the same
  transaction, including previous and selected version ids.
- [x] Add a test that writes more than 200 events over multiple mutations and
  retrieves every page without duplicates, then verifies the release ledger.
- [x] Make `ProjectService` use repository pagination after applying actor
  visibility; invalid/invisible cursors remain `INVALID_HISTORY_CURSOR`.
- [x] Run:
  `bun --filter @deploykit/server test tests/services/historyDomain.test.ts tests/services/sqliteProjectRepository.test.ts tests/api/contracts.test.ts`

## Task 4: Introduce durable, revocable browser and desktop sessions

**Files:**
- Create: `apps/server/src/repositories/sessionRepository.ts`
- Create: `apps/server/src/services/sessionService.ts`
- Modify: `apps/server/src/middleware/session.ts`
- Modify: `apps/server/src/services/contracts.ts`
- Modify: `apps/server/src/api.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `packages/shared/src/errors.ts`
- Modify: `apps/server/tests/services/session.test.ts`
- Create: `apps/server/tests/services/sessionRepository.test.ts`
- Create: `apps/server/tests/api/sessions.test.ts`
- Modify: `apps/server/tests/api/desktopAuth.test.ts`
- Modify: `apps/server/tests/api/helpers.ts`

- [x] Add failing token tests requiring `sub`, random `jti`, `kind`, and `exp`.
- [x] Add repository tests for create/list/active lookup/revoke/revoke-all/
  expiry cleanup and persistence across repository/app instances.
- [x] Add API tests proving logout immediately invalidates the same bearer
  token, restart does not invalidate a SQLite session, and revoking another
  user's session is impossible.
- [x] Make session middleware require both a valid signature and an active
  repository row, then load the current user role from persistence.
- [x] Make login/register create one browser session and desktop exchange one
  desktop session. Do not issue a different cookie token and response token.
- [x] Add authenticated `GET /api/auth/sessions`,
  `DELETE /api/auth/sessions/:sessionId`, and
  `POST /api/auth/logout-all`.
- [x] Keep JSON fixture mode explicit and in-memory; production/default SQLite
  uses durable rows.
- [x] Run:
  `bun --filter @deploykit/server test tests/services/session.test.ts tests/services/sessionRepository.test.ts tests/api/sessions.test.ts tests/api/desktopAuth.test.ts`

## Task 5: Phase gate, documentation, and remote checkpoint

**Files:**
- Modify: `README.md`
- Modify: `apps/server/README.md`
- Modify: `apps/server/.env.example`
- Modify: `docs/architecture.md`
- Modify: `docs/backend-hardening-roadmap.md`
- Modify: `docs/superpowers/plans/2026-07-30-revocable-sessions-relational-sqlite.md`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`

- [x] Run `bun run verify`.
- [x] Start an app against a copied legacy database, log in, publish, restart,
  confirm `/api/me`, revoke the session, and confirm the old token returns 401.
- [x] Inspect the migrated database with `PRAGMA foreign_key_check`,
  `PRAGMA integrity_check`, table counts, and release/audit ordering.
- [x] Update all architecture claims that still describe a single JSON row,
  200-event retention, or stateless sessions.
- [x] Commit each independently verified slice, then push `main` and confirm
  `origin/main` matches.
