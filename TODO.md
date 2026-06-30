# DeployKit TODO

This project is moving from a local Vite demo deployment tool toward an enterprise-grade frontend deployment platform. The near-term goal is not to overbuild, but to create stable architecture, reliable contracts, and a testable foundation.

## Product Direction

- [ ] Define the product name consistently. Current names include `DeployKit`, `Dist Deploy`, `deploykit-server`, and `deploykit-dashboard`.
- [ ] Clarify the first enterprise-grade scope:
  - [ ] Static frontend artifact hosting for Vite demos.
  - [ ] Project and version management.
  - [ ] Production version activation and version preview.
  - [ ] SPA fallback support.
  - [ ] Local-first operation first, enterprise hardening later.
- [ ] Decide storage evolution:
  - [ ] Phase 1: keep local file storage and metadata JSON, but wrap it behind repository interfaces.
  - [ ] Phase 2: evaluate SQLite or another embedded database when metadata grows.
  - [ ] Phase 3: support external object storage and database only when deployment targets require it.

## Current Critical Issues

- [ ] Fix broken text encoding in documentation and source comments.
  - [ ] `README.md`
  - [ ] `server/README.md`
  - [ ] `web/README.md`
  - [x] `server/main.ts`
  - [ ] `web/src/i18n/locales/zh.json`
  - [ ] Affected UI strings in React files.
- [x] Fix the settings API contract mismatch.
  - [x] Frontend sends `{ settings: { spaMode, routingType } }`.
  - [x] Backend currently expects top-level `{ spaMode, routingType }`.
  - [x] Prefer a dedicated endpoint: `PATCH /api/projects/:id/settings`.
- [x] Fix version activation behavior.
  - [x] Reject unknown `versionId` before mutating any project state.
  - [x] Prevent all versions from becoming inactive when activation fails.
  - [x] Reassign or clear active version when deleting the active version.
- [x] Fix upload response typing.
  - [x] Frontend expects `{ version: { id, name } }`.
  - [x] Backend currently returns the version object directly.
- [x] Remove or implement nonexistent frontend API methods.
  - [x] `api.getProject()` calls `GET /api/projects/:id`, which does not exist.
- [x] Fix server TypeScript configuration.
  - [x] `server/tsconfig.json` currently fails because `ignoreDeprecations: "6.0"` is invalid.
- [x] Remove hard-coded `3000` from frontend deployment URLs.
  - [x] Use `window.location.origin` for same-origin production.
  - [x] Use a config endpoint or env variable for non-same-origin deployments.

## Security And File Safety

- [x] Add safe path utilities.
  - [x] `safeJoin(root, relativePath)` must resolve and verify the final path remains inside `root`.
  - [x] Reject absolute paths, `..`, empty unsafe paths, and Windows drive path escapes.
- [ ] Harden folder upload.
  - [ ] Validate every `webkitRelativePath` before writing.
  - [ ] Normalize path separators.
  - [ ] Reject hidden system metadata where appropriate.
- [ ] Harden ZIP extraction.
  - [ ] Do not trust `tar -xf` blindly.
  - [ ] Detect path traversal entries.
  - [ ] Reject or ignore symlinks.
  - [x] Clean temporary files in both success and failure paths.
- [x] Add upload limits.
  - [x] Max ZIP size.
  - [x] Max extracted size.
  - [x] Max file count.
  - [x] Max path length.
- [x] Add safer static serving headers.
  - [x] Correct `Content-Type`.
  - [x] Cache policy for hashed assets.
  - [x] No-cache policy for HTML.
  - [x] Optional security headers for the management UI.

## Backend Architecture

- [x] Replace `server/main.ts` single-file backend with focused modules.
  - [x] `server/src/app.ts`: create and compose the Hono app.
  - [x] `server/src/index.ts`: runtime entrypoint and `Bun.serve`.
  - [x] `server/src/config.ts`: environment and path configuration.
  - [x] `server/src/domain/project.ts`: domain types and constants.
  - [x] `server/src/domain/version.ts`: version types and state rules.
  - [x] `server/src/repositories/projectRepository.ts`: repository interface.
  - [x] `server/src/repositories/jsonProjectRepository.ts`: JSON-backed implementation.
  - [x] `server/src/services/projectService.ts`: project use cases.
  - [x] `server/src/services/versionService.ts`: version upload, delete, and activation use cases.
  - [x] `server/src/services/artifactService.ts`: artifact write, extract, flatten, delete, and serve helpers.
  - [x] `server/src/services/deployResolver.ts`: map `/deploy/*` requests to safe artifact files.
  - [x] `server/src/routes/projects.ts`: project API routes.
  - [x] `server/src/routes/versions.ts`: version API routes.
  - [x] `server/src/routes/history.ts`: history API routes.
  - [x] `server/src/routes/deploy.ts`: deployment static route.
  - [x] `server/src/utils/id.ts`: ID generation.
  - [x] `server/src/utils/safePath.ts`: filesystem safety helpers.
  - [x] `server/src/utils/mime.ts`: MIME lookup.
