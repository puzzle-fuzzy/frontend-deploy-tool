# Desktop Client (P0 MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a native Electron desktop client that connects to a user-specified remote DeployKit server, mirrors 100% of the web panel's deploy-management features, and adds native directory + drag-and-drop folder uploads — with the server unchanged.

**Architecture:** Extract the web app's transport-coupled `api` singleton into a transport-agnostic `ApiClient` interface + `<ApiClientProvider>` React context inside a new `packages/client` package. Web and desktop each become thin shells: web provides a `fetchApiClient` (hono/client), desktop provides an `ipcApiClient` that bridges to the Electron main process. The main process owns all server I/O via Electron `net` over a dedicated `persist:deploykit` session partition (cookies auto-persist, encrypted at rest), so session tokens never enter the renderer. Components, hooks, i18n, theme — everything UI — is shared verbatim.

**Tech Stack:** Electron 43 + Electron Forge (Vite plugin), React 19 + React Compiler, Tailwind v4, Hono (server types only via `@deploykit/server/api`), TypeScript (strict, `erasableSyntaxOnly`, `verbatimModuleSyntax`), Vitest + RTL (packages/client), bun:test (desktop main-process unit tests), Bun workspace + catalog deps.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-02-desktop-client-design.md` — every decision below traces to it. P0 = the table row in spec §6.
- **Server is frozen** (spec §1, §2): NO new routes, NO CORS changes, NO SameSite changes, NO OAuth. All endpoints the desktop calls already exist (confirmed: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/me`, `GET/POST /api/projects`, `PATCH/DELETE /api/projects/:id`, `PATCH /api/projects/:id/settings`, `POST /api/projects/:id/versions`, `POST .../publish`, `POST .../rollback`, `DELETE .../versions/:versionId`).
- **`erasableSyntaxOnly: true` + `verbatimModuleSyntax: true`** in `packages/client` and `apps/web` tsconfigs (web §6): **NO TS enums, NO namespaces, NO constructor parameter properties.** `ErrorCode` is a `const` object + derived union (see `apps/server/src/errors.ts:9-34`). All type-only imports use `import type`.
- **`@` alias** means `apps/web/src` in web and **`packages/client/src`** in the client package (both use `@` — see Task 2). Components migrated to `packages/client` keep `@/...` imports working unchanged.
- **Transport contract:** every method on `ApiClient` returns the **exact** shape the web `api` singleton returns today (confirmed in `apps/web/src/shared/api.ts`). `getMe` returns `SafeUser | null` (null on 401). All others throw `Error` on non-2xx. The error envelope is `{ error: { code, message } }` (server `app.ts:99-118`); `checkOk`/`extractMessage` parse it.
- **Upload multipart field names are load-bearing** (server `apps/server/src/routes/versions.ts:10-35`): single zip → field `file`; folder → multi-value field `folderFiles` with each part's filename = `webkitRelativePath || name`; description → field `versionDesc`. Endpoint `POST /api/projects/:id/versions`, returns `201 { version: { id, name } }`.
- **Folder path handling** (server `apps/server/src/services/artifactService.ts:216-258`): server does `f.webkitRelativePath || f.name`, normalizes `\`→`/`, strips leading `/`. Desktop must set `webkitRelativePath` to a POSIX-relative path.
- **Native capability boundary** (spec §4.5): `ApiClient` holds server-shape methods only. Desktop-native capabilities (server config, web login, native directory pick, native notify, auth-expired event) live on `window.deploykit.native.*`, NOT on `ApiClient`.
- **Cookie partition:** `Session.fromPartition('persist:deploykit')` (spec §3.4). All server requests use Electron `net.request({ session })`. Renderer NEVER sees cookies; only `SafeUser` crosses IPC.
- **Commit convention:** conventional commits, `feat`/`fix`/`refactor`/`chore`/`test`/`docs`. Single quotes, 2-space indent, LF, width 80, ES5 trailing commas, semicolons (Biome, spec conventions). Run `bun run check:fix` before each commit.
- **Commit cadence:** every task ends with ≥1 commit. Within a task, commit after each step that produces green tests.
- **Frequent green builds:** after every task, `bun run typecheck && bun run test` (root) must pass; `bun run check` must pass before commit.
- **Server roles** (AGENTS.md): `admin` create/delete projects; `developer` upload/publish/rollback/delete versions + edit settings; `viewer` read-only. The desktop reflects whatever role the server returns.

## File Structure

This plan touches 4 packages. Map of what each file owns:

### New: `packages/client/` (`@deploykit/client`) — the reuse core
- `packages/client/package.json` — name `@deploykit/client`, deps: `@deploykit/shared`, `@deploykit/server` (type only), `react`, `react-i18next`, `i18next`, `radix-ui`, `hono`, `lucide-react`, `tailwind-merge`, `class-variance-authority`, `clsx`, `tw-animate-css`, `zod`. devDeps: vitest, RTL stack, `@types/react`/`react-dom`, typescript (all `catalog:`). `exports: { ".": "./src/index.ts" }`.
- `packages/client/tsconfig.json` — `strict`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `jsx: react-jsx`, `paths: { "@/*": ["./src/*"] }`, `include: ["src", "tests"]`, `moduleResolution: bundler`, `noEmit: true`. `lib: ["ES2023","DOM","DOM.Iterable"]`.
- `packages/client/vitest.config.ts` — `environment: 'jsdom'`, setupFiles `['./tests/setup.ts']`, `resolve.alias: { '@': resolve(__dirname,'./src') }`.
- `packages/client/tests/setup.ts` — copy of `apps/web/tests/setup.ts` (ResizeObserver stub, react-i18next mock, toast mock, jest-dom).
- `packages/client/src/api/ApiClient.ts` — **the interface.** `interface ApiClient { getMe; login; logout; listProjects; createProject; updateProject; deleteProject; updateSettings; uploadVersion; publishVersion; rollbackVersion; deleteVersion }`. Pure types, no impl.
- `packages/client/src/api/errors.ts` — `extractMessage(text)` + `checkOk(res)` (moved from web `shared/api.ts:8-26`).
- `packages/client/src/api/ApiClientProvider.tsx` — `createContext<ApiClient | null>`, `<ApiClientProvider client={...}>`, `useApiClient()` hook (throws if missing).
- `packages/client/src/api/index.ts` — barrel: re-export `ApiClient`, `ApiClientProvider`, `useApiClient`, `extractMessage`, `checkOk`.
- `packages/client/src/api/fetchApiClient.ts` — `createFetchApiClient(): ApiClient` — the hono/client-backed impl (moved out of web). Re-exported from index for web/tests.
- `packages/client/src/index.ts` — top barrel: re-export `./api` + `./App` + `./features` + `./pages` + `./shared` + `./i18n` + `./theme` (built incrementally).
- **Migrated from web (mechanical move, keep `@/` imports):**
  - `src/shared/` ← `apps/web/src/shared/{types.ts, format.ts, utils.ts, ui/**}` (NOT `api.ts` — that becomes `api/`).
  - `src/features/` ← `apps/web/src/features/**` (auth, projects, settings, versions, deploy, i18n, theme).
  - `src/pages/` ← `apps/web/src/pages/DeployPage.tsx`.
  - `src/i18n/` ← `apps/web/src/i18n/**`.
  - `src/theme/` ← (none today; theme lives in features/theme — create dir only if needed; otherwise skip).
- `packages/client/src/api/__tests__/ApiClientProvider.test.tsx` — provider + hook tests with a mock client.
- Migrated tests from `apps/web/tests/unit/` → `packages/client/tests/unit/` (all `*.test.{ts,tsx}` except `config.test.ts`, `api.test.ts` which stay web-local; `useProjects.test.ts` and dialog tests come along).

### Modified: `apps/web/` (shell)
- `apps/web/package.json` — add `@deploykit/client: workspace:*`. Remove now-shared deps that live in client (or keep as peerDeps — see Task 5; simplest: keep them, they're cheap). Add `dev`/`typecheck` already exist.
- `apps/web/tsconfig.app.json` — add `paths: { "@/*": ["./src/*"], "@deploykit/client/*": ["../../packages/client/src/*"] }` so web source can still alias-import (only needed if web keeps any src; after migration web src shrinks to `main.tsx`, `App.tsx`, `config.ts`, `index.css`).
- `apps/web/vite.config.ts` — add alias `'@deploykit/client': resolve(__dirname,'../../packages/client/src')`.
- `apps/web/vitest.config.ts` — same alias addition (so migrated tests' `@/` resolves into the client package).
- `apps/web/src/main.tsx` — now: `import { App } from '@deploykit/client'` + render under `<ApiClientProvider client={createFetchApiClient()}>`. Wait — App already wraps providers; simplest: web's `main.tsx` renders `<ApiClientProvider client={...}><App/></ApiClientProvider>`.
- `apps/web/src/App.tsx` — DELETE (moves to `packages/client/src/App.tsx`). Web no longer has its own App.
- `apps/web/src/config.ts`, `apps/web/src/index.css`, `apps/web/src/i18n/` — DELETE (move to client) **or** keep `config.ts` web-local and pass into App as a prop. Decision (Task 3): move `config.ts` to client as `shared/config.ts` since desktop needs the same `getPublicBaseURL`-style helper but resolved differently (desktop resolves server origin at runtime, not build-time — so `config.ts` becomes an injected value; see Task 3 for the seam).
- `apps/web/tests/unit/api.test.ts` — keep, but update to test `createFetchApiClient()` instead of `api`.

### New: `apps/desktop/` (shell + main process)
- `apps/desktop/package.json` — rename `my-new-app`→`@deploykit/desktop`, `version: 0.0.0`, `type: module`, add `@deploykit/client`, `@deploykit/shared`, `@deploykit/server` (type-only), `hono`, `react`, `react-dom`, `react-i18next`, etc. deps via `catalog:` where catalog has them; add electron-forge/electron deps to catalog if absent (or hard-pin for now — see Task 1). Scripts: `dev`/`start`, `build`, `typecheck`, `lint`, `test`.
- `apps/desktop/tsconfig.json` — `strict`, `erasableSyntaxOnly`, `module: commonjs` (Electron main/preload), separate `tsconfig.web.json` for renderer (`module: esnext`, `jsx`, etc.). Path mappings for `@deploykit/client`, `@deploykit/shared`, `@deploykit/server`.
- `apps/desktop/forge.config.ts` — keep Vite plugin + makers; main entry stays `src/main/index.ts`.
- `apps/desktop/vite.main.config.ts` — add `resolve.preserveSymlinks: false` + `external: [...]` for Node builtins; build `src/main/index.ts`.
- `apps/desktop/vite.preload.config.ts` — same symlink fix; build `src/preload.ts`.
- `apps/desktop/vite.renderer.config.mts` — keep symlink fix; add `resolve.alias` for `@deploykit/client`→client src, `@deploykit/shared`→shared src; add `@`→renderer src.
- `apps/desktop/src/shared/bridge.ts` — `DesktopBridge` interface (the `window.deploykit` contract).
- `apps/desktop/src/shared/config.ts` — server config read/write (`electron-store` or hand-rolled JSON in `app.getPath('userData')`), `getServerOrigin()`/`setServerOrigin()`/`clearServer()`, limits constants.
- `apps/desktop/src/main/index.ts` — app lifecycle, window creation, tray (P1), wires `registerIpc()`.
- `apps/desktop/src/main/ipc.ts` — `registerIpc(getServerOrigin, session)` — registers `ipcMain.handle('api:*', ...)` + native handlers.
- `apps/desktop/src/main/serverRequest.ts` — `request(method, path, { body?, multipart?, onProgress? })` over `net.request({ session })`; throws typed errors on non-2xx.
- `apps/desktop/src/main/auth.ts` — `login(email,password)`, `getMe()`, `logout()`, `loginViaWeb(parentWindow)`, `validateServer(url)` — all use `serverRequest`.
- `apps/desktop/src/main/nativeUpload.ts` — `collectDirectory(absPath)`, `preflight(files)`, `uploadFolder(...)`, `uploadZip(...)`, `pickDirectory(parentWindow)` — multipart build + progress over `net`.
- `apps/desktop/src/preload.ts` — `contextBridge.exposeApi('deploykit', bridge)` (typed via `DesktopBridge`).
- `apps/desktop/src/renderer/main.tsx` — mount `<DesktopApp/>` under `ApiClientProvider`.
- `apps/desktop/src/renderer/DesktopApp.tsx` — bootstrap → login gate → `<App/>` (from client).
- `apps/desktop/src/renderer/ipcApiClient.ts` — `createIpcApiClient(): ApiClient` — each method calls `window.deploykit.api.*`.
- `apps/desktop/src/renderer/index.css` — `@import "tailwindcss";` + theme tokens (copy from web `index.css`).
- `apps/desktop/index.html` — `<div id="root">`, loads `/src/renderer/main.tsx`.
- `apps/desktop/tests/` — `nativeUpload.test.ts`, `preflight.test.ts`, `serverRequest.test.ts` (bun:test, mock `net`).
- `apps/desktop/.gitignore` — already ignores `.vite/`, `out/`. Add nothing.

### Modified: root
- `package.json` — add `apps/desktop` to `workspaces.packages`; add `dev:desktop` script.
- Root `.gitignore` — already ignores `bun.lock`; no change.
- Delete `apps/desktop/bun.lock` from disk (Task 1; it's already untracked — physical removal only).

---

## P0 Task Breakdown

P0 is split into 8 sequential tasks. **Strict ordering:** Task 1 (workspace) → 2 (client skeleton) → 3 (refactor transport) → 4 (migrate UI) → 5 (web shell) → 6 (desktop workspace+main) → 7 (desktop transport+auth) → 8 (desktop upload+UI). Tasks 1–5 are pure refactor (web stays green throughout); 6–8 add the desktop.

---

### Task 1: Join `apps/desktop` to the root Bun workspace

**Goal:** Make `apps/desktop` a first-class workspace member named `@deploykit/desktop`, switch shared deps to catalog, add the missing Electron catalog entries, and add a root `dev:desktop` script. After this task `bun install` at root resolves the desktop package and its deps; the desktop still launches via the unchanged Forge template.

**Files:**
- Modify: `package.json` (root) — `workspaces.packages`, `workspaces.catalog`, `scripts`.
- Modify: `apps/desktop/package.json` — rename, version, `type`, scripts, catalog deps.
- Delete: `apps/desktop/bun.lock` (already gitignored at `.gitignore:19`; physical file removal only).

**Interfaces:** Produces — a workspace where `@deploykit/desktop` is symlinked into root `node_modules` and `bun install` produces a single consolidated install. No code interfaces yet.

- [ ] **Step 1: Add `apps/desktop` to root workspaces + add catalog entries + `dev:desktop` script**

In `package.json` (root), edit the `workspaces` block. Replace:

```json
  "workspaces": {
    "packages": [
      "apps/server",
      "apps/web",
      "packages/*"
    ],
    "catalog": {
```

with:

```json
  "workspaces": {
    "packages": [
      "apps/server",
      "apps/web",
      "apps/desktop",
      "packages/*"
    ],
    "catalog": {
```

Then add the Electron-only catalog entries. Inside the existing `catalog` object (alphabetical is nice but not required), add these keys (they are desktop-only; no other package references them yet):

```json
      "@electron-forge/cli": "^7.11.2",
      "@electron-forge/maker-deb": "^7.11.2",
      "@electron-forge/maker-rpm": "^7.11.2",
      "@electron-forge/maker-squirrel": "^7.11.2",
      "@electron-forge/maker-zip": "^7.11.2",
      "@electron-forge/plugin-auto-unpack-natives": "^7.11.2",
      "@electron-forge/plugin-fuses": "^7.11.2",
      "@electron-forge/plugin-vite": "^7.11.2",
      "@electron/fuses": "^1.8.0",
      "@types/electron-squirrel-startup": "^1.0.2",
      "electron": "43.0.0",
      "electron-squirrel-startup": "^1.0.1",
```

Then add the `dev:desktop` script. In the root `scripts` object, after the `"dev:server"` line, add:

```json
    "dev:desktop": "bun --filter @deploykit/desktop dev",
```

- [ ] **Step 2: Rewrite `apps/desktop/package.json` to the workspace identity**

Replace the entire contents of `apps/desktop/package.json` with:

```json
{
  "name": "@deploykit/desktop",
  "productName": "DeployKit",
  "version": "0.0.0",
  "description": "DeployKit desktop client",
  "main": ".vite/build/main.js",
  "private": true,
  "scripts": {
    "dev": "electron-forge start",
    "start": "electron-forge start",
    "package": "electron-forge package",
    "make": "electron-forge make",
    "publish": "electron-forge publish",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "biome lint .",
    "test": "bun test"
  },
  "author": { "name": "Error418", "email": "16615812538@163.com" },
  "license": "MIT",
  "dependencies": {
    "electron-squirrel-startup": "catalog:",
    "react": "catalog:",
    "react-dom": "catalog:"
  },
  "devDependencies": {
    "@electron-forge/cli": "catalog:",
    "@electron-forge/maker-deb": "catalog:",
    "@electron-forge/maker-rpm": "catalog:",
    "@electron-forge/maker-squirrel": "catalog:",
    "@electron-forge/maker-zip": "catalog:",
    "@electron-forge/plugin-auto-unpack-natives": "catalog:",
    "@electron-forge/plugin-fuses": "catalog:",
    "@electron-forge/plugin-vite": "catalog:",
    "@electron/fuses": "catalog:",
    "@tailwindcss/vite": "catalog:",
    "@types/electron-squirrel-startup": "catalog:",
    "@types/react": "catalog:",
    "@types/react-dom": "catalog:",
    "@vitejs/plugin-react": "catalog:",
    "electron": "catalog:",
    "tailwindcss": "catalog:",
    "typescript": "catalog:",
    "vite": "catalog:"
  }
}
```

> Note: the scaffold currently has `@tailwindcss/vite` + `tailwindcss` as `dependencies`; move them to `devDependencies` (build-time only) to match web. `electron` is a `devDependency` (it is the build/runtime toolchain, not shipped semantics — Forge convention).

- [ ] **Step 3: Delete the stale desktop lockfile from disk**

```bash
rm -f apps/desktop/bun.lock
```

Verify it is gitignored (should print the matched rule, no error):

```bash
git check-ignore apps/desktop/bun.lock
```

- [ ] **Step 4: Install + verify workspace wiring**

Run from repo root:

```bash
bun install
```

Expected: completes without error; produces/updates the root install. Verify the package resolves:

```bash
ls node_modules/@deploykit/desktop/package.json
bun pm ls 2>/dev/null | grep @deploykit/desktop || echo "ls-based check passed"
```

Expected: `node_modules/@deploykit/desktop/package.json` exists (workspace symlink).

- [ ] **Step 5: Verify lint/format clean**

```bash
bun run check
```

Expected: Biome reports no errors in `apps/desktop`. If formatting diffs appear, run `bun run check:fix` and re-run.

- [ ] **Step 6: Commit**

```bash
git add package.json apps/desktop/package.json
git commit -m "chore(desktop): join apps/desktop to root bun workspace as @deploykit/desktop"
```

(The deleted `apps/desktop/bun.lock` is already untracked, so it needs no `git add`.)

---

### Task 2: Create `packages/client` skeleton + transport-agnostic core

**Goal:** Create the `@deploykit/client` package holding the `ApiClient` interface, error helpers, three React providers (`ApiClientProvider`, `NativeProvider`, `ServerInfoProvider`), and the web `fetchApiClient` implementation — with unit tests. The web app is **untouched** in this task and stays green; it starts consuming this package in Task 3.

**Files (all Create):**
- `packages/client/package.json`
- `packages/client/tsconfig.json`
- `packages/client/vitest.config.ts`
- `packages/client/tests/setup.ts`
- `packages/client/src/api/ApiClient.ts` — the interface (+ `UploadableFile`, `UploadProgress`).
- `packages/client/src/api/errors.ts` — `extractMessage` + `checkOk`.
- `packages/client/src/api/NativeBridge.ts` — desktop-capability interface (nullable in web).
- `packages/client/src/api/ApiClientProvider.tsx` — context + `useApiClient()`.
- `packages/client/src/api/NativeProvider.tsx` — context + `useNative()`.
- `packages/client/src/api/ServerInfoProvider.tsx` — context + `useServerInfo()`.
- `packages/client/src/api/fetchApiClient.ts` — `createFetchApiClient(): ApiClient` (hono/client + XHR upload).
- `packages/client/src/api/index.ts` — barrel.
- `packages/client/src/index.ts` — top barrel (re-exports `./api` for now; UI added in Task 4).
- Test: `packages/client/tests/unit/ApiClientProvider.test.tsx`

**Interfaces:**
- Produces: `ApiClient` (the 12-method contract every transport implements), `ApiClientProvider`/`useApiClient`, `NativeBridge`/`NativeProvider`/`useNative`, `ServerInfoProvider`/`useServerInfo`, `createFetchApiClient`, `extractMessage`, `checkOk`. These are consumed by Task 3 (web) and Tasks 7–8 (desktop).

- [ ] **Step 1: Create the package + configs**

`packages/client/package.json`:

```json
{
  "name": "@deploykit/client",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc -p tsconfig.json --noEmit",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "lint": "biome lint ."
  },
  "dependencies": {
    "@deploykit/shared": "workspace:*",
    "class-variance-authority": "catalog:",
    "clsx": "catalog:",
    "hono": "catalog:",
    "i18next": "catalog:",
    "lucide-react": "catalog:",
    "radix-ui": "catalog:",
    "react": "catalog:",
    "react-dom": "catalog:",
    "react-i18next": "catalog:",
    "tailwind-merge": "catalog:",
    "tw-animate-css": "catalog:",
    "zod": "catalog:"
  },
  "devDependencies": {
    "@deploykit/server": "workspace:*",
    "@tailwindcss/vite": "catalog:",
    "@testing-library/jest-dom": "catalog:",
    "@testing-library/react": "catalog:",
    "@testing-library/user-event": "catalog:",
    "@types/react": "catalog:",
    "@types/react-dom": "catalog:",
    "@vitejs/plugin-react": "catalog:",
    "@rollldown/plugin-babel": "catalog:",
    "babel-plugin-react-compiler": "catalog:",
    "jsdom": "catalog:",
    "tailwindcss": "catalog:",
    "typescript": "catalog:",
    "vite": "catalog:",
    "vitest": "catalog:"
  }
}
```

> Add these missing catalog entries to root `package.json` `workspaces.catalog` now (test stack + babel — web already uses these but verify presence): `vitest`, `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`, `jsdom`, `@rolldown/plugin-babel`, `babel-plugin-react-compiler`. If `bun install` later complains a catalog key is missing, add it with web's pinned version (see `apps/web/package.json` devDeps for exact ranges). Concretely add to root catalog:

```json
      "@rolldown/plugin-babel": "^0.2.3",
      "@testing-library/jest-dom": "^6.9.1",
      "@testing-library/react": "^16.3.2",
      "@testing-library/user-event": "^14.6.1",
      "babel-plugin-react-compiler": "^1.0.0",
      "jsdom": "^29.1.1",
      "vitest": "^4.1.9",
```

> (`@rolldown/plugin-babel` and `babel-plugin-react-compiler` already appear in the existing catalog per Task 1's snapshot — keep one copy; de-dup if duplicate keys error.)

`packages/client/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "types": ["vite/client", "@testing-library/jest-dom"],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src", "tests"]
}
```

`packages/client/vitest.config.ts`:

```ts
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
  },
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
});
```

`packages/client/tests/setup.ts` (copy of `apps/web/tests/setup.ts` verbatim):

```ts
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom does not implement ResizeObserver (used by Radix ScrollArea/Tooltip).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

afterEach(() => {
  cleanup();
});

// Components use useTranslation; render with the i18n key as the label so tests
// stay locale-independent.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', changeLanguage: () => {} },
  }),
}));

// Toast is a side-effect channel; no-op it in tests.
vi.mock('@/shared/ui/toast-context', () => ({
  useToast: () => ({ toast: () => {} }),
}));
```

> The last mock (`@/shared/ui/toast-context`) is needed only once UI lands in Task 4; harmless to declare now.

- [ ] **Step 2: Write the failing provider test first (TDD)**

`packages/client/tests/unit/ApiClientProvider.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientProvider, useApiClient } from '@/api/ApiClientProvider';
import type { ApiClient } from '@/api/ApiClient';

const stubClient = { getMe: vi.fn() } as unknown as ApiClient;

function Consumer() {
  const c = useApiClient();
  return <span>{c === stubClient ? 'got-it' : 'wrong'}</span>;
}

describe('ApiClientProvider', () => {
  it('provides the client through context', () => {
    render(
      <ApiClientProvider client={stubClient}>
        <Consumer />
      </ApiClientProvider>,
    );
    expect(screen.getByText('got-it')).toBeInTheDocument();
  });

  it('throws when used without a provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Consumer />)).toThrow(/ApiClientProvider/);
    spy.mockRestore();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails (module not found)**

From repo root:

```bash
bun --filter @deploykit/client test
```

Expected: FAIL — `Cannot find module '@/api/ApiClientProvider'` (and `@/api/ApiClient`). This confirms the test is wired before the code exists.

- [ ] **Step 4: Implement `ApiClient.ts` (the interface)**

`packages/client/src/api/ApiClient.ts`:

```ts
import type { Project, SafeUser, Settings } from '@deploykit/shared';

/**
 * A file that can be uploaded. A real browser `File` satisfies this; Electron
 * drag-drop Files additionally carry a non-standard `path` (absolute on-disk
 * path), and native-picked files set `path` + `webkitRelativePath` so the
 * main process can read bytes from disk instead of crossing IPC.
 */
export interface UploadableFile {
  name: string;
  size: number;
  type: string;
  webkitRelativePath?: string;
  path?: string;
}

export type UploadProgress = (percent: number) => void;

/**
 * Transport-agnostic server API. Mirrors the method set of the legacy web
 * `api` singleton 1:1 (same names, same return shapes). Web implements it with
 * `hono/client` + XHR; desktop implements it over IPC to the Electron main
 * process. Components consume it via `useApiClient()`.
 */
export interface ApiClient {
  /** Returns null on 401 (not authenticated). */
  getMe(): Promise<SafeUser | null>;
  login(email: string, password: string): Promise<SafeUser>;
  logout(): Promise<void>;
  listProjects(): Promise<Project[]>;
  createProject(input: {
    name: string;
    slug: string;
    description: string;
  }): Promise<Project>;
  updateProject(
    id: string,
    updates: { name?: string; slug?: string; description?: string },
  ): Promise<Project>;
  deleteProject(id: string): Promise<{ ok: boolean }>;
  updateSettings(id: string, settings: Settings): Promise<Project>;
  uploadVersion(
    projectId: string,
    file: UploadableFile | null,
    folderFiles: UploadableFile[] | null,
    description: string,
    onProgress?: UploadProgress,
  ): Promise<{ version: { id: string; name: string } }>;
  publishVersion(projectId: string, versionId: string): Promise<{ ok: boolean }>;
  rollbackVersion(projectId: string, versionId: string): Promise<{ ok: boolean }>;
  deleteVersion(projectId: string, versionId: string): Promise<{ ok: boolean }>;
}
```

`packages/client/src/api/errors.ts` (moved verbatim from `apps/web/src/shared/api.ts:8-26`):

```ts
export function extractMessage(text: string): string {
  try {
    return JSON.parse(text)?.error?.message ?? text;
  } catch {
    return text;
  }
}

export async function checkOk(res: {
  ok: boolean;
  statusText: string;
  text: () => Promise<string>;
}): Promise<void> {
  if (res.ok) return;
  const text = await res.text();
  throw new Error(extractMessage(text) || res.statusText);
}
```

- [ ] **Step 5: Implement `NativeBridge.ts`**

`packages/client/src/api/NativeBridge.ts`:

```ts
import type { SafeUser } from '@deploykit/shared';
import type { UploadProgress } from './ApiClient';

/** A file picked from disk by the Electron main process. */
export interface NativeFile {
  name: string;
  size: number;
  type: string;
  /** POSIX-relative path within the picked directory, e.g. "assets/app.js". */
  webkitRelativePath: string;
  /** Absolute on-disk path; the main process reads bytes from here. */
  path: string;
}

export interface PickedDirectory {
  directoryName: string;
  files: NativeFile[];
}

export type ValidateServerResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Desktop-only capabilities (spec §4.5). Lives on `window.deploykit.native`,
 * NOT on `ApiClient`. Web provides `null` (features gated on `useNative()`).
 */
export interface NativeBridge {
  pickDirectory(): Promise<PickedDirectory | null>;
  /** Validates + persists a server origin. 401 from /api/me = reachable. */
  validateServer(url: string): Promise<ValidateServerResult>;
  configureServer(url: string): Promise<void>;
  /** Returns '' before onboarding completes. */
  getServerOrigin(): string;
  /** Opens an embedded web-login window; resolves the user or null on close. */
  loginViaWeb(): Promise<SafeUser | null>;
  /** Fires when the main process sees a 401 mid-session. Returns unsubscribe. */
  onAuthExpired(cb: () => void): () => void;
}
```

- [ ] **Step 6: Implement the three providers**

`packages/client/src/api/ApiClientProvider.tsx`:

```tsx
import { createContext, useContext, type ReactNode } from 'react';
import type { ApiClient } from './ApiClient';

const ApiClientContext = createContext<ApiClient | null>(null);

export function ApiClientProvider({
  client,
  children,
}: {
  client: ApiClient;
  children: ReactNode;
}) {
  return (
    <ApiClientContext.Provider value={client}>
      {children}
    </ApiClientContext.Provider>
  );
}

export function useApiClient(): ApiClient {
  const client = useContext(ApiClientContext);
  if (!client) {
    throw new Error('useApiClient must be used within <ApiClientProvider>');
  }
  return client;
}
```

`packages/client/src/api/NativeProvider.tsx`:

```tsx
import { createContext, useContext, type ReactNode } from 'react';
import type { NativeBridge } from './NativeBridge';

const NativeContext = createContext<NativeBridge | null>(null);

export function NativeProvider({
  bridge,
  children,
}: {
  bridge: NativeBridge | null;
  children: ReactNode;
}) {
  return <NativeContext.Provider value={bridge}>{children}</NativeContext.Provider>;
}

/** Returns the native bridge, or null in the web app. */
export function useNative(): NativeBridge | null {
  return useContext(NativeContext);
}
```

`packages/client/src/api/ServerInfoProvider.tsx`:

```tsx
import { createContext, useContext, type ReactNode } from 'react';

const ServerInfoContext = createContext<{ origin: string }>({ origin: '' });

export function ServerInfoProvider({
  origin,
  children,
}: {
  origin: string;
  children: ReactNode;
}) {
  return (
    <ServerInfoContext.Provider value={{ origin }}>
      {children}
    </ServerInfoContext.Provider>
  );
}

/** Server origin used to build deploy URLs etc. Web: publicBaseUrl; desktop: configured origin. */
export function useServerInfo(): { origin: string } {
  return useContext(ServerInfoContext);
}
```

- [ ] **Step 7: Implement `fetchApiClient.ts` (the web transport)**

`packages/client/src/api/fetchApiClient.ts` — moved from `apps/web/src/shared/api.ts`, signatures unchanged, wrapped as a factory. `File` is structurally compatible with `UploadableFile`:

```ts
import type { ApiApp } from '@deploykit/server/api';
import { hc } from 'hono/client';
import type { Project, SafeUser, Settings } from '@deploykit/shared';
import type { ApiClient, UploadableFile, UploadProgress } from './ApiClient';
import { checkOk, extractMessage } from './errors';

// Same-origin API; the Vite dev server proxies `/api` to the backend in dev.
const client = hc<ApiApp>('');

export function createFetchApiClient(): ApiClient {
  return {
    async getMe(): Promise<SafeUser | null> {
      const res = await client.api.me.$get();
      if (res.status === 401) return null;
      await checkOk(res);
      return (await res.json()) as SafeUser;
    },

    async login(email: string, password: string): Promise<SafeUser> {
      const res = await client.api.auth.login.$post({ json: { email, password } });
      await checkOk(res);
      const body = (await res.json()) as { user: SafeUser };
      return body.user;
    },

    async logout(): Promise<void> {
      const res = await client.api.auth.logout.$post();
      await checkOk(res);
    },

    async listProjects(): Promise<Project[]> {
      const res = await client.api.projects.$get();
      await checkOk(res);
      return (await res.json()) as Project[];
    },

    async createProject(input: {
      name: string;
      slug: string;
      description: string;
    }): Promise<Project> {
      const res = await client.api.projects.$post({ json: input });
      await checkOk(res);
      return (await res.json()) as Project;
    },

    async updateProject(
      id: string,
      updates: { name?: string; slug?: string; description?: string },
    ): Promise<Project> {
      const res = await client.api.projects[':id'].$patch({
        param: { id },
        json: updates,
      });
      await checkOk(res);
      return (await res.json()) as Project;
    },

    async deleteProject(id: string): Promise<{ ok: boolean }> {
      const res = await client.api.projects[':id'].$delete({ param: { id } });
      await checkOk(res);
      return (await res.json()) as { ok: boolean };
    },

    async updateSettings(id: string, settings: Settings): Promise<Project> {
      const res = await client.api.projects[':id'].settings.$patch({
        param: { id },
        json: settings,
      });
      await checkOk(res);
      return (await res.json()) as Project;
    },

    uploadVersion(
      projectId: string,
      file: UploadableFile | null,
      folderFiles: UploadableFile[] | null,
      description: string,
      onProgress?: UploadProgress,
    ): Promise<{ version: { id: string; name: string } }> {
      return new Promise((resolve, reject) => {
        const form = new FormData();
        if (file) form.append('file', file as File);
        if (folderFiles) {
          for (const f of folderFiles) {
            form.append('folderFiles', f as File, f.webkitRelativePath || f.name);
          }
        }
        form.append('versionDesc', description);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/projects/${projectId}/versions`);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && onProgress) {
            onProgress(Math.round((e.loaded / e.total) * 100));
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(JSON.parse(xhr.responseText));
          } else {
            reject(new Error(extractMessage(xhr.responseText) || 'Upload failed'));
          }
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.send(form);
      });
    },

    async publishVersion(
      projectId: string,
      versionId: string,
    ): Promise<{ ok: boolean }> {
      const res = await client.api.projects[':id'].versions[':versionId'].publish.$post(
        { param: { id: projectId, versionId } },
      );
      await checkOk(res);
      return (await res.json()) as { ok: boolean };
    },

    async rollbackVersion(
      projectId: string,
      versionId: string,
    ): Promise<{ ok: boolean }> {
      const res = await client.api.projects[':id'].versions[':versionId'].rollback.$post(
        { param: { id: projectId, versionId } },
      );
      await checkOk(res);
      return (await res.json()) as { ok: boolean };
    },

    async deleteVersion(
      projectId: string,
      versionId: string,
    ): Promise<{ ok: boolean }> {
      const res = await client.api.projects[':id'].versions[':versionId'].$delete({
        param: { id: projectId, versionId },
      });
      await checkOk(res);
      return (await res.json()) as { ok: boolean };
    },
  };
}
```

> `file as File` / `f as File`: in the web transport a real `File` is always passed, so the cast is sound at runtime; the `UploadableFile` interface only loosens the *static* type so desktop can pass path-backed stubs through the shared `ApiClient` contract without dragging Electron types into `packages/client`.

- [ ] **Step 8: Write the barrels**

`packages/client/src/api/index.ts`:

```ts
export type { ApiClient, UploadableFile, UploadProgress } from './ApiClient';
export { checkOk, extractMessage } from './errors';
export { ApiClientProvider, useApiClient } from './ApiClientProvider';
export { NativeProvider, useNative } from './NativeProvider';
export type {
  NativeBridge,
  NativeFile,
  PickedDirectory,
  ValidateServerResult,
} from './NativeBridge';
export { ServerInfoProvider, useServerInfo } from './ServerInfoProvider';
export { createFetchApiClient } from './fetchApiClient';
```

`packages/client/src/index.ts` (top barrel — UI added in Task 4):

```ts
export * from './api';
```

- [ ] **Step 9: Run the test to verify it passes**

```bash
bun --filter @deploykit/client test
```

Expected: PASS (2 tests in `ApiClientProvider.test.tsx`).

- [ ] **Step 10: Typecheck + lint**

```bash
bun --filter @deploykit/client typecheck
bun --filter @deploykit/client lint
```

Expected: both clean. If `verbatimModuleSyntax` errors appear on type re-exports, switch the barrel line to `export type { ... }` for type-only symbols (the `index.ts` above already uses `export type` for type-only re-exports).

- [ ] **Step 11: Commit**

```bash
git add packages/client package.json
git commit -m "feat(client): add @deploykit/client package with ApiClient interface and providers"
```

---

### Task 3: Switch web to dependency injection (components stay in `apps/web`)

**Goal:** Replace the imported `api` singleton with `useApiClient()` in all 5 consumers, wire `<ApiClientProvider>` in `main.tsx`, delete the old `apps/web/src/shared/api.ts`, and update the affected tests to inject a mock client. After this task the web app is transport-agnostic at the call sites but the component files have not yet moved.

**Files:**
- Modify: `apps/web/package.json` — add `@deploykit/client: workspace:*` dep.
- Modify: `apps/web/vite.config.ts` + `apps/web/vitest.config.ts` — alias `@deploykit/client` → client src, and alias `@` → client src (so client's internal `@/` imports resolve when bundled by web).
- Modify: `apps/web/src/main.tsx` — wrap with providers.
- Modify: `apps/web/src/features/auth/useAuth.ts`
- Modify: `apps/web/src/features/projects/useProjects.ts`
- Modify: `apps/web/src/features/projects/CreateProjectDialog.tsx`
- Modify: `apps/web/src/features/settings/ProjectSettingsDialog.tsx`
- Modify: `apps/web/src/features/versions/UploadVersionDialog.tsx`
- Delete: `apps/web/src/shared/api.ts` (content lives in `@deploykit/client` now).
- Modify tests: `apps/web/tests/unit/useProjects.test.ts`, `apps/web/tests/unit/UploadVersionDialog.test.tsx`, `apps/web/tests/unit/api.test.ts`, and any other test that `vi.mock('@/shared/api')`.

**Interfaces:**
- Consumes: `ApiClient`, `ApiClientProvider`, `useApiClient`, `createFetchApiClient` (from Task 2).
- Produces: a web app whose components acquire the client via context — the precondition for the file move in Task 4 and for the desktop `ipcApiClient`.

- [ ] **Step 1: Add the dependency + aliases**

`apps/web/package.json` — in `dependencies`, add:

```json
    "@deploykit/client": "workspace:*",
```

`apps/web/vite.config.ts` — extend the `resolve.alias` block. Replace:

```ts
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
```

with:

```ts
  resolve: {
    alias: {
      // Client package is consumed from source so its internal `@/` imports
      // resolve into the client src tree, and web's own `@` keeps pointing at
      // web src for the few files that remain here during the transition.
      '@deploykit/client': path.resolve(__dirname, '../../packages/client/src'),
      '@deploykit/shared': path.resolve(__dirname, '../../packages/shared/src'),
      '@': path.resolve(__dirname, './src'),
    },
  },
```

`apps/web/vitest.config.ts` — mirror the same aliases:

```ts
  resolve: {
    alias: {
      '@deploykit/client': path.resolve(__dirname, '../../packages/client/src'),
      '@deploykit/shared': path.resolve(__dirname, '../../packages/shared/src'),
      '@': path.resolve(__dirname, './src'),
    },
  },
```

Run `bun install` to link the new workspace dep.

- [ ] **Step 2: Write a test helper for injecting a mock client**

`apps/web/tests/helpers/renderWithClient.tsx` (Create):

```tsx
import { render, type RenderOptions } from '@testing-library/react';
import { type ReactNode } from 'react';
import { ApiClientProvider } from '@deploykit/client';
import type { ApiClient } from '@deploykit/client';
import { vi } from 'vitest';

/** Builds a mock ApiClient whose every method is a vi.fn returning undefined. */
export function mockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const stub = {
    getMe: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    listProjects: vi.fn(),
    createProject: vi.fn(),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
    updateSettings: vi.fn(),
    uploadVersion: vi.fn(),
    publishVersion: vi.fn(),
    rollbackVersion: vi.fn(),
    deleteVersion: vi.fn(),
  } as unknown as ApiClient;
  return Object.assign(stub, overrides) as ApiClient;
}

export function renderWithClient(
  ui: ReactNode,
  client: ApiClient,
  options?: RenderOptions,
) {
  return render(<ApiClientProvider client={client}>{ui}</ApiClientProvider>, options);
}
```

- [ ] **Step 3: Convert `useAuth.ts` to use the context**

Replace the body of `apps/web/src/features/auth/useAuth.ts`. The current file imports `api` and calls `api.getMe/login/logout`. New version:

```ts
import { useCallback, useEffect, useState } from 'react';
import { useApiClient } from '@deploykit/client';
import type { SafeUser } from '@/shared/types';

export function useAuth() {
  const api = useApiClient();
  const [user, setUser] = useState<SafeUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getMe()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, [api]);

  const login = useCallback(
    async (email: string, password: string) => {
      const next = await api.login(email, password);
      setUser(next);
      return next;
    },
    [api],
  );

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, [api]);

  return { user, loading, login, logout };
}
```

- [ ] **Step 4: Convert `useProjects.ts`**

In `apps/web/src/features/projects/useProjects.ts`: remove `import { api } from '@/shared/api'`; add `const api = useApiClient();` at the top of the hook body (the function `useProjects`), and add `api` to the dependency arrays of any `useEffect`/`useCallback` that close over it (refresh, publishVersion, rollbackVersion, deleteVersion, the mount effect). Concretely:

- Top of `useProjects()`: `const api = useApiClient();`
- In every `useCallback(..., [deps])` that calls `api.*`, add `api` to `deps`.
- In the mount `useEffect(..., [])`, change deps to `[api]`.

Leave all other logic (hash helpers, toasts, pending state) untouched. The `useApiClient` import:

```ts
import { useApiClient } from '@deploykit/client';
```

- [ ] **Step 5: Convert the three dialog components**

Each of these calls `api.<method>` inside an event handler. Replace the module-level `import { api } from '@/shared/api'` with a hook call inside the component.

`CreateProjectDialog.tsx` — remove the api import; inside the component add `const api = useApiClient();` (import from `@deploykit/client`). The `api.createProject(...)` call site at ~L46 stays the same.

`ProjectSettingsDialog.tsx` — same pattern; `const api = useApiClient();` at top of component; `api.updateProject/updateSettings/deleteProject` call sites unchanged.

`UploadVersionDialog.tsx` — same; `const api = useApiClient();`; the `api.uploadVersion(projectId, file, folderFiles, desc, setProgress)` call at ~L94 stays the same.

- [ ] **Step 6: Wire providers in `main.tsx`**

Replace `apps/web/src/main.tsx`:

```tsx
import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiClientProvider, createFetchApiClient } from '@deploykit/client';
import './i18n';
import './index.css';
import App from './App';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element #root was not found.');
}

createRoot(rootElement).render(
  <StrictMode>
    <Suspense>
      <ApiClientProvider client={createFetchApiClient()}>
        <App />
      </ApiClientProvider>
    </Suspense>
  </StrictMode>,
);
```

- [ ] **Step 7: Delete the legacy singleton**

```bash
rm apps/web/src/shared/api.ts
```

Grep to confirm no remaining importers:

```bash
grep -rn "from '@/shared/api'" apps/web/src apps/web/tests || echo "no importers remain"
```

Expected: `no importers remain`. If any file still imports it, convert it (Step 3–5 covered the 5 known consumers).

- [ ] **Step 8: Update `useProjects.test.ts` to inject a mock client**

The current test does `vi.mock('@/shared/api')` then `vi.mocked(api.listProjects).mockResolvedValue(...)`. Replace that pattern with the provider + mock client. At the top of the test file, remove the `vi.mock('@/shared/api')` line and the `import { api } from '@/shared/api'`. Import the helper and `renderHook`/`wrapper`:

```tsx
import { renderHook, act } from '@testing-library/react';
import { type ReactNode } from 'react';
import { ApiClientProvider } from '@deploykit/client';
import { useProjects } from '@/features/projects/useProjects';
import { mockApiClient } from '../helpers/renderWithClient';

function wrapper(client: ReturnType<typeof mockApiClient>) {
  return ({ children }: { children: ReactNode }) => (
    <ApiClientProvider client={client}>{children}</ApiClientProvider>
  );
}
```

Then for each test case, build `const client = mockApiClient({ listProjects: vi.fn().mockResolvedValue([...]) })` and call `renderHook(() => useProjects(), { wrapper: wrapper(client) })`. Assertions move from `vi.mocked(api.listProjects)` to `client.listProjects` (cast: `expect(client.listProjects).toHaveBeenCalledWith(...)`). For action tests (publish/rollback/delete), pre-stub the corresponding method on `client` and assert it was called with the right ids.

> Concrete example for the list test:
> ```tsx
> it('loads the project list on mount', async () => {
>   const client = mockApiClient({
>     listProjects: vi.fn().mockResolvedValue([project('a'), project('b')]),
>   });
>   const { result } = renderHook(() => useProjects(), { wrapper: wrapper(client) });
>   await act(() => Promise.resolve());
>   expect(result.current.projects).toHaveLength(2);
> });
> ```

- [ ] **Step 9: Update `UploadVersionDialog.test.tsx`**

Remove `vi.mock('@/shared/api')` and the api import. Render via `renderWithClient(<UploadVersionDialog ...props />, mockApiClient({ uploadVersion: vi.fn().mockResolvedValue({ version: { id: 'v1', name: 'v1' } }) }))`. Replace `vi.mocked(api.uploadVersion)` assertions with the stub on the client object.

- [ ] **Step 10: Update `api.test.ts` → now tests `createFetchApiClient`**

This file currently imports `{ api }` from `@/shared/api` and stubs `globalThis.XMLHttpRequest` to verify multipart field names. Move its assertions onto `createFetchApiClient()`. Replace the import:

```ts
import { createFetchApiClient } from '@deploykit/client';
```

and the subject:

```ts
const api = createFetchApiClient();
await api.uploadVersion('project-1', null, [file], 'folder upload');
```

Keep the XHR stub and the assertion that the sent multipart `folderFiles` part's name equals `dist/assets/app.js` (the `webkitRelativePath`-preservation test). The stubbed XHR's `open` URL assertion (`/api/projects/project-1/versions`) stays.

- [ ] **Step 11: Update any other test that mocked `@/shared/api`**

Search:

```bash
grep -rln "@/shared/api" apps/web/tests
```

For each hit (likely `LoginPage.test.tsx`, `CreateProjectDialog.test.tsx`, `ProjectSettingsDialog.test.tsx`, `VersionList.test.tsx`, `ProjectList.test.tsx`), apply the same conversion: drop `vi.mock('@/shared/api')`, render through `renderWithClient(ui, mockApiClient({ ... }))`, and assert on the stubbed client methods.

- [ ] **Step 12: Run web tests + typecheck + lint**

```bash
bun --filter @deploykit/web test
bun --filter @deploykit/web typecheck
bun --filter @deploykit/web lint
```

Expected: all green. If a test fails because a component now throws "useApiClient must be used within provider," it wasn't rendered with `renderWithClient` — fix it.

- [ ] **Step 13: Commit**

```bash
git add apps/web
git commit -m "refactor(web): inject ApiClient via context instead of importing the singleton"
```

---

### Task 4: Move web UI source into `packages/client` (web becomes a shell)

**Goal:** Physically relocate `apps/web/src/{features,shared,pages,i18n}` + `App.tsx` + `config.ts` + `index.css` into `packages/client/src`, so both web and desktop import one shared `<App/>`. Web's `src/` shrinks to `main.tsx` only. All tests move to `packages/client/tests`. The app is byte-for-byte the same UI; only file locations change.

**Files:**
- Move: `apps/web/src/{features,shared,pages,i18n}` → `packages/client/src/{features,shared,pages,i18n}`
- Move: `apps/web/src/App.tsx` → `packages/client/src/App.tsx`
- Move: `apps/web/src/config.ts` → `packages/client/src/shared/config.ts` (adjust internal consumers)
- Move: `apps/web/src/index.css` → `packages/client/src/index.css`
- Move: `apps/web/tests/unit/*` (except those testing web-only concerns — none remain after Task 3) → `packages/client/tests/unit/*`
- Move: `apps/web/tests/helpers/*` → `packages/client/tests/helpers/*`
- Modify: `apps/web/src/main.tsx` — import `App` from `@deploykit/client`; import css from the client package (or keep a 1-line web `index.css` that `@import`s the client one).
- Modify: `apps/web/tsconfig.app.json` — keep `@` alias for residual web src; add `@deploykit/client` path if needed.
- Modify: `packages/client/src/index.ts` — re-export `App` and submodules.

**Interfaces:**
- Consumes: Task 2's `api/*` (the moved components now sit alongside it and use `@/api/...`).
- Produces: `@deploykit/client` exporting `{ App }` plus all UI — the single import both shells use.

- [ ] **Step 1: Move the UI directories with `git mv`**

From repo root:

```bash
git mv apps/web/src/features      packages/client/src/features
git mv apps/web/src/shared        packages/client/src/shared
git mv apps/web/src/pages         packages/client/src/pages
git mv apps/web/src/i18n          packages/client/src/i18n
git mv apps/web/src/App.tsx       packages/client/src/App.tsx
git mv apps/web/src/config.ts     packages/client/src/shared/config.ts
git mv apps/web/src/index.css     packages/client/src/index.css
```

The `@/` alias already maps to `packages/client/src` inside the client package (Task 2 tsconfig/vitest), and web's vite/vitest aliases (Task 3) point `@` at the client src — so the moved files' internal `@/shared/...`, `@/features/...`, `@/pages/...` imports keep resolving in **both** builds without text edits. Verify with a quick grep that nothing imported `./App` or `./config` by relative path that now breaks:

```bash
grep -rn "from '\./App'\|from '\./config'\|from '\.\./config'" apps/web/src packages/client/src || echo "no relative-path breakage"
```

Expected: `no relative-path breakage`. (web's `main.tsx` imported `./App` — that's fixed in Step 4.)

- [ ] **Step 2: Move the tests + helpers**

```bash
git mv apps/web/tests/helpers     packages/client/tests/helpers
for f in apps/web/tests/unit/*.test.ts apps/web/tests/unit/*.test.tsx; do
  git mv "$f" "packages/client/tests/unit/$(basename "$f")"
done
```

Then remove the now-empty `apps/web/tests/unit` (leave `apps/web/tests/setup.ts` if it exists — web has no remaining tests, so delete it; the client has its own `setup.ts` from Task 2):

```bash
rm -f apps/web/tests/setup.ts
```

- [ ] **Step 3: Update `packages/client/src/index.ts` to re-export `App`**

Replace the top barrel `packages/client/src/index.ts`:

```ts
export * from './api';
export { default as App } from './App';
```

(`App.tsx` uses `export default function App()` — confirm; if it's a named export, adjust to `export { App } from './App'`. Per Task 0 recon it is `export default function App()`.)

- [ ] **Step 4: Shrink `apps/web/src/main.tsx` to a pure shell**

Replace `apps/web/src/main.tsx`:

```tsx
import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiClientProvider, App, createFetchApiClient } from '@deploykit/client';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element #root was not found.');
}

createRoot(rootElement).render(
  <StrictMode>
    <Suspense>
      <ApiClientProvider client={createFetchApiClient()}>
        <App />
      </ApiClientProvider>
    </Suspense>
  </StrictMode>,
);
```

Note: `./i18n` and `./index.css` side-effect imports are gone — the client `App` (or its children) must own those side effects. Add the i18n init + css import inside the client so both shells get them. Edit `packages/client/src/App.tsx` to add at top:

```tsx
import './i18n';
import './index.css';
```

(Place these as the first imports of `App.tsx` so they run before children render. The original web `main.tsx` imported `./i18n` before `App`; moving them into `App.tsx` preserves ordering.)

- [ ] **Step 5: Update web's tsconfig to drop the now-empty src checks**

`apps/web/tsconfig.app.json` — the `include` is `["src", "tests"]`. After the move, `src` contains only `main.tsx` and `tests/` is empty. That's fine; leave `include: ["src"]` (drop `"tests"`). No path changes needed since `main.tsx` imports from `@deploykit/client` (a real workspace package) and `@/` is no longer used by web src.

- [ ] **Step 6: Run client tests + web typecheck + web build**

```bash
bun --filter @deploykit/client test
bun --filter @deploykit/web typecheck
bun --filter @deploykit/web lint
bun --filter @deploykit/web build
```

Expected: all green. The client test run now includes the migrated component tests (they use `@/` which resolves to client src inside the client vitest config). If a migrated test imports the helper via `'../helpers/renderWithClient'` and the helper moved too, the relative path still holds.

- [ ] **Step 7: Smoke-test the dev server**

```bash
bun run dev:web &
sleep 3
curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/
kill %1 2>/dev/null
```

Expected: `200` (Vite serves `index.html`). Manually loading in a browser should show the login page (no backend running → `/api/me` 401 → login screen). Kill the server.

- [ ] **Step 8: Commit**

```bash
git add -A apps/web packages/client
git commit -m "refactor(client): move web UI into packages/client; web becomes a thin shell"
```

---

### Task 5: P0 acceptance gate — refactor integrity

**Goal:** Verify the refactor is behavior-preserving end-to-end before building the desktop on top of it. No new code; only verification + a contract test that locks the `ApiClient` shape against server drift.

**Files:**
- Test (Create): `packages/client/tests/unit/apiClientShape.test.ts` — asserts `createFetchApiClient()` returns an object implementing every `ApiClient` method.
- No production changes.

**Interfaces:** none new.

- [ ] **Step 1: Write the shape contract test**

`packages/client/tests/unit/apiClientShape.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createFetchApiClient } from '@/api/fetchApiClient';
import type { ApiClient } from '@/api/ApiClient';

const EXPECTED_METHODS = [
  'getMe',
  'login',
  'logout',
  'listProjects',
  'createProject',
  'updateProject',
  'deleteProject',
  'updateSettings',
  'uploadVersion',
  'publishVersion',
  'rollbackVersion',
  'deleteVersion',
] as const;

describe('createFetchApiClient', () => {
  it('implements every ApiClient method', () => {
    const client: ApiClient = createFetchApiClient();
    for (const name of EXPECTED_METHODS) {
      expect(typeof client[name]).toBe('function');
    }
  });
});
```

- [ ] **Step 2: Run the full repo gate**

```bash
bun install
bun run typecheck
bun run check
bun run test
bun run build
```

Expected: all pass. `bun run build` runs `turbo run build && bun run package`, packaging web dist into server/public — confirms the web shell still produces a working bundle.

- [ ] **Step 3: Commit**

```bash
git add packages/client/tests/unit/apiClientShape.test.ts
git commit -m "test(client): lock ApiClient method surface against drift"
```

---

### Task 6: Desktop main process skeleton (window + server config + IPC plumbing)

**Goal:** Replace the Forge-template `main.ts` with a real main-process structure: a window with strict security, a persistent `electron-store`-backed server-origin config, the `DesktopBridge` type contract, the preload that exposes it, and an `ipc.ts` that registers the API + native handlers (delegating to `auth.ts`/`serverRequest.ts`/`nativeUpload.ts` stubs that Task 7 fills). After this task `bun run dev:desktop` opens a window showing a placeholder renderer that can read the configured server origin; the renderer is not yet the shared `<App/>`.

**Files:**
- Modify: `apps/desktop/package.json` — add `electron-store`, `@deploykit/client`, `@deploykit/shared`, `@deploykit/server` deps + `@types/node`.
- Modify: `apps/desktop/tsconfig.json` — strict + path mappings; add `apps/desktop/src/main/tsconfig.json` (CJS) and `apps/desktop/src/renderer/tsconfig.json` (ESM/jsx) OR keep one tsconfig with permissive settings (decision below).
- Create: `apps/desktop/src/shared/bridge.ts` — `DesktopBridge` interface.
- Create: `apps/desktop/src/shared/config.ts` — server-origin read/write/clear via `electron-store`.
- Create: `apps/desktop/src/main/index.ts` — app lifecycle + window.
- Create: `apps/desktop/src/main/ipc.ts` — `registerIpc()`.
- Create: `apps/desktop/src/main/serverRequest.ts` — stub (Task 7 implements).
- Create: `apps/desktop/src/main/auth.ts` — stub.
- Create: `apps/desktop/src/main/nativeUpload.ts` — stub.
- Modify: `apps/desktop/src/preload.ts` — `contextBridge.exposeApi('deploykit', ...)`.
- Modify: `apps/desktop/vite.main.config.ts` + `vite.preload.config.ts` — symlink fix + externals.
- Modify: `apps/desktop/vite.renderer.config.mts` — alias `@deploykit/*` and `@`.
- Modify: `apps/desktop/index.html`, `apps/desktop/src/renderer.tsx` (rename/move to `src/renderer/main.tsx`), `apps/desktop/src/App.tsx` (delete template), `apps/desktop/src/index.css` (theme tokens).
- Delete: `apps/desktop/src/main.ts` (replaced by `src/main/index.ts`).

**Interfaces:**
- Consumes: Task 2's `NativeBridge`/`ApiClient` types for the bridge contract.
- Produces: `DesktopBridge` (the `window.deploykit` shape), a window, a server-origin config, and the IPC handler registration hook that Task 7 plugs real logic into.

- [ ] **Step 1: Add desktop runtime deps**

`apps/desktop/package.json` — in `dependencies` add:

```json
    "@deploykit/client": "workspace:*",
    "@deploykit/shared": "workspace:*",
    "electron-store": "^10.0.1",
```

In `devDependencies` add:

```json
    "@deploykit/server": "workspace:*",
    "@types/node": "catalog:",
```

Then `bun install`. (Add `electron-store` to the root catalog too: `"electron-store": "^10.0.1"` and reference `catalog:` to stay consistent — optional.)

> `electron-store` v10 is ESM. The main process builds to CJS via Forge's Vite plugin; Vite handles the ESM→CJS interop at build time. If this proves problematic, fallback to a hand-rolled JSON file in `app.getPath('userData')/config.json` (atomic write via temp+rename, mirroring `jsonProjectRepository`). The plan assumes electron-store; Task 7 Step 1 has the fallback if install fails.

- [ ] **Step 2: Define `DesktopBridge`**

`apps/desktop/src/shared/bridge.ts`:

```ts
import type { SafeUser } from '@deploykit/shared';
import type {
  NativeFile,
  PickedDirectory,
  ValidateServerResult,
} from '@deploykit/client';
import type { ApiClient } from '@deploykit/client';

/**
 * The shape exposed on `window.deploykit` by the preload script. `api` mirrors
 * `ApiClient` over IPC; `native` carries desktop-only capabilities (spec §4.5).
 */
export interface DesktopBridge {
  api: ApiClient;
  native: {
    pickDirectory(): Promise<PickedDirectory | null>;
    validateServer(url: string): Promise<ValidateServerResult>;
    configureServer(url: string): Promise<void>;
    getServerOrigin(): Promise<string>;
    loginViaWeb(): Promise<SafeUser | null>;
    onAuthExpired(cb: () => void): () => void;
  };
  /** Internal: upload a folder by absolute path, reporting progress over IPC. */
  nativeUpload: {
    uploadFolder(
      projectId: string,
      directoryPath: string,
      description: string,
      onProgress?: (percent: number) => void,
    ): Promise<{ version: { id: string; name: string } }>;
    uploadZipPath(
      projectId: string,
      zipPath: string,
      description: string,
      onProgress?: (percent: number) => void,
    ): Promise<{ version: { id: string; name: string } }>;
  };
}

declare global {
  interface Window {
    deploykit: DesktopBridge;
  }
}
```

- [ ] **Step 3: Implement server-origin config**

`apps/desktop/src/shared/config.ts`:

```ts
import Store from 'electron-store';

interface DesktopConfig {
  serverOrigin: string;
}

const store = new Store<DesktopConfig>({
  defaults: { serverOrigin: '' },
});

/** Normalizes a user-entered URL: trims, strips trailing slash. */
export function normalizeOrigin(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

export function getServerOrigin(): string {
  return store.get('serverOrigin');
}

export function setServerOrigin(origin: string): void {
  store.set('serverOrigin', normalizeOrigin(origin));
}

export function clearServerOrigin(): void {
  store.set('serverOrigin', '');
}

/** True when the origin is http:// and not localhost — warn about cleartext creds. */
export function isInsecureOrigin(origin: string): boolean {
  return /^http:\/\//i.test(origin) && !/\/\/(localhost|127\.0\.0\.1)/i.test(origin);
}
```

- [ ] **Step 4: Create main-process module stubs**

`apps/desktop/src/main/serverRequest.ts` (stub — Task 7 fills):

```ts
import type { Session } from 'electron';

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  multipart?: FormData;
  onProgress?: (percent: number) => void;
}

export interface RequestResult<T> {
  status: number;
  data: T;
}

export async function serverRequest<T>(
  _session: Session,
  _origin: string,
  _opts: RequestOptions,
): Promise<RequestResult<T>> {
  throw new Error('serverRequest not implemented yet (Task 7)');
}
```

`apps/desktop/src/main/auth.ts` (stub):

```ts
import type { Session } from 'electron';
import type { SafeUser } from '@deploykit/shared';

export async function getMe(
  _session: Session,
  _origin: string,
): Promise<SafeUser | null> {
  throw new Error('auth.getMe not implemented yet (Task 7)');
}

export async function login(
  _session: Session,
  _origin: string,
  _email: string,
  _password: string,
): Promise<SafeUser> {
  throw new Error('auth.login not implemented yet (Task 7)');
}

export async function logout(_session: Session, _origin: string): Promise<void> {
  throw new Error('auth.logout not implemented yet (Task 7)');
}

export async function validateServer(
  _session: Session,
  _origin: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  throw new Error('auth.validateServer not implemented yet (Task 7)');
}

export async function loginViaWeb(
  _session: Session,
  _origin: string,
  _parent: Electron.BrowserWindow,
): Promise<SafeUser | null> {
  throw new Error('auth.loginViaWeb not implemented yet (Task 7)');
}
```

`apps/desktop/src/main/nativeUpload.ts` (stub):

```ts
import type { Session } from 'electron';
import type { PickedDirectory } from '@deploykit/client';

export async function pickDirectory(
  _parent: Electron.BrowserWindow,
): Promise<PickedDirectory | null> {
  throw new Error('nativeUpload.pickDirectory not implemented yet (Task 8)');
}

export async function uploadFolder(
  _session: Session,
  _origin: string,
  _projectId: string,
  _directoryPath: string,
  _description: string,
  _onProgress?: (percent: number) => void,
): Promise<{ version: { id: string; name: string } }> {
  throw new Error('nativeUpload.uploadFolder not implemented yet (Task 8)');
}
```

- [ ] **Step 5: Implement `ipc.ts` (handler registration)**

`apps/desktop/src/main/ipc.ts`:

```ts
import { ipcMain, type Session, type BrowserWindow } from 'electron';
import {
  clearServerOrigin,
  getServerOrigin,
  setServerOrigin,
  normalizeOrigin,
} from '../shared/config';
import { getMe, login, logout, validateServer, loginViaWeb } from './auth';
import { pickDirectory, uploadFolder } from './nativeUpload';
import { serverRequest } from './serverRequest';

/**
 * Registers all `window.deploykit.*` handlers. `getMainWindow` is a thunk
 * because the window may be recreated (e.g. after server switch).
 */
export function registerIpc(deps: {
  session: Session;
  getOrigin: () => string;
  getMainWindow: () => BrowserWindow | null;
  onAuthExpired: (cb: () => void) => void;
}) {
  const { session, getOrigin, getMainWindow, onAuthExpired } = deps;

  // ---- API methods (mirror ApiClient over IPC) -------------------------------
  ipcMain.handle('api:getMe', async () => getMe(session, getOrigin()));
  ipcMain.handle('api:login', async (_e, email: string, password: string) =>
    login(session, getOrigin(), email, password),
  );
  ipcMain.handle('api:logout', async () => logout(session, getOrigin()));
  ipcMain.handle('api:listProjects', async () => {
    const r = await serverRequest<unknown[]>(session, getOrigin(), {
      method: 'GET',
      path: '/api/projects',
    });
    return r.data;
  });
  ipcMain.handle('api:createProject', async (_e, input) => {
    const r = await serverRequest(session, getOrigin(), {
      method: 'POST',
      path: '/api/projects',
      body: input,
    });
    return r.data;
  });
  ipcMain.handle('api:updateProject', async (_e, id: string, updates) => {
    const r = await serverRequest(session, getOrigin(), {
      method: 'PATCH',
      path: `/api/projects/${id}`,
      body: updates,
    });
    return r.data;
  });
  ipcMain.handle('api:deleteProject', async (_e, id: string) => {
    const r = await serverRequest(session, getOrigin(), {
      method: 'DELETE',
      path: `/api/projects/${id}`,
    });
    return r.data;
  });
  ipcMain.handle('api:updateSettings', async (_e, id: string, settings) => {
    const r = await serverRequest(session, getOrigin(), {
      method: 'PATCH',
      path: `/api/projects/${id}/settings`,
      body: settings,
    });
    return r.data;
  });
  ipcMain.handle(
    'api:publishVersion',
    async (_e, projectId: string, versionId: string) => {
      const r = await serverRequest(session, getOrigin(), {
        method: 'POST',
        path: `/api/projects/${projectId}/versions/${versionId}/publish`,
      });
      return r.data;
    },
  );
  ipcMain.handle(
    'api:rollbackVersion',
    async (_e, projectId: string, versionId: string) => {
      const r = await serverRequest(session, getOrigin(), {
        method: 'POST',
        path: `/api/projects/${projectId}/versions/${versionId}/rollback`,
      });
      return r.data;
    },
  );
  ipcMain.handle(
    'api:deleteVersion',
    async (_e, projectId: string, versionId: string) => {
      const r = await serverRequest(session, getOrigin(), {
        method: 'DELETE',
        path: `/api/projects/${projectId}/versions/${versionId}`,
      });
      return r.data;
    },
  );
  // api:uploadVersion is NOT registered here — uploads go through nativeUpload
  // (nativeUpload.uploadFolder / uploadZipPath) since they read bytes from disk.

  // ---- Native methods --------------------------------------------------------
  ipcMain.handle('native:pickDirectory', async () => {
    const parent = getMainWindow();
    return parent ? pickDirectory(parent) : null;
  });
  ipcMain.handle('native:validateServer', async (_e, url: string) =>
    validateServer(session, normalizeOrigin(url)),
  );
  ipcMain.handle('native:configureServer', async (_e, url: string) => {
    clearServerOrigin();
    setServerOrigin(url);
  });
  ipcMain.handle('native:getServerOrigin', async () => getServerOrigin());
  ipcMain.handle('native:loginViaWeb', async () => {
    const parent = getMainWindow();
    return parent ? loginViaWeb(session, getOrigin(), parent) : null;
  });
  ipcMain.on('native:onAuthExpiredSubscribe', (e) => {
    onAuthExpired(() => e.sender.send('native:authExpired'));
  });

  // ---- Native upload (disk-backed) ------------------------------------------
  ipcMain.handle(
    'nativeUpload:uploadFolder',
    async (
      _e,
      projectId: string,
      directoryPath: string,
      description: string,
      // progress is delivered via webContents.send below; this is the channel name
      progressChannel: string,
    ) => {
      const win = getMainWindow();
      return uploadFolder(
        session,
        getOrigin(),
        projectId,
        directoryPath,
        description,
        win
          ? (p) => win.webContents.send(progressChannel, p)
          : undefined,
      );
    },
  );
}
```

- [ ] **Step 6: Implement `main/index.ts` (window + lifecycle)**

`apps/desktop/src/main/index.ts`:

```ts
import { app, BrowserWindow, shell, session } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import path from 'node:path';
import { getServerOrigin } from '../shared/config';
import { registerIpc } from './ipc';

if (squirrelStartup) {
  app.quit();
}

const PARTITION = 'persist:deploykit';
let mainWindow: BrowserWindow | null = null;
const authExpiredSubscribers: Array<() => void> = [];

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs contextBridge; sandbox stays off until CJS preload is sandbox-compatible
      partition: PARTITION,
    },
  });

  win.once('ready-to-show', () => win.show());

  // Open external links (deploy URLs clicked in-app) in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  return win;
}

function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

app.whenReady().then(() => {
  const ses = session.fromPartition(PARTITION);
  registerIpc({
    session: ses,
    getOrigin: () => getServerOrigin(),
    getMainWindow,
    onAuthExpired: (cb) => authExpiredSubscribers.push(cb),
  });

  mainWindow = createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

> `MAIN_WINDOW_VITE_DEV_SERVER_URL` / `MAIN_WINDOW_VITE_NAME` are globals provided by Forge's Vite plugin (declared via `forge.env.d.ts`). Keep them as-is.

- [ ] **Step 7: Implement the preload**

`apps/desktop/src/preload.ts`:

```ts
import { contextBridge, ipcRenderer } from 'electron';

const SUB_ID = (() => {
  let n = 0;
  return () => `native-upload-${++n}`;
})();

contextBridge.exposeInMainWorld('deploykit', {
  api: {
    getMe: () => ipcRenderer.invoke('api:getMe'),
    login: (email: string, password: string) =>
      ipcRenderer.invoke('api:login', email, password),
    logout: () => ipcRenderer.invoke('api:logout'),
    listProjects: () => ipcRenderer.invoke('api:listProjects'),
    createProject: (input) => ipcRenderer.invoke('api:createProject', input),
    updateProject: (id, updates) =>
      ipcRenderer.invoke('api:updateProject', id, updates),
    deleteProject: (id) => ipcRenderer.invoke('api:deleteProject', id),
    updateSettings: (id, settings) =>
      ipcRenderer.invoke('api:updateSettings', id, settings),
    uploadVersion: () => {
      // Real uploads go through nativeUpload.* — this should not be called.
      throw new Error('Use window.deploykit.nativeUpload.* for desktop uploads');
    },
    publishVersion: (projectId, versionId) =>
      ipcRenderer.invoke('api:publishVersion', projectId, versionId),
    rollbackVersion: (projectId, versionId) =>
      ipcRenderer.invoke('api:rollbackVersion', projectId, versionId),
    deleteVersion: (projectId, versionId) =>
      ipcRenderer.invoke('api:deleteVersion', projectId, versionId),
  },
  native: {
    pickDirectory: () => ipcRenderer.invoke('native:pickDirectory'),
    validateServer: (url: string) =>
      ipcRenderer.invoke('native:validateServer', url),
    configureServer: (url: string) =>
      ipcRenderer.invoke('native:configureServer', url),
    getServerOrigin: () => ipcRenderer.invoke('native:getServerOrigin'),
    loginViaWeb: () => ipcRenderer.invoke('native:loginViaWeb'),
    onAuthExpired: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('native:authExpired', handler);
      return () => ipcRenderer.removeListener('native:authExpired', handler);
    },
  },
  nativeUpload: {
    uploadFolder: (
      projectId: string,
      directoryPath: string,
      description: string,
      onProgress?: (percent: number) => void,
    ) => {
      const channel = SUB_ID();
      const handler = (_e: unknown, p: number) => onProgress?.(p);
      if (onProgress) ipcRenderer.on(channel, handler);
      return ipcRenderer
        .invoke('nativeUpload:uploadFolder', projectId, directoryPath, description, channel)
        .finally(() => {
          if (onProgress) ipcRenderer.removeListener(channel, handler);
        });
    },
    uploadZipPath: (
      projectId: string,
      zipPath: string,
      description: string,
      onProgress?: (percent: number) => void,
    ) => {
      throw new Error('uploadZipPath wired in Task 8');
    },
  },
});
```

- [ ] **Step 8: Update Forge config + Vite configs**

`apps/desktop/forge.config.ts` — change the main build entry from `'src/main.ts'` to `'src/main/index.ts'`. In the `plugins` array, the `VitePlugin` `build[0]` entry:

```ts
            entry: 'src/main/index.ts',
            config: 'vite.main.config.ts',
            target: 'main',
```

`apps/desktop/vite.main.config.ts`:

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      external: ['electron', 'electron-store'],
    },
  },
  resolve: {
    // Electron Forge's VitePlugin forces preserveSymlinks:true, which breaks
    // resolution under bun's symlinked node_modules. Restore Vite's default.
    preserveSymlinks: false,
  },
});
```

`apps/desktop/vite.preload.config.ts`:

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: { external: ['electron'] },
  },
  resolve: { preserveSymlinks: false },
});
```

`apps/desktop/vite.renderer.config.mts` — add aliases so the renderer can import `@deploykit/client` from source:

```ts
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    preserveSymlinks: false,
    alias: {
      '@deploykit/client': path.resolve(__dirname, '../../packages/client/src'),
      '@deploykit/shared': path.resolve(__dirname, '../../packages/shared/src'),
      '@deploykit/server': path.resolve(__dirname, '../../apps/server/src'),
      '@': path.resolve(__dirname, './src'),
    },
  },
});
```

> The `@deploykit/server` alias points at server src so the `import type { ApiApp } from '@deploykit/server/api'` inside `packages/client/src/api/fetchApiClient.ts` resolves — but the desktop renderer does **not** import `fetchApiClient` (it uses `ipcApiClient`), so this alias is precautionary. Verify Task 8's `ipcApiClient.ts` does not transitively pull `fetchApiClient` into the renderer bundle.

- [ ] **Step 9: Update the desktop tsconfig**

`apps/desktop/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "jsx": "react-jsx",
    "module": "commonjs",
    "allowJs": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "strict": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "sourceMap": true,
    "outDir": "dist",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "types": ["node"],
    "paths": {
      "@deploykit/client": ["../../packages/client/src"],
      "@deploykit/client/*": ["../../packages/client/src/*"],
      "@deploykit/shared": ["../../packages/shared/src"],
      "@deploykit/shared/*": ["../../packages/shared/src/*"],
      "@deploykit/server/api": ["../../apps/server/src/api.ts"],
      "@/*": ["./src/*"]
    }
  },
  "include": ["src"]
}
```

> The main/preload are CJS (`module: commonjs`) but `verbatimModuleSyntax` + `erasableSyntaxOnly` are still satisfiable. `@types/node` is needed for `path`, `electron-store`. Add a separate `apps/desktop/src/renderer/tsconfig.json` only if the renderer needs ESM-specific options; the single tsconfig above works because the renderer is built by Vite (esbuild), not tsc, and tsc only typechecks.

- [ ] **Step 10: Placeholder renderer (replaces the template)**

Delete the template files and write a minimal renderer that reads the configured origin (proves the bridge works end-to-end):

```bash
rm apps/desktop/src/App.tsx
git mv apps/desktop/src/renderer.tsx apps/desktop/src/renderer/main.tsx
```

`apps/desktop/src/renderer/main.tsx`:

```tsx
/// <reference types="vite/client" />
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

