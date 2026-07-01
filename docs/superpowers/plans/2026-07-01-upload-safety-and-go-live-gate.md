# Upload Safety & "Upload ≠ Go-Live" Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three P0 upload-pipeline gaps — block dangerous files, require `index.html`, stop auto-publishing the first version — and surface the "no production version yet" state in the UI.

**Architecture:** A new pure `domain/uploadSafety.ts` predicate (`matchBlockedPath`) is called by both write paths in `artifactService` (`extractZip`, `writeFolderFiles`) to reject dangerous entries with `BLOCKED_FILE`. An `index.html` gate (`hasRootIndexHtml`) runs in `versionService` after `flattenOutput` and rejects with `MISSING_INDEX_HTML`. The first-version auto-activation is removed from `versionService`, so every upload is preview-only until an explicit activate. The web `DeployUrl` mutes itself and shows the existing `deployHint` when `activeVersionId` is null.

**Tech Stack:** Bun, Hono, fflate (`zipSync`/`unzip`), zod, `bun:test` (server), Vitest + RTL + jsdom (web), React 19, Biome.

## Global Constraints

(Copied verbatim from the spec + `CLAUDE.md`; every task's requirements implicitly include these.)

- **Biome formatting:** single quotes, 2-space indent, LF, line width 80, ES5 trailing commas, semicolons always. Run `bun run check:fix` before each commit.
- **Biome lint:** `noExplicitAny` (warn), `noUnusedVariables` (error), `noNonNullAssertion` (warn). No unused vars, no `any`.
- **Error codes** are plain string members of the `ErrorCode` const object in `apps/server/src/errors.ts` — **no TS enums** (web build uses `erasableSyntaxOnly`). Pattern: `CODE_NAME: 'CODE_NAME',`.
- **`domain/` modules are pure** — no `node:*` or `bun:*` imports. `domain/uploadSafety.ts` must stay I/O-free.
- **`ApiError` pass-through:** `versionService.uploadVersion`'s `catch` does `if (err instanceof ApiError) throw err;` then otherwise maps to `FILE_PROCESSING_FAILED` (500). New gates throw `ApiError` directly so they surface with their own code/status (400).
- **Shared schema** (`packages/shared`) is the single source of truth — this plan makes **no** shared schema change.
- **Server tests** use `bun:test` and drive the full app via `app.request(...)` with a per-test temp dir. Single-test run: `bun --filter @deploykit/server test <path>`; add `-t "name"` to filter by test name.
- **Web tests** use Vitest + RTL + jsdom. The global setup (`apps/web/tests/setup.ts`) auto-mocks `react-i18next` (returns the key as the label) and `@/shared/ui/toast-context` (no-op), and stubs `ResizeObserver`. **Note: web Vitest is currently broken on Windows locally** — if `vitest run` fails to launch on Windows, rely on CI (`.github/workflows/ci.yml`) to validate web tests; the test below follows the exact pattern of `apps/web/tests/unit/VersionList.test.tsx`.
- **No data migration:** only the new-upload path changes; existing `activeVersionId` values are preserved.

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `apps/server/src/domain/uploadSafety.ts` | **New.** Pure deny-list predicate `matchBlockedPath` + exported `BLOCKED_FILE_RULES`. No I/O. | 1 |
| `apps/server/tests/services/uploadSafety.test.ts` | **New.** Pure unit tests for the predicate (no filesystem). | 1 |
| `apps/server/src/errors.ts` | Add `BLOCKED_FILE` and `MISSING_INDEX_HTML` to the `ErrorCode` const. | 2, 3 |
| `apps/server/src/services/artifactService.ts` | Call `matchBlockedPath` in `extractZip` + `writeFolderFiles`; add `hasRootIndexHtml`. | 2, 3 |
| `apps/server/src/services/versionService.ts` | Add `index.html` gate in both branches; remove first-version auto-activation. | 3, 4 |
| `apps/server/tests/api/contracts.test.ts` | New dangerous-file + missing-index.html + no-active-404 tests; update first-upload, delete-active, serve-active tests. | 2, 3, 4 |
| `apps/server/tests/api/app.test.ts` | Update the unknown-version-activate test for preview-only uploads. | 4 |
| `apps/web/src/features/deploy/DeployUrl.tsx` | Add `hasProduction` prop; mute URL + show `deployHint` when false. | 5 |
| `apps/web/src/pages/DeployPage.tsx` | Pass `hasProduction={selectedProject.activeVersionId != null}`. | 5 |
| `apps/web/tests/unit/DeployUrl.test.tsx` | **New.** Tests the muted/no-link rendering when `hasProduction` is false. | 5 |

---

### Task 1: Pure deny-list predicate `matchBlockedPath`

**Files:**
- Create: `apps/server/src/domain/uploadSafety.ts`
- Test: `apps/server/tests/services/uploadSafety.test.ts`

**Interfaces:**
- Produces: `matchBlockedPath(relativePath: string): string | null` — returns a short reason string (e.g. `"secrets/env file"`) when the path is dangerous, or `null` when safe. `relativePath` is POSIX-normalized (forward slashes, no leading separator). Also exports `BLOCKED_FILE_RULES` (the rule data).

- [ ] **Step 1: Write the failing test**

Create `apps/server/tests/services/uploadSafety.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { matchBlockedPath } from '../../src/domain/uploadSafety';

describe('matchBlockedPath', () => {
  describe('blocks dangerous paths', () => {
    test.each([
      // env / secrets
      ['.env'],
      ['.env.local'],
      ['.env.production'],
      ['.env.example'],
      ['config/.env'],
      // VCS + dependency directories (any path segment)
      ['.git/config'],
      ['.svn/entries'],
      ['.hg/store'],
      ['node_modules/react/index.js'],
      // private keys (basename suffix)
      ['cert.pem'],
      ['secrets/server.key'],
      // SSH keys (exact basename)
      ['id_rsa'],
      ['id_rsa.pub'],
      ['subdir/id_rsa'],
    ])('%s', (path) => {
      expect(matchBlockedPath(path)).not.toBeNull();
    });
  });

  describe('allows safe paths (precision — no naive substring match)', () => {
    test.each([
      'greenhouse.js',
      'env-config.js',
      '.environment.js',
      '.envrc',
      'monkey.jpeg',
      'keyboard.txt',
      'id_rsa_backup.txt',
      '.gitignore',
      'id_ed25519',
      'index.html',
      'assets/main.js',
      // OS junk is NOT handled here (isSystemMetadata owns it):
      '.DS_Store',
      // case-sensitive in v1 — uppercase variants are not matched:
      'config/.ENV',
      '.GIT/config',
    ])('%s', (path) => {
      expect(matchBlockedPath(path)).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --filter @deploykit/server test tests/services/uploadSafety.test.ts`
Expected: FAIL — `Cannot find module '../../src/domain/uploadSafety'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/server/src/domain/uploadSafety.ts`:

```ts
/**
 * Pure deny-list check for upload entries. Returns a short reason string when
 * `relativePath` is dangerous, or `null` when it is safe. `relativePath` uses
 * the form already produced by `extractZip` (zip entry names) and
 * `writeFolderFiles` (normalized `webkitRelativePath`): POSIX separators, no
 * leading separator.
 *
 * Matching is segment- and basename-based (not a naive substring) so filenames
 * like `greenhouse.js` or `env-config.js` are not false-positive'd. It is
 * case-sensitive in v1 (build outputs are conventionally lowercase).
 *
 * OS junk (`.DS_Store`, `__MACOSX`, `._*`) is intentionally NOT handled here —
 * `isSystemMetadata` in artifactService owns that. This predicate is concerned
 * only with content that must never be deployed (secrets, VCS, dependencies).
 */

export const BLOCKED_FILE_RULES = {
  /** Any path segment equal to one of these blocks the upload. */
  vcsDirs: ['.git', '.svn', '.hg'],
  depDirs: ['node_modules'],
  /** Matched as an exact basename, or any basename starting with this + `.`. */
  envFile: '.env',
  /** Matched as a basename suffix. */
  keyExtensions: ['.pem', '.key'],
  /** Matched as an exact basename. */
  sshKeys: ['id_rsa', 'id_rsa.pub'],
};

/** @returns a short reason string when `relativePath` is blocked, else `null`. */
export function matchBlockedPath(relativePath: string): string | null {
  const segments = relativePath.split('/');
  const basename = segments.at(-1) ?? '';

  for (const segment of segments) {
    if (BLOCKED_FILE_RULES.vcsDirs.includes(segment)) {
      return 'VCS directory';
    }
    if (BLOCKED_FILE_RULES.depDirs.includes(segment)) {
      return 'dependency directory';
    }
  }

  if (basename === BLOCKED_FILE_RULES.envFile || basename.startsWith(`${BLOCKED_FILE_RULES.envFile}.`)) {
    return 'secrets/env file';
  }
  if (BLOCKED_FILE_RULES.keyExtensions.some((ext) => basename.endsWith(ext))) {
    return 'private key file';
  }
  if (BLOCKED_FILE_RULES.sshKeys.includes(basename)) {
    return 'SSH key file';
  }

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --filter @deploykit/server test tests/services/uploadSafety.test.ts`
Expected: PASS — all `blocks` and `allows` cases green.

- [ ] **Step 5: Lint + commit**

```bash
bun run check:fix
git add apps/server/src/domain/uploadSafety.ts apps/server/tests/services/uploadSafety.test.ts
git commit -m "feat(server): add upload-safety deny-list predicate"
```

---

### Task 2: Block dangerous files at upload (zip + folder)

**Files:**
- Modify: `apps/server/src/errors.ts` (add `BLOCKED_FILE`)
- Modify: `apps/server/src/services/artifactService.ts` (wire `matchBlockedPath` into `extractZip` + `writeFolderFiles`; add the import)
- Test: `apps/server/tests/api/contracts.test.ts` (add two contract tests + the `fflate` import)

**Interfaces:**
- Consumes: `matchBlockedPath` from Task 1.
- Produces: `ErrorCode.BLOCKED_FILE` (400) thrown from both write paths; message template `` `Upload rejected: "<path>" is blocked (<reason>). Remove it and upload again.` ``

- [ ] **Step 1: Write the failing tests**

In `apps/server/tests/api/contracts.test.ts`, add the `fflate` import at the top (next to the other imports) and two new tests. The import block currently starts with:

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
```

Add after them:

```ts
import { zipSync } from 'fflate';
```

Append these tests at the end of the file:

```ts
test('rejects a zip containing a blocked file with 400 BLOCKED_FILE', async () => {
  const project = await createProject(app);
  const zip = new File(
    [zipSync({ '.env': new TextEncoder().encode('SECRET=1') })],
    'build.zip',
    { type: 'application/zip' }
  );
  const form = new FormData();
  form.append('file', zip);
  form.append('versionDesc', 'leaky');
  const res = await app.request(`/api/projects/${project.id}/versions`, {
    method: 'POST',
    body: form,
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error.code).toBe('BLOCKED_FILE');

  // No version is recorded after the failed upload.
  expect((await getProject(app, project.id)).versions).toHaveLength(0);
});

test('rejects a folder upload containing a blocked file with 400 BLOCKED_FILE', async () => {
  const project = await createProject(app);
  const form = new FormData();
  form.append('folderFiles', new File(['<html></html>'], 'index.html'));
  form.append('folderFiles', new File(['SECRET=1'], '.env'));
  form.append('versionDesc', 'leaky');
  const res = await app.request(`/api/projects/${project.id}/versions`, {
    method: 'POST',
    body: form,
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error.code).toBe('BLOCKED_FILE');
  expect((await getProject(app, project.id)).versions).toHaveLength(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun --filter @deploykit/server test tests/api/contracts.test.ts -t "blocked file"`
Expected: FAIL — both tests get status `201` (the dangerous file is accepted today), so the `400` assertion fails.

- [ ] **Step 3: Add the `BLOCKED_FILE` error code**

In `apps/server/src/errors.ts`, add `BLOCKED_FILE` to the `ErrorCode` const object, immediately before `INTERNAL_ERROR`:

```ts
  FILE_PROCESSING_FAILED: 'FILE_PROCESSING_FAILED',
  BLOCKED_FILE: 'BLOCKED_FILE',
  MISSING_INDEX_HTML: 'MISSING_INDEX_HTML',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
```

(Add both now; Task 3 uses `MISSING_INDEX_HTML`. `ApiError`, `ErrorCode` are already imported in `artifactService.ts`.)

- [ ] **Step 4: Wire the predicate into `extractZip`**

In `apps/server/src/services/artifactService.ts`, add the import. The existing imports include (line ~13):

```ts
import { ApiError, ErrorCode } from '../errors';
import { getMimeType } from '../utils/mime';
import { safeJoin } from '../utils/safePath';
```

Add:

```ts
import { matchBlockedPath } from '../domain/uploadSafety';
```

Then in `extractZip`, the entry loop currently reads:

```ts
  for (const [entryPath, bytes] of Object.entries(entries)) {
    if (entryPath.endsWith('/') || isSystemMetadata(entryPath)) continue; // directory marker or junk
    const target = safeJoin(destDir, entryPath);
    if (!target) throw new Error(`Unsafe zip entry: ${entryPath}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
```

Replace it with:

```ts
  for (const [entryPath, bytes] of Object.entries(entries)) {
    if (entryPath.endsWith('/') || isSystemMetadata(entryPath)) continue; // directory marker or junk
    const reason = matchBlockedPath(entryPath);
    if (reason) {
      throw new ApiError(
        ErrorCode.BLOCKED_FILE,
        `Upload rejected: "${entryPath}" is blocked (${reason}). Remove it and upload again.`,
        400
      );
    }
    const target = safeJoin(destDir, entryPath);
    if (!target) throw new Error(`Unsafe zip entry: ${entryPath}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
```

- [ ] **Step 5: Wire the predicate into `writeFolderFiles`**

In the same file, `writeFolderFiles` currently reads:

```ts
    if (!relativePath || isSystemMetadata(relativePath)) continue;

    if (maxPathLength && relativePath.length > maxPathLength) {
```

Insert the dangerous-file check between those two blocks so it becomes:

```ts
    if (!relativePath || isSystemMetadata(relativePath)) continue;

    const reason = matchBlockedPath(relativePath);
    if (reason) {
      throw new ApiError(
        ErrorCode.BLOCKED_FILE,
        `Upload rejected: "${relativePath}" is blocked (${reason}). Remove it and upload again.`,
        400
      );
    }

    if (maxPathLength && relativePath.length > maxPathLength) {
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun --filter @deploykit/server test tests/api/contracts.test.ts`
Expected: PASS — the two new `BLOCKED_FILE` tests pass, and all existing contract tests still pass (no existing test uploads a blocked file).

- [ ] **Step 7: Lint + commit**

```bash
bun run check:fix
git add apps/server/src/errors.ts apps/server/src/services/artifactService.ts apps/server/tests/api/contracts.test.ts
git commit -m "feat(server): block dangerous files at upload"
```

---

### Task 3: Require `index.html` after extraction/flatten

**Files:**
- Modify: `apps/server/src/services/artifactService.ts` (add `hasRootIndexHtml`)
- Modify: `apps/server/src/services/versionService.ts` (import `hasRootIndexHtml`; gate both branches after `flattenOutput`)
- Test: `apps/server/tests/api/contracts.test.ts` (add a missing-`index.html` contract test)

**Interfaces:**
- Produces: `hasRootIndexHtml(dir: string): boolean` in `artifactService`; `ErrorCode.MISSING_INDEX_HTML` (400) thrown from `versionService.uploadVersion` in both the zip and folder branches, immediately after `flattenOutput`.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/tests/api/contracts.test.ts`:

```ts
test('rejects an upload with no index.html after flatten with 400 MISSING_INDEX_HTML', async () => {
  const project = await createProject(app);
  const form = new FormData();
  // A non-blocked, non-junk file that is not index.html and lives at the root.
  form.append('folderFiles', new File(['just data'], 'foo.txt'));
  form.append('versionDesc', 'no entry point');
  const res = await app.request(`/api/projects/${project.id}/versions`, {
    method: 'POST',
    body: form,
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error.code).toBe('MISSING_INDEX_HTML');
  expect((await getProject(app, project.id)).versions).toHaveLength(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --filter @deploykit/server test tests/api/contracts.test.ts -t "no index.html"`
Expected: FAIL — status is `201` today (flatten no-ops, upload "succeeds"), so the `400` assertion fails.

- [ ] **Step 3: Add `hasRootIndexHtml` to `artifactService`**

In `apps/server/src/services/artifactService.ts`, add the helper immediately after the `flattenOutput` function (which ends with its closing brace; `existsSync`, `join` are already imported at the top of the file):

```ts
/** True when an `index.html` exists at the root of `dir`. */
export function hasRootIndexHtml(dir: string): boolean {
  return existsSync(join(dir, 'index.html'));
}
```

- [ ] **Step 4: Import `hasRootIndexHtml` in `versionService`**

In `apps/server/src/services/versionService.ts`, the existing import block from `./artifactService` is:

```ts
import {
  countFiles,
  extractZip,
  flattenOutput,
  getDirectorySize,
  removeDir,
  writeFolderFiles,
} from './artifactService';
```

Add `hasRootIndexHtml` (keeping the list alphabetical):

```ts
import {
  countFiles,
  extractZip,
  flattenOutput,
  getDirectorySize,
  hasRootIndexHtml,
  removeDir,
  writeFolderFiles,
} from './artifactService';
```

(`ApiError`, `ErrorCode` are already imported on line ~10 of `versionService.ts`.)

- [ ] **Step 5: Gate the zip branch**

In `versionService.uploadVersion`, the zip branch currently ends its inner `try` with:

```ts
            flattenOutput(versionDir);
          } finally {
```

Replace with:

```ts
            flattenOutput(versionDir);
            if (!hasRootIndexHtml(versionDir)) {
              throw new ApiError(
                ErrorCode.MISSING_INDEX_HTML,
                'Upload rejected: no index.html found at the root after extraction. DeployKit serves sites from index.html.',
                400
              );
            }
          } finally {
```

- [ ] **Step 6: Gate the folder branch**

In the same function, the folder branch currently ends with:

```ts
          flattenOutput(versionDir);
        } else if (file && file.size > 0) {
```

Replace with:

```ts
          flattenOutput(versionDir);
          if (!hasRootIndexHtml(versionDir)) {
            throw new ApiError(
              ErrorCode.MISSING_INDEX_HTML,
              'Upload rejected: no index.html found at the root after extraction. DeployKit serves sites from index.html.',
              400
            );
          }
        } else if (file && file.size > 0) {
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun --filter @deploykit/server test tests/api/contracts.test.ts`
Expected: PASS — the new `MISSING_INDEX_HTML` test passes, and existing tests that upload an `index.html` (via the `uploadVersion` helper) still return `201`.

- [ ] **Step 8: Lint + commit**

```bash
bun run check:fix
git add apps/server/src/services/artifactService.ts apps/server/src/services/versionService.ts apps/server/tests/api/contracts.test.ts
git commit -m "feat(server): require index.html after extraction"
```

---

### Task 4: Stop auto-publishing the first version

**Files:**
- Modify: `apps/server/src/services/versionService.ts` (remove the `isFirstVersion` activation)
- Modify: `apps/server/tests/api/contracts.test.ts` (update 3 existing tests + add a no-active-404 test)
- Modify: `apps/server/tests/api/app.test.ts` (update the unknown-version-activate test)

**Interfaces:**
- Produces: after any upload (including the first), `project.activeVersionId` stays `null` until an explicit `PUT /api/projects/:id/versions/:versionId/activate`. `/deploy/:slug/` returns `404 "No active version"` while `activeVersionId` is null (already handled by `routes/deploy.ts`).

- [ ] **Step 1: Write/update the failing tests first**

Update three existing tests and add one new test in `apps/server/tests/api/contracts.test.ts`.

**1a.** Replace the test currently titled `'uploads a folder version that becomes the active version'` (around L216) — including its title — with:

```ts
test('uploads a folder version as preview-only until activated', async () => {
  const project = await createProject(app);
  const res = await uploadVersion(app, project.id);
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.version.id).toBeTruthy();
  expect(body.version.name).toBe(body.version.id.slice(0, 7));

  const after = await getProject(app, project.id);
  expect(after.versions).toHaveLength(1);
  // Upload does NOT publish — no active version until an explicit activate.
  expect(after.activeVersionId).toBeNull();

  // Production is reached only by an explicit activate action.
  const activateRes = await app.request(
    `/api/projects/${project.id}/versions/${after.versions[0].id}/activate`,
    { method: 'PUT' }
  );
  expect(activateRes.status).toBe(200);
  const afterActivate = await getProject(app, project.id);
  expect(afterActivate.activeVersionId).toBe(after.versions[0].id);

  // Upload metadata is recorded for the version.
  const version = after.versions[0];
  expect(version.sourceType).toBe('folder');
  expect(version.fileCount).toBe(1);
  expect(version.size).toBeGreaterThan(0);
});
```

**1b.** Replace the test `'deleting the active version promotes a replacement'` (around L270) with:

```ts
test('deleting the active version promotes a replacement', async () => {
  const project = await createProject(app);
  await uploadVersion(app, project.id, '<html>v1</html>');
  await uploadVersion(app, project.id, '<html>v2</html>');
  const [first] = (await getProject(app, project.id)).versions;
  // Uploads are preview-only; promote v1 so deletion triggers replacement.
  await app.request(
    `/api/projects/${project.id}/versions/${first.id}/activate`,
    { method: 'PUT' }
  );

  const res = await app.request(
    `/api/projects/${project.id}/versions/${first.id}`,
    { method: 'DELETE' }
  );
  expect(res.status).toBe(200);

  const after = await getProject(app, project.id);
  expect(after.versions).toHaveLength(1);
  expect(after.activeVersionId).toBe(after.versions[0].id);
});
```

**1c.** Replace the test `'serves the active version via /deploy/:slug/'` (around L287) with the activated version, and add a new no-active-404 test right after it:

```ts
test('serves the active version via /deploy/:slug/', async () => {
  const project = await createProject(app, 'demo-app');
  await uploadVersion(app, project.id, '<html><body>deployed</body></html>');
  // Upload alone is not live; activate before serving.
  const [version] = (await getProject(app, project.id)).versions;
  await app.request(
    `/api/projects/${project.id}/versions/${version.id}/activate`,
    { method: 'PUT' }
  );

  const res = await app.request('/deploy/demo-app/');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(await res.text()).toBe('<html><body>deployed</body></html>');
});

test('returns 404 on /deploy/:slug/ when no version is active', async () => {
  const project = await createProject(app, 'demo-app');
  await uploadVersion(app, project.id, '<html><body>preview</body></html>');

  const res = await app.request('/deploy/demo-app/');
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: Update `app.test.ts`**

In `apps/server/tests/api/app.test.ts`, replace the entire test `'rejects activating an unknown version without changing the active version'` (L55–L84) with:

```ts
test('rejects activating an unknown version without changing the active version', async () => {
  const client = createTestClient();
  const project = await createProject(client);
  // The upload route's form input is not validator-typed (the frontend uploads
  // via XHR for progress), so exercise it through the typed client with a cast.
  const version = await client.api.projects[':id'].versions.$post({
    param: { id: project.id },
    form: {
      folderFiles: new File(['<html></html>'], 'index.html'),
      versionDesc: 'first build',
    },
  } as { param: { id: string }; form: unknown });

  expect(version.status).toBe(201);
  const createdVersion = await version.json();

  // Uploads are preview-only; promote explicitly before testing the guard.
  const activated = await client.api.projects[':id'].versions[
    ':versionId'
  ].activate.$put({
    param: { id: project.id, versionId: createdVersion.version.id },
  });
  expect(activated.status).toBe(200);

  const failed = await client.api.projects[':id'].versions[
    ':versionId'
  ].activate.$put({
    param: { id: project.id, versionId: 'missing-version' },
  });

  expect(failed.status).toBe(404);

  const list = await client.api.projects[':id'].versions.$get({
    param: { id: project.id },
  });
  const currentProject = await list.json();
  // The failed activation must not have changed the active version.
  expect(currentProject.activeVersionId).toBe(createdVersion.version.id);
});
```

- [ ] **Step 3: Run the updated tests to verify they fail**

Run: `bun --filter @deploykit/server test tests/api/contracts.test.ts tests/api/app.test.ts`
Expected: FAIL — the `activeVersionId` assertions fail because the first upload still auto-activates today (e.g. `expect(after.activeVersionId).toBeNull()` gets the version id).

- [ ] **Step 4: Remove the first-version auto-activation**

In `apps/server/src/services/versionService.ts`, the post-extraction block currently reads:

```ts
      const isFirstVersion = project.versions.length === 0;
      project.versions.push(version);
      if (isFirstVersion) project.activeVersionId = version.id;
      project.updatedAt = new Date().toISOString();
```

Replace it with:

```ts
      // Uploads are preview-only; production is reached only by an explicit
      // activate action (上传≠上线). Do not auto-set activeVersionId here.
      project.versions.push(version);
      project.updatedAt = new Date().toISOString();
```

- [ ] **Step 5: Run the full server test suite to verify nothing else broke**

Run: `bun --filter @deploykit/server test`
Expected: PASS — all server tests green. (The `version.activate` test that uploads v1+v2 and activates `second` is unaffected: it never relied on auto-activation. The deploy-resolver, schema-migration, and version-domain tests construct projects directly and are unaffected.)

- [ ] **Step 6: Lint + commit**

```bash
bun run check:fix
git add apps/server/src/services/versionService.ts apps/server/tests/api/contracts.test.ts apps/server/tests/api/app.test.ts
git commit -m "feat(server): stop auto-publishing the first version"
```

---

### Task 5: Mute the deploy URL when no production version exists

**Files:**
- Modify: `apps/web/src/features/deploy/DeployUrl.tsx` (add `hasProduction` prop; conditional rendering)
- Modify: `apps/web/src/pages/DeployPage.tsx` (pass the prop)
- Test: `apps/web/tests/unit/DeployUrl.test.tsx` (new)

**Interfaces:**
- Produces: `DeployUrl({ slug, hasProduction }: { slug: string; hasProduction: boolean })`. When `hasProduction === false`, the URL renders as muted non-clickable text, the existing `versions.deployHint` is shown, and the "open in new tab" affordance is hidden; the copy button stays. When `true`, current behavior is unchanged.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/unit/DeployUrl.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DeployUrl } from '@/features/deploy/DeployUrl';
import { TooltipProvider } from '@/shared/ui/tooltip';

// Tooltip requires a provider ancestor (rooted in App.tsx in the real app).
const renderWithProvider = (ui: React.ReactElement) =>
  render(<TooltipProvider>{ui}</TooltipProvider>);

describe('DeployUrl', () => {
  it('mutes the URL and shows the deploy hint when there is no production version', () => {
    renderWithProvider(<DeployUrl slug="demo" hasProduction={false} />);

    expect(screen.getByText('versions.deployHint')).toBeInTheDocument();
    // No clickable link: the URL is plain text (clicking would 404) and the
    // open-in-new-tab affordance is hidden.
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders the URL as a link and hides the hint when a production version exists', () => {
    renderWithProvider(<DeployUrl slug="demo" hasProduction={true} />);

    expect(screen.queryByText('versions.deployHint')).not.toBeInTheDocument();
    expect(screen.getAllByRole('link').length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

From `apps/web`: `bunx vitest run tests/unit/DeployUrl.test.tsx`
Expected: FAIL — `DeployUrl` does not accept a `hasProduction` prop today (TypeScript/render error), or the `deployHint` text is not rendered.
> **Windows caveat:** web Vitest is currently broken on Windows locally. If `vitest run` fails to launch on Windows, skip local verification here and rely on CI (`.github/workflows/ci.yml`) for this test — it follows the exact pattern of `VersionList.test.tsx`.

- [ ] **Step 3: Update `DeployUrl` to accept `hasProduction`**

Replace the entire contents of `apps/web/src/features/deploy/DeployUrl.tsx` with:

```tsx
import { Copy, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { publicBaseURL } from '@/config';
import { Button } from '@/shared/ui/button';
import { useToast } from '@/shared/ui/toast-context';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';

interface DeployUrlProps {
  slug: string;
  /** Whether the project has an active (production) version. */
  hasProduction: boolean;
}

export function DeployUrl({ slug, hasProduction }: DeployUrlProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const deployUrl = `${publicBaseURL}/deploy/${slug}/`;

  return (
    <div className="flex-1 flex items-center justify-end gap-2 min-w-0">
      {hasProduction ? (
        <a
          href={deployUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-primary hover:underline bg-muted px-2 py-1.5 rounded-md truncate shrink"
        >
          {deployUrl}
        </a>
      ) : (
        <div className="flex flex-col items-end min-w-0">
          <span className="text-sm text-muted-foreground bg-muted px-2 py-1.5 rounded-md truncate shrink">
            {deployUrl}
          </span>
          <span className="text-xs text-muted-foreground/80 mt-0.5">
            {t('versions.deployHint')}
          </span>
        </div>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => {
              navigator.clipboard.writeText(deployUrl);
              toast(t('common.copied'));
            }}
          >
            <Copy className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('common.copy')}</TooltipContent>
      </Tooltip>
      {hasProduction && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="icon-sm" asChild>
              <a href={deployUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-4" />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('versions.preview')}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Pass the prop from `DeployPage`**

In `apps/web/src/pages/DeployPage.tsx`, the `DeployUrl` usage is:

```tsx
                    <DeployUrl slug={selectedProject.slug} />
```

Replace with:

```tsx
                    <DeployUrl
                      slug={selectedProject.slug}
                      hasProduction={selectedProject.activeVersionId != null}
                    />
```

- [ ] **Step 5: Run the web test to verify it passes**

From `apps/web`: `bunx vitest run tests/unit/DeployUrl.test.tsx`
Expected: PASS. (Windows caveat as in Step 2 — rely on CI if local Vitest won't launch.) Also run the existing `VersionList.test.tsx` to confirm no regression: `bunx vitest run tests/unit/VersionList.test.tsx` — it should be unchanged (its mock uses `activeVersionId: 'v1'`, which is still a valid scenario for `VersionList`).

- [ ] **Step 6: Lint + commit**

```bash
bun run check:fix
git add apps/web/src/features/deploy/DeployUrl.tsx apps/web/src/pages/DeployPage.tsx apps/web/tests/unit/DeployUrl.test.tsx
git commit -m "feat(web): mute deploy URL when no production version"
```

---

## Final verification

After all five tasks:

- [ ] **Run the full CI-equivalent locally (server parts):**

```bash
bun run typecheck
bun run check
bun --filter @deploykit/server test
bun run build
```

All green. (`bun run lint` is web-only and optional; `bun run test` runs all workspaces but web Vitest may not run on Windows — see caveat.)

- [ ] **Manual end-to-end check** (two terminals: `bun run dev:server` + `bun run dev:web`):
  - Upload a folder containing `index.html` → the version appears **preview-only** (no PRODUCTION badge; "Set Production" button shown); the deploy URL is muted with the hint text.
  - Visit `/deploy/<slug>/` before activating → `404 "No active version"`.
  - Click "Set Production" → the badge appears; `/deploy/<slug>/` now serves the version.
  - Try uploading a folder that includes a `.env` (or `.git/`, `id_rsa`) → rejected with `BLOCKED_FILE`.
  - Try uploading a folder with only `foo.txt` (no `index.html`) → rejected with `MISSING_INDEX_HTML`.

## Self-Review

**1. Spec coverage** — every spec section maps to a task:
- Pure predicate in `domain/` → Task 1.
- Blocked-pattern table (precise, case-sensitive, segment/basename) → Task 1 (impl + tests).
- Dangerous file in `extractZip` + `writeFolderFiles` → Task 2.
- `index.html` gate after `flattenOutput`, both branches → Task 3.
- Remove first-version auto-activation; no migration → Task 4.
- `DeployUrl` muted + `deployHint`; `VersionList` unchanged; i18n already present → Task 5.
- Error codes `BLOCKED_FILE` / `MISSING_INDEX_HTML` → Tasks 2 & 3.
- New unit + contract tests, updated existing tests → Tasks 1–5.

**2. Placeholder scan** — none. Every code step contains full, copy-pasteable code; every command has expected output.

**3. Type/name consistency** — `matchBlockedPath`, `BLOCKED_FILE_RULES`, `hasRootIndexHtml`, `ErrorCode.BLOCKED_FILE`, `ErrorCode.MISSING_INDEX_HTML`, `DeployUrl({ slug, hasProduction })` are spelled identically across every task that defines or consumes them. Error message templates are identical in both write paths.
