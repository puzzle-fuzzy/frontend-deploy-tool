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
> - `docs/superpowers/specs/2026-07-01-version-audit-design.md` — original audit design; durable queue and release gates are shipped

## Completed baseline (foundation already shipped)

- Bun workspace (`apps/server`, `apps/web`, `packages/shared`) with Catalogs, Biome, CI.
- Layered backend: routes → services → domain → repositories; `createApp()` split from `Bun.serve`.
- Typed session management API via `hono/client`; the dedicated CI router has
  its own explicit contract and isolation tests.
- Project CRUD + settings; version upload (zip/folder) with flatten, size/fileCount/sourceType metadata.
- Active-version pointer model (`activeVersionId`); deleting the active version leaves the project unpublished and never promotes a replacement.
- Deploy serving: `/deploy/{slug}/` (active) + `/deploy/{slug}/{versionId}/` (preview); SPA fallback.
- Cache policy matching the enterprise spec (HTML `no-cache`; hashed assets `public, max-age=31536000, immutable`).
- Safe-path utilities, upload limits (zip/extracted/count/path-length), security headers on the management UI.
- Schema versioning + idempotent migration + backup-on-load.
- i18n (zh/en), theme toggle, React 19 + shadcn/ui panel with loading/empty/error/uploading states.
- Project owner/admin API Token lifecycle (create/list/rotate/revoke/security events);
  plaintext is returned only by create/rotate and v1 scope is only
  `preview:upload`.
- Dedicated `POST /api/ci/projects/:id/versions` route with session/token
  isolation, 24-hour SQLite idempotency, shared upload limits, and preview-only
  semantics. Production still requires a user session and explicit
  compare-and-set publish.

---

## P0 — Upload safety & the "upload ≠ go-live" gate

Enterprise docs §6.1, §7.4, Phase 1 acceptance. Quick, high-value, currently missing.

- [x] Block dangerous files at upload (both zip extraction and folder write).
  - ZIP and folder uploads reject `.env` / `.env.*`, `*.pem`, `*.key`,
    `id_rsa`, `.git/`, `node_modules/`, `.svn/` and `.hg/`, while still
    ignoring ordinary OS metadata.
  - Tests cover both upload forms and stable rejection codes.
- [x] Require `index.html` after extraction/flatten; reject the upload if it is absent.
  - This is an upload-time structural gate; audit-time checks remain a
    separate defense.
- [x] Stop auto-publishing the first version.
  - Every upload, including the first, now creates a **preview-only** version;
    production is reached only through an explicit publish action.
  - A project with previews but no active version remains intentionally
    unpublished and returns the existing no-active response.

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
  - Delete, publish and rollback share the
    [ConfirmDialog flow](packages/client/src/features/versions/VersionList.tsx#L140).

## P3 — Ops & deployment packaging

Enterprise docs §10, plan "运维". Native backup/recovery is shipped; container
and reverse-proxy packaging remains.

- [ ] Multi-stage `Dockerfile` for the Bun app (build web → package into `apps/server/public` → run a single server image).
- [ ] `docker-compose.yml` with persistent volumes for `deploykit.sqlite*` and
  `.voasx/storage`; surface upload limits as compose env.
- [ ] Nginx reverse-proxy reference config: immutable caching for hashed assets, `no-cache` for `index.html`, large `client_max_body_size` for uploads, SPA-fallback passthrough.
- [x] SQLite + storage backup/verify/restore commands and recovery procedure.

## P4 — Version Audit (durable foundation shipped; UI/rule depth next)

Design: `docs/superpowers/specs/2026-07-01-version-audit-design.md`; plan: `docs/superpowers/plans/2026-07-01-version-audit.md`.

- [x] Static artifact audit for HTML metadata/SEO/social metadata, file
  inventory, entry/checksum structure, and total/file-count/largest-file
  budgets.
- [x] SQLite-backed artifact audit queue with deduplication, leases, retries,
  cancellation, process isolation and restart recovery.
- [x] Persist current reports and long-term history; bind freshness to artifact
  checksum, engine version and policy snapshot.
- [x] Advisory/blocking release policy and publish/rollback gates.
- [ ] Add the management-panel Audit view for queue state, polling,
  cancellation, findings and policy explanation.
- [ ] Deepen SEO and bundle-size detection on the **existing artifact audit
  queue**: validate internal-link targets and actual image files, add
  JS/CSS/font-specific budgets, and version new rules without rebuilding the
  already shipped total/file-count/largest-file checks. Do not build a second
  queue.
- [ ] Consider rendered-DOM auditing only after the static queue UI and rule
  contracts are complete; it must remain isolated and separately budgeted.

---

## Later (Phase 2+ of the enterprise plan)

- [ ] Deployment environments: add Staging alongside Production (each points at a version). §7.2, plan Phase 2.
- [ ] Member management & finer roles (`owner / admin / developer / tester / viewer`). Plan Phase 2 (needs P1).
- [ ] Version retention policy: keep last N / younger than N days; never auto-delete production history; manual version lock. Plan Phase 4.
- [x] Observability: structured logs, request IDs, protected low-cardinality metrics and graceful shutdown. §Enterprise "Observability".
- [ ] Deployment adapters: abstract artifact storage behind an interface, then add S3 / OSS / MinIO. (The metadata repo is already behind `ProjectRepository`; artifact I/O in `artifactService` is not.)
- [x] Project API Token + idempotent CI Preview upload. Plan Phase 3.
- [ ] CLI wrapper, Webhook and Git info on versions. These must not add
  staging/production Token scopes or automatic production publishing.
- [ ] Custom domains, access control (password / IP allowlist), release notifications. Plan Phase 4.

## Non-goals (YAGNI — deliberately not doing)

- Project `type` field (React / Vue / Astro / …) — the audit profile already captures intent; a cosmetic label isn't worth the schema churn.
- Renaming the preview URL to `/deploy/{slug}/preview/{id}/` — the current `/deploy/{slug}/{id}/` works; renaming is pure churn.
- Renaming the API resource `versions` → `deployments` — churn with no behavior gain.


### 后续思考部分（合理的思考）

1. cookie 和 bearer 方面的思考
2. 有关 bun workspace 的设计，catalog 方面，是不是需要将所有的包都写在 root 的 package.json 里面
3. 项目中有关文档 markdown 的整理
4. 项目中有关架构的设计。

现在请你查看一下这个项目，主要还是关注于 web端，服务端，和桌面端的认证方式，现在就是桌面端现在登陆后一直出现 Error invoking remote method 'api:listProjects': ServerError: Authentication required 等有关认证的问题，应该是electron对cookie 的存储还存在问题，我在思考，这个项目是改为使用 bearer 好还是延续使用 cookie 好呢。请你合理正确的分析这个问题。