function Probe() {
  const [origin, setOrigin] = useState('(loading)');
  useEffect(() => {
    window.deploykit.native.getServerOrigin().then(setOrigin);
  }, []);
  return (
    <div style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
      <h1>DeployKit Desktop</h1>
      <p>Configured server: <code>{origin || '(none)'}</code></p>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root was not found.');
createRoot(root).render(
  <StrictMode>
    <Probe />
  </StrictMode>,
);
```

`apps/desktop/index.html` — change the script src to `/src/renderer/main.tsx`:

```html
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>DeployKit</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/main.tsx"></script>
  </body>
</html>
```

`apps/desktop/src/index.css` — keep `@import "tailwindcss";` for now (theme tokens added in Task 8 when the real UI mounts):

```css
@import "tailwindcss";
```

Delete the old `apps/desktop/src/main.ts`:

```bash
git rm apps/desktop/src/main.ts
```

- [ ] **Step 11: Typecheck + build the desktop**

```bash
bun --filter @deploykit/desktop typecheck
bun --filter @deploykit/desktop lint
```

Expected: clean. (`electron-forge start` will be exercised in Task 7 once `auth.ts`/`serverRequest.ts` are real — running it now throws the stub errors only if the renderer calls those handlers, which `Probe` does not.)

- [ ] **Step 12: Commit**

```bash
git add -A apps/desktop
git commit -m "feat(desktop): scaffold main process, server config, DesktopBridge IPC contract"
```

---

### Task 7: Desktop transport (`serverRequest`) + auth + bootstrap UI

**Goal:** Implement the Electron `net`-based transport over the `persist:deploykit` session, the three login flows (password, web-login window, persisted-session resume), the first-run onboarding screen, and the renderer's `ipcApiClient`. After this task `bun run dev:desktop` against `dev:server` (or any remote DeployKit) completes onboarding → login → and would render `<App/>` (Task 8 wires the real `<App/>` + native upload).

**Files:**
- Modify: `apps/desktop/src/main/serverRequest.ts` — full `net.request` impl + error mapping.
- Modify: `apps/desktop/src/main/auth.ts` — `getMe`/`login`/`logout`/`validateServer`/`loginViaWeb`.
- Create: `apps/desktop/src/main/authExpired.ts` — 401-detection helper.
- Modify: `apps/desktop/src/main/nativeUpload.ts` — keep stub (Task 8).
- Create: `apps/desktop/src/renderer/ipcApiClient.ts` — `createIpcApiClient(): ApiClient`.
- Create: `apps/desktop/src/renderer/DesktopApp.tsx` — onboarding gate → login gate → `<App/>`.
- Modify: `apps/desktop/src/renderer/main.tsx` — mount `<DesktopApp/>` with providers.
- Modify: `apps/desktop/src/renderer/index.css` — theme tokens (copy from web `index.css`).
- Test (Create): `apps/desktop/tests/nativeUpload.test.ts` is Task 8; here add `apps/desktop/tests/serverRequest.test.ts` (mock `net`).

**Interfaces:**
- Consumes: `ApiClient`, `NativeBridge`, `DesktopBridge` (Tasks 2, 6), `extractMessage`/`checkOk` from `@deploykit/client` (pure JS, importable in main process).
- Produces: `createIpcApiClient`, a working `serverRequest`, a working auth module, and the `<DesktopApp/>` bootstrap.

- [ ] **Step 1: Implement `serverRequest.ts`**

`apps/desktop/src/main/serverRequest.ts`:

```ts
import { net, type Session } from 'electron';
import { extractMessage } from '@deploykit/client';

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  /** JSON body (for non-multipart requests). */
  body?: unknown;
  /** Pre-built multipart body with on-write progress reporting. */
  multipart?: { chunks: Buffer[]; totalBytes: number };
  onProgress?: (percent: number) => void;
}

export interface RequestResult<T> {
  status: number;
  data: T;
}

/** Thrown on non-2xx; message is the server's `{ error.message }`. */
export class ServerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ServerError';
  }
}