- [ ] Introduce explicit domain invariants.
  - [ ] Prefer `project.activeVersionId` over `version.active`.
  - [x] A project can have zero or one active version.
  - [ ] A version must belong to exactly one project.
  - [ ] Slug must be unique.
- [ ] Introduce typed request validation.
  - [ ] Validate JSON bodies before passing to services.
  - [ ] Validate route params.
  - [ ] Return consistent API errors.
- [ ] Standardize API error format.
  - [ ] Example: `{ "error": { "code": "PROJECT_NOT_FOUND", "message": "Project not found" } }`.
- [x] Separate app creation from server startup.
  - [x] Required for `hono/testing`.
  - [x] Tests should import `createApp()` without opening a port.

## Hono Client Contract

- [x] Move route definitions into a typed Hono app export.
- [x] Use `hono/client` on the frontend instead of handwritten fetch wrappers where possible.
- [x] Keep a separate upload client path if progress events still require `XMLHttpRequest`.
- [x] Share API types from the backend package instead of duplicating `Project`, `Version`, and `Settings` manually.
- [x] Add contract tests for key endpoints.
  - [x] Project creation.
  - [x] Settings update.
  - [x] Version upload.
  - [x] Version activation.
  - [x] Deploy route fallback.

## Backend Testing

- [x] Add `hono/testing` based API tests.
  - [x] Test app creation without starting `Bun.serve`.
  - [x] Use temporary data and storage directories per test.
  - [x] Assert response status and JSON body shape.
- [ ] Add service-level tests.
  - [x] Slug validation.
  - [x] Active version invariant.
  - [x] Safe path rejection.
  - [x] JSON repository atomic writes.
- [x] Add artifact tests.
  - [x] Folder upload path normalization.
  - [x] ZIP extraction failure cleanup.
  - [x] SPA fallback returns `index.html`.
  - [x] Missing file returns 404 when SPA mode is off.
- [x] Add a backend test script.
  - [x] `bun test`
  - [ ] Optional coverage script later.

## Frontend Architecture

- [x] Split `web/src/pages/DeployPage.tsx`.
  - [x] `features/projects/ProjectList.tsx`
  - [x] `features/projects/CreateProjectDialog.tsx`
  - [x] `features/projects/useProjects.ts`
  - [x] `features/versions/VersionList.tsx`
  - [x] `features/versions/UploadVersionDialog.tsx`
  - [x] `features/settings/ProjectSettingsDialog.tsx`
  - [x] `features/deploy/DeployUrl.tsx`
  - [x] `features/theme/ThemeToggle.tsx`
  - [x] `features/i18n/LanguageToggle.tsx`
- [ ] Move shared frontend code under `web/src/shared`.
  - [ ] `shared/api`
  - [ ] `shared/types`
  - [ ] `shared/ui`
  - [ ] `shared/utils`
- [x] Remove imports from `../../node_modules/...`.
  - [x] Use package imports such as `react-i18next`.
  - [x] Fix `i18n/index.ts`.
  - [x] Fix all page components.
- [ ] Introduce a real client state strategy.
  - [x] Start with focused hooks.
  - [ ] Consider TanStack Query later if cache invalidation grows.
- [ ] Improve UI states.
  - [ ] Loading.
  - [ ] Empty.
  - [ ] Error.
  - [ ] Uploading.
  - [ ] Disabled states.
  - [ ] Confirmation flows.
- [ ] Replace custom toast if needed.
  - [ ] Keep custom toast for now if it remains simple.
  - [ ] Ensure it is accessible enough for keyboard and screen reader users.

## Frontend Testing

- [x] Add Vitest.
- [x] Add React Testing Library.
- [x] Add frontend unit tests.
  - [x] API client behavior.
  - [x] Project list rendering.
  - [x] Settings dialog save payload.
  - [x] Version list active state.
  - [x] Upload dialog file selection behavior.
