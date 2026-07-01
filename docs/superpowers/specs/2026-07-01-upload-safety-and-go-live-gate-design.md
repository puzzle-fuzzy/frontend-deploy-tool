# Upload Safety & "Upload ≠ Go-Live" Gate Design

## Background

DeployKit is an internal, enterprise-grade frontend deployment platform. Its
product principle §6.1 is **"上传≠上线" (upload ≠ go-live)**: uploading an
artifact must not, by itself, publish it to production. Three safety gaps in the
current upload pipeline violate that principle or weaken release control
(`TODO.md` §P0, enterprise docs §6.1 / §7.4, Phase 1 acceptance):

1. **Dangerous files are not blocked.** `artifactService.ts` only skips OS junk
   (`SYSTEM_METADATA` + `._*`). A `.env`, `.git/`, `id_rsa`, or `*.pem` inside an
   upload is silently extracted into storage and served.
2. **Missing `index.html` is not rejected.** `flattenOutput` silently no-ops when
   no `index.html` exists anywhere, so an upload with no entry point "succeeds"
   and the deploy URL 404s at request time.
3. **The first upload auto-publishes.** `versionService.uploadVersion` sets
   `activeVersionId` immediately on the first version, so the very first upload
   goes live without an explicit publish action.

The server already handles the "no active version" state correctly
(`deployResolver` returns `no-active` → 404), so a project with versions but no
active version is reachable server-side. The work is to (a) close the two upload
gaps and (b) stop auto-publishing, then surface the resulting "no production
version yet" state in the UI.

## Goals

- Block dangerous files at upload time, on **both** the zip-extraction and
  folder-write paths, rejecting the whole upload with a clear error code.
- Require an `index.html` at the storage root after extraction/flatten; reject
  the upload when it is absent.
- Make **every** upload (including the first) create a preview-only version;
  production is reached only by an explicit activate action.
- Surface "no production version yet" in the management UI without introducing a
  new banner component.

## Non-Goals (YAGNI — out of scope for this spec)

- No explicit version `status` field (`preview | production | archived | failed`)
  — that is P2. "Production" remains implicit via `activeVersionId`.
- No confirmation dialog for publish/activate — P2. Activation stays one-click.
- No `uploadedBy` / `publishedBy` / `checksum` metadata — P2 (needs P1 auth).
- No env-configurable deny list. The blocked-pattern table is hardcoded; it can
  be made configurable later if a deployment needs to extend it.
- No distinction between "first upload" and later uploads beyond removing the
  auto-activation. No data migration of existing projects.

## Architecture

This spec follows the existing backend layering (**routes → services → domain →
repositories**) and the convention that `domain/` holds pure, I/O-free rules.

### Pure predicate in `domain/` (the chosen approach)

A new module **`apps/server/src/domain/uploadSafety.ts`** holds only pure
functions — no Node/Bun imports, fully unit-testable without a filesystem,
mirroring `domain/version.ts` and `domain/history.ts`.

Exports:

- `BLOCKED_FILE_RULES` — the data describing the deny list (for documentation and
  future extensibility).
- `matchBlockedPath(relativePath: string): string | null` — returns a short,
  human-readable reason string when `relativePath` is dangerous, or `null` when
  it is safe. Callers use the non-`null` result to build the error message.

`relativePath` is POSIX-normalized (forward slashes, no leading separator),
matching the form already produced by `extractZip` (zip entry names) and
`writeFolderFiles` (normalized `webkitRelativePath`).

### Blocked-pattern matching rules

Matching is **precise** (segment- and basename-based) to avoid false positives
such as `greenhouse.js` or `env-config.js`. It is **case-sensitive** in v1
(build outputs are conventionally lowercase); `.ENV` is intentionally not
matched. Let `segments = relativePath.split('/')` and
`basename = segments[segments.length - 1]`.

| Category | Rule | Example hits | Example non-hits |
| --- | --- | --- | --- |
| VCS / dep dirs | any `segment ===` `.git` \| `.svn` \| `.hg` \| `node_modules` | `.git/config`, `node_modules/react/x.js` | `.gitignore`, `myapp/submodules/` |
| Env / secrets | `basename === '.env'` **or** `basename` starts with `.env.` | `.env`, `.env.local`, `.env.production`, `.env.example` | `greenhouse.js`, `env-config.js`, `.environment.js`, `.envrc` |
| Private keys | `basename` ends with `.pem` **or** `.key` | `cert.pem`, `server.key` | `monkey.jpeg`, `keyboard.txt` |
| SSH keys | `basename === 'id_rsa'` **or** `basename === 'id_rsa.pub'` | `id_rsa`, `id_rsa.pub` | `id_rsa_backup.txt`, `id_ed25519` (not in v1 list) |

