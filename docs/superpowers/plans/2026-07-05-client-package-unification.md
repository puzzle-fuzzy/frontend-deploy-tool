# Client Package Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate two independent UI implementations (web app + desktop's client package) into one shared codebase in `packages/client`.

**Architecture:** Move all UI from `apps/web/src` into `packages/client/src`, replace the old client UI, wire web as a thin shell, and have desktop inherit the new UI automatically via its existing `<App />` import from `@deploykit/client`.

**Tech Stack:** React 19, shadcn/ui (base-ui primitives), Tailwind v4, i18next, Hono client, Vite, Biome

## Global Constraints

- Both `apps/web` and `packages/client` use `@/*` → `src/*` path aliases
- `@tabler/icons-react` icons in AppSidebar → replace with `lucide-react` equivalents (avoid new dep)
- Desktop's UploadVersionDialog has native bridge support (`useNative()`) — must be preserved when replacing with web version
- `erasableSyntaxOnly: true` in both web and client tsconfig — no TS enums, parameter properties, namespaces
- Run `bun run check:fix` after bulk file moves; `bun run typecheck` at each phase boundary
- Frequent commits — one per task

---

## File Structure Map

### Files MOVED from `apps/web/src/` into `packages/client/src/`

| Source (apps/web/src) | Destination (packages/client/src) |
|---|---|
| `components/AppHeader.tsx` | `components/AppHeader.tsx` |
| `components/AppLayout.tsx` | `components/AppLayout.tsx` |
| `components/AppSidebar.tsx` | `components/AppSidebar.tsx` |
| `components/DropdownMenuAvatar.tsx` | `components/DropdownMenuAvatar.tsx` |
| `components/ui/*` (18 files) | `components/ui/*` |
| `features/auth/LoginPage.tsx` | `features/auth/LoginPage.tsx` |
| `features/auth/useAuth.ts` | `features/auth/useAuth.ts` (merge w/ client) |
| `features/members/AddMemberDialog.tsx` | `features/members/AddMemberDialog.tsx` |
| `features/members/MemberList.tsx` | `features/members/MemberList.tsx` |
| `features/projects/CreateProjectDialog.tsx` | `features/projects/CreateProjectDialog.tsx` |
| `features/projects/slug.ts` | `features/projects/slug.ts` |
| `features/projects/useProjects.ts` | `features/projects/useProjects.ts` |
| `features/settings/ProjectSettingsForm.tsx` | `features/settings/ProjectSettingsForm.tsx` |
| `features/versions/UploadVersionDialog.tsx` | `features/versions/UploadVersionDialog.tsx` (merge native) |
| `features/versions/VersionList.tsx` | `features/versions/VersionList.tsx` |
| `features/versions/VersionStatusBadge.tsx` | `features/versions/VersionStatusBadge.tsx` |
| `hooks/use-mobile.ts` | `hooks/use-mobile.ts` |
| `lib/utils.ts` | `lib/utils.ts` |
| `shared/api/context.tsx` | (merge into `api/ApiClientProvider.tsx`) |
| `shared/api/fetch-client.ts` | (merge into `api/fetchApiClient.ts`) |
| `shared/api/errors.ts` | (skip — identical to `api/errors.ts`) |
| `shared/api/types.ts` | (skip — identical to `api/ApiClient.ts`) |
| `shared/capabilities.ts` | `shared/capabilities.ts` |
| `shared/format.ts` | `shared/format.ts` (identical; overwrite) |
| `shared/preferences.ts` | `shared/preferences.ts` |
| `shared/types.ts` | `shared/types.ts` (merge: add `ProjectMember`) |
| `i18n/index.ts` | (skip — merge translations into JSON locale files) |
| `index.css` | `index.css` (replace) |

### Files DELETED from `packages/client/src/`

- `pages/DeployPage.tsx`
- `shared/ui/*` (all 30 files)
- `features/auth/LoginPage.tsx` + `useAuth.ts` (old versions)
- `features/members/AddMemberDialog.tsx` + `MemberList.tsx` (old versions)
- `features/projects/` (old CreateProjectDialog, useProjects, slug, ProjectList)
- `features/settings/ProjectSettingsDialog.tsx`
- `features/versions/` (old UploadVersionDialog, VersionList)
- `shared/avatar.ts`, `shared/error-messages.ts`, `shared/ui/avatar-dropdown.tsx`

### Files KEPT in `packages/client/src/` (desktop-specific)

- `api/NativeBridge.ts`, `api/NativeProvider.tsx`, `api/ServerInfoProvider.tsx`
- `api/desktopAuth.ts`, `api/index.ts`
- `features/desktop-auth/DesktopAuthorizePage.tsx`
- `features/deploy/DeployUrl.tsx`
- `features/theme/ThemeToggle.tsx`, `features/theme/useTheme.ts`
- `features/i18n/LanguageToggle.tsx`
- `features/members/TransferOwnershipDialog.tsx`, `features/members/useUserCache.ts`
- `shared/config.ts`

### Files CHANGED in `apps/web/src/`

- `App.tsx` → thin shell that imports from `@deploykit/client`
- All other files → DELETED
- `main.tsx` → simplified entry
- `index.css` → minimal, delegates to client

### Files CHANGED in `apps/desktop/`

- `DesktopApp.tsx` → use shadcn/ui components for onboarding
- `index.css` → minimal, removes duplicate Tailwind setup
- `package.json` → remove redundant deps now provided by client

---