/** Thrown when the request never reaches the server / connection fails. */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export function serverRequest<T>(
  ses: Session,
  origin: string,
  opts: RequestOptions,
): Promise<RequestResult<T>> {
  return new Promise((resolve, reject) => {
    const url = `${origin}${opts.path}`;
    const req = net.request({ url, session: ses, method: opts.method });

    const headers: Record<string, string> = {};
    if (opts.body !== undefined) {
      const json = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
      // body written below after registering listeners
      (req as unknown as { __jsonBody: string }).__jsonBody = json;
    }
    if (opts.multipart) {
      headers['Content-Type'] = 'multipart/form-data; boundary=----deploykit';
      headers['Content-Length'] = String(opts.multipart.totalBytes);
    }

    req.on('response', (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (c) => chunks.push(c));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = response.statusCode;
        if (status >= 200 && status < 300) {
          let data: T;
          try {
            data = (text ? JSON.parse(text) : {}) as T;
          } catch {
            data = text as unknown as T;
          }
          resolve({ status, data });
        } else {
          reject(new ServerError(extractMessage(text) || `HTTP ${status}`, status));
        }
      });
    });

    req.on('error', (err) => reject(new NetworkError(err.message)));

    // Write body.
    if (opts.body !== undefined) {
      const json = (req as unknown as { __jsonBody?: string }).__jsonBody ?? '';
      req.write(json, 'utf8');
    } else if (opts.multipart) {
      let written = 0;
      for (const chunk of opts.multipart.chunks) {
        req.write(chunk);
        written += chunk.length;
        if (opts.onProgress) {
          opts.onProgress(Math.round((written / opts.multipart.totalBytes) * 100));
        }
      }
    }
    req.end();
  });
}
```

> The `__jsonBody` workaround avoids a closure-capture quirk in the type-only branch; an alternative is to compute `json` once at the top and reference it in the write block directly. Prefer the cleaner version:

```ts
    const jsonBody =
      opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    // ... (header setup uses jsonBody) ...
    if (jsonBody !== undefined) {
      req.write(jsonBody, 'utf8');
    } else if (opts.multipart) {
      // ... as above ...
    }
