# SQLite, History Timeline, Verify/CI, and UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the authentication experience, make SQLite the default metadata store with safe JSON import, expose the existing audit history as a first-class project timeline, and provide one reliable local/CI verification command.

**Architecture:** Keep the existing synchronous `ProjectRepository` boundary and add a Bun SQLite document repository using WAL mode and a single versioned state row. This avoids a premature relational rewrite while replacing fragile JSON writes and preserving all existing domain/service code. Extend the transport-neutral `ApiClient` through both Hono and Electron IPC, then render history as a fourth project detail tab. Mount one shared toast provider at the client root so authentication and operational feedback never changes page geometry.

**Tech Stack:** Bun 1.3, `bun:sqlite`, Hono, React 19, TypeScript 6, Vitest, Bun test, Tailwind CSS 4, Sonner, Electron IPC, Turbo, Biome, GitHub Actions.

## Global Constraints

- Preserve the cobalt, neutral paper, square-grid design language already implemented in `packages/client/src/index.css`.
- Authentication failures must use localized toast feedback and must not insert content into the login form.
- Hover states must preserve readable semantic foreground colors in light and dark themes.
- SQLite is the default runtime store; existing `data.json` is imported once only when the SQLite store is empty.
- The JSON file remains untouched and a sibling `.sqlite-migration.bak` copy is created before import.
- Existing project, version, user, history, upload, desktop, and deploy contracts must remain backward compatible.
- Do not introduce Drizzle or PostgreSQL in this iteration.
- All new user-facing copy must exist in both `zh.json` and `en.json`.
- The final `bun run verify` command must perform Biome checking, type checking, tests, and a production build.

---

### Task 1: Stabilize authentication layout and toast feedback

**Files:**
- Modify: `packages/client/src/App.tsx`
- Modify: `packages/client/src/features/auth/LoginPage.tsx`
- Modify: `packages/client/src/components/ui/sonner.tsx`
- Modify: `packages/client/src/index.css`
- Modify: `packages/client/src/i18n/locales/zh.json`
- Modify: `packages/client/src/i18n/locales/en.json`
- Test: `packages/client/tests/unit/LoginPage.test.tsx`

**Interfaces:**
- Consumes: `ToastProvider`, `useToast()`, and `getLocalizedError(error, t, fallback)`.
- Produces: a root-mounted toast viewport and a login form whose failed submit preserves its dimensions.

- [ ] **Step 1: Replace the inline-error test with a toast contract**

```tsx
render(
  <ToastProvider>
    <LoginPage onLogin={onLogin} />
  </ToastProvider>
);

expect(await screen.findByText('error.invalidCredentials')).toBeInTheDocument();
expect(screen.queryByRole('alert')).not.toBeInTheDocument();
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `bun --filter @deploykit/client test -- tests/unit/LoginPage.test.tsx`

Expected: FAIL because `LoginPage` still renders the raw exception inline.

- [ ] **Step 3: Mount the shared toast provider once**

Refactor `App.tsx` to keep routing/auth decisions in `AppContent`:

```tsx
export default function App() {
  return (
    <ToastProvider>
      <AppContent />
    </ToastProvider>
  );
}
```

- [ ] **Step 4: Move authentication failures to localized toast feedback**

Use this submit failure shape:

```tsx
const { toast } = useToast();

catch (error) {
  toast(getLocalizedError(error, t, t('auth.failed')), 'error');
}
```

Remove the local `error` state and all inline error markup. Change the Chinese credential copy to `邮箱或密码不正确，请检查后重试` and English to `Email or password is incorrect. Check both fields and try again.`

- [ ] **Step 5: Correct alignment, heights, and hover states**

Add a shared `.auth-section-header` class with a fixed `min-height`, identical border position, and aligned controls. Increase the auth tabs from `h-12` to `h-14`; keep inactive hover text on `--primary` and active hover text on `--primary-foreground`. Do not use a global black hover color.

- [ ] **Step 6: Run the focused tests**

Run: `bun --filter @deploykit/client test -- tests/unit/LoginPage.test.tsx tests/unit/toast.test.tsx`

Expected: PASS.

---

### Task 2: Add the SQLite document repository and safe JSON import

**Files:**
- Create: `apps/server/src/repositories/sqliteProjectRepository.ts`
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/repositories/projectRepository.ts`
- Create: `apps/server/tests/services/sqliteProjectRepository.test.ts`
- Modify: `apps/server/tests/services/config.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `ProjectRepository`, `Data`, `migrate(raw)`, `createEmptyData()`.
- Produces:

```ts
export interface SqliteProjectRepositoryOptions {
  databaseFile: string;
  legacyDataFile?: string;
}