- [ ] Add browser-level tests later.
  - [ ] Prefer Playwright when core flows stabilize.
  - [ ] Cover create project, upload version, activate version, and preview link.

## Monorepo And Tooling

- [x] Convert the repository to a Bun workspace.
  - [x] Root `package.json`.
  - [x] `workspaces`.
  - [ ] Root scripts for dev, build, test, lint, and typecheck.
- [x] Use Bun Catalogs for dependency versions.
  - [x] Centralize shared versions for Hono, React, TypeScript, Vite, ESLint, Vitest, and related packages.
  - [x] Remove package-level version drift.
- [x] Rename packages consistently.
  - [x] `@deploykit/server`
  - [x] `@deploykit/web`
  - [x] Optional future package: `@deploykit/shared`
- [x] Align package managers.
  - [x] Remove `packageManager: pnpm@...`.
  - [x] Use Bun consistently.
  - [x] Regenerate lockfile at the workspace root.
- [x] Add root quality scripts.
  - [x] `bun run dev`
  - [x] `bun run build`
  - [x] `bun run test`
  - [x] `bun run lint`
  - [x] `bun run typecheck`
- [x] Add formatting.
  - [x] Choose Biome or Prettier.
  - [x] Add root format and check scripts.
- [ ] Add CI later.
  - [ ] Install with Bun.
  - [ ] Typecheck.
  - [ ] Lint.
  - [ ] Unit tests.
  - [ ] Build server and web.

## Workspace Layout Migration

- [x] Move to a standard `apps/` + `packages/` workspace layout before deeper feature work.
  - [x] Use `apps/web` for the React management dashboard.
  - [x] Use `apps/server` for the Hono API and static artifact server.
  - [x] Use `packages/shared` for cross-app domain types, API schemas, constants, and pure utilities.
  - [ ] Use `packages/config` later only if shared eslint, tsconfig, or tooling config starts duplicating.
  - [ ] Do not introduce a top-level `services/` folder yet; backend service modules should live inside `apps/server/src/services`.
- [ ] Target folder structure:

  ```txt
  deploykit/
    apps/
      server/
        src/
          app.ts
          index.ts
          config.ts
          domain/
          repositories/
          routes/
          services/
          utils/
        tests/
          api/
          services/
          fixtures/
        package.json
        tsconfig.json
      web/
        src/
          app/
          features/
          shared/
          components/
        tests/
          unit/
          integration/
          fixtures/
        package.json
        vite.config.ts
        tsconfig.json
    packages/
      shared/
        src/
          api/
          domain/
          utils/
        tests/
        package.json
        tsconfig.json
    docs/
      architecture/
      development/
    package.json
    bun.lock
  ```

- [ ] Use a consistent test placement rule.
  - [ ] Package-level tests go in each workspace package's `tests/` directory.
  - [ ] Backend API tests go in `apps/server/tests/api`.
  - [ ] Backend service tests go in `apps/server/tests/services`.
  - [ ] Frontend component and hook tests go in `apps/web/tests/unit`.
  - [ ] Frontend flow tests go in `apps/web/tests/integration`.
  - [ ] Test fixtures go in `tests/fixtures` inside the package that owns them.
  - [ ] Avoid colocated `*.test.ts` files in `src/` unless a package becomes large enough to justify a different convention.
- [x] Update workspace config after moving folders.
  - [x] Change root `workspaces.packages` to `["apps/*", "packages/*"]`.
  - [x] Update root scripts to filter `@deploykit/server`, `@deploykit/web`, and `@deploykit/shared`.
  - [x] Update package names and path references without changing public behavior.
  - [x] Update Vite aliases after moving `web`.
  - [ ] Update TypeScript project references if introduced.
- [x] Move current tests into the new convention.
  - [x] Move `server/app.test.ts` to `apps/server/tests/api/app.test.ts`.
  - [x] Keep temporary directory fixtures local to the test file until a reusable helper is needed.
- [x] Migrate in a dedicated branch/commit at the right time.
  - [x] Best timing: immediately after Phase 1 workspace foundation and before Phase 2 backend module splitting.
  - [x] Reason: moving files after backend/frontend modules are split will create noisy diffs and harder reviews.
  - [x] Do not mix this migration with feature work, storage changes, or API contract changes.
