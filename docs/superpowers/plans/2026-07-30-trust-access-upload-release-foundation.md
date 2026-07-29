# Trust, Access, Upload, and Release Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the security and release invariants required before DeployKit's persistence and artifact-audit features can safely grow.

**Architecture:** Keep one Bun/Hono process but route requests through two browser trust zones: a trusted management/API origin and a separate untrusted deploy origin. Put project visibility and mutation decisions behind a single policy module, bound multipart and ZIP work before it can exhaust memory or disk, and make publish/rollback the only operations that select an active version.

**Tech Stack:** Bun 1.3, TypeScript, Hono 4, SQLite, fflate, Zod, bun:test

## Global Constraints

- Preserve the route → service → domain → repository layering.
- Keep `apps/server/src/api.ts` and its transitive type graph free of Bun and Node runtime imports.
- Keep one Bun/Hono server process and the existing SQLite/local-filesystem deployment model.
- Upload never publishes a version.
- Only explicit publish and rollback operations may select an active version.
- Production must fail closed when management and deploy origins are absent or equal.
- Existing metadata and artifacts must remain readable.
- Every task uses failing tests first and ends with an independently verifiable commit.

---

## File Map

- `apps/server/src/config.ts`: parse and validate management/deploy origins and upload budgets.
- `apps/server/src/middleware/trustBoundary.ts`: enforce host/path separation for trusted and untrusted routes.
- `packages/client/src/api/fetchApiClient.ts`: use cookie sessions only in the browser.
- `packages/client/src/shared/config.ts`: expose the deploy base URL to generated links.
- `apps/server/src/domain/authorization.ts`: pure project visibility and role decisions.
- `apps/server/src/middleware/auth.ts`: adapt the pure policy to Hono route guards.
- `apps/server/src/services/contracts.ts`: actor-aware service signatures.
- `apps/server/src/services/projectService.ts`: enforce actor-aware reads at the service boundary.
- `apps/server/src/routes/projects.ts`: apply global create policy and actor-aware reads.
- `apps/server/src/routes/history.ts`: return only visible audit events.
- `apps/server/src/routes/userSearch.ts`: limit user discovery to project owners and admins.
- `apps/server/src/middleware/uploadLimits.ts`: bound multipart request size and concurrent uploads.
- `apps/server/src/services/artifactService.ts`: stream ZIP extraction with cumulative budgets.
- `apps/server/src/services/versionService.ts`: validate publish targets and explicit unpublish-on-delete.
- `apps/server/src/domain/version.ts`: pure release state transitions.
- `packages/shared/src/errors.ts`: stable machine-readable conflict and upload-limit errors.
- `apps/server/tests/api/securityBoundary.test.ts`: trust-zone contract tests.
- `apps/server/tests/api/permissions.test.ts`: project visibility and mutation matrix.
- `apps/server/tests/api/uploadLimits.test.ts`: request and concurrency limits.
- `apps/server/tests/services/artifactService.test.ts`: adversarial ZIP budget tests.
- `apps/server/tests/services/versionService.test.ts`: publish and delete invariants.

### Task 1: Separate trusted management traffic from untrusted artifacts

**Files:**
- Modify: `apps/server/src/config.ts`
- Create: `apps/server/src/middleware/trustBoundary.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `packages/client/src/api/fetchApiClient.ts`
- Modify: `packages/client/src/shared/config.ts`
- Modify: `apps/server/tests/services/config.test.ts`
- Create: `apps/server/tests/api/securityBoundary.test.ts`
- Modify: `packages/client/tests/unit/config.test.ts`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/development.md`

**Interfaces:**
- Produces: `managementBaseURL?: string` and `deployBaseURL?: string` on `AppConfig`.
- Produces: `createTrustBoundary(config: Pick<AppConfig, 'managementBaseURL' | 'deployBaseURL' | 'environment'>): MiddlewareHandler`.
- Produces: `deployBaseURL` in the shared browser configuration.

- [x] **Step 1: Write failing production configuration tests**

```ts
expect(() =>
  loadConfig({
    appDir,
    env: {
      DEPLOYKIT_ENV: 'production',
      SESSION_SECRET: 's'.repeat(32),
      ADMIN_PASSWORD: 'admin-password',
      MANAGEMENT_BASE_URL: 'https://console.example.com',
      DEPLOY_BASE_URL: 'https://console.example.com',
    },
  })
).toThrow('must use different origins');
```