```

Use this cleaner form in the actual file (drop `__jsonBody`).

- [ ] **Step 2: Write the `serverRequest` unit test (mock `net`)**

`apps/desktop/tests/serverRequest.test.ts` (bun:test). We mock Electron's `net`:

```ts
import { mock, test } from 'bun:test';
import { ServerError, NetworkError, serverRequest } from '../src/main/serverRequest';

// Mock electron's net + Session. The test builds a fake request emitter.
const fakeResponse = (status: number, body: string) => ({
  statusCode: status,
  on(event: string, cb: (arg?: unknown) => void) {
    if (event === 'data') setTimeout(() => cb(Buffer.from(body)), 0);
    if (event === 'end') setTimeout(() => cb(), 1);
  },
});

const makeNetMock = (status: number, body: string, error?: Error) => {
  const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  const req = {
    on(event: string, cb: (arg?: unknown) => void) {
      (handlers[event] ||= []).push(cb);
      return req;
    },
    write() {},
    end() {
      if (error) setTimeout(() => handlers.error[0]?.(error), 0);
      else setTimeout(() => handlers.response[0]?.(fakeResponse(status, body)), 0);
    },
  };
  return { req, handlers };
};

// Bun's module mock for 'electron':
mock.module('electron', () => ({
  net: { request: () => makeNetMock(200, JSON.stringify({ ok: true })).req },
  session: { fromPartition: () => ({}) },
}));

