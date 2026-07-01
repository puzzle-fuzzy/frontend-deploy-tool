# DeployKit TODO

> **Direction:** an internal, enterprise-grade frontend deployment platform —
> 项目清晰、版本可靠、发布可控、回滚迅速、权限明确、日志完整.
> The foundation (workspace, backend layering, typed contracts, tests, deploy
> serving, schema migration) is already in place. This file tracks what remains,
> prioritized P0 → P4.
>
> **Reference docs**
> - `docs/enterprise-frontend-deploy-goals.md` — product goals & acceptance criteria
> - `docs/enterprise-frontend-deploy-plan.md` — phased plan (Phase 1-4)
> - `docs/superpowers/specs/2026-07-01-version-audit-design.md` — designed, not yet built

## Completed baseline (foundation already shipped)

- Bun workspace (`apps/server`, `apps/web`, `packages/shared`) with Catalogs, Biome, CI.
- Layered backend: routes → services → domain → repositories; `createApp()` split from `Bun.serve`.
- Typed API via `hono/client`; shared zod schemas as the single source of truth; contract tests.
- Project CRUD + settings; version upload (zip/folder) with flatten, size/fileCount/sourceType metadata.
- Active-version pointer model (`activeVersionId`); deleting the active version promotes a replacement.
- Deploy serving: `/deploy/{slug}/` (active) + `/deploy/{slug}/{versionId}/` (preview); SPA fallback.
- Cache policy matching the enterprise spec (HTML `no-cache`; hashed assets `public, max-age=31536000, immutable`).
- Safe-path utilities, upload limits (zip/extracted/count/path-length), security headers on the management UI.
- Schema versioning + idempotent migration + backup-on-load.
- i18n (zh/en), theme toggle, React 19 + shadcn/ui panel with loading/empty/error/uploading states.

---

## P0 — Upload safety & the "upload ≠ go-live" gate

Enterprise docs §6.1, §7.4, Phase 1 acceptance. Quick, high-value, currently missing.

