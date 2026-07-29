# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What this is

DeployKit — a self-hosted frontend-artifact deployment manager. Users upload a ZIP or folder, preview versions, explicitly publish, and manually roll back. It requires Bun but no external database service: relational SQLite stores metadata/audit/releases/sessions and the local filesystem stores artifacts.

Bun workspace: `apps/server` (Hono + Bun backend), `apps/web` (React management panel), `packages/shared` (cross-app zod schemas + types).

## Commands

All commands run from the repo root.

| Command | What it does |
|---|---|
| `bun install` | Install workspace deps (Bun catalogs resolve versions) |
| `bun run dev` / `dev:server` | Backend only (API + deploy serving) on `:4010` |
| `bun run dev:web` | Frontend Vite dev server on `:5018`; `/api` proxies to `:4010` |
| `bun run ops -- ...` | Backup, verify, restore, GC, and artifact-integrity operations |
| `bun run build` | Build all workspaces, then `scripts/package-web.ts` mirrors `apps/web/dist` → `apps/server/public` |
| `bun run package` | Re-run just the web→server packaging step |
| `bun run test` | Run tests across all workspaces |
| `bun run typecheck` | `tsc --noEmit` / `tsc -b` in every workspace |
| `bun run lint` | ESLint — **web only** (`@deploykit/web`) |
| `bun run check` / `check:fix` | Biome lint+format across `apps/**` and `packages/**` |
| `bun run format` / `format:check` | Biome formatter (write / read-only) |

**Full-stack dev** = two terminals: `dev:server` + `dev:web`. In `dev:web` mode the panel talks to the real backend through the Vite proxy.

**Single test:**
- Server (bun:test): `bun --filter @deploykit/server test tests/api/contracts.test.ts` — add `-t "creates a project"` to filter by name.
- Web (Vitest): from `apps/web`, `bunx vitest run tests/unit/ProjectList.test.tsx` (use `run` to avoid watch mode), or `bunx vitest run -t "renders"`.

CI (`.github/workflows/ci.yml`) runs typecheck → lint → biome check → test → build on every PR.

## Architecture

### Backend layering (`apps/server/src`)

Request flow: **routes → services → domain → repositories**. Keep these layers separate — each has a single concern and the boundaries are load-bearing (see the "Bun-free type boundary" note below).

- `routes/` — Hono route handlers. Thin: parse/validate input, call a service, return JSON. Validation lives in `domain/schemas.ts` (zod, throws `ApiError`).
- `services/` — use cases (`projectService`, `versionService`, artifact recovery/integrity, storage reconciliation/GC, backup/restore, deploy resolution). Orchestrate domain rules + persistence + filesystem. The API-facing service *interfaces* live in `services/contracts.ts`.
- `domain/` — pure rules + schemas, no I/O. `project.ts` / `version.ts` / `history.ts` are pure functions; `schema.ts` does data migration; `schemas.ts` does request validation.
- `repositories/` — persistence. `sqliteProjectRepository.ts` is the default relational WAL implementation with `BEGIN IMMEDIATE`; `jsonProjectRepository.ts` remains only for legacy import and isolated tests.
- `utils/` — `id` (nanoid), `mime`, `safePath` (`safeJoin` enforces path traversal containment).

`app.ts` composes everything and layers the response pipeline: typed `/api` → deploy route → `onError` (maps `ApiError` → `{ error: { code, message } }`) → security headers (management UI only) → static serving → SPA fallback. `index.ts` only calls `loadConfig()` + `Bun.serve(createApp(config).fetch)`. **`createApp()` is deliberately split from `Bun.serve`** so tests call `app.request(path)` without binding a port.

### The Bun-free type boundary (most important convention)

`src/api.ts` exports `ApiApp = ReturnType<typeof createApiApp>`, and the **web app imports this type** via `@deploykit/server/api` to power `hono/client` (`apps/web/src/shared/api.ts`). For this import to type-check under the web build, `api.ts` and its transitive type dependencies (`services/contracts.ts`, the route modules, `errors.ts`) must be **free of Bun and Node runtime imports**.

Concretely:
- `services/contracts.ts` and `errors.ts` carry comments calling out this constraint — preserve it. Don't add `node:fs`, `bun:*`, etc. to modules in that type graph.
- The web tsconfig sets `erasableSyntaxOnly: true`, so shared types **must not use TS enums, parameter properties, or namespaces**. `errors.ts` implements `ErrorCode` as a plain `const` object + derived type for exactly this reason. Follow that pattern.

### Shared package is the single source of truth

`packages/shared/src/domain.ts` defines zod schemas (`projectSchema`, `versionSchema`, `settingsSchema`, `historyEventSchema`, `dataSchema`); all types are `z.infer`-ed from them. Both server and web import these. **When the data shape changes, change the schema here first.** Schemas are pure JS (no Bun/Node) so they type-check under both apps.