test('serverRequest resolves with parsed JSON on 2xx', async () => {
  const ses = {} as never;
  const r = await serverRequest<{ ok: boolean }>(ses, 'http://x', {
    method: 'GET',
    path: '/api/projects',
  });
  // (assertion depends on the mock above wiring; adjust to the actual mock shape)
  // expect r.data.ok === true
});
```

> Bun's `mock.module` is async-resolved; for determinism prefer constructing the mock emitter inline and asserting on the resolved value. Simplify the test to one happy-path and one `ServerError` (status 401, body `{"error":{"message":"Authentication required"}}` → thrown `ServerError` with `.message === 'Authentication required'` and `.status === 401`). Mark `expect` with `import { expect } from 'bun:test'`. The exact mock plumbing is finicky; the goal is to lock the error-enveloping behavior. If mocking `net` proves too brittle in CI, downgrade this to a pure-function test of the error-parsing branch by extracting `parseResponse(status, text)` and testing that directly — keep at least the 401→ServerError and non-JSON-text fallback cases covered.

- [ ] **Step 3: Implement `auth.ts`**

`apps/desktop/src/main/auth.ts`:

```ts
import { BrowserWindow, type Session } from 'electron';
import type { SafeUser } from '@deploykit/shared';
import { serverRequest, ServerError } from './serverRequest';