### Task 1: Prerequisites — add `@deploykit/client` dependency to web, align shared types

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/tsconfig.app.json`
- Modify: `packages/client/src/shared/types.ts`

**Interfaces:**
- Produces: `apps/web` can import from `@deploykit/client`; `ProjectMember` exported from `@deploykit/client/shared/types`

- [ ] **Step 1: Add `@deploykit/client` dependency to web**

Edit `apps/web/package.json`, add under `"dependencies"`:
```json
"@deploykit/client": "workspace:*",
```

- [ ] **Step 2: Add `ProjectMember` to client's shared/types.ts**

Edit `packages/client/src/shared/types.ts` — add `ProjectMember` to the re-exports:
```ts
export type {
  HistoryEvent,
  Project,
  ProjectMember,
  Role,
  SafeUser,
  Settings,
  Version,
  VersionSourceType,
  VersionStatus,
} from '@deploykit/shared';
```

- [ ] **Step 3: Install and verify**

```bash
bun install
bun run typecheck
```

Expected: PASS — web can now resolve `@deploykit/client`, and `ProjectMember` is available.

- [ ] **Step 4: Commit**

```bash
git add apps/web/package.json bun.lock packages/client/src/shared/types.ts
git commit -m "chore: add @deploykit/client dep to web, export ProjectMember type

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: CSS & theme — replace client CSS with web's

**Files:**
- Replace: `packages/client/src/index.css` ← `apps/web/src/index.css`
- Delete: `packages/client/src/shared/ui/index.css` (if exists)

**Interfaces:**
- Produces: `packages/client` has the canonical CSS: neutral theme, Geist font, 0.5rem radius, sidebar bg extension, button cursor-pointer

- [ ] **Step 1: Copy web CSS to client**

```bash
cp apps/web/src/index.css packages/client/src/index.css
```

- [ ] **Step 2: Add `@source` directive for client package scanning**

The web CSS imports `@fontsource-variable/geist`. The client package doesn't depend on this yet. Remove the Geist font import and replace with system sans-serif since `packages/client` doesn't have `@fontsource-variable/geist` as a dep.

Actually — add the dep instead. This keeps the font consistent.

```bash
cd packages/client && bun add @fontsource-variable/geist
```

- [ ] **Step 3: Verify typecheck and web dev server**

```bash
bun run typecheck
cd apps/web && bun run dev &
# Visually confirm: same appearance as before
```

Expected: Web renders with same theme as before (now loading CSS from client package).

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/index.css packages/client/package.json bun.lock
git commit -m "feat: replace client CSS with web theme (neutral, Geist, smaller radius)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: shadcn/ui components — move from web to client

**Files:**
- Create: `packages/client/src/lib/utils.ts` (from `apps/web/src/lib/utils.ts`)
- Create: `packages/client/src/components/ui/avatar.tsx` through `tooltip.tsx` (18 files from `apps/web/src/components/ui/`)
- Delete: `packages/client/src/shared/ui/*` (all files)
- Modify: `packages/client/src/shared/utils.ts` → remove (replaced by `lib/utils.ts`)

**Interfaces:**
- Produces: `@/components/ui/*` available in client; `cn()` from `@/lib/utils`

- [ ] **Step 1: Create lib directory and copy cn utility**

```bash
mkdir -p packages/client/src/lib
cp apps/web/src/lib/utils.ts packages/client/src/lib/utils.ts
```

- [ ] **Step 2: Copy all shadcn/ui components**

```bash
mkdir -p packages/client/src/components/ui
cp apps/web/src/components/ui/*.tsx packages/client/src/components/ui/
```

- [ ] **Step 3: Delete old shared/ui directory**

```bash
rm -rf packages/client/src/shared/ui
rm packages/client/src/shared/utils.ts
```

- [ ] **Step 4: Update imports in moved UI components**

The web's components import from `@/lib/utils`. Since `packages/client` also has `@/*` → `src/*`, these imports resolve correctly. No changes needed.

Verify one component has correct paths:
```bash
head -5 packages/client/src/components/ui/button.tsx
```

- [ ] **Step 5: Update client package exports**

Edit `packages/client/src/index.ts`:
```ts
export { default as App } from './App';
export * from './api';
export { cn } from './lib/utils';
```

- [ ] **Step 6: Verify typecheck**

```bash
bun run typecheck
```

Expected: PASS. No residual imports from deleted `shared/ui/` or `shared/utils.ts`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: move shadcn/ui components from web to client, delete old shared/ui

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Supporting files — hooks, shared utilities, capabilities, preferences

**Files:**
- Create: `packages/client/src/hooks/use-mobile.ts`
- Create: `packages/client/src/shared/capabilities.ts`
- Create: `packages/client/src/shared/preferences.ts`
- Modify: `packages/client/src/shared/format.ts` (already identical, but overwrite to be safe)

**Interfaces:**
- Produces: `useIsMobile()`, `capabilities` object, `useThemePreference()`, `useLanguagePreference()`

- [ ] **Step 1: Copy files**

```bash
mkdir -p packages/client/src/hooks
cp apps/web/src/hooks/use-mobile.ts packages/client/src/hooks/use-mobile.ts
cp apps/web/src/shared/capabilities.ts packages/client/src/shared/capabilities.ts
cp apps/web/src/shared/preferences.ts packages/client/src/shared/preferences.ts
```

- [ ] **Step 2: Verify typecheck**

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/hooks packages/client/src/shared/capabilities.ts packages/client/src/shared/preferences.ts
git commit -m "feat: add hooks, capabilities, preferences to client package

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: i18n — merge web translations into client JSON locales

**Files:**
- Modify: `packages/client/src/i18n/locales/en.json`
- Modify: `packages/client/src/i18n/locales/zh.json`
- Modify: `packages/client/src/i18n/index.ts` (add languageChanged handler)

**Interfaces:**
- Produces: Unified translation keys covering both web and desktop needs

- [ ] **Step 1: Merge English translations**

The web's inline TS has keys that the client JSON is missing: `app.projectSubtitle`, `app.noProjects`, `app.more`, `app.archive`, `app.archivedProjects`, updated `projects.*` values, `create.*`, `members.*`, `settings.*`.