- [x] Block dangerous files at upload (both zip extraction and folder write).
  - Current `SYSTEM_METADATA` ([artifactService.ts:21](apps/server/src/services/artifactService.ts#L21)) only catches OS junk (`.DS_Store`, `Thumbs.db`, `__MACOSX`, `._*`).
  - Reject entries whose path contains: `.env` / `.env.*`, `*.pem`, `*.key`, `id_rsa`, `.git/`, `node_modules/`, `.svn/`, `.hg/`.
  - Tests: a zip and a folder upload containing `.env` / `.git/` / `id_rsa` are rejected with a clear error code.
- [x] Require `index.html` after extraction/flatten; reject the upload if it is absent.
  - Today `flattenOutput` ([artifactService.ts:78](apps/server/src/services/artifactService.ts#L78)) silently no-ops when no `index.html` exists anywhere → upload succeeds, deploy 404s.
  - Phase 1 acceptance: "没有 index.html 时上传失败".
  - Note: Version Audit (P4) detects a missing `index.html` at *audit* time; this is the *upload*-time gate and must exist independently.
- [x] Stop auto-publishing the first version.
  - Today the first upload sets `activeVersionId` immediately ([versionService.ts:142](apps/server/src/services/versionService.ts#L142)), violating principle §6.1 "上传≠上线".
  - Change: every upload (including the first) creates a **preview-only** version; production is reached only by an explicit publish action.
  - The `no-active` state already returns 404 "No active version" ([deployResolver.ts:37](apps/server/src/services/deployResolver.ts#L37)), so a project with versions but no active version is already handled server-side.
  - Update affected server tests (first-upload activation assertions) and surface "no production version yet" in the UI.

## P1 — Authentication, users & permissions

Enterprise docs §7.9, plan Phase 1 §2.1. Elevated to near-term per product direction.

- [x] Add a simple login flow + session.
  - `POST /api/auth/login`, `GET /api/me`; login-state retention.
  - Start with a seeded admin account / local admin token; enterprise SSO is later.
- [x] Add Phase 1 roles: `admin` / `developer` / `viewer`.
  - Permission middleware on mutating routes: create project, upload, publish/rollback, delete, edit settings, manage members.
  - Phase 1 acceptance: "非授权用户不能发布正式环境".
- [x] Record `actorId` on history events once users exist.
  - Wire `actorId` into `appendHistoryEvent`; backfill as `system` for legacy events.
  - Unblocks `uploadedBy` / `publishedBy` version metadata in P2.

## P2 — Version model, publish semantics & audit completeness

Enterprise docs §6.2–6.5, §7.3, §7.5, §7.10.

- [x] Add an explicit version `status` field: `preview | production | archived | failed`.
  - Today "production" is implicit (`activeVersionId === v.id`). Make it first-class to match the enterprise model and to support filtering / UI badges / archived state.
  - Migration: derive initial `status` from the existing `activeVersionId`.
- [x] Track publish metadata on versions: `publishedAt`, `publishedBy` (needs P1), `checksum` (sha256 of the upload), and a later `commit` / CI slot.
  - `checksum` and the field scaffolding can land before auth; `uploadedBy` / `publishedBy` wait for P1.
- [x] Make rollback a distinct action.
  - Add a `version.rollback` history event; either treat "activate a version older than the current active one" as rollback, or add an explicit endpoint (`POST /api/projects/:id/versions/:versionId/rollback`).
  - The audit log must show "谁回滚到哪个版本".
- [x] Record history for project-info and settings edits.
  - `updateProject` ([projectService.ts:79](apps/server/src/services/projectService.ts#L79)) and `updateProjectSettings` currently append no history event.
  - Add `project.update` / `project.update_settings` to the history action enum in `packages/shared`.
- [x] Add per-project audit-log filtering.
  - Today only global `/api/history` exists. Add `GET /api/projects/:id/history` (or a `?projectId=` filter) for the project-detail "日志" tab.
- [x] Add confirmation dialogs for publish & rollback.
  - Delete already confirms ([VersionList.tsx:137](apps/web/src/features/versions/VersionList.tsx#L137)); publish (activate) is one-click today. Enterprise docs require 二次确认 for both publish and rollback.

## P3 — Ops & deployment packaging

Enterprise docs §10, plan "运维". Currently absent from the repo entirely.

- [ ] Multi-stage `Dockerfile` for the Bun app (build web → package into `apps/server/public` → run a single server image).
- [ ] `docker-compose.yml` with volumes for `data.json` and the `.voasx/storage` tree; surface upload limits (`MAX_ZIP_SIZE`, `MAX_EXTRACTED_SIZE`, `MAX_FILE_COUNT`) as compose env.
- [ ] Nginx reverse-proxy reference config: immutable caching for hashed assets, `no-cache` for `index.html`, large `client_max_body_size` for uploads, SPA-fallback passthrough.
- [ ] Backup/restore procedure for `data.json` + storage (scheduled snapshot/rsync; document restore).

## P4 — Version Audit (designed, ready to implement)

Design: `docs/superpowers/specs/2026-07-01-version-audit-design.md`; plan: `docs/superpowers/plans/2026-07-01-version-audit.md`.

- [ ] Phase 1: static artifact audit (metadata / SEO / links / images / social / assets / deploy checks); `POST /api/projects/:id/versions/:versionId/audit`; Audit tab beside the Versions list.
  - Shared contract in `packages/shared`; `cheerio` for parsing; ephemeral reports (no schema change).
- [ ] Phase 2: rendered DOM audit (Playwright).
- [ ] Phase 3: persisted audit reports + history.
- [ ] Phase 4: release gates (block activation on errors; manual override recorded as a history event).

---

## Later (Phase 2+ of the enterprise plan)

- [ ] Deployment environments: add Staging alongside Production (each points at a version). §7.2, plan Phase 2.
- [ ] Member management & finer roles (`owner / admin / developer / tester / viewer`). Plan Phase 2 (needs P1).
- [ ] Version retention policy: keep last N / younger than N days; never auto-delete production history; manual version lock. Plan Phase 4.
- [ ] Observability: structured logs, request IDs, basic metrics. §Enterprise "Observability".
- [ ] Deployment adapters: abstract artifact storage behind an interface, then add S3 / OSS / MinIO. (The metadata repo is already behind `ProjectRepository`; artifact I/O in `artifactService` is not.)
- [ ] API token + CI upload + CLI + Webhook + Git info on versions. Plan Phase 3.
- [ ] Custom domains, access control (password / IP allowlist), release notifications. Plan Phase 4.

## Non-goals (YAGNI — deliberately not doing)

- Project `type` field (React / Vue / Astro / …) — the audit profile already captures intent; a cosmetic label isn't worth the schema churn.
- Renaming the preview URL to `/deploy/{slug}/preview/{id}/` — the current `/deploy/{slug}/{id}/` works; renaming is pure churn.
- Renaming the API resource `versions` → `deployments` — churn with no behavior gain.
