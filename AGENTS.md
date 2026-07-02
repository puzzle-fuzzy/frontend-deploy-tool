# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What this is

DeployKit — a frontend-artifact deployment manager. Users upload a ZIP or a folder of built static files; the server extracts/flattens them, tracks versions, and serves the active version at `/deploy/{slug}/`. Requires only the Bun runtime — no database (JSON metadata + filesystem storage).

Bun workspace: `apps/server` (Hono + Bun backend), `apps/web` (React management panel), `packages/shared` (cross-app zod schemas + types).

## Commands

All commands run from the repo root.

| Command | What it does |
|---|---|
| `bun install` | Install workspace deps (Bun catalogs resolve versions) |
| `bun run dev` / `dev:server` | Backend only (API + deploy serving) on `:3000` |
| `bun run dev:web` | Frontend Vite dev server on `:5173`; `/api` proxies to `:3000` |
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
- `services/` — use cases (`projectService`, `versionService`, `artifactService`, `deployResolver`). Orchestrate domain rules + persistence + filesystem. The service *interfaces* live in `services/contracts.ts`.
- `domain/` — pure rules + schemas, no I/O. `project.ts` / `version.ts` / `history.ts` are pure functions; `schema.ts` does data migration; `schemas.ts` does request validation.
- `repositories/` — persistence. `projectRepository.ts` is the interface; `jsonProjectRepository.ts` is the only implementation (atomic write via temp-file + `rename`, migrates + backs up on load).
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

- `apps/server/data.json` — all metadata (projects, versions, history). Runtime/gitignored. Written atomically; migrated on load.
- `apps/server/.voasx/storage/{projectId}/{versionId}/` — flattened artifact files. The `.voasx` name is intentional; treat it as the storage root.
- `apps/server/public/` — management UI, populated by the packaging script (gitignored; empty in `dev:server`-only mode).

These paths are overridable via env (`config.ts`): `DATA_FILE`, `STORAGE_DIR`, `PUBLIC_DIR`, `PUBLIC_BASE_URL`, plus upload limits (`MAX_ZIP_SIZE`, `MAX_EXTRACTED_SIZE`, `MAX_FILE_COUNT`, `MAX_PATH_LENGTH`). Bad/missing env values fall back to safe defaults rather than throwing.

### Deploy serving

`/deploy/{slug}/` serves the **active** version; `/deploy/{slug}/{versionId}/` serves a specific version. `deployResolver.ts` picks the version and `safeJoin`s the requested subpath against the version root (rejects `..`/absolute escapes → 403). When `project.settings.spaMode` is on, a missing file falls back to that version's `index.html`.

### Build/packaging pipeline

Web builds to its own `apps/web/dist/` (package-local). The root `build` script then runs `scripts/package-web.ts`, which **mirrors** `dist/` into `apps/server/public/` (clearing stale assets first). So in production the same backend that owns the API also serves the UI. Don't point Vite's `outDir` directly at `server/public` — that coupling was intentionally removed.

### Active version invariant

A project has zero or one active version, tracked by `project.activeVersionId` (nullable). Do **not** re-introduce a per-version `active` boolean. Deleting the active version promotes a replacement via `chooseReplacementActiveVersionId` (`domain/version.ts`) — preserve this on edits.

## Conventions

- **Errors**: throw `new ApiError(ErrorCode.X, message, status?)` from anywhere; `app.onError` serializes it to `{ error: { code, message } }`. `status` is `400 | 401 | 403 | 404 | 500`. Add new codes to the `ErrorCode` const object in `errors.ts`.
- **Request validation**: prefer zod schemas in `domain/schemas.ts` that throw `ApiError`, wired through Hono `validator('json', ...)` or a `parse*` helper. Routes should receive already-typed values — no `as` casts.
- **History**: every mutating service call appends an event via `appendHistoryEvent` (capped at 200). New actions must be added to the `historyEventSchema` action enum in `shared`.
- **Auth + roles**: `/api` requires a session except login/logout. `admin`
  can create/delete projects; `developer` can upload, publish/rollback/delete
  versions, and edit project settings; `viewer` is read-only.
- **Formatting** (Biome, enforced in CI): single quotes, 2-space indent, LF, line width 80, ES5 trailing commas, semicolons always. Biome also lints (`noExplicitAny` warn, `noUnusedVariables` error, `noNonNullAssertion` warn). Run `bun run check:fix` before committing.
- **Tests**: server API tests in `apps/server/tests/api` drive the full app via `app.request()` with per-test temp dirs; service/domain unit tests in `apps/server/tests/services`. Web component/hook tests in `apps/web/tests/unit` (Vitest + RTL + jsdom). Don't colocate `*.test.ts` in `src/`.
- **Web stack**: React 19 + React Compiler, shadcn/ui (Radix) + Tailwind v4, react-router, i18next (zh/en under `src/i18n/locales`). `@` alias → `apps/web/src`. Uploads use a hand-written XHR in `shared/api.ts` (for progress events); all other calls use the typed `hono/client`.

## Reference docs

- `docs/architecture.md` — system overview, module boundaries, API contract, storage layout
- `docs/development.md` — workspace commands, test flow, local upload/preview
- `docs/vite-deployment.md` — `base` path, hash vs path routing, SPA fallback for deployed Vite apps
- `TODO.md` — product direction and the checklist driving the architecture (good context for *why* things are structured this way)