Replace `packages/client/src/i18n/locales/en.json` with a merged version — keep ALL existing client keys (desktop needs `history`, `upload`, `error`, `auth.desktopAuth`, `auth.roles`) and add/update the web's keys:

```json
{
  "app": {
    "title": "DeployKit",
    "projects": "Projects",
    "projectSubtitle": "Deploy and manage static frontend artifacts.",
    "projectCount": "{{count}} project(s)",
    "newProject": "New Project",
    "archive": "Archive",
    "archivedProjects": "Archived projects",
    "noProjects": "No projects",
    "more": "More",
    "history": "History",
    "settings": "Settings"
  },
  "auth": {
    "subtitle": "Sign in to manage deployments",
    "registerSubtitle": "Create an account to continue",
    "email": "Email",
    "password": "Password",
    "name": "Name",
    "signIn": "Sign in",
    "register": "Register",
    "logout": "Log out",
    "failed": "Authentication failed",
    "invalid": "Invalid email or password",
    "registerFailed": "Registration failed",
    "namePlaceholder": "Your name",
    "emailPlaceholder": "you@example.com",
    "passwordPlaceholder": "Password",
    "goToRegister": "Don't have an account? Register",
    "goToLogin": "Already have an account? Sign in",
    "desktopAuth": {
      "title": "Authorize desktop client",
      "desc": "Grant the DeployKit desktop app access to your account.",
      "authorize": "Authorize",
      "authorizing": "Authorizing…",
      "signedInAs": "Signed in as {{email}}",
      "notYou": "Use a different account",
      "missingCallback": "Missing callback URL.",
      "failed": "Authorization failed"
    },
    "roles": {
      "admin": "Admin",
      "developer": "Developer",
      "viewer": "Viewer"
    }
  },
  "common": {
    "loading": "Loading...",
    "refresh": "Refresh",
    "cancel": "Cancel",
    "create": "Create",
    "creating": "Creating...",
    "save": "Save changes",
    "saving": "Saving...",
    "delete": "Delete",
    "deleting": "Deleting...",
    "failed": "Failed",
    "copy": "Copy",
    "copied": "Copied",
    "confirm": "Confirm",
    "deleteProjectConfirm": "Delete project \"{{name}}\" and all its versions?",
    "deleteVersionConfirm": "Delete version \"{{name}}\"?",
    "publishVersionConfirm": "Publish version \"{{name}}\" to production?",
    "rollbackVersionConfirm": "Roll production back to version \"{{name}}\"?",
    "created": "Created",
    "saved": "Saved",
    "deleted": "Deleted",
    "uploaded": "Upload successful",
    "activated": "Set as production",
    "published": "Published to production",
    "rolledBack": "Rolled back",
    "copyFailed": "Copy failed",
    "close": "Close"
  },
  "preferences": {
    "switchToEnglish": "Switch to English",
    "switchToChinese": "切换成中文",
    "lightTheme": "Switch to light theme",
    "darkTheme": "Switch to dark theme"
  },
  "projects": {
    "title": "Projects",
    "empty": "No projects yet",
    "emptyDesc": "Create your first project to upload a build artifact.",
    "updated": "Updated {{date}}",
    "versions": "{{count}} version(s)",
    "production": "Production",
    "notLive": "Not live"
  },
  "create": {
    "title": "New project",
    "desc": "Create a deployment target for static frontend artifacts.",
    "name": "Name",
    "slug": "Slug",
    "description": "Description",
    "namePlaceholder": "e.g. Marketing Site",
    "slugPlaceholder": "e.g. marketing-site",
    "descPlaceholder": "Optional notes about this project"
  },
  "versions": {
    "title": "Versions",
    "empty": "Upload a ZIP or build folder to create the first version.",
    "upload": "Upload version",
    "uploadDesc": "Upload a ZIP file or select a build folder.",
    "description": "Description",
    "descriptionPlaceholder": "Release notes or build label",
    "zipArtifact": "ZIP artifact",
    "buildFolder": "Build folder",
    "uploading": "Uploading...",
    "preview": "Preview",
    "setProduction": "Set as production",
    "rollback": "Rollback",
    "delete": "Delete",
    "previewStatus": "Preview",
    "productionStatus": "Production",
    "archivedStatus": "Archived",
    "failedStatus": "Failed",
    "files": "{{count}} files",
    "live": "Live",
    "notLive": "Not live",
    "deployUrl": "Deploy URL",
    "deployHint": "Set a version as production to access via this URL",
    "sourceZip": "ZIP",
    "sourceFolder": "Folder",
    "sourceUnknown": "Unknown",
    "meta": "{{source}} · {{size}} · {{count}} file(s)"
  },
  "upload": {
    "title": "Upload New Version",
    "dropzone": "Drop .zip file here",
    "dropzoneDesc": "Max 500MB. Supported: .zip or folder upload",
    "selectedFiles": "{{count}} file(s)",
    "selectZip": "Select .zip",
    "selectFolder": "Select Folder",
    "releaseNotes": "Release Notes",
    "releaseNotesPlaceholder": "Describe the changes in this build...",
    "cancel": "Cancel",
    "submit": "Initiate Deployment"
  },
  "members": {
    "title": "Members",
    "desc": "Manage project access.",
    "add": "Add member",
    "addTitle": "Add member",
    "addDesc": "Invite an existing user by email and assign their project role.",
    "role": "Role",
    "searchPlaceholder": "user@example.com",
    "member": "Member",
    "owner": "Owner",
    "remove": "Remove member",
    "transfer": "Transfer",
    "none": "No project members are recorded yet.",
    "actionFailed": "Member action failed",
    "you": "You",
    "invited": "Invited {{date}}",
    "transferTitle": "Transfer Ownership",
    "selectTarget": "Select a member…",
    "noResults": "No users found"
  },
  "settings": {
    "title": "Settings",
    "desc": "Update project metadata and serving behavior.",
    "projectTitle": "Project Settings",
    "projectDesc": "Configure deployment behavior",
    "projectInfo": "Project information",
    "selectProject": "Select Project",
    "selectProjectPlaceholder": "Choose a project...",
    "spaMode": "SPA fallback mode",
    "routingType": "Routing type",
    "routingHash": "Hash routing",
    "routingPath": "Path routing",
    "deleteProject": "Delete project",
    "deleteProjectConfirm": "Delete project \"{{name}}\"?",
    "save": "Save Settings",
    "saved": "Settings saved",
    "dangerZone": "Danger Zone",
    "deleteProjectDesc": "Remove project and all versions. This cannot be undone"
  },
  "history": {
    "title": "History",
    "desc": "Deployment event log across all projects",
    "empty": "No events yet",
    "emptyDesc": "Events will appear when you create projects or upload versions",
    "project.create": "Project created",
    "project.update": "Project updated",
    "project.update_settings": "Settings updated",
    "project.delete": "Project deleted",
    "version.upload": "Version uploaded",
    "version.publish": "Version published",
    "version.activate": "Set as production",
    "version.rollback": "Rolled back",
    "version.delete": "Version deleted",
    "toProject": "to project",
    "ofProject": "of project"
  },
  "error": {
    "unauthorized": "Authentication required",
    "invalidCredentials": "Invalid email or password",
    "emailAlreadyExists": "Email is already registered",
    "registrationDisabled": "Registration is disabled",
    "forbidden": "You don't have permission to do that",
    "notAMember": "You are not a member of this project",
    "alreadyMember": "User is already a member",
    "cannotRemoveLastOwner": "Cannot remove the last owner",
    "userNotFound": "No user found with that email",
    "projectNotFound": "Project not found",
    "slugTaken": "This slug is already taken",
    "versionNotFound": "Version not found",
    "tooManyFiles": "Too many files",
    "pathTooLong": "File path is too long",
    "extractedTooLarge": "Total file size is too large",
    "zipTooLarge": "Zip file is too large",
    "internalError": "Internal server error"
  }
}
```