export function createSqliteProjectRepository(
  options: SqliteProjectRepositoryOptions
): ProjectRepository;
```

- [ ] **Step 1: Write repository tests before implementation**

Cover:

```ts
test('creates a SQLite store with WAL enabled');
test('save persists data that a second repository can read');
test('imports legacy JSON only when the SQLite state row is empty');
test('creates data.json.sqlite-migration.bak before import');
test('does not overwrite an existing SQLite state with later JSON changes');
test('migrates an older payload and persists the current schema');
```

- [ ] **Step 2: Run the repository test and verify it fails**

Run: `bun test apps/server/tests/services/sqliteProjectRepository.test.ts`

Expected: FAIL because the repository module does not exist.

- [ ] **Step 3: Implement the SQLite repository**

Create the schema:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS deploykit_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Use a prepared `SELECT` and an `INSERT ... ON CONFLICT(id) DO UPDATE` wrapped by a Bun SQLite transaction. Parse payloads through `migrate`; persist the migrated shape immediately.

- [ ] **Step 4: Implement one-time legacy import**

When row `id = 1` does not exist and `legacyDataFile` exists:

1. copy it to `${legacyDataFile}.sqlite-migration.bak`;
2. read through `createJsonProjectRepository(legacyDataFile).load()`;
3. save the result into SQLite;
4. leave the original JSON file untouched.

- [ ] **Step 5: Make SQLite the default runtime store**

Extend `AppConfig` with `databaseFile?: string`. `loadConfig()` returns:

```ts
databaseFile: env.DATABASE_FILE ?? join(appDir, 'deploykit.sqlite')
```

`createApp()` selects SQLite when `databaseFile` is defined and retains the JSON repository fallback for existing isolated tests that construct `AppConfig` manually.

- [ ] **Step 6: Update configuration documentation**

Document `DATABASE_FILE`, legacy `DATA_FILE` import behavior, WAL sidecar files, and backup behavior.

- [ ] **Step 7: Run server repository and API tests**

Run: `bun --filter @deploykit/server test`

Expected: all server tests pass.

---

### Task 3: Extend the typed API and Electron bridge for history

**Files:**
- Modify: `packages/client/src/api/ApiClient.ts`
- Modify: `packages/client/src/api/fetchApiClient.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/renderer/ipcApiClient.ts`
- Modify: `packages/client/tests/unit/apiClientShape.test.ts`

**Interfaces:**
- Consumes: `HistoryEvent` from `@deploykit/shared` and existing `/api/projects/:id/history`.
- Produces:

```ts
listProjectHistory(projectId: string, limit?: number): Promise<HistoryEvent[]>;
```

- [ ] **Step 1: Add `listProjectHistory` to the expected API shape test**

Add the method name to `EXPECTED_METHODS` and a fetch assertion for the project history route.

- [ ] **Step 2: Run the shape test and verify it fails**

Run: `bun --filter @deploykit/client test -- tests/unit/apiClientShape.test.ts`

Expected: FAIL because the client does not expose the method.

- [ ] **Step 3: Implement web transport**

Call the typed Hono route with `{ param: { id }, query: { limit: String(limit) } }`, omitting the query when `limit` is undefined, and return `HistoryEvent[]`.

- [ ] **Step 4: Mirror the method over Electron IPC**

Register `api:listProjectHistory` in `apps/desktop/src/main/ipc.ts` and forward it from `createIpcApiClient()`. Preserve the `ApiClient` interface as the only renderer-facing contract.

- [ ] **Step 5: Run client and desktop type checks**

Run:

```bash
bun --filter @deploykit/client typecheck
bun --filter @deploykit/desktop typecheck
```

Expected: both pass.

---

### Task 4: Build the project history timeline

**Files:**
- Create: `packages/client/src/features/history/ProjectHistoryTimeline.tsx`
- Create: `packages/client/tests/unit/ProjectHistoryTimeline.test.tsx`
- Modify: `packages/client/src/features/projects/ProjectWorkspace.tsx`
- Modify: `packages/client/src/i18n/locales/zh.json`
- Modify: `packages/client/src/i18n/locales/en.json`

**Interfaces:**
- Consumes:

```ts
interface ProjectHistoryTimelineProps {
  projectId: string;
  refreshKey: string;
}
```

- Produces: a loading skeleton, retryable failure state, empty state, and ordered timeline for up to 50 project events.

- [ ] **Step 1: Write timeline component tests**

Test loading, successful events, empty results, error plus retry, localized action labels, actor/version metadata, and chronological ordering.

- [ ] **Step 2: Run the timeline test and verify it fails**

Run: `bun --filter @deploykit/client test -- tests/unit/ProjectHistoryTimeline.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement timeline fetching and states**

