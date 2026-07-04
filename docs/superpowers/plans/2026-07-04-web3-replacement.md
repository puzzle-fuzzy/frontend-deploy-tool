# web3 Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the production `apps/web` management panel with the new web3 interface while preserving the existing server API contract and packaging flow.

**Architecture:** Keep `apps/web` as the production package and migrate the web3 source into it. Implement app-local API, auth, project, version, member, settings, and capability modules inside `apps/web/src`, using `@deploykit/shared` for domain types and the existing Hono API type for typed requests. Leave `packages/client` intact for the desktop app.

**Tech Stack:** Bun workspaces, Vite 8, React 19, React Compiler, TypeScript 6, Tailwind CSS v4, Base UI/shadcn primitives, Hono typed client, Vitest/RTL where focused tests are added.

## Global Constraints

- `apps/web` remains the production package and keeps the name `@deploykit/web`.
- Web UI components stay inside `apps/web`; do not move business UI or UI primitives into `packages`.
- Existing backend API paths, request bodies, and response shapes remain compatible.
- `project.activeVersionId` remains the single source of truth for the active version.
- Archive and other backend-missing features are app-local disabled placeholders only.
- `apps/desktop` and `packages/client` behavior are out of scope.
- `apps/web/dist` remains the production build output copied by `scripts/package-web.ts`.

---

## File Structure

- Modify `apps/web/package.json`: add web3 dependencies while keeping workspace package identity and scripts.
- Modify `apps/web/vite.config.ts`: make `@` point to `apps/web/src`, keep port/proxy/build output.
- Replace `apps/web/src/main.tsx`: render the app-local web implementation.
- Create/replace `apps/web/src/App.tsx`: top-level auth gate and app shell.
- Copy/adapt `apps/web3/src/components/ui/*` to `apps/web/src/components/ui/*`: app-local UI primitives.
- Copy/adapt web3 shell components into `apps/web/src/components/*`.
- Create `apps/web/src/shared/api/*`: typed API client and provider.
- Create `apps/web/src/features/auth/*`: auth hook and login/register screen.
- Create `apps/web/src/features/projects/*`: project list, creation dialog, selection state.
- Create `apps/web/src/features/versions/*`: upload dialog, version list/actions.
- Create `apps/web/src/features/members/*`: member list and ownership actions.
- Create `apps/web/src/features/settings/*`: project settings and delete flow.
- Create `apps/web/src/shared/capabilities.ts`: disabled archive capability placeholder.
- Remove `apps/web3` after migration succeeds.

---