- [ ] Verification for the layout migration.
  - [x] `bun install`
  - [x] `bun run test`
  - [x] `bun run typecheck`
  - [x] `bun run lint`
  - [x] `bun run build`
  - [x] Confirm no local data files or generated deployment artifacts are tracked.

## Build And Deployment Flow

- [x] Decouple web build output from `server/public`.
  - [x] Current `web/vite.config.ts` writes directly to `../server/public`.
  - [x] Prefer package-local `web/dist`.
  - [x] Add a packaging step that copies or mounts web assets into the server distribution.
- [x] Add clear local development modes.
  - [x] Backend only.
  - [x] Frontend dev server with API proxy.
  - [x] Production-like local server serving built web assets.
- [x] Add environment configuration.
  - [x] `PORT`
  - [x] `DATA_FILE`
  - [x] `STORAGE_DIR`
  - [x] `PUBLIC_DIR`
  - [x] `PUBLIC_BASE_URL`
- [x] Add project base path guidance for deployed Vite apps.
  - [x] Hash router apps work naturally.
  - [x] Path router apps must build with a compatible `base`.
  - [x] Document `/deploy/:slug/` and `/deploy/:slug/:versionId/` behavior.

## Data Model Evolution

- [ ] Define schema versioning for metadata.
  - [ ] `schemaVersion`.
  - [ ] Migration functions.
  - [ ] Backup before migration.
- [ ] Replace duplicated `version.active` with `project.activeVersionId`.
- [ ] Add version metadata.
  - [ ] Size.
  - [ ] File count.
  - [ ] Uploaded by.
  - [ ] Checksum.
  - [ ] Source type: `zip` or `folder`.
- [ ] Add project metadata.
  - [ ] Owner or team later.
  - [ ] Visibility later.
  - [ ] Deployment settings.
- [ ] Add operation history structure.
  - [ ] Stable event code.
  - [ ] Human-readable message generated by frontend i18n.
  - [ ] Event metadata object for future filtering.

## Enterprise Features Later

- [ ] Authentication.
  - [ ] Local admin token first.
  - [ ] Enterprise SSO later.
- [ ] Authorization.
  - [ ] Project-level permissions.
  - [ ] Team-level permissions.
- [ ] Audit logs.
  - [ ] Immutable append-only event log.
  - [ ] Export support.
- [ ] Deployment environments.
  - [ ] Preview.
  - [ ] Staging.
  - [ ] Production.
- [ ] Rollback.
  - [ ] One-click activate previous version.
  - [ ] Record rollback events.
- [ ] Retention policy.
  - [ ] Keep last N versions.
  - [ ] Delete versions older than N days.
- [ ] Artifact integrity.
  - [ ] Checksum verification.
  - [ ] Duplicate artifact detection.
- [ ] Observability.
  - [ ] Structured logs.
  - [ ] Request IDs.
  - [ ] Basic metrics.
- [ ] Deployment adapters.
  - [ ] Local filesystem.
  - [ ] S3-compatible object storage.
  - [ ] CDN integration.

## Documentation

- [x] Rewrite all README files in UTF-8.
- [x] Add architecture documentation.
  - [x] System overview.
  - [x] Backend module boundaries.
  - [x] API contract.
  - [x] Storage layout.
- [x] Add development guide.
  - [x] Bun workspace commands.
  - [x] Test commands.
  - [x] Local upload and preview workflow.
- [x] Add Vite app deployment guide.
  - [x] Recommended Vite `base` settings.
  - [x] Hash router vs path router.
  - [x] SPA fallback behavior.

## Suggested Execution Order

- [ ] Phase 0: Fix current breakages.
  - [ ] Encoding.
  - [x] TypeScript config.
  - [x] Settings API mismatch.
  - [x] Version activation invariant.
- [x] Phase 1: Introduce Bun workspace and package consistency.
  - [x] Root package.
  - [x] Bun Catalogs.
  - [x] Package renames.
  - [x] Root scripts.
- [ ] Phase 2: Split backend architecture.
  - [ ] `createApp()`.
  - [ ] Routes.
  - [ ] Services.
  - [ ] Repositories.
  - [ ] Safe filesystem utilities.
- [ ] Phase 3: Add backend tests with `hono/testing`.
- [x] Phase 4: Switch frontend API usage toward `hono/client`.
- [x] Phase 5: Split frontend feature modules and add Vitest tests.
- [x] Phase 6: Improve deployment packaging and documentation.
- [ ] Phase 7: Start enterprise features only after the core is tested and stable.