- [x] **Step 2: Run configuration tests and observe the missing invariant**

Run: `bun --filter @deploykit/server test tests/services/config.test.ts`

Expected: FAIL because the two origin fields and validation do not exist.

- [x] **Step 3: Parse exact origins and fail closed in production**

Add the two optional fields to `AppConfig`, parse `MANAGEMENT_BASE_URL` and
`DEPLOY_BASE_URL` with the existing absolute-URL rules, normalize each to
`new URL(value).origin`, and require both distinct origins in production.
Derive `secureCookies` from `managementBaseURL`.

```ts
if (environment === 'production') {
  if (!config.managementBaseURL || !config.deployBaseURL) {
    throw new Error(
      'MANAGEMENT_BASE_URL and DEPLOY_BASE_URL are required in production'
    );
  }
  if (
    new URL(config.managementBaseURL).origin ===
    new URL(config.deployBaseURL).origin
  ) {
    throw new Error(
      'MANAGEMENT_BASE_URL and DEPLOY_BASE_URL must use different origins'
    );
  }
}
```

- [x] **Step 4: Write failing host-boundary API tests**

```ts
const management = { headers: { Host: 'console.example.test' } };
const deploy = { headers: { Host: 'assets.example.test' } };

expect((await app.request('/api/me', management)).status).toBe(401);
expect((await app.request('/api/me', deploy)).status).toBe(404);
expect((await app.request('/deploy/demo/', management)).status).toBe(404);
expect((await app.request('/deploy/demo/', deploy)).status).not.toBe(404);
```

- [x] **Step 5: Implement the trust-boundary middleware**

Compare `new URL(c.req.url).origin` with the configured origins. On the deploy
origin, permit only `/deploy/*` and `/health/*`; on the management origin,
reject `/deploy/*`. Return 404 rather than exposing the existence of trusted
routes. When origins are unset in development/test, preserve the legacy
same-origin behavior.

```ts
export function createTrustBoundary(
  config: Pick<
    AppConfig,
    'environment' | 'managementBaseURL' | 'deployBaseURL'
  >
): MiddlewareHandler {
  return async (c, next) => {
    if (!config.managementBaseURL || !config.deployBaseURL) {
      await next();
      return;
    }
    const origin = new URL(c.req.url).origin;
    const isDeployPath = c.req.path.startsWith('/deploy/');
    if (origin === new URL(config.deployBaseURL).origin && !isDeployPath) {
      return c.notFound();
    }
    if (origin !== new URL(config.deployBaseURL).origin && isDeployPath) {
      return c.notFound();
    }
    await next();
  };
}
```

- [x] **Step 6: Remove browser bearer-token persistence**

Delete `deploykit.auth.token`, `authToken`, `getAuthHeaders`, and all browser
`Authorization` handling. Keep the server's HttpOnly cookie and make XHR upload
send credentials.

```ts
xhr.open('POST', `/api/projects/${projectId}/versions`);
xhr.withCredentials = true;
```

Login and register return `body.user`; the browser ignores a legacy `token`
field so desktop compatibility is unchanged until durable device sessions land.

- [x] **Step 7: Point deploy links at the deploy origin**

Read `VITE_DEPLOY_BASE_URL`, retain `VITE_PUBLIC_BASE_URL` as a temporary
compatibility input, normalize trailing slashes, and fall back to `''` only in
development.

```ts
const configured =
  import.meta.env.VITE_DEPLOY_BASE_URL ??
  import.meta.env.VITE_PUBLIC_BASE_URL;
```

- [x] **Step 8: Run focused and full verification**

Run: `bun --filter @deploykit/server test tests/services/config.test.ts tests/api/securityBoundary.test.ts`

Run: `bun --filter @deploykit/client test tests/unit/config.test.ts`

Run: `bun run verify`

Expected: all commands exit 0.

- [x] **Step 9: Commit the trust-boundary slice**

```bash
git add apps/server/src/config.ts apps/server/src/middleware/trustBoundary.ts apps/server/src/app.ts apps/server/tests/services/config.test.ts apps/server/tests/api/securityBoundary.test.ts packages/client/src/api/fetchApiClient.ts packages/client/src/shared/config.ts packages/client/tests/unit/config.test.ts README.md docs/architecture.md docs/development.md
git commit -m "security: isolate deployed artifacts from management"
```