- [ ] **Step 2: Merge Chinese translations**

Replace `packages/client/src/i18n/locales/zh.json` with merged version — same merging logic:

```json
{
  "app": {
    "title": "DeployKit",
    "projects": "项目",
    "projectSubtitle": "部署并管理静态前端构建产物。",
    "projectCount": "{{count}} 个项目",
    "newProject": "新建项目",
    "archive": "归档",
    "archivedProjects": "已归档项目",
    "noProjects": "暂无项目",
    "more": "更多",
    "history": "历史记录",
    "settings": "设置"
  },
  "auth": {
    "subtitle": "登录以管理部署",
    "registerSubtitle": "创建账户以继续",
    "email": "邮箱",
    "password": "密码",
    "name": "姓名",
    "signIn": "登录",
    "register": "注册",
    "logout": "退出登录",
    "failed": "认证失败",
    "invalid": "邮箱或密码错误",
    "registerFailed": "注册失败",
    "namePlaceholder": "你的姓名",
    "emailPlaceholder": "you@example.com",
    "passwordPlaceholder": "密码",
    "goToRegister": "没有账户？注册",
    "goToLogin": "已有账户？登录",
    "desktopAuth": {
      "title": "授权桌面客户端",
      "desc": "允许 DeployKit 桌面端访问你的账户。",
      "authorize": "授权",
      "authorizing": "授权中…",
      "signedInAs": "已登录：{{email}}",
      "notYou": "切换账户",
      "missingCallback": "缺少回调地址。",
      "failed": "授权失败"
    },
    "roles": {
      "admin": "管理员",
      "developer": "开发者",
      "viewer": "只读用户"
    }
  },
  "common": {
    "loading": "加载中...",
    "refresh": "刷新",
    "cancel": "取消",
    "create": "创建",
    "creating": "创建中...",
    "save": "保存修改",
    "saving": "保存中...",
    "delete": "删除",
    "deleting": "删除中...",
    "failed": "操作失败",
    "copy": "复制",
    "copied": "已复制",
    "confirm": "确认",
    "deleteProjectConfirm": "确定删除项目「{{name}}」及其所有版本？",
    "deleteVersionConfirm": "确定删除版本「{{name}}」？",
    "publishVersionConfirm": "确定将版本「{{name}}」发布到正式环境？",
    "rollbackVersionConfirm": "确定将正式环境回滚到版本「{{name}}」？",
    "created": "已创建",
    "saved": "已保存",
    "deleted": "已删除",
    "uploaded": "上传成功",
    "activated": "已设为正式",
    "published": "已发布到正式环境",
    "rolledBack": "已回滚",
    "copyFailed": "复制失败",
    "close": "关闭"
  },
  "preferences": {
    "switchToEnglish": "Switch to English",
    "switchToChinese": "切换成中文",
    "lightTheme": "切换日间主题",
    "darkTheme": "切换夜间主题"
  },
  "projects": {
    "title": "项目列表",
    "empty": "暂无项目",
    "emptyDesc": "创建第一个项目后即可上传构建产物。",
    "updated": "更新于 {{date}}",
    "versions": "{{count}} 个版本",
    "production": "正式版本",
    "notLive": "未上线"
  },
  "create": {
    "title": "新建项目",
    "desc": "创建一个用于部署静态前端产物的目标。",
    "name": "项目名称",
    "slug": "项目标识",
    "description": "项目描述",
    "namePlaceholder": "例如：官网",
    "slugPlaceholder": "例如：official-site",
    "descPlaceholder": "可选的项目说明"
  },
  "versions": {
    "title": "版本列表",
    "empty": "上传 ZIP 或构建文件夹来创建第一个版本。",
    "upload": "上传版本",
    "uploadDesc": "上传 ZIP 文件或选择构建文件夹。",
    "description": "版本说明",
    "descriptionPlaceholder": "描述本次构建的变更或标签",
    "zipArtifact": "ZIP 产物",
    "buildFolder": "构建文件夹",
    "uploading": "上传中...",
    "preview": "预览",
    "setProduction": "设为正式",
    "rollback": "回滚",
    "delete": "删除",
    "previewStatus": "预览",
    "productionStatus": "正式版本",
    "archivedStatus": "已归档",
    "failedStatus": "失败",
    "files": "{{count}} 个文件",
    "live": "已上线",
    "notLive": "未上线",
    "deployUrl": "部署地址",
    "deployHint": "设为正式版本后可通过此地址访问",
    "sourceZip": "ZIP",
    "sourceFolder": "文件夹",
    "sourceUnknown": "未知",
    "meta": "{{source}} · {{size}} · {{count}} 个文件"
  },
  "upload": {
    "title": "上传新版本",
    "dropzone": "拖拽 .zip 文件到此处",
    "dropzoneDesc": "最大 500MB，支持 .zip 或文件夹上传",
    "selectedFiles": "{{count}} 个文件",
    "selectZip": "选择 .zip",
    "selectFolder": "选择文件夹",
    "releaseNotes": "版本说明",
    "releaseNotesPlaceholder": "描述本次构建的变更...",
    "cancel": "取消",
    "submit": "开始部署"
  },
  "members": {
    "title": "成员",
    "desc": "管理项目访问权限。",
    "add": "添加成员",
    "addTitle": "添加成员",
    "addDesc": "通过邮箱邀请已有用户并分配项目角色。",
    "role": "角色",
    "searchPlaceholder": "user@example.com",
    "member": "成员",
    "owner": "拥有者",
    "remove": "移除成员",
    "transfer": "转让",
    "none": "暂无项目成员记录。",
    "actionFailed": "成员操作失败",
    "you": "你",
    "invited": "邀请于 {{date}}",
    "transferTitle": "转让所有权",
    "selectTarget": "选择成员…",
    "noResults": "未找到用户"
  },
  "settings": {
    "title": "设置",
    "desc": "更新项目元信息和部署访问行为。",
    "projectTitle": "项目设置",
    "projectDesc": "配置部署行为",
    "projectInfo": "项目信息",
    "selectProject": "选择项目",
    "selectProjectPlaceholder": "选择一个项目...",
    "spaMode": "SPA 回退模式",
    "routingType": "路由类型",
    "routingHash": "Hash 路由",
    "routingPath": "路径路由",
    "deleteProject": "删除项目",
    "deleteProjectConfirm": "确定删除项目「{{name}}」？",
    "save": "保存设置",
    "saved": "设置已保存",
    "dangerZone": "危险操作",
    "deleteProjectDesc": "移除项目及所有版本，此操作不可撤销"
  },
  "history": {
    "title": "历史记录",
    "desc": "所有项目的部署操作日志",
    "empty": "暂无记录",
    "emptyDesc": "创建项目或上传版本后，操作记录将显示在此处",
    "project.create": "创建了项目",
    "project.update": "更新了项目",
    "project.update_settings": "更新了设置",
    "project.delete": "删除了项目",
    "version.upload": "上传了版本",
    "version.publish": "发布了版本",
    "version.activate": "将版本设为正式",
    "version.rollback": "回滚了版本",
    "version.delete": "删除了版本",
    "toProject": "到项目",
    "ofProject": "的项目"
  },
  "error": {
    "unauthorized": "需要登录",
    "invalidCredentials": "邮箱或密码错误",
    "emailAlreadyExists": "该邮箱已注册",
    "registrationDisabled": "注册已关闭",
    "forbidden": "没有操作权限",
    "notAMember": "你不是此项目的成员",
    "alreadyMember": "该用户已是成员",
    "cannotRemoveLastOwner": "不能移除最后一个拥有者",
    "userNotFound": "未找到此邮箱的用户",
    "projectNotFound": "项目未找到",
    "slugTaken": "该标识符已被占用",
    "versionNotFound": "版本未找到",
    "tooManyFiles": "文件数量过多",
    "pathTooLong": "文件路径过长",
    "extractedTooLarge": "解压后总大小超过限制",
    "zipTooLarge": "压缩包大小超过限制",
    "internalError": "服务器内部错误"
  }
}
```