The server's `domain/schema.ts` adds a separate *lenient* `legacyDataSchema` + `migrate()` that upgrades old `data.json` files (e.g. the legacy per-version `active` flag → `project.activeVersionId`) and is idempotent. `CURRENT_SCHEMA_VERSION` is bumped there.

### Storage model

- `apps/server/deploykit.sqlite` — users, projects, members, versions, audit events, releases, and revocable sessions.
- `apps/server/data.json` — legacy import source only; imported once into an empty SQLite database.
- `apps/server/.voasx/storage/{projectId}/{versionId}/` — flattened artifact files, plus owned `.staging` and `.recovery` subtrees.
- `apps/server/public/` — management UI, populated by the packaging script (gitignored; empty in `dev:server`-only mode).

These paths are overridable via env (`config.ts`): `DATABASE_FILE`, `DATA_FILE`,
`STORAGE_DIR`, `PUBLIC_DIR`, plus trust-zone URLs, upload budgets, storage
quotas, and retention windows. Multipart size,
ZIP/extracted size, entry count, path length, compression ratio, and global /
user / project concurrency limits are all server-enforced. Invalid explicit
values throw; safe defaults apply only when a value is omitted.

Deletion is two-phase: artifacts move into `.recovery/trash` before metadata
commits and are restored if the transaction fails. Only expired committed trash
is garbage-collected. Restore requires a verified backup and `--force`, and the
server must be stopped first.

### Deploy serving

`/deploy/{slug}/` serves the **active** version; `/deploy/{slug}/{versionId}/` serves a specific version. `deployResolver.ts` picks the version and `safeJoin`s the requested subpath against the version root (rejects `..`/absolute escapes → 403). When `project.settings.spaMode` is on, a missing file falls back to that version's `index.html`.

### Build/packaging pipeline

Web builds to its own `apps/web/dist/` (package-local). The root `build` script then runs `scripts/package-web.ts`, which **mirrors** `dist/` into `apps/server/public/` (clearing stale assets first). So in production the same backend that owns the API also serves the UI. Don't point Vite's `outDir` directly at `server/public` — that coupling was intentionally removed.

### Active version invariant

A project has zero or one active version, tracked by `project.activeVersionId` (nullable). Do **not** re-introduce a per-version `active` boolean. Only an explicit publish, rollback, or compatibility activate command may select an active version, and every release command must carry the caller's observed `expectedActiveVersionId`. Deleting the active version unpublishes the project; it must never promote a replacement implicitly.

## Conventions

- **Errors**: throw `new ApiError(ErrorCode.X, message, status?)` from anywhere; `app.onError` serializes it to `{ error: { code, message } }`. Supported statuses are declared by `ApiError`; use `409` for optimistic release conflicts, `413` for request limits, and `429` for exhausted upload capacity. Add new codes to `packages/shared/src/errors.ts`.
- **Request validation**: prefer zod schemas in `domain/schemas.ts` that throw `ApiError`, wired through Hono `validator('json', ...)` or a `parse*` helper. Routes should receive already-typed values — no `as` casts.
- **History**: every mutating service call appends an event via `appendHistoryEvent`; SQLite persists new events append-only and pages by database sequence. The aggregate's 200-event window is only a compatibility buffer and must never delete older SQL rows. New actions must be added to `historyEventSchema`; release actions also populate `releases`.
- **Auth + roles**: `/api` requires a session except login/register/logout and
  desktop exchange. `admin` can read/manage every project; `developer` can
  create projects and can write only projects where it has the required
  `owner/member` role; `viewer` is read-only and sees only its memberships.
  Keep read scoping in `ProjectService`, not only in route middleware.
- **Sessions**: signed browser/desktop tokens must contain a `jti` backed by an
  active `sessions` row. Logout revokes before clearing transport state; never
  restore stateless bearer acceptance or trust the role embedded in a token.
- **Formatting** (Biome, enforced in CI): single quotes, 2-space indent, LF, line width 80, ES5 trailing commas, semicolons always. Biome also lints (`noExplicitAny` warn, `noUnusedVariables` error, `noNonNullAssertion` warn). Run `bun run check:fix` before committing.
- **Tests**: server API tests in `apps/server/tests/api` drive the full app via `app.request()` with per-test temp dirs; service/domain unit tests in `apps/server/tests/services`. Web component/hook tests in `apps/web/tests/unit` (Vitest + RTL + jsdom). Don't colocate `*.test.ts` in `src/`.
- **Web stack**: React 19 + React Compiler, shadcn/ui (Radix) + Tailwind v4, react-router, i18next (zh/en under `src/i18n/locales`). `@` alias → `apps/web/src`. Uploads use a hand-written XHR in `shared/api.ts` (for progress events); all other calls use the typed `hono/client`.

## Reference docs

- `docs/architecture.md` — system overview, module boundaries, API contract, storage layout
- `docs/development.md` — workspace commands, test flow, local upload/preview
- `docs/vite-deployment.md` — `base` path, hash vs path routing, SPA fallback for deployed Vite apps
- `TODO.md` — product direction and the checklist driving the architecture (good context for *why* things are structured this way)