### Task 2: Centralize actor-aware project authorization

**Files:**
- Create: `apps/server/src/domain/authorization.ts`
- Modify: `apps/server/src/middleware/auth.ts`
- Modify: `apps/server/src/services/contracts.ts`
- Modify: `apps/server/src/services/projectService.ts`
- Modify: `apps/server/src/routes/projects.ts`
- Modify: `apps/server/src/routes/history.ts`
- Modify: `apps/server/src/routes/userSearch.ts`
- Modify: `apps/server/src/routes/members.ts`
- Modify: `apps/server/src/api.ts`
- Modify: `apps/server/tests/api/permissions.test.ts`
- Create: `apps/server/tests/services/authorization.test.ts`

**Interfaces:**
- Produces: `type Actor = Pick<SafeUser, 'id' | 'role'>`.
- Produces: `canReadProject(actor: Actor, project: Project): boolean`.
- Produces: `canCreateProject(actor: Actor): boolean`.
- Produces: `hasProjectRole(actor: Actor, project: Project, role: 'member' | 'owner'): boolean`.
- Changes: project read/history service methods receive an `Actor`.

- [x] **Step 1: Write failing pure policy tests**

```ts
expect(canReadProject(admin, project)).toBe(true);
expect(canReadProject(member, project)).toBe(true);
expect(canReadProject(stranger, project)).toBe(false);
expect(canCreateProject(developer)).toBe(true);
expect(canCreateProject(viewer)).toBe(false);
expect(hasProjectRole(admin, project, 'owner')).toBe(true);
```

- [x] **Step 2: Run the policy tests**

Run: `bun --filter @deploykit/server test tests/services/authorization.test.ts`

Expected: FAIL because `domain/authorization.ts` does not exist.

- [x] **Step 3: Implement the pure policy**

```ts
export function canReadProject(actor: Actor, project: Project): boolean {
  return (
    actor.role === 'admin' ||
    project.members.some((member) => member.userId === actor.id)
  );
}

export function canCreateProject(actor: Actor): boolean {
  return actor.role === 'admin' || actor.role === 'developer';
}

export function hasProjectRole(
  actor: Actor,
  project: Project,
  minimum: 'member' | 'owner'
): boolean {
  if (actor.role === 'admin') return true;
  const membership = project.members.find(
    (member) => member.userId === actor.id
  );
  return Boolean(
    membership &&
      (minimum === 'member' || membership.role === 'owner')
  );
}
```

- [x] **Step 4: Write failing API matrix tests**

Cover these exact outcomes:

```ts
expect(await projectIds(listAs(ownerCookie))).toEqual([project.id]);
expect(await projectIds(listAs(memberCookie))).toEqual([project.id]);
expect(await projectIds(listAs(strangerCookie))).toEqual([]);
expect((await versionsAs(strangerCookie, project.id)).status).toBe(403);
expect((await historyAs(strangerCookie, project.id)).status).toBe(403);
expect((await globalHistoryAs(strangerCookie)).json()).toMatchObject({
  items: [],
});
expect((await createProjectAs(viewerCookie)).status).toBe(403);
expect((await searchUsersAs(memberCookie)).status).toBe(403);
expect((await searchUsersAs(ownerCookie)).status).toBe(200);
```

- [x] **Step 5: Move read scoping into the service contract**

Use actor-aware signatures so a new route cannot accidentally bypass policy.

```ts
listProjects(actor: Actor): Project[];
getProjectForActor(id: string, actor: Actor): Project;
listHistory(actor: Actor, limit?: string, cursor?: string): HistoryPage;
listProjectHistory(
  projectId: string,
  actor: Actor,
  limit?: string,
  cursor?: string
): HistoryPage;
```

Keep `getProject(id)` for internal deploy lookup and route guards only.

- [x] **Step 6: Apply the policy to every route**

Require `developer` for project creation. Pass the authenticated user to list,
version-list, and history methods. Restrict user search to admins or an owner of
the project identified by a required `projectId` query parameter.

For ownership transfer, pass the complete actor to the service and let
`hasProjectRole` provide the admin bypass consistently; do not recheck only the
actor's membership.

- [x] **Step 7: Run focused and full verification**

Run: `bun --filter @deploykit/server test tests/services/authorization.test.ts tests/api/permissions.test.ts`