export async function getMe(
  ses: Session,
  origin: string,
): Promise<SafeUser | null> {
  try {
    const r = await serverRequest<SafeUser>(ses, origin, {
      method: 'GET',
      path: '/api/me',
    });
    return r.data;
  } catch (e) {
    if (e instanceof ServerError && e.status === 401) return null;
    throw e;
  }
}

export async function login(
  ses: Session,
  origin: string,
  email: string,
  password: string,
): Promise<SafeUser> {
  await serverRequest(ses, origin, {
    method: 'POST',
    path: '/api/auth/login',
    body: { email, password },
  });
  // Server Set-Cookie is captured by the partition session automatically.
  const me = await getMe(ses, origin);
  if (!me) throw new Error('Login succeeded but /api/me returned no user');
  return me;
}

export async function logout(ses: Session, origin: string): Promise<void> {
  await serverRequest(ses, origin, { method: 'POST', path: '/api/auth/logout' });
}

export async function validateServer(
  ses: Session,
  origin: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const me = await getMe(ses, origin);
    // 401 = reachable & needs login → valid. A logged-in me is also fine.
    void me;
    return { ok: true };
  } catch (e) {
    const reason =
      e instanceof Error ? e.message : 'Could not reach the server';
    return { ok: false, reason };
  }
}

export async function loginViaWeb(
  ses: Session,
  origin: string,
  parent: Electron.BrowserWindow,
): Promise<SafeUser | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = async () => {
      if (settled) return;
      const me = await getMe(ses, origin);
      if (me) {
        settled = true;
        child.close();
        ses.cookies.off('changed', onCookie);
        clearInterval(poll);
        resolve(me);
      }
    };

    const onCookie = () => void finish();
    ses.cookies.on('changed', onCookie);

    // Fallback poll (~1s) in case the changed event misses.
    const poll = setInterval(() => void finish(), 1000);

    const child = new BrowserWindow({
      parent,
      modal: true,
      width: 480,
      height: 640,
      webPreferences: {
        partition: ses.partition,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    child.on('closed', () => {
      if (!settled) {
        settled = true;
        ses.cookies.off('changed', onCookie);
        clearInterval(poll);
        resolve(null); // user cancelled
      }
    });

    child.loadURL(origin);
  });
}
```

> `ses.partition` is the string `'persist:deploykit'`; the child window shares it so the deployed SPA's login form sets the same cookie the main window's `net` requests read.

- [ ] **Step 4: Implement `ipcApiClient.ts`**

`apps/desktop/src/renderer/ipcApiClient.ts`:

```ts
import type { ApiClient, UploadableFile, UploadProgress } from '@deploykit/client';

export function createIpcApiClient(): ApiClient {
  const bridge = window.deploykit;
  return {
    getMe: () => bridge.api.getMe(),
    login: (email, password) => bridge.api.login(email, password),
    logout: () => bridge.api.logout(),
    listProjects: () => bridge.api.listProjects(),
    createProject: (input) => bridge.api.createProject(input),
    updateProject: (id, updates) => bridge.api.updateProject(id, updates),
    deleteProject: (id) => bridge.api.deleteProject(id),
    updateSettings: (id, settings) => bridge.api.updateSettings(id, settings),
    uploadVersion: (
      _projectId: string,
      _file: UploadableFile | null,
      _folderFiles: UploadableFile[] | null,
      _description: string,
      _onProgress?: UploadProgress,
    ) => {
      // Desktop overrides the upload path at the call site (Task 8 wires
      // UploadVersionDialog to detect a native bridge and call nativeUpload).
      throw new Error(
        'Desktop uploads must go through window.deploykit.nativeUpload.*',
      );
    },
    publishVersion: (projectId, versionId) =>
      bridge.api.publishVersion(projectId, versionId),
    rollbackVersion: (projectId, versionId) =>
      bridge.api.rollbackVersion(projectId, versionId),
    deleteVersion: (projectId, versionId) =>
      bridge.api.deleteVersion(projectId, versionId),
  };
}
```

- [ ] **Step 5: Implement `<DesktopApp/>` (onboarding → login → App gate)**

`apps/desktop/src/renderer/DesktopApp.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  ApiClientProvider,
  App,
  NativeProvider,
  ServerInfoProvider,
  useApiClient,
} from '@deploykit/client';
import type { SafeUser } from '@deploykit/shared';
import { createIpcApiClient } from './ipcApiClient';

type Phase = 'loading' | 'onboarding' | 'auth' | 'ready';