- [ ] **Step 3: Add languageChanged handler to client i18n init**

Edit `packages/client/src/i18n/index.ts` — add after `i18n.init(...)`:

```ts
i18n.on('languageChanged', (language) => {
  document.documentElement.lang = language.startsWith('zh') ? 'zh-CN' : 'en';
});

document.documentElement.lang = i18n.language.startsWith('zh') ? 'zh-CN' : 'en';
```

- [ ] **Step 4: Verify typecheck**

```bash
bun run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/i18n/
git commit -m "feat: merge web translations into client JSON locale files

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Layout shell — AppLayout, AppSidebar, AppHeader, DropdownMenuAvatar

**Files:**
- Create: `packages/client/src/components/AppLayout.tsx`
- Create: `packages/client/src/components/AppSidebar.tsx`
- Create: `packages/client/src/components/AppHeader.tsx`
- Create: `packages/client/src/components/DropdownMenuAvatar.tsx`

**Interfaces:**
- Produces: `<AppLayout>` renders sidebar + main content area; `<AppSidebar>` renders project list sidebar; `<AppHeader>` renders top bar with avatar dropdown; `<DropdownMenuAvatar>` renders the user menu

- [ ] **Step 1: Copy component files**

```bash
cp apps/web/src/components/AppLayout.tsx packages/client/src/components/AppLayout.tsx
cp apps/web/src/components/AppSidebar.tsx packages/client/src/components/AppSidebar.tsx
cp apps/web/src/components/AppHeader.tsx packages/client/src/components/AppHeader.tsx
cp apps/web/src/components/DropdownMenuAvatar.tsx packages/client/src/components/DropdownMenuAvatar.tsx
```

- [ ] **Step 2: Replace @tabler/icons-react imports with lucide-react**

Edit `packages/client/src/components/AppSidebar.tsx`:

Change the import:
```tsx
import {
  IconArchive,
  IconBox,
  IconDots,
  IconFolderOpen,
  IconPlus,
} from '@tabler/icons-react';
```
to:
```tsx
import { Archive, Box, Ellipsis, FolderOpen, Plus } from 'lucide-react';
```

And update all usages in the JSX:
- `<IconFolderOpen />` → `<FolderOpen />`
- `<IconPlus />` → `<Plus />`
- `<IconBox />` → `<Box />`
- `<IconArchive />` → `<Archive />`
- `<IconDots />` → `<Ellipsis />`

- [ ] **Step 3: Update imports in moved components**

Each moved component imports from `@/components/ui/*`, `@/shared/*`, etc. Since the client package has the same `@/*` alias, no path changes needed. But verify:

```bash
grep -n "from '@/" packages/client/src/components/AppLayout.tsx
grep -n "from '@/" packages/client/src/components/AppSidebar.tsx
```

These resolve to `packages/client/src/...` which is correct.

- [ ] **Step 4: Verify typecheck**

```bash
bun run typecheck
```

Expected: PASS. If errors about `@tabler/icons-react` references remain, fix them.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/components/
git commit -m "feat: add layout shell components (AppLayout, AppSidebar, AppHeader)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Rewrite App.tsx in client to use new sidebar layout

**Files:**
- Modify: `packages/client/src/App.tsx`
- Delete: `packages/client/src/pages/DeployPage.tsx`

**Interfaces:**
- Produces: `<App />` renders the full workspace with sidebar layout; `<App />` takes no props (uses `useAuth()` internally)

- [ ] **Step 1: Delete the old DeployPage**

```bash
rm packages/client/src/pages/DeployPage.tsx
```

- [ ] **Step 2: Rewrite App.tsx**

The new `App.tsx` needs to be a self-contained entry point that includes:
- i18n init
- CSS import
- Auth state management
- Project workspace with sidebar layout
- Desktop auth page handling

The current `apps/web/src/App.tsx` has the full logic. Adapt it to work as a shared entry point. The key difference: the web's `App` wraps in `ApiClientProvider` externally, while the client's `App` wraps internally. Actually, `ApiClientProvider` needs to be external (so desktop can provide IPC client and web can provide fetch client). So the new `App.tsx` should NOT include `ApiClientProvider` — that stays in the app shells.

Write the new `packages/client/src/App.tsx`:

```tsx
import './i18n';
import './index.css';
import { Loader2 } from 'lucide-react';
import { DesktopAuthorizePage } from './features/auth/DesktopAuthorizePage';
import { LoginPage } from './features/auth/LoginPage';
import { useAuth } from './features/auth/useAuth';
import { ProjectWorkspace } from './features/projects/ProjectWorkspace';

export default function App() {
  const { user, loading, login, register, logout } = useAuth();

  const isDesktopAuth =
    typeof window !== 'undefined' &&
    window.location.pathname === '/desktop-auth';

  if (isDesktopAuth) {
    return <DesktopAuthorizePage />;
  }

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) {
    return <LoginPage onLogin={login} onRegister={register} />;
  }

  return <ProjectWorkspace user={user} onLogout={logout} />;
}
```

Note: `ProjectWorkspace` needs to be created — it's currently inline in `apps/web/src/App.tsx`. We'll extract it in Task 8.

- [ ] **Step 3: Verify App.tsx is structurally sound**

At this point `ProjectWorkspace` doesn't exist yet, so typecheck will fail on that import. This is expected — Task 8 creates it.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/App.tsx
git commit -m "feat: rewrite client App.tsx to use new sidebar layout shell

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Features — move project workspace and all feature components

**Files:**
- Create: `packages/client/src/features/projects/ProjectWorkspace.tsx` (extracted from web's `App.tsx`)
- Create: `packages/client/src/features/projects/CreateProjectDialog.tsx`
- Create: `packages/client/src/features/projects/useProjects.ts`
- Create: `packages/client/src/features/projects/slug.ts`
- Create: `packages/client/src/features/auth/LoginPage.tsx` (overwrite old)
- Create: `packages/client/src/features/auth/useAuth.ts` (overwrite old)
- Create: `packages/client/src/features/members/AddMemberDialog.tsx` (overwrite old)
- Create: `packages/client/src/features/members/MemberList.tsx` (overwrite old)
- Create: `packages/client/src/features/settings/ProjectSettingsForm.tsx`
- Create: `packages/client/src/features/versions/VersionList.tsx`
- Create: `packages/client/src/features/versions/VersionStatusBadge.tsx`
- Delete: `packages/client/src/features/projects/ProjectList.tsx`
- Delete: `packages/client/src/features/settings/ProjectSettingsDialog.tsx`
- Modify: `packages/client/src/features/versions/UploadVersionDialog.tsx` (merge native bridge into web's version)

**Interfaces:**
- Produces: All feature components available from `@deploykit/client`

- [ ] **Step 1: Copy feature files from web**

```bash
# Auth
cp apps/web/src/features/auth/LoginPage.tsx packages/client/src/features/auth/LoginPage.tsx
cp apps/web/src/features/auth/useAuth.ts packages/client/src/features/auth/useAuth.ts

# Projects
cp apps/web/src/features/projects/CreateProjectDialog.tsx packages/client/src/features/projects/CreateProjectDialog.tsx
cp apps/web/src/features/projects/useProjects.ts packages/client/src/features/projects/useProjects.ts
cp apps/web/src/features/projects/slug.ts packages/client/src/features/projects/slug.ts

# Members
cp apps/web/src/features/members/AddMemberDialog.tsx packages/client/src/features/members/AddMemberDialog.tsx
cp apps/web/src/features/members/MemberList.tsx packages/client/src/features/members/MemberList.tsx

# Settings
cp apps/web/src/features/settings/ProjectSettingsForm.tsx packages/client/src/features/settings/ProjectSettingsForm.tsx

# Versions
cp apps/web/src/features/versions/VersionList.tsx packages/client/src/features/versions/VersionList.tsx
cp apps/web/src/features/versions/VersionStatusBadge.tsx packages/client/src/features/versions/VersionStatusBadge.tsx
```

- [ ] **Step 2: Delete old client feature files**

```bash
rm packages/client/src/features/projects/ProjectList.tsx
rm packages/client/src/features/settings/ProjectSettingsDialog.tsx
rm packages/client/src/features/members/useUserCache.ts  # no longer needed
```

- [ ] **Step 3: Update imports in moved feature files**

The web's feature files import from `@/components/ui/*`, `@/shared/*`, `@/features/*`, `@/hooks/*`. Since client has same `@/*` alias, these resolve correctly. However:

- Web's `useAuth` imports from `@/shared/api/context` → needs to import from `@/api/ApiClientProvider` in client
- Web's `useProjects` imports from `@/shared/api/context` → same fix
- Web's feature components import from `@/shared/api/context` → same fix

Edit all feature files that import from `@/shared/api/context` to use `@/api/ApiClientProvider`:

Files to update:
- `packages/client/src/features/auth/useAuth.ts`: change `from '@/shared/api/context'` to `from '@/api/ApiClientProvider'`
- `packages/client/src/features/projects/useProjects.ts`: same change
- `packages/client/src/features/members/AddMemberDialog.tsx`: same change
- `packages/client/src/features/members/MemberList.tsx`: same change
- `packages/client/src/features/settings/ProjectSettingsForm.tsx`: same change
- `packages/client/src/features/versions/UploadVersionDialog.tsx`: same change
- `packages/client/src/features/versions/VersionList.tsx`: same change

- [ ] **Step 4: Merge native upload into UploadVersionDialog**

The web's `UploadVersionDialog.tsx` doesn't support native bridge. Merge the desktop's native upload feature from the old client version.

Read the old `packages/client/src/features/versions/UploadVersionDialog.tsx` (before deleting — it's already deleted in step 2. Actually, I haven't told them to delete the old one yet — the old UploadVersionDialog IS at that path).

Actually, the web's version was already copied over it in step 1. We need to re-add the native bridge support.

The key additions from the old desktop version:
1. `import { useNative } from '@deploykit/client';` (or `@/api/NativeProvider`)
2. `const native = useNative();`
3. A "Pick directory" button when native is available
4. Native upload path in `handleSubmit`

Modify the web's UploadVersionDialog.tsx (now at `packages/client/src/features/versions/UploadVersionDialog.tsx`):

Add after `const api = useApiClient();`:
```tsx
import { useNative } from '@/api/NativeProvider';
// ...inside component:
const native = useNative();
```

In the JSX, add a third button for native directory picker (only when `native` is truthy), between the folder select and the progress bar. Also add `nativeDir` state and native upload path in `handleSubmit`. Reference the old dialog's logic for exact implementation.

- [ ] **Step 5: Create ProjectWorkspace component**

Extract the `ProjectWorkspace` + `ProjectList` + `ProjectDetail` components from `apps/web/src/App.tsx:83-393` into `packages/client/src/features/projects/ProjectWorkspace.tsx`. This is the main content area that uses `AppLayout`.

```bash
# This is a new file — write it manually
```

The component wraps `AppLayout` and contains all the page-level logic. Import path adjustments:
- `@/components/AppLayout` stays the same
- All other `@/` imports stay the same

- [ ] **Step 6: Verify typecheck**

```bash
bun run typecheck
```

Fix any residual import errors.

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/features/
git commit -m "feat: move all feature components from web to client

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Wire up web app as thin shell

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/main.tsx`
- Delete: all moved files from `apps/web/src/`

**Interfaces:**
- Produces: Web app bootstraps via `<App />` from `@deploykit/client`

- [ ] **Step 1: Rewrite web's main.tsx**

```tsx
/// <reference types="vite/client" />
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, ApiClientProvider, createFetchApiClient } from '@deploykit/client';
import './index.css';

const client = createFetchApiClient();

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root was not found.');

createRoot(root).render(
  <StrictMode>
    <ApiClientProvider client={client}>
      <App />
    </ApiClientProvider>
  </StrictMode>
);
```

- [ ] **Step 2: Rewrite web's App.tsx**

```tsx
// This file is no longer needed — App comes from @deploykit/client.
// Keep as a re-export if needed, or delete entirely.
```

Actually, delete `apps/web/src/App.tsx` — main.tsx imports directly from `@deploykit/client`.

- [ ] **Step 3: Simplify web's index.css**

Replace with a minimal file that imports the client CSS:

```css
@import '@deploykit/client/index.css';
```

Wait — this won't work because Tailwind v4 processes CSS at build time. The web's `index.css` must still have the Tailwind imports since it's the entry point that Vite processes. The client's CSS file is imported by the client's `App.tsx` (via `'./index.css'`), which gets bundled when web imports `<App />`.

So web's `index.css` can be empty or just contain any web-specific overrides. Let's keep it minimal:

```css
/* Web-specific overrides (if any). Theme is in @deploykit/client. */
```

Actually, it can be completely empty. The Tailwind styles come from `@deploykit/client`'s CSS which is imported in its `App.tsx`.

But wait — we need `@tailwindcss/vite` to still scan all the source files for class names. That's configured in `vite.config.ts`, not CSS. So an empty `index.css` is fine.

- [ ] **Step 4: Delete all moved files from web**

```bash
rm -rf apps/web/src/components/
rm -rf apps/web/src/features/
rm -rf apps/web/src/hooks/
rm -rf apps/web/src/i18n/
rm -rf apps/web/src/lib/
rm -rf apps/web/src/shared/api/
rm -f apps/web/src/shared/capabilities.ts
rm -f apps/web/src/shared/format.ts
rm -f apps/web/src/shared/preferences.ts
rm -f apps/web/src/shared/types.ts
rm -f apps/web/src/App.tsx
```

- [ ] **Step 5: Verify web builds and runs**

```bash
cd apps/web && bun run dev &
# Open http://localhost:5018
# Verify: sidebar, project list, version upload, member management all work
```

- [ ] **Step 6: Run full typecheck and tests**

```bash
bun run typecheck
bun run test
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: wire up web app as thin shell, import from @deploykit/client

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: Wire up desktop — update DesktopApp.tsx, clean up CSS