Run: `bun run verify`

Expected: all commands exit 0.

- [x] **Step 8: Commit the authorization slice**

```bash
git add apps/server/src/domain/authorization.ts apps/server/src/middleware/auth.ts apps/server/src/services/contracts.ts apps/server/src/services/projectService.ts apps/server/src/routes/projects.ts apps/server/src/routes/history.ts apps/server/src/routes/userSearch.ts apps/server/src/routes/members.ts apps/server/src/api.ts apps/server/tests/api/permissions.test.ts apps/server/tests/services/authorization.test.ts
git commit -m "security: enforce actor-aware project authorization"
```

### Task 3: Bound multipart and ZIP resource usage

**Files:**
- Modify: `apps/server/src/config.ts`
- Create: `apps/server/src/middleware/uploadLimits.ts`
- Modify: `apps/server/src/routes/versions.ts`
- Modify: `apps/server/src/services/artifactService.ts`
- Modify: `apps/server/src/services/versionService.ts`
- Modify: `packages/shared/src/errors.ts`
- Create: `apps/server/tests/api/uploadLimits.test.ts`
- Modify: `apps/server/tests/services/artifactService.test.ts`
- Modify: `apps/server/tests/services/config.test.ts`

**Interfaces:**
- Produces: `maxUploadRequestSize` and `maxConcurrentUploads` on `AppConfig`.
- Produces: `createUploadGate(options): MiddlewareHandler<AppEnv>`.
- Changes: `extractZip(zipPath, destDir, limits: ArtifactLimits): Promise<ArtifactStats>`.

- [x] **Step 1: Add failing request and concurrency tests**

```ts
expect(oversized.status).toBe(413);
expect((await oversized.json()).error.code).toBe('UPLOAD_TOO_LARGE');

const [first, second] = await Promise.all([
  uploadBlockingArtifact(),
  uploadWhileFirstIsBlocked(),
]);
expect([first.status, second.status].sort()).toEqual([201, 429]);
```

- [x] **Step 2: Add stable errors and supported HTTP statuses**

Add `UPLOAD_TOO_LARGE`, `UPLOAD_BUSY`, `ZIP_RATIO_EXCEEDED`, and
`RELEASE_CONFLICT` to `packages/shared/src/errors.ts`. Extend `ApiError.status`
to include `409 | 413 | 429`.

- [x] **Step 3: Enforce the multipart body limit before `formData()`**

Use Hono's `bodyLimit` on the upload route with
`maxUploadRequestSize = maxZipSize + 1 MiB` by default. Its error handler must
return the normal API envelope and 413.

```ts
bodyLimit({
  maxSize: config.maxUploadRequestSize,
  onError: (c) =>
    c.json(
      {
        error: {
          code: ErrorCode.UPLOAD_TOO_LARGE,
          message: 'Upload request exceeds the configured limit',
        },
      },
      413
    ),
});
```

- [x] **Step 4: Add a keyed upload semaphore**

The gate tracks active uploads by user id and project id, releases in `finally`,
and returns 429 when either the configured global or per-project budget is
exhausted. Tests inject a gate instance so they are deterministic.

```ts
try {
  lease = limiter.acquire(projectId);
  if (!lease) {
    throw new ApiError(ErrorCode.UPLOAD_BUSY, 'Upload capacity is busy', 429);
  }
  await next();
} finally {
  lease?.release();
}
```

- [x] **Step 5: Write adversarial streaming ZIP tests**

Generate archives that exceed each single budget:

```ts
await expect(
  extractZip(zipPath, dest, {
    maxExtractedSize: 8,
    maxFileCount: 10,
    maxPathLength: 100,
    maxCompressionRatio: 20,
  })
).rejects.toMatchObject({ code: ErrorCode.EXTRACTED_TOO_LARGE });
```

Also cover too many entries, an overlong path, a high compression ratio,
path traversal, a secret path, and cleanup of partial output.

- [x] **Step 6: Replace whole-archive unzip with streaming extraction**

Use `Unzip` and `UnzipInflate`, feed it chunks from `Bun.file(zipPath).stream()`,
and process one file stream at a time. Before `file.start()`, validate entry
name, path length, declared original size, declared compression ratio, and file
count. During `file.ondata`, increment the actual cumulative byte count before
writing each chunk and abort immediately when the budget is exceeded.