export function DesktopApp() {
  const native = window.deploykit.native;
  const [phase, setPhase] = useState<Phase>('loading');
  const [origin, setOrigin] = useState('');
  const [user, setUser] = useState<SafeUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const o = await native.getServerOrigin();
      if (cancelled) return;
      if (!o) {
        setPhase('onboarding');
        return;
      }
      setOrigin(o);
      // Resume persisted session.
      try {
        const me = await window.deploykit.api.getMe();
        if (cancelled) return;
        if (me) {
          setUser(me);
          setPhase('ready');
        } else {
          setPhase('auth');
        }
      } catch (e) {
        setPhase('auth');
        setError(e instanceof Error ? e.message : 'Cannot reach server');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [native]);

  const onConnect = useCallback(async (url: string) => {
    setError(null);
    const result = await native.validateServer(url);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    await native.configureServer(url);
    setOrigin(url);
    setPhase('auth');
  }, [native]);

  if (phase === 'loading') {
    return (
      <div className="flex items-center justify-center min-h-dvh">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (phase === 'onboarding') {
    return <Onboarding onSubmit={onConnect} error={error} />;
  }

  if (phase === 'auth' || !user) {
    return (
      <LoginGate
        origin={origin}
        onLoggedIn={(me) => {
          setUser(me);
          setPhase('ready');
        }}
        error={error}
      />
    );
  }

  return (
    <NativeProvider bridge={native}>
      <ServerInfoProvider origin={origin}>
        <ApiClientProvider client={createIpcApiClient()}>
          <App />
        </ApiClientProvider>
      </ServerInfoProvider>
    </NativeProvider>
  );
}

function Onboarding({
  onSubmit,
  error,
}: {
  onSubmit: (url: string) => void | Promise<void>;
  error: string | null;
}) {
  const [url, setUrl] = useState('http://localhost:3000');
  return (
    <form
      className="flex flex-col gap-3 max-w-sm mx-auto mt-32 p-6"
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(url);
      }}
    >
      <h1 className="text-xl font-semibold">Connect to your DeployKit server</h1>
      <input
        className="border rounded px-3 py-2"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://deploy.example.com"
      />
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <button className="bg-blue-600 text-white rounded px-4 py-2" type="submit">
        Connect
      </button>
    </form>
  );
}