**Files:**
- Modify: `apps/desktop/src/renderer/DesktopApp.tsx`
- Modify: `apps/desktop/src/renderer/index.css`
- Modify: `apps/desktop/src/renderer/main.tsx`
- Modify: `apps/desktop/package.json` (remove redundant deps)

**Interfaces:**
- Produces: Desktop app renders `<App />` from `@deploykit/client` with IPC client

- [ ] **Step 1: Rewrite desktop's index.css**

The desktop renderer loads `@deploykit/client`'s CSS via its `App` import. Its own CSS just needs font-face (if keeping JetBrainsMapleMono) or can be empty. Switch to Geist for consistency:

```css
/* Desktop inherits all styles from @deploykit/client. */
```

Empty file is fine — remove the duplicate Tailwind imports.

- [ ] **Step 2: Update desktop's main.tsx**

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
  </StrictMode>
);
```

(No real changes needed — it already imports `DesktopApp`.)

- [ ] **Step 3: Update DesktopApp.tsx — use shadcn/ui components for onboarding**

Replace the raw HTML in `Onboarding` and `LoginGate` components with shadcn/ui components imported from `@deploykit/client`:

```tsx
import { Button, Input, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@deploykit/client';
// Or use the direct paths if not re-exported:
// import { Button } from '@deploykit/client/components/ui/button';
```

Better: add UI component exports to `packages/client/src/index.ts`:

```ts
export { Button } from './components/ui/button';
export { Input } from './components/ui/input';
export { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card';
```

Then in `DesktopApp.tsx`, update the `Onboarding` form:

```tsx
function Onboarding({ onSubmit, error }: { onSubmit: (url: string) => void; error: string | null }) {
  const [url, setUrl] = useState('http://localhost:3000');
  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Connect to DeployKit</CardTitle>
          <CardDescription>Enter your DeployKit server URL</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void onSubmit(url); }}>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://deploy.example.com" />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit">Connect</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
```

Similarly for `LoginGate` — replace raw `<input>` / `<button>` with `<Input>` / `<Button>`. Keep the "Sign in via web page" functionality.

The `LoginGate` can import `LoginPage` from `@deploykit/client` for the login form, then add the web-login button below it.

- [ ] **Step 4: Remove redundant desktop dependencies**

Check `apps/desktop/package.json` — the desktop app likely has its own `@base-ui/react`, `lucide-react`, etc. that are now provided transitively through `@deploykit/client`. Remove any that are no longer directly imported.

- [ ] **Step 5: Verify desktop compiles**

```bash
cd apps/desktop && bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/ packages/client/src/index.ts
git commit -m "feat: wire up desktop with shadcn/ui onboarding, shared client UI

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: Final cleanup and verification

**Files:**
- No new files. Clean up any residual references.

**Interfaces:**
- Produces: Clean typecheck, passing tests, reproducible builds

- [ ] **Step 1: Remove `@tabler/icons-react` from web deps**

Since AppSidebar now uses lucide icons, remove the dependency:

```bash
cd apps/web && bun remove @tabler/icons-react
```

- [ ] **Step 2: Run full CI checks**

```bash
bun run typecheck
bun run test
bun run check:fix
bun run build
```

Expected: All pass.

- [ ] **Step 3: Verify web dev server**

```bash
bun run dev:web &
# Test: login, project CRUD, version upload, member management, settings
```

- [ ] **Step 4: Verify server dev + web**

```bash
bun run dev:server &
# Visit http://localhost:3000 — management UI should load
```

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: cleanup after client package unification

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Summary

| Task | What | Risk |
|---|---|---|
| 1 | Prerequisites — add dep, align types | Low |
| 2 | CSS & theme — replace client CSS | Low |
| 3 | shadcn/ui — move components, delete old shared/ui | Medium — import breakage |
| 4 | Supporting files — hooks, capabilities, preferences | Low |
| 5 | i18n — merge translations into JSON locales | Medium — key conflicts |
| 6 | Layout shell — move AppLayout, AppSidebar, etc. | Medium — icon replacement |
| 7 | Rewrite App.tsx — new sidebar layout entry | Medium — structural |
| 8 | Features — move all feature components, merge native upload | High — most changes |
| 9 | Wire up web — thin shell | Medium — import chain |
| 10 | Wire up desktop — onboarding restyle | Medium — Electron build |
| 11 | Final cleanup & verification | Low |