```ts
const unzipper = new Unzip((entry) => {
  state.fileCount += 1;
  assertEntryBudgets(entry, state, limits);
  entry.ondata = (error, chunk, final) => {
    if (error) return fail(error);
    state.extractedBytes += chunk.length;
    assertExtractedSize(state.extractedBytes, limits.maxExtractedSize);
    writer.write(chunk);
    if (final) writer.end();
  };
  entry.start();
});
unzipper.register(UnzipInflate);
```

On any failure, terminate active entries, close writers, remove partial output,
and reject with the original `ApiError`.

- [x] **Step 7: Use streaming stats in version creation**

Pass all four limits from config into `extractZip`; use its returned
`fileCount` and `extractedBytes` as the first stats, then recalculate after
flattening for the persisted values. Keep checksum generation after validation.

- [x] **Step 8: Run focused and full verification**

Run: `bun --filter @deploykit/server test tests/api/uploadLimits.test.ts tests/services/artifactService.test.ts`

Run: `bun run verify`

Expected: all commands exit 0 and the adversarial ZIP tests do not cause an
unbounded memory increase.

- [x] **Step 9: Commit the upload slice**

```bash
git add apps/server/src/config.ts apps/server/src/middleware/uploadLimits.ts apps/server/src/routes/versions.ts apps/server/src/services/artifactService.ts apps/server/src/services/versionService.ts packages/shared/src/errors.ts apps/server/tests/api/uploadLimits.test.ts apps/server/tests/services/artifactService.test.ts apps/server/tests/services/config.test.ts
git commit -m "security: enforce bounded artifact uploads"
```

### Task 4: Enforce explicit and conflict-safe releases

**Files:**
- Modify: `apps/server/src/domain/version.ts`
- Modify: `apps/server/src/domain/schemas.ts`
- Modify: `apps/server/src/services/contracts.ts`
- Modify: `apps/server/src/services/versionService.ts`
- Modify: `apps/server/src/routes/versions.ts`
- Modify: `packages/client/src/api/ApiClient.ts`
- Modify: `packages/client/src/api/fetchApiClient.ts`
- Modify: `apps/server/tests/services/versionDomain.test.ts`
- Modify: `apps/server/tests/services/versionService.test.ts`
- Modify: `apps/server/tests/api/contracts.test.ts`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/architecture.md`

**Interfaces:**
- Produces: `ReleaseCommand = { expectedActiveVersionId: string | null }`.
- Changes: `publishVersion`, `activateVersion`, and `rollbackVersion` accept `ReleaseCommand`.
- Produces: `assertPublishableVersion(projectId, versionId)` internal service check.

- [x] **Step 1: Write failing release invariant tests**

```ts
expect(() =>
  service.publishVersion('p1', 'failed', actorId, {
    expectedActiveVersionId: 'v1',
  })
).toThrow('Version is not publishable');

expect(() =>
  service.publishVersion('p1', 'v2', actorId, {
    expectedActiveVersionId: null,
  })
).toMatchObject({ code: ErrorCode.RELEASE_CONFLICT, status: 409 });