Fetch on `projectId` and `refreshKey`, ignore stale promise results on unmount, and render events with semantic `<ol>`/`<li>` markup. Use action-specific Lucide icons and textual labels so color is never the only status signal.

- [ ] **Step 4: Add History as the fourth detail tab**

Extend:

```ts
type DetailTab = 'versions' | 'history' | 'members' | 'settings';
```

Use a four-column tab list ordered Versions, History, Members, Settings. Add hash routing for `/history`; pass `project.updatedAt` as `refreshKey`.

- [ ] **Step 5: Add bilingual timeline copy**

Include loading, retry, actor fallback, version label, timestamp label, and metadata summaries without exposing raw JSON.

- [ ] **Step 6: Run client tests and type check**

Run:

```bash
bun --filter @deploykit/client test
bun --filter @deploykit/client typecheck
```

Expected: all pass.

---

### Task 5: Unify verification and CI

**Files:**
- Modify: `package.json`
- Modify: `biome.json`
- Modify: `.github/workflows/ci.yml`
- Modify only when required by Biome: existing files reported by `bun run check`

**Interfaces:**
- Produces the root command:

```json
"verify": "bun run check && bun run typecheck && bun run test && bun run build"
```

- [ ] **Step 1: Reproduce the current repository-wide check failures**

Run: `bun run check`

Expected: FAIL on the known formatting/accessibility debt.

- [ ] **Step 2: Update the Biome schema and fix repository-wide safe issues**

Run Biome safe formatting, then manually fix semantic accessibility errors. Do not apply unsafe transformations to auth or permission code without review.

- [ ] **Step 3: Add and run `verify`**

Run: `bun run verify`

Expected: Biome, typecheck, tests, and build all pass.

- [ ] **Step 4: Simplify GitHub Actions**

Replace duplicated quality steps with:

```yaml
- name: Verify
  run: bun run verify
```

Pin the Bun version to the repository `packageManager` value and use `bun install --frozen-lockfile`.

---

### Task 6: Browser polish and responsive verification

**Files:**
- Modify as defects require: files from Tasks 1 and 4 only.

**Interfaces:**
- Consumes: running Web app on `http://localhost:5018/`.
- Produces: verified desktop and mobile login/workspace/history states.

- [ ] **Step 1: Inspect the login page at desktop width**

Verify the `DeployKit / 01` and `Account / Access` rules share the same Y coordinate, tabs are 56px high, hover text remains readable, and an invalid login produces a toast without moving inputs or submit button.

- [ ] **Step 2: Inspect the login page at 390×844**

Verify 44px minimum touch targets, no horizontal overflow, readable labels, and toast placement clear of primary controls.

- [ ] **Step 3: Create a temporary project and inspect history**

Create a project, confirm the creation event appears in History, update settings, confirm a second event, and verify timeline loading/empty/error states.

- [ ] **Step 4: Clean up temporary data**

Delete only the project created in Step 3 and confirm it is absent from the final workspace.

- [ ] **Step 5: Final verification**

Run:

```bash
bun run verify
git diff --check
```

Expected: both pass and the browser console has zero errors.

---

## Self-Review

- Spec coverage: Task 1 covers every named login/UI defect; Task 2 covers SQLite and migration; Tasks 3–4 cover the history timeline across Web and Electron; Task 5 covers verify/CI; Task 6 covers real UI inspection.
- Placeholder scan: no deferred implementation steps or undefined TODOs remain.
- Type consistency: `listProjectHistory(projectId, limit?)` is identical in the shared interface, Web client, Electron IPC, renderer client, and timeline consumer.
- Scope decision: a single-row SQLite document repository is intentional for this single-node iteration. Relational tables, PostgreSQL, and object storage remain out of scope until multi-instance requirements exist.

## Execution

The current user request explicitly authorizes inline execution in this session. Implement tasks in order and keep each task independently testable.