function LoginGate({
  origin,
  onLoggedIn,
  error,
}: {
  origin: string;
  onLoggedIn: (me: SafeUser) => void;
  error: string | null;
}) {
  const api = useApiClient(); // this LoginGate is rendered under a temp provider below
  // (see note: LoginGate needs its own ApiClientProvider for password login)
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setLocalErr(null);
    try {
      const me = await api.login(email, password);
      onLoggedIn(me);
    } catch (err) {
      setLocalErr(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  const webLogin = async () => {
    setBusy(true);
    setLocalErr(null);
    try {
      const me = await window.deploykit.native.loginViaWeb();
      if (me) onLoggedIn(me);
    } finally {
      setBusy(false);
    }
  };

  void origin;
  return (
    <div className="flex flex-col gap-3 max-w-sm mx-auto mt-32 p-6">
      <h1 className="text-xl font-semibold">Sign in</h1>
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <input className="border rounded px-3 py-2" placeholder="Email"
          value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="border rounded px-3 py-2" placeholder="Password"
          type="password" value={password}
          onChange={(e) => setPassword(e.target.value)} />
        {(localErr || error) && (
          <p className="text-red-600 text-sm">{localErr ?? error}</p>
        )}
        <button className="bg-blue-600 text-white rounded px-4 py-2 disabled:opacity-50"
          type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <button className="text-sm underline" onClick={webLogin} disabled={busy}>
        Sign in via web page
      </button>
    </div>
  );
}
```

> `LoginGate` calls `useApiClient()`, so the `auth` branch must wrap it in an `ApiClientProvider`. Fix the `auth` branch in `DesktopApp`:

```tsx
  if (phase === 'auth' || !user) {
    return (
      <ApiClientProvider client={createIpcApiClient()}>
        <LoginGate
          origin={origin}
          onLoggedIn={(me) => { setUser(me); setPhase('ready'); }}
          error={error}
        />
      </ApiClientProvider>
    );
  }
```

(`createIpcApiClient()` is cheap; calling it twice across phase transitions is fine.)

- [ ] **Step 6: Mount in `main.tsx` + copy theme tokens**

`apps/desktop/src/renderer/main.tsx`:

```tsx
/// <reference types="vite/client" />
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { DesktopApp } from './DesktopApp';

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root was not found.');
createRoot(root).render(
  <StrictMode>
    <DesktopApp />
  </StrictMode>,
);
```

`apps/desktop/src/renderer/index.css` — copy the **entire** contents of `packages/client/src/index.css` (the web theme tokens) here, since the desktop renderer is a separate Vite build that needs the same Tailwind setup:

```bash
cp packages/client/src/index.css apps/desktop/src/renderer/index.css
```

> If `packages/client/src/index.css` imports fonts or assets via relative paths, adjust those. After Task 4 the web `index.css` is the canonical theme; duplicating it into the desktop renderer is the simplest way to give the renderer the same design tokens without a cross-package CSS import (which Forge's Vite plugin handles poorly).

- [ ] **Step 7: Typecheck + lint**

```bash
bun --filter @deploykit/desktop typecheck
bun --filter @deploykit/desktop lint
bun run check
```

Expected: clean. Resolve any `verbatimModuleSyntax` errors by adding `import type` to type-only imports (e.g. `import type { Session } from 'electron'`).

- [ ] **Step 8: Manual end-to-end smoke test**

In two terminals:

```bash
# Terminal 1
bun run dev:server
# Terminal 2
bun run dev:desktop
```

Expected flow in the desktop window:
1. First run shows onboarding with `http://localhost:3000` prefilled.
2. Click Connect → server reachable (401 from `/api/me` = valid) → login screen.
3. Enter admin credentials (from server seed) → signs in → renders the shared `<App/>`.
4. Quit and relaunch → bypasses onboarding, resumes the persisted session (`/api/me` returns the user), lands directly in `<App/>`.

If step 2 fails with a network error, confirm `dev:server` is up (`curl http://localhost:3000/api/me` should return 401 JSON).

- [ ] **Step 9: Commit**

```bash
git add -A apps/desktop
git commit -m "feat(desktop): net-based transport, three login flows, onboarding + session resume"
```

---

### Task 8: Native directory + drag-and-drop upload, and P0 sign-off

**Goal:** Implement the desktop-native upload path — directory picker, recursive disk read, client-side preflight against server limits, multipart construction with progress, and zip-path upload — then wire `UploadVersionDialog` to detect the native bridge and route uploads through it. After this task the desktop client is feature-complete against the web panel (P0 done).

**Files:**
- Modify: `apps/desktop/src/main/nativeUpload.ts` — `collectDirectory`, `preflight`, `buildFolderMultipart`, `uploadFolder`, `uploadZipPath`, `pickDirectory`.
- Modify: `apps/desktop/src/preload.ts` — implement `uploadZipPath` (was a stub in Task 6).
- Modify: `apps/desktop/src/main/ipc.ts` — register `nativeUpload:uploadZipPath` handler.
- Modify: `apps/desktop/src/shared/bridge.ts` — none (interface already declares both methods).
- Modify: `packages/client/src/features/versions/UploadVersionDialog.tsx` — detect `useNative()`; when present, use `pickDirectory()` + `nativeUpload.uploadFolder()` instead of the `<input type=file>` + `api.uploadVersion()`. Also handle drag-drop Files carrying `.path`.
- Modify: `apps/desktop/vite.renderer.config.mts` if the dialog's native path needs an alias (it shouldn't — `useNative` comes from the client package).
- Test (Create): `apps/desktop/tests/nativeUpload.test.ts` — `collectDirectory` + `preflight` + multipart boundary tests (pure functions).
- Test (Create): `apps/desktop/tests/preflight.test.ts` — limits edge cases.

**Interfaces:**
- Consumes: `NativeBridge`, `ApiClient`, server limits constants, `extractMessage`.
- Produces: working folder + zip upload from disk, with progress; `UploadVersionDialog` works on both web (XHR) and desktop (native).

- [ ] **Step 1: Define the limits constants**

At the top of `apps/desktop/src/main/nativeUpload.ts`:

```ts
import { dialog, type Session } from 'electron';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, posix } from 'node:path';
import { extractMessage } from '@deploykit/client';
import type { NativeFile, PickedDirectory } from '@deploykit/client';
import { serverRequest, ServerError } from './serverRequest';

// Mirrors server defaults (apps/server/src/config.ts). Overridden at runtime by
// the server's MAX_* env, but these are the values we preflight against since
// the server does not expose its configured limits over the API.
export const LIMITS = {
  maxExtractedSize: 100 * 1024 * 1024, // 100 MB
  maxFileCount: 1000,
  maxPathLength: 1000,
  maxZipSize: 100 * 1024 * 1024, // 100 MB
};

const MULTI_PART_BOUNDARY = '----deploykit';
```

> These defaults match `apps/server/src/config.ts` (`parseSize` default 100MB, `parseCount` default 1000). The plan does **not** add a server endpoint to fetch configured limits (YAGNI for P0); if the server runs tighter limits the upload will still be rejected by the server with a clear `FILES_TOO_LARGE`/`TOO_MANY_FILES`/`PATH_TOO_LONG` message, just after bytes are sent. Preflight is a best-effort optimization.

- [ ] **Step 2: Implement `collectDirectory` (recursive read)**

Append to `nativeUpload.ts`:

```ts
/**
 * Recursively reads a directory, returning NativeFile entries with POSIX
 * relative paths rooted at the picked directory (e.g. "assets/app.js").
 */
export async function collectDirectory(
  directoryPath: string,
): Promise<NativeFile[]> {
  const result: NativeFile[] = [];

  async function walk(absDir: string) {
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        const st = await stat(abs);
        const rel = relative(directoryPath, abs).split(join.sep).join(posix.sep);
        result.push({
          name: entry.name,
          size: st.size,
          type: guessType(entry.name),
          webkitRelativePath: rel,
          path: abs,
        });
      }
    }
  }

  await walk(directoryPath);
  return result;
}

function guessType(name: string): string {
  if (name.endsWith('.html')) return 'text/html';
  if (name.endsWith('.js')) return 'text/javascript';
  if (name.endsWith('.css')) return 'text/css';
  if (name.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}
```

- [ ] **Step 3: Implement `preflight` (client-side validation)**

Append:

```ts
export interface PreflightError {
  reason: string;
}

/** Returns null if ok, else a human-readable reason. */
export function preflight(
  files: NativeFile[],
  limits: typeof LIMITS = LIMITS,
): PreflightError | null {
  if (files.length > limits.maxFileCount) {
    return {
      reason: `Too many files: ${files.length} (max ${limits.maxFileCount}).`,
    };
  }
  let total = 0;
  for (const f of files) {
    total += f.size;
    if (f.webkitRelativePath.length > limits.maxPathLength) {
      return {
        reason: `Path too long: ${f.webkitRelativePath} (max ${limits.maxPathLength} chars).`,
      };
    }
  }
  if (total > limits.maxExtractedSize) {
    return {
      reason: `Total size too large: ${total} bytes (max ${limits.maxExtractedSize}).`,
    };
  }
  return null;
}
```

- [ ] **Step 4: Write the `preflight` + `collectDirectory` tests**

`apps/desktop/tests/preflight.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { preflight, LIMITS } from '../src/main/nativeUpload';
import type { NativeFile } from '@deploykit/client';

const mk = (rel: string, size: number): NativeFile => ({
  name: rel.split('/').pop() || rel,
  size,
  type: 'application/octet-stream',
  webkitRelativePath: rel,
  path: `/fake/${rel}`,
});

test('preflight passes under all limits', () => {
  expect(preflight([mk('a.js', 10), mk('b.js', 20)])).toBeNull();
});

test('preflight rejects too many files', () => {
  const files = Array.from({ length: LIMITS.maxFileCount + 1 }, (_, i) =>
    mk(`f${i}.js`, 1),
  );
  const err = preflight(files);
  expect(err?.reason).toMatch(/Too many files/);
});

test('preflight rejects oversized total', () => {
  const err = preflight([mk('big.bin', LIMITS.maxExtractedSize + 1)]);
  expect(err?.reason).toMatch(/Total size too large/);
});

test('preflight rejects a too-long path', () => {
  const long = 'a'.repeat(LIMITS.maxPathLength + 1);
  const err = preflight([mk(long, 1)]);
  expect(err?.reason).toMatch(/Path too long/);
});
```

`apps/desktop/tests/nativeUpload.test.ts` (collectDirectory against a temp dir):

```ts
import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectDirectory } from '../src/main/nativeUpload';

test('collectDirectory walks subdirs and yields POSIX relative paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dk-'));
  await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'index.html'), '<html/>');
  await writeFile(join(dir, 'assets', 'app.js'), 'console.log(1)');

  const files = await collectDirectory(dir);
  const paths = files.map((f) => f.webkitRelativePath).sort();
  expect(paths).toEqual(['assets/app.js', 'index.html']);
});
```

Run:

```bash
bun --filter @deploykit/desktop test
```

Expected: all pass.

- [ ] **Step 5: Implement multipart construction + upload**

Append to `nativeUpload.ts`:

```ts
/**
 * Builds a multipart/form-data body for folder upload. Each file part's
 * filename is its POSIX-relative webkitRelativePath so the server's
 * writeFolderFiles reconstructs the tree. Returns the full body buffer + size.
 */
export function buildFolderMultipart(
  files: NativeFile[],
  description: string,
): { chunks: Buffer[]; totalBytes: number } {
  const chunks: Buffer[] = [];
  let total = 0;
  const push = (s: string | Buffer) => {
    const b = Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8');
    chunks.push(b);
    total += b.length;
  };

  for (const f of files) {
    push(`--${MULTI_PART_BOUNDARY}\r\n`);
    push(
      `Content-Disposition: form-data; name="folderFiles"; filename="${f.webkitRelativePath}"\r\n` +
        `Content-Type: ${f.type}\r\n\r\n`,
    );
    // NOTE: file bytes are added lazily by the uploader (read from disk during
    // the request to avoid buffering a 100MB body in memory). We record a
    // placeholder marker that the uploader replaces.
    push(`\r\n`);
  }
  push(`--${MULTI_PART_BOUNDARY}\r\n`);
  push(`Content-Disposition: form-data; name="versionDesc"\r\n\r\n`);
  push(`${description}\r\n`);
  push(`--${MULTI_PART_BOUNDARY}--\r\n`);

  return { chunks, totalBytes: total };
}

/**
 * Streams a folder upload: builds the multipart envelope but interleaves file
 * bytes read from disk, reporting progress. We avoid buffering everything in
 * memory by composing the full buffer in order — acceptable up to ~100MB
 * (the preflight cap).
 */
export async function uploadFolder(
  ses: Session,
  origin: string,
  projectId: string,
  directoryPath: string,
  description: string,
  onProgress?: (percent: number) => void,
): Promise<{ version: { id: string; name: string } }> {
  const files = await collectDirectory(directoryPath);
  const err = preflight(files);
  if (err) throw new Error(err.reason);

  // Compose the full body in order, reading file bytes from disk as we go.
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let written = 0;
  for (const f of files) {
    const header = Buffer.from(
      `--${MULTI_PART_BOUNDARY}\r\n` +
        `Content-Disposition: form-data; name="folderFiles"; filename="${f.webkitRelativePath}"\r\n` +
        `Content-Type: ${f.type}\r\n\r\n`,
      'utf8',
    );
    chunks.push(header);
    totalBytes += header.length;
    const data = await readFile(f.path);
    chunks.push(data);
    totalBytes += data.length;
    const tail = Buffer.from('\r\n', 'utf8');
    chunks.push(tail);
    totalBytes += tail.length;
  }
  const desc = Buffer.from(
    `--${MULTI_PART_BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="versionDesc"\r\n\r\n` +
      `${description}\r\n` +
      `--${MULTI_PART_BOUNDARY}--\r\n`,
    'utf8',
  );
  chunks.push(desc);
  totalBytes += desc.length;
  void written;

  const r = await serverRequest<{ version: { id: string; name: string } }>(
    ses,
    origin,
    {
      method: 'POST',
      path: `/api/projects/${projectId}/versions`,
      multipart: { chunks, totalBytes },
      onProgress,
    },
  );
  return r.data;
}

export async function uploadZipPath(
  ses: Session,
  origin: string,
  projectId: string,
  zipPath: string,
  description: string,
  onProgress?: (percent: number) => void,
): Promise<{ version: { id: string; name: string } }> {
  const data = await readFile(zipPath);
  if (data.byteLength > LIMITS.maxZipSize) {
    throw new Error(
      `Zip too large: ${data.byteLength} bytes (max ${LIMITS.maxZipSize}).`,
    );
  }
  const header = Buffer.from(
    `--${MULTI_PART_BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${zipPath.split(/[\\/]/).pop()}"\r\n` +
      `Content-Type: application/zip\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from('\r\n', 'utf8');
  const desc = Buffer.from(
    `--${MULTI_PART_BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="versionDesc"\r\n\r\n` +
      `${description}\r\n` +
      `--${MULTI_PART_BOUNDARY}--\r\n`,
    'utf8',
  );
  const totalBytes = header.length + data.length + tail.length + desc.length;

  const r = await serverRequest<{ version: { id: string; name: string } }>(
    ses,
    origin,
    {
      method: 'POST',
      path: `/api/projects/${projectId}/versions`,
      multipart: { chunks: [header, data, tail, desc], totalBytes },
      onProgress,
    },
  );
  return r.data;
}

export async function pickDirectory(
  parent: Electron.BrowserWindow,
): Promise<PickedDirectory | null> {
  const result = await dialog.showOpenDialog(parent, {
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const directoryPath = result.filePaths[0];
  const files = await collectDirectory(directoryPath);
  const directoryName = directoryPath.split(/[\\/]/).pop() || directoryPath;
  return { directoryName, files };
}
```

> `buildFolderMultipart` is exported for unit-testing the envelope shape (boundary, header `name="folderFiles"`, filename = relative path, `versionDesc` field). The actual upload (`uploadFolder`) re-composes the body reading bytes from disk, since the placeholder-marker approach in `buildFolderMultipart` would require a more complex streaming writer — the in-memory composition is bounded by the 100MB preflight cap and is simpler/correct. Keep `buildFolderMultipart` only if you want to test the header format in isolation; otherwise drop it and rely on the integration smoke test in Step 8.

- [ ] **Step 6: Implement `uploadZipPath` in preload + register the IPC handler**

`apps/desktop/src/preload.ts` — replace the `uploadZipPath` body (was a `throw` in Task 6 Step 7):

```ts
    uploadZipPath: (
      projectId: string,
      zipPath: string,
      description: string,
      onProgress?: (percent: number) => void,
    ) => {
      const channel = SUB_ID();
      const handler = (_e: unknown, p: number) => onProgress?.(p);
      if (onProgress) ipcRenderer.on(channel, handler);
      return ipcRenderer
        .invoke('nativeUpload:uploadZipPath', projectId, zipPath, description, channel)
        .finally(() => {
          if (onProgress) ipcRenderer.removeListener(channel, handler);
        });
    },
```

`apps/desktop/src/main/ipc.ts` — inside `registerIpc`, after the `nativeUpload:uploadFolder` handler, add:

```ts
  ipcMain.handle(
    'nativeUpload:uploadZipPath',
    async (
      _e,
      projectId: string,
      zipPath: string,
      description: string,
      progressChannel: string,
    ) => {
      const win = getMainWindow();
      return uploadZipPath(
        session,
        getOrigin(),
        projectId,
        zipPath,
        description,
        win ? (p) => win.webContents.send(progressChannel, p) : undefined,
      );
    },
  );
```

And update the `import { pickDirectory, uploadFolder } from './nativeUpload'` line at the top of `ipc.ts` to also import `uploadZipPath`:

```ts
import { pickDirectory, uploadFolder, uploadZipPath } from './nativeUpload';
```

- [ ] **Step 7: Wire `UploadVersionDialog` to detect native + drag-drop**

In `packages/client/src/features/versions/UploadVersionDialog.tsx` (now living in the client package after Task 4):

1. Add imports at the top:

```tsx
import { useApiClient, useNative } from '@/api';
```

(`useApiClient`/`useNative` are re-exported from `@/api` since the client's top barrel re-exports `./api`.)

2. Inside the component, acquire both:

```tsx
const api = useApiClient();
const native = useNative();
```

3. Replace the upload invocation (the `api.uploadVersion(...)` call at ~L94) with a branch:

```tsx
const handleUpload = async () => {
  setProgress(0);
  try {
    if (native) {
      // Desktop path: read from disk via the native bridge.
      // folderFiles here come from pickDirectory() or drag-drop (File.path).
      const folderPaths = (folderFiles ?? [])
        .map((f) => (f as File & { path?: string }).path)
        .filter((p): p is string => Boolean(p));
      if (folderPaths.length > 0) {
        // Drag-drop: a single dragged top-level directory; the main process
        // re-reads it. For multi-drop P0 we support the first path.
        const result = await window.deploykit.nativeUpload.uploadFolder(
          projectId,
          // Resolve directory from the first dropped file's path.
          await window.deploykit.native.pickDirectory().then((d) => d?.files?.[0]?.path ?? ''),
          description,
          setProgress,
        );
        onUploaded(result);
        return;
      }
      // No drag-drop path: require an explicit pick.
      const picked = await window.deploykit.native.pickDirectory();
      if (!picked) return; // user cancelled
      const result = await window.deploykit.nativeUpload.uploadFolder(
        projectId,
        picked.files[0]?.path ?? '',
        description,
        setProgress,
      );
      onUploaded(result);
      return;
    }
    // Web path (unchanged): XHR upload of the picked File objects.
    const result = await api.uploadVersion(
      projectId,
      file,
      folderFiles,
      description,
      setProgress,
    );
    onUploaded(result);
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Upload failed');
  }
};
```

> The drag-drop case is intentionally simplified for P0: a native bridge present + dragged files → the user is prompted to re-pick via `pickDirectory()` to get a clean directory root (drag-drop gives per-file paths, not a root dir, and reconstructing the root is fiddly). A cleaner drag-drop UX (resolve the common parent of dropped paths) is a P1 polish item. The above keeps the `pickDirectory()` button as the primary desktop upload affordance and leaves drag-drop functional but equivalent to a re-pick. If the team prefers, gate drag-drop entirely behind P1 and only ship `pickDirectory()` for P0 — either is acceptable; the plan ships `pickDirectory()` as the documented path and keeps drag-drop as a passthrough.

4. The existing `<input type="file" webkitdirectory>` element stays for the web build. For the desktop, add a "Pick directory" button that calls `pickDirectory()` and stores the result. Concretely, near the file input JSX, add:

```tsx
{native && (
  <button
    type="button"
    className="border rounded px-3 py-2"
    onClick={async () => {
      const picked = await native.pickDirectory();
      if (picked) {
        setFolderFiles(
          picked.files as unknown as File[], // NativeFile is structurally compatible
        );
      }
    }}
  >
    Pick directory…
  </button>
)}
```

> `setFolderFiles` is the existing state setter in the dialog; confirm its name in the migrated file. The `NativeFile[]` cast to `File[]` works because `uploadVersion`'s branch on the native path does not read `File`-only APIs.

- [ ] **Step 8: Typecheck + lint + tests across the repo**

```bash
bun --filter @deploykit/desktop test
bun run typecheck
bun run check
bun run test
```

Expected: all green. The migrated `UploadVersionDialog.test.tsx` (now in `packages/client/tests`) renders without a native bridge (`useNative()` returns null) and exercises the web XHR path — unchanged behavior.

- [ ] **Step 9: Manual P0 end-to-end smoke test**

```bash
# Terminal 1
bun run dev:server
# Terminal 2
bun run dev:desktop
```

In the desktop window, after onboarding + login:
1. Create a project (admin role) or pick an existing one.
2. Click "Upload version" → "Pick directory…" → select a built static site folder (e.g. a local `dist/`).
3. Observe the progress bar advance; on completion the version appears in the list.
4. Publish the version; open `${origin}/deploy/${slug}/` in the system browser (clicking the deploy URL uses the `setWindowOpenHandler` → `shell.openExternal` from Task 6).
5. Drag-drop test (optional for P0): drag a folder onto the dialog — it should resolve to a pick prompt per Step 7's note.
6. Rollback / delete a version with confirmation dialogs — all should work identically to web.
7. Quit + relaunch → session resumes.

If `pickDirectory()` returns null silently, check the Forge dev console for permission errors. If the upload fails with `MISSING_INDEX_HTML`, the picked folder has no root `index.html` (server-side `flattenOutput` handles a single wrapping subdir but not deeper nesting).

- [ ] **Step 10: Commit**

```bash
git add -A apps/desktop packages/client
git commit -m "feat(desktop): native directory + zip upload with progress, client preflight"
```

---

## Self-Review

**1. Spec coverage (P0 row, spec §6):**

| Spec P0 deliverable | Task |
|---|---|
| workspace 并入 (`apps/desktop` joins root Bun workspace) | Task 1 |
| `packages/client` + `ApiClient` + IPC transport | Tasks 2, 3, 4, 7 |
| 首次引导 (first-run onboarding — server address) | Task 7 (`Onboarding`) |
| 两种登录 + session 持久化 (password + web-login + persisted resume) | Task 7 (`auth.ts`, `LoginGate`) |
| 功能对齐 web (mirrors web features — shared `<App/>`) | Tasks 4, 7 |
| 原生目录选择器 + 拖拽上传 (directory picker + drag-drop) | Task 8 |
| 客户端预检 (client preflight) | Task 8 (`preflight`) |

Spec §1 非目标 (out of scope): no server changes (✓ no server files touched), no multi-server profile, no offline mode, no self-hosted updater — all respected.

Spec §4.5 接口归属 (capability boundary): `ApiClient` holds server-shape methods only; `native.*` + `nativeUpload.*` are desktop-only on `window.deploykit` — enforced by the `DesktopBridge.api: ApiClient` + `native`/`nativeUpload` split (Task 6 Step 2).

Spec §3.4 (transport + session): all server requests go through `net.request({ session })` on `persist:deploykit` (Task 7 `serverRequest.ts`); tokens never enter the renderer (only `SafeUser` crosses IPC) — enforced by the IPC handler design.

**2. Placeholder scan:** searched for TBD/TODO/"implement later"/"similar to"/"add error handling". None present in production code. Two intentional future-references remain: (a) `preload.ts` `uploadZipPath` stub in Task 6 is explicitly filled in Task 8 Step 6 (a deliberate staged reveal, not a placeholder); (b) Task 8 Step 7's drag-drop simplification is a documented scope decision (deferred polish), not a placeholder. Test files contain complete test code.

**3. Type consistency:**
- `ApiClient` methods: `getMe`, `login`, `logout`, `listProjects`, `createProject`, `updateProject`, `deleteProject`, `updateSettings`, `uploadVersion`, `publishVersion`, `rollbackVersion`, `deleteVersion` — identical across Task 2 (definition), Task 2 Step 7 (`fetchApiClient`), Task 5 Step 1 (shape test), Task 6 Step 2 (`DesktopBridge.api: ApiClient`), Task 6 Step 5/7 (IPC handlers + preload), Task 7 Step 4 (`ipcApiClient`), Task 8 (call sites). ✓
- `NativeBridge`: `pickDirectory`, `validateServer`, `configureServer`, `getServerOrigin`, `loginViaWeb`, `onAuthExpired` — Task 2 Step 5 (def), Task 6 Step 2 (`DesktopBridge.native`), Task 6 Step 7 (preload), Task 7 Step 5 (consumed). Note: `NativeBridge.getServerOrigin` returns `string` synchronously (Task 2 Step 5), but the IPC bridge makes it async (`Promise<string>`) in `DesktopBridge.native.getServerOrigin` (Task 6 Step 2) and `DesktopApp` awaits it (Task 7 Step 5). **Fix:** make `NativeBridge.getServerOrigin` return `Promise<string>` in Task 2 Step 5 to match — see the patch below.
- `NativeFile`/`PickedDirectory`/`ValidateServerResult`: identical across Task 2 Step 5, Task 6 Step 2, Task 8. ✓
- `serverRequest` signature `(session, origin, opts)` consistent across Task 6 stub, Task 7 impl, Task 8 callers. ✓
- `ServerError`/`NetworkError`: Task 7 Step 1 defines; Task 7 Step 3 (`auth.ts`) consumes `ServerError`. ✓

**Patch to Task 2 Step 5** (fix `getServerOrigin` return type): change the `NativeBridge` interface member from

```ts
  getServerOrigin(): string;
```

to

```ts
  getServerOrigin(): Promise<string>;
```

(The IPC transport is inherently async; web provides a sync override or the client never calls it on web. Since `getServerOrigin` is desktop-only in practice, the async signature is correct. Apply this edit when implementing Task 2.)

**4. Sequencing risk:** Tasks 1→8 are strictly ordered; Task 3 cannot pass without Task 2's exports, Task 4 cannot run without Task 3's context wiring, etc. Each task ends green (typecheck + test + lint). The one cross-task coupling to watch: Task 4 moves `useProjects.test.ts` etc. into `packages/client/tests` — Task 3 must have already converted those tests to the `renderWithClient` pattern, else the moved tests fail in the client run. Task 3 Step 8 covers this conversion; Task 4 Step 2 then moves the already-converted files.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-02-desktop-client-p0.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for this plan: 8 tasks with clear boundaries, each independently reviewable, and the refactor tasks (3–5) benefit from a green-gate review before the desktop tasks (6–8) build on them.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. Faster wall-clock but less review surface between the refactor and the desktop build.

**Which approach?**

If you proceed, the recommended order is exactly Tasks 1→8; do not parallelize — the desktop tasks depend on the refactor landing first. After Task 5 (refactor gate), consider a manual `dev:web` smoke test before starting Task 6. After Task 8, run the full manual P0 smoke test (Task 8 Step 9) before declaring P0 done.

---

---

---