service.deleteVersion('p1', 'v1', actorId);
expect(project.activeVersionId).toBeNull();
expect(project.versions.every((item) => item.status !== 'production')).toBe(
  true
);
```

- [x] **Step 2: Run domain and service tests**

Run: `bun --filter @deploykit/server test tests/services/versionDomain.test.ts tests/services/versionService.test.ts`

Expected: FAIL because deletion still promotes a replacement and release
commands have no precondition.

- [x] **Step 3: Replace automatic replacement with explicit unpublish**

Delete `chooseReplacementActiveVersionId`. When deleting an active version, set
`activeVersionId` to `null`, call `syncProductionStatus(versions, null)`, and
write history metadata:

```ts
{
  wasActive: true,
  previousActiveVersionId: versionId,
  activeVersionId: null,
}
```

Do not update another version's `publishedAt` or `publishedBy`.

- [x] **Step 4: Validate the release precondition**

Parse JSON body `{ expectedActiveVersionId: string | null }` on publish,
activate, and rollback. Inside the same repository mutation that changes the
active version, compare it with `project.activeVersionId`; mismatch throws
`RELEASE_CONFLICT` with 409.

```ts
if (project.activeVersionId !== command.expectedActiveVersionId) {
  throw new ApiError(
    ErrorCode.RELEASE_CONFLICT,
    'The active version changed; refresh before releasing',
    409
  );
}
```

- [x] **Step 5: Validate artifacts before publication**

Reject `failed` and `archived` versions. Require the version directory and root
`index.html`, then compare `checksumDirectory(versionDir)` to the persisted
checksum. Perform the filesystem check before the repository mutation and
recheck lifecycle state inside the mutation.

```ts
if (!['preview', 'production'].includes(version.status)) {
  throw new ApiError(
    ErrorCode.INVALID_REQUEST,
    'Version is not publishable',
    400
  );
}
assertIndexHtml(versionDir);
if (checksumDirectory(versionDir) !== version.checksum) {
  throw new ApiError(
    ErrorCode.FILE_PROCESSING_FAILED,
    'Artifact checksum verification failed',
    500
  );
}
```

- [x] **Step 6: Send preconditions from all clients**

Change `ApiClient.publishVersion` and `rollbackVersion` to receive the current
`activeVersionId`. Send it in the JSON body so stale UI tabs cannot overwrite a
newer operator action.

```ts
json: { expectedActiveVersionId }
```

- [x] **Step 7: Update architecture guidance**

Replace the AGENTS.md instruction that requires automatic replacement with the
new invariant: deleting an active version unpublishes the project and only an
explicit publish/rollback may select another version.

- [x] **Step 8: Run focused and full verification**

Run: `bun --filter @deploykit/server test tests/services/versionDomain.test.ts tests/services/versionService.test.ts tests/api/contracts.test.ts`

Run: `bun run verify`

Expected: all commands exit 0.

- [x] **Step 9: Commit the release slice**

```bash
git add apps/server/src/domain/version.ts apps/server/src/domain/schemas.ts apps/server/src/services/contracts.ts apps/server/src/services/versionService.ts apps/server/src/routes/versions.ts packages/client/src/api/ApiClient.ts packages/client/src/api/fetchApiClient.ts apps/server/tests/services/versionDomain.test.ts apps/server/tests/services/versionService.test.ts apps/server/tests/api/contracts.test.ts AGENTS.md README.md docs/architecture.md
git commit -m "feat: enforce explicit conflict-safe releases"
```

### Task 5: Phase gate and handoff to persistence work

**Files:**
- Modify: `docs/backend-hardening-roadmap.md`
- Modify: `docs/superpowers/plans/2026-07-30-trust-access-upload-release-foundation.md`

**Interfaces:**
- Consumes: all invariants and tests produced by Tasks 1 through 4.
- Produces: a verified security/release baseline for the relational SQLite plan.

- [x] **Step 1: Run the repository baseline**

Run: `bun run verify`

Expected: Biome, all workspace typechecks, all server/client/desktop tests, and
the production build exit 0.

- [x] **Step 2: Run the production fail-closed smoke test**

Run:

```bash
DEPLOYKIT_ENV=production SESSION_SECRET="$(printf 's%.0s' {1..32})" ADMIN_PASSWORD=admin-password bun apps/server/src/index.ts
```

Expected: process exits non-zero and names missing
`MANAGEMENT_BASE_URL`/`DEPLOY_BASE_URL`.

- [x] **Step 3: Run the two-origin local smoke test**

Run the server with:

```bash
MANAGEMENT_BASE_URL=http://console.localhost:4010 DEPLOY_BASE_URL=http://deploy.localhost:4010 SESSION_SECRET=local-session-secret-at-least-32-bytes bun run dev:server
```

Verify:

```bash
curl -i http://console.localhost:4010/health/live
curl -i http://deploy.localhost:4010/api/me
curl -i http://console.localhost:4010/deploy/example/
```

Expected: health is 204; the API request on the deploy origin is 404; the
deploy request on the management origin is 404.

- [x] **Step 4: Self-review the phase diff**

Run:

```bash
git diff --check
git status --short
git log --oneline origin/main..HEAD
```

Expected: no whitespace errors, only scoped files are modified, and each slice
has its own reviewed commit.

- [x] **Step 5: Mark completed checkboxes and push main**

```bash
git add docs/backend-hardening-roadmap.md docs/superpowers/plans/2026-07-30-trust-access-upload-release-foundation.md
git commit -m "docs: record backend hardening phase one"
git push origin main
```

Expected: `main` and `origin/main` point to the same commit.