> Note: `id_ed25519` / `id_ecdsa` and `.envrc` are deliberately **not** in the v1
> list (they are not in the TODO). The rules table is exported so it can be
> extended in a follow-up without touching call sites.

### Where the gates run

| Gate | Location | When |
| --- | --- | --- |
| Dangerous file (zip) | `artifactService.extractZip`, per entry, before `safeJoin`+write | on each zip entry |
| Dangerous file (folder) | `artifactService.writeFolderFiles`, per file, before `safeJoin`+write | on each folder file |
| `index.html` required | `versionService.uploadVersion`, after each `flattenOutput` call | once per upload, in both the zip and folder branches |

`extractZip` and `writeFolderFiles` currently throw a plain `Error` for unsafe
(traversal) paths. For dangerous files they instead throw `ApiError` directly,
which `versionService.uploadVersion`'s existing `catch` passes through unchanged
(it re-throws `ApiError` as-is and otherwise maps to a 500). The same `catch`
already calls `removeDir(versionDir)`, so a mid-extraction rejection leaves no
partial files behind — the rejection is atomic from the caller's perspective (no
version is ever recorded).

A thin helper **`hasRootIndexHtml(dir: string): boolean`** is added to
`artifactService.ts` (`existsSync(join(dir, 'index.html'))`). It is invoked in
both upload branches **immediately after** the existing `flattenOutput` call, so
that a zip whose `index.html` lives in a single nested subdirectory is hoisted by
`flattenOutput` and then passes the gate.

## Behavior changes

### 1. Block dangerous files

`extractZip` and `writeFolderFiles` gain, per entry, before writing:

```ts
const reason = matchBlockedPath(relativePath);
if (reason) {
  throw new ApiError(
    ErrorCode.BLOCKED_FILE,
    `Upload rejected: "${relativePath}" is blocked (${reason}). Remove it and upload again.`,
    400
  );
}
```

The check runs **before** the file is written, so the offending file itself never
lands on disk. The whole upload is rejected (not stripped-and-warned), per the
"clear error code" requirement.

### 2. Require `index.html`

In both branches of `versionService.uploadVersion`, after `flattenOutput(versionDir)`:

```ts
if (!hasRootIndexHtml(versionDir)) {
  throw new ApiError(
    ErrorCode.MISSING_INDEX_HTML,
    'Upload rejected: no index.html found at the root after extraction. DeployKit serves sites from index.html.',
    400
  );
}
```

The check is placed **after** `flattenOutput` deliberately: `flattenOutput`
hoists a single nested subdirectory containing `index.html`, so legitimate
"build output wrapped in one folder" uploads pass, while artifacts with no
`index.html` anywhere are rejected at upload time rather than 404-ing at deploy
time. Multi-level nesting (index.html two+ directories deep) is not hoisted and
will be rejected; that matches existing `flattenOutput` behavior.

### 3. Stop auto-publishing the first version

In `versionService.uploadVersion`, remove the first-version activation:

```diff
- const isFirstVersion = project.versions.length === 0;
  project.versions.push(version);
- if (isFirstVersion) project.activeVersionId = version.id;
  project.updatedAt = new Date().toISOString();
```

After this change `activeVersionId` stays `null` until an explicit
`activateVersion` call. The `version.upload` history event is unchanged;
activation continues to emit `version.activate` as a separate event.

**No migration is required:** only the new-upload path changes. Existing
projects keep their current `activeVersionId`, and already-stored versions
continue to be served and previewed unchanged.

### 4. Surface "no production version yet" in the UI

`DeployUrl` gains a `hasProduction: boolean` prop (passed from `DeployPage` as
`selectedProject.activeVersionId != null`):

- `hasProduction === false`: render the deploy URL as muted, non-clickable text
  (`text-muted-foreground`, not an `<a>`); show the existing
  `versions.deployHint` copy; hide the "open in new tab" button (it would 404);
  keep the **copy** button enabled (the URL is still useful to share/copy).
- `hasProduction === true`: current behavior unchanged.

`VersionList` requires **no changes** — it already renders correctly when no
version is active (no `PRODUCTION` badge; every version shows "Set Production").

i18n: both locales already have `versions.deployHint`
(`en.json` `"Set a version as production to access via this URL"`,
`zh.json` `"设为正式版本后可通过此地址访问"`), so no new strings are needed.

## Error contract

Two new codes are added to the `ErrorCode` const object in `errors.ts` (both
`status: 400`, serialized by `app.onError` to `{ error: { code, message } }`):

| Code | Message template | Notes |
| --- | --- | --- |
| `BLOCKED_FILE` | `Upload rejected: "<path>" is blocked (<reason>). Remove it and upload again.` | Reveals the offending path and the matched reason (internal tool; helpful for debugging). |
| `MISSING_INDEX_HTML` | `Upload rejected: no index.html found at the root after extraction. DeployKit serves sites from index.html.` | Static message (no path). |