### Task 1: Production Package Wiring

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/vite.config.ts`
- Modify: `apps/web/src/main.tsx`

**Interfaces:**
- Consumes: existing root scripts `bun run dev:web`, `bun run build`, `scripts/package-web.ts`
- Produces: `@` alias resolving to `apps/web/src`; app entry rendering `App` from `./App`

- [ ] **Step 1: Update `apps/web/package.json` dependencies**

Keep `name`, `scripts`, and workspace dependencies. Add the web3 UI stack using catalog versions where available:

```json
{
  "dependencies": {
    "@base-ui/react": "catalog:",
    "@deploykit/server": "workspace:*",
    "@deploykit/shared": "workspace:*",
    "@fontsource-variable/geist": "^5.2.9",
    "@tabler/icons-react": "^3.44.0",
    "class-variance-authority": "catalog:",
    "clsx": "catalog:",
    "hono": "catalog:",
    "i18next": "catalog:",
    "i18next-browser-languagedetector": "catalog:",
    "lucide-react": "catalog:",
    "react": "catalog:",
    "react-dom": "catalog:",
    "react-i18next": "catalog:",
    "tailwind-merge": "catalog:",
    "tailwindcss": "catalog:",
    "tw-animate-css": "catalog:",
    "zod": "catalog:"
  }
}
```

- [ ] **Step 2: Update `apps/web/vite.config.ts` aliases**

Use this alias shape:

```ts
resolve: {
  alias: {
    '@deploykit/shared': path.resolve(__dirname, '../../packages/shared/src'),
    '@': path.resolve(__dirname, './src'),
  },
},
```

Keep `build.outDir`, `server.port = 5018`, `strictPort`, and the `/api` and
`/deploy` proxies unchanged.

- [ ] **Step 3: Replace `apps/web/src/main.tsx`**

Render app-local providers:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element #root was not found.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

- [ ] **Step 4: Run package-level typecheck**

Run: `bun --filter @deploykit/web typecheck`

Expected at this checkpoint: it may fail because `./App` is not created yet.
The useful assertion is that package resolution starts from `apps/web`.

---

### Task 2: Move web3 UI Foundation Into `apps/web`

**Files:**
- Create/replace: `apps/web/src/index.css`
- Create/replace: `apps/web/src/lib/utils.ts`
- Create/replace: `apps/web/src/hooks/use-mobile.ts`
- Create/replace: `apps/web/src/components/ui/*.tsx`
- Create/replace: `apps/web/src/components/AppLayout.tsx`
- Create/replace: `apps/web/src/components/AppHeader.tsx`
- Create/replace: `apps/web/src/components/AppSidebar.tsx`
- Create/replace: `apps/web/src/components/DropdownMenuAvatar.tsx`
- Create/replace: `apps/web/src/components/VersionStatusBadge.tsx`

**Interfaces:**
- Consumes: web3 local imports using `@/components/ui/*`, `@/lib/utils`
- Produces: reusable app-local shell components for Task 4 onward

- [ ] **Step 1: Copy web3 files into `apps/web/src`**

Copy the current web3 UI primitive, shell, hook, style, and utility files from:

```text
apps/web3/src/index.css
apps/web3/src/lib/utils.ts
apps/web3/src/hooks/use-mobile.ts
apps/web3/src/components/ui/
apps/web3/src/components/AppLayout.tsx
apps/web3/src/components/AppHeader.tsx
apps/web3/src/components/AppSidebar.tsx
apps/web3/src/components/DropdownMenuAvatar.tsx
apps/web3/src/components/VersionStatusBadge.tsx
```

to the matching paths under `apps/web/src`.

- [ ] **Step 2: Normalize formatting**

Run: `bun biome format --write apps/web/src`

Expected: files use single quotes, semicolons, 2-space indentation.

- [ ] **Step 3: Add `apps/web/src/App.tsx` smoke shell**

```tsx
import './index.css';
import { AppLayout } from '@/components/AppLayout';

export function App() {
  return (
    <AppLayout>
      <div className="py-6">
        <h1 className="text-2xl font-semibold">DeployKit</h1>
      </div>
    </AppLayout>
  );
}
```

- [ ] **Step 4: Run build smoke test**

Run: `bun --filter @deploykit/web build`

Expected: PASS, producing `apps/web/dist`.

---

### Task 3: App-Local API Client And Auth Gate

**Files:**
- Create: `apps/web/src/shared/api/types.ts`
- Create: `apps/web/src/shared/api/errors.ts`
- Create: `apps/web/src/shared/api/fetch-client.ts`
- Create: `apps/web/src/shared/api/context.tsx`
- Create: `apps/web/src/shared/types.ts`
- Create: `apps/web/src/features/auth/useAuth.ts`
- Create: `apps/web/src/features/auth/LoginPage.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Produces: `ApiClient`, `createFetchApiClient()`, `ApiClientProvider`, `useApiClient()`, `useAuth()`
- Consumes: existing server API endpoints and `@deploykit/shared` types

- [ ] **Step 1: Create API type contract**

`apps/web/src/shared/api/types.ts` exports:

```ts
import type { Project, SafeUser, Settings } from '@deploykit/shared';

export interface UploadableFile {
  name: string;
  size: number;
  type: string;
  webkitRelativePath?: string;
}

export type UploadProgress = (percent: number) => void;

export interface ApiClient {
  getMe(): Promise<SafeUser | null>;
  login(email: string, password: string): Promise<SafeUser>;
  register(input: {
    name: string;
    email: string;
    password: string;
  }): Promise<SafeUser>;
  logout(): Promise<void>;
  listProjects(): Promise<Project[]>;
  createProject(input: {
    name: string;
    slug: string;
    description: string;
  }): Promise<Project>;
  updateProject(
    id: string,
    updates: { name?: string; slug?: string; description?: string }
  ): Promise<Project>;
  deleteProject(id: string): Promise<{ ok: boolean }>;
  updateSettings(id: string, settings: Settings): Promise<Project>;
  uploadVersion(
    projectId: string,
    file: UploadableFile | null,
    folderFiles: UploadableFile[] | null,
    description: string,
    onProgress?: UploadProgress
  ): Promise<{ version: { id: string; name: string } }>;
  publishVersion(
    projectId: string,
    versionId: string
  ): Promise<{ ok: boolean }>;
  rollbackVersion(
    projectId: string,
    versionId: string
  ): Promise<{ ok: boolean }>;
  deleteVersion(projectId: string, versionId: string): Promise<{ ok: boolean }>;
  searchUsers(query: string): Promise<SafeUser[]>;
  addMember(
    projectId: string,
    email: string,
    role: 'owner' | 'member'
  ): Promise<{ project: Project }>;
  removeMember(projectId: string, userId: string): Promise<{ ok: boolean }>;
  transferOwnership(
    projectId: string,
    targetUserId: string
  ): Promise<{ project: Project }>;
}
```

- [ ] **Step 2: Create fetch client**

Port the method implementations from `packages/client/src/api/fetchApiClient.ts`
to `apps/web/src/shared/api/fetch-client.ts`, changing imports to local
`./types` and keeping `type ApiApp` from `@deploykit/server/api`.

- [ ] **Step 3: Create API provider**

`apps/web/src/shared/api/context.tsx` exports a React context, provider, and hook:

```tsx
import { createContext, useContext } from 'react';
import type { ApiClient } from './types';

const ApiClientContext = createContext<ApiClient | null>(null);

export function ApiClientProvider({
  client,
  children,
}: {
  client: ApiClient;
  children: React.ReactNode;
}) {
  return (
    <ApiClientContext.Provider value={client}>
      {children}
    </ApiClientContext.Provider>
  );
}

export function useApiClient() {
  const client = useContext(ApiClientContext);
  if (!client) {
    throw new Error('useApiClient must be used within ApiClientProvider');
  }
  return client;
}
```

- [ ] **Step 4: Create auth hook and login page**

Port `useAuth` and `LoginPage` from `packages/client/src/features/auth`, changing
imports to app-local UI components and local `useApiClient`.

- [ ] **Step 5: Wire auth gate in `App.tsx`**

`App.tsx` should create a fetch client once, wrap `ApiClientProvider`, show a
spinner while loading, render `LoginPage` while unauthenticated, and render
`AppLayout` after authentication.

- [ ] **Step 6: Verify**

Run: `bun --filter @deploykit/web typecheck`

Expected: PASS or only missing UI component errors that are resolved in the same
task before proceeding.

---

### Task 4: Projects And Shell State

**Files:**
- Create: `apps/web/src/shared/capabilities.ts`
- Create: `apps/web/src/shared/format.ts`
- Create: `apps/web/src/features/projects/slug.ts`
- Create: `apps/web/src/features/projects/useProjects.ts`
- Create: `apps/web/src/features/projects/CreateProjectDialog.tsx`
- Modify: `apps/web/src/components/AppSidebar.tsx`
- Modify: `apps/web/src/components/AppHeader.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: `ApiClient.listProjects()`, `ApiClient.createProject()`
- Produces: selected project state and creation flow for version/member/settings tasks

- [ ] **Step 1: Add capability placeholder**

`apps/web/src/shared/capabilities.ts`:

```ts
export const capabilities = {
  projectArchive: false,
  analytics: false,
  reports: false,
} as const;
```

- [ ] **Step 2: Port formatting and slug helpers**

Copy current formatting and project slug helpers from `packages/client/src/shared/format.ts`
and `packages/client/src/features/projects/slug.ts` into app-local files.

- [ ] **Step 3: Create `useProjects`**

Port `packages/client/src/features/projects/useProjects.ts`, remove desktop
notification usage, keep URL hash selection, and expose:

```ts
{
  projects,
  loading,
  selectedProject,
  pendingVersionId,
  selectProject,
  refresh,
  publishVersion,
  rollbackVersion,
  deleteVersion,
  onProjectDeleted,
}
```

- [ ] **Step 4: Create project dialog**

Port `CreateProjectDialog` to app-local UI primitives. On submit call
`api.createProject({ name, slug, description })`, close on success, and call
`onCreated(project)`.

- [ ] **Step 5: Make sidebar project-aware**

Change `AppSidebar` props to:

```ts
interface AppSidebarProps {
  projects: Project[];
  selectedProjectId: string | null;
  onSelectProject: (project: Project) => void;
  onCreateProject: () => void;
}
```

Render real projects. Render the archive section disabled when
`capabilities.projectArchive` is `false`.

- [ ] **Step 6: Verify**

Run: `bun --filter @deploykit/web typecheck`

Expected: PASS.

---

### Task 5: Versions And Upload Flow

**Files:**
- Create/replace: `apps/web/src/features/versions/VersionList.tsx`
- Create/replace: `apps/web/src/features/versions/VersionItem.tsx`
- Create: `apps/web/src/features/versions/UploadVersionDialog.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: selected `Project`, `pendingVersionId`, version action callbacks
- Produces: functional upload, preview, publish, rollback, and delete UI

- [ ] **Step 1: Convert web3 version model to shared domain model**

Replace web3 `VersionInfo` usage with `Version` from `@deploykit/shared`.
Derive:

```ts
const isLive = project.activeVersionId === version.id;
const previewUrl = `/deploy/${project.slug}/${version.id}/`;
const liveUrl = `/deploy/${project.slug}/`;
```

- [ ] **Step 2: Implement version row actions**

`VersionItem` props:

```ts
interface VersionItemProps {
  project: Project;
  version: Version;
  pending: boolean;
  readOnly: boolean;
  onPublish: (versionId: string) => void;
  onRollback: (versionId: string) => void;
  onDelete: (versionId: string) => void;
}
```

Show Preview, Set as Production, Rollback, and Delete. Disable mutating actions
when `readOnly` or `pending` is true.

- [ ] **Step 3: Implement upload dialog**

Port upload behavior from `packages/client/src/features/versions/UploadVersionDialog.tsx`.
Support one ZIP file or folder upload, pass `versionDesc`, and show upload
progress from `ApiClient.uploadVersion`.

- [ ] **Step 4: Verify**

Run: `bun --filter @deploykit/web typecheck`

Expected: PASS.

---

### Task 6: Members And Settings

**Files:**
- Create: `apps/web/src/features/members/AddMemberDialog.tsx`
- Create: `apps/web/src/features/members/MemberList.tsx`
- Create: `apps/web/src/features/members/TransferOwnershipDialog.tsx`
- Create: `apps/web/src/features/settings/ProjectSettingsForm.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: selected `Project`, current `SafeUser`, `ApiClient` member/settings methods
- Produces: functional members tab and settings tab

- [ ] **Step 1: Port member components**

Port member add, remove, and transfer logic from `packages/client/src/features/members`.
Keep owner-only actions and refresh after successful mutation.

- [ ] **Step 2: Port settings form**

Port settings update and project delete behavior from
`packages/client/src/features/settings/ProjectSettingsDialog.tsx`. Keep
`spaMode` and `routingType` fields exactly aligned with `Settings`.

- [ ] **Step 3: Wire project tabs**

Replace web3 mock `ProjectTabs` with real tabs:

```ts
type DetailTab = 'versions' | 'members' | 'settings';
```

Use versions, members, and settings content only. Do not keep functional
analytics or reports tabs in this replacement.

- [ ] **Step 4: Verify**

Run: `bun --filter @deploykit/web typecheck`

Expected: PASS.

---

### Task 7: Remove web3 Directory And Final Verification

**Files:**
- Delete: `apps/web3/`
- Modify as needed: root lockfile after dependency install

**Interfaces:**
- Consumes: fully migrated `apps/web`
- Produces: one production web app

- [ ] **Step 1: Remove `apps/web3`**

Delete the migrated source directory after `apps/web` builds.

- [ ] **Step 2: Install/update dependencies**

Run: `bun install`

Expected: lockfile updates only for dependencies needed by `apps/web`.

- [ ] **Step 3: Run focused checks**

Run:

```bash
bun --filter @deploykit/web typecheck
bun --filter @deploykit/web build
```

Expected: both PASS.

- [ ] **Step 4: Run root checks**

Run:

```bash
bun run typecheck
bun run build
```

Expected: both PASS, and build packages `apps/web/dist` into
`apps/server/public`.

- [ ] **Step 5: Review git diff**

Run:

```bash
git status --short
git diff --stat
```

Expected: changes are limited to the web replacement, plan/spec docs, and
dependency lockfile updates. Pre-existing unrelated changes are not reverted.