Both are 400 (`INVALID_UPLOAD`-class). They are added as plain string members of
the `ErrorCode` const object, following the existing pattern (no TS enums, to
stay safe under `erasableSyntaxOnly`).

## Files touched

| File | Change |
| --- | --- |
| `apps/server/src/domain/uploadSafety.ts` | **New.** Pure `matchBlockedPath` + `BLOCKED_FILE_RULES`. |
| `apps/server/src/services/artifactService.ts` | Call `matchBlockedPath` in `extractZip` + `writeFolderFiles`; add `hasRootIndexHtml`. |
| `apps/server/src/services/versionService.ts` | Remove first-version auto-activation; add `index.html` gate in both branches. |
| `apps/server/src/errors.ts` | Add `BLOCKED_FILE`, `MISSING_INDEX_HTML`. |
| `apps/web/src/features/deploy/DeployUrl.tsx` | `hasProduction` prop; muted/hint rendering when false. |
| `apps/web/src/pages/DeployPage.tsx` | Pass `hasProduction={selectedProject.activeVersionId != null}`. |
| `packages/shared/**` | **No change.** No data shape change. |

## Testing

### New unit tests — `apps/server/tests/services/uploadSafety.test.ts`

Pure, no filesystem. Covers each rule and the precise-match guarantees:

- Hits: `.env`, `.env.local`, `.env.production`, `.env.example`, `config/.env`,
  `.git/config`, `node_modules/react/index.js`, `secrets/server.key`, `cert.pem`,
  `id_rsa`, `id_rsa.pub`, `subdir/.hg/state`.
- Non-hits (precision): `greenhouse.js`, `env-config.js`, `.environment.js`,
  `.envrc`, `monkey.jpeg`, `keyboard.txt`, `id_rsa_backup.txt`, `.gitignore`,
  `id_ed25519`, uppercase `.ENV`/`.GIT`.

### New API contract tests — `apps/server/tests/api`

- A zip containing `.env` (and separately `.git/config`, `id_rsa`) is uploaded →
  `400` with `error.code === 'BLOCKED_FILE'`; no version is recorded.
- A folder upload containing `.env` / `.git/` / `id_rsa` → same `400` +
  `BLOCKED_FILE`.
- An upload whose only file is `foo.txt` (no `index.html`) → `400` with
  `error.code === 'MISSING_INDEX_HTML'`; no version recorded.
- A valid upload containing `index.html` still returns `201`.

### Updated existing tests

| Test | Current assertion | Update |
| --- | --- | --- |
| `contracts.test.ts` "uploads a folder version that becomes the active version" (~L216) | `activeVersionId === versions[0].id` after first upload | Assert `activeVersionId` is `null` after upload; add an assertion that it becomes the version id only after `activate`. |
| `contracts.test.ts` "serves the active version via /deploy/:slug/" (~L287) | Upload then `GET /deploy/:slug/` → 200 | Add an `activate` step before asserting 200; add a case that an un-activated upload yields 404 on `/deploy/:slug/`. |
| `contracts.test.ts` "deleting the active version promotes a replacement" (~L270) | v1 auto-active, delete v1 promotes v2 | Activate v1 first, then delete it, then assert v2 is promoted. |
| `app.test.ts` (~L83) | `activeVersionId === createdVersion.version.id` | Assert `null` after upload. |
| `apps/web/tests/unit/VersionList.test.tsx` | Verify the mock project's `activeVersionId` aligns with the new default (null until activated) | Adjust mock/assertions if the test assumed the first version is active. |

### Manual verification

After implementation, `bun run typecheck && bun run check && bun run test && bun run build`
should all pass. A quick end-to-end check in `dev:server` + `dev:web`: upload a
folder with `index.html` → it appears as preview-only (no badge, "Set
Production" button); `/deploy/:slug/` returns 404 until "Set Production" is
clicked, then serves the version.

## Acceptance criteria

- An upload containing `.env`, `.git/`, `node_modules/`, `*.pem`/`*.key`, or
  `id_rsa`(/`.pub`) is rejected with `BLOCKED_FILE`; no version is persisted.
- An upload with no `index.html` anywhere (after flatten) is rejected with
  `MISSING_INDEX_HTML`.
- Every upload (including the first) leaves `activeVersionId === null` until an
  explicit activate; `/deploy/:slug/` 404s in that state and serves the version
  after activation.
- Existing projects and their stored versions are unaffected (no migration).
- The management UI shows a muted deploy URL + the `deployHint` copy when a
  project has no production version.
- CI (`typecheck → lint → biome check → test → build`) is green.
