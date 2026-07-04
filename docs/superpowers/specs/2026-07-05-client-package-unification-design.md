# Client Package Unification Design

## Goal

Consolidate the two independent UI implementations (web app + desktop's client package) into one shared codebase in `packages/client`. The web app becomes a thin shell; the desktop app inherits the web-quality UI automatically.

## Current State

Two separate implementations of the same project-management UI:

| | `apps/web` (new) | `packages/client` (old) |
|---|---|---|
| Layout | Sidebar + main content | Top header + centered content |
| Components | shadcn/ui (base-ui primitives) | Custom `shared/ui/` |
| Theme | Neutral gray, Geist font | Blue-tinted, JetBrainsMapleMono font |
| Radius | 0.5rem | 0.375rem |
| i18n | Inline TS object | JSON locale files |
| Auth | LoginPage + useAuth | LoginPage + useAuth (duplicate) |

Both define an identical `ApiClient` interface. Web implements it with `hono/client`+XHR; desktop with `window.deploykit.api.*` IPC bridge.

## Target Architecture

```
packages/client/           ← single source of UI truth
├── api/
│   ├── ApiClient.ts           ← interface (keep existing)
│   ├── ApiClientProvider.tsx  ← keep existing
│   ├── fetchApiClient.ts      ← keep existing (hono/client + XHR)
│   ├── errors.ts              ← keep existing
│   ├── NativeBridge.ts        ← keep (desktop-specific)
│   ├── NativeProvider.tsx     ← keep
│   ├── ServerInfoProvider.tsx ← keep
│   └── index.ts               ← re-exports
├── components/
│   ├── AppLayout.tsx          ← from web
│   ├── AppSidebar.tsx         ← from web
│   ├── AppHeader.tsx          ← from web
│   ├── DropdownMenuAvatar.tsx ← from web
│   └── ui/                    ← shadcn/ui set from web (replaces shared/ui/)
│       ├── avatar.tsx, breadcrumb.tsx, button.tsx, card.tsx
│       ├── checkbox.tsx, dialog.tsx, dropdown-menu.tsx
│       ├── input.tsx, item.tsx, scroll-area.tsx, select.tsx
│       ├── separator.tsx, sheet.tsx, sidebar.tsx, skeleton.tsx
│       ├── tabs.tsx, textarea.tsx, tooltip.tsx
├── features/
│   ├── auth/             ← from web (LoginPage + useAuth)
│   ├── desktop-auth/     ← keep DesktopAuthorizePage
│   ├── deploy/           ← keep DeployUrl
│   ├── members/          ← from web (AddMemberDialog, MemberList)
│   ├── projects/         ← from web (CreateProjectDialog, useProjects, slug)
│   ├── settings/         ← from web (ProjectSettingsForm)
│   ├── theme/            ← keep ThemeToggle + useTheme
│   ├── i18n/             ← keep LanguageToggle
│   └── versions/         ← from web (UploadVersionDialog, VersionList, VersionStatusBadge)
├── hooks/                ← from web (use-mobile)
├── i18n/                 ← merge web inline TS → JSON locale files
├── lib/                  ← from web (cn utils)
├── shared/
│   ├── format.ts         ← merge web additions
│   ├── types.ts          ← merge web additions
│   ├── capabilities.ts   ← from web
│   ├── preferences.ts    ← from web
│   └── config.ts         ← keep
├── App.tsx               ← rewritten: uses new AppLayout + sidebar
├── index.css             ← from web (neutral theme, Geist, 0.5rem radius, sidebar bg extension, button cursor)
├── index.ts              ← updated exports
└── main entry            ← none; this is a library, not an app entry point
```

### What stays in `packages/client` (desktop-specific, unchanged)

- `api/NativeBridge.ts` + `NativeProvider.tsx` — desktop native upload bridge
- `api/ServerInfoProvider.tsx` — server origin context
- `api/desktopAuth.ts` — web-based login loopback
- `features/desktop-auth/DesktopAuthorizePage.tsx`
- `features/deploy/DeployUrl.tsx`
- `features/theme/ThemeToggle.tsx` + `useTheme.ts`
- `features/i18n/LanguageToggle.tsx`
- `features/members/TransferOwnershipDialog.tsx` — desktop only (web's members page does it inline)

### What from `packages/client` gets removed

- `pages/DeployPage.tsx` — replaced by new `App.tsx` + sidebar layout
- `shared/ui/*` (all files) — replaced by shadcn/ui components from web
- `features/auth/LoginPage.tsx` + `useAuth.ts` — replaced by web versions
- `features/members/AddMemberDialog.tsx` + `MemberList.tsx` — replaced by web versions
- `features/projects/*` — replaced by web versions
- `features/settings/ProjectSettingsDialog.tsx` — replaced by web's `ProjectSettingsForm`
- `features/versions/*` — replaced by web versions
- `shared/avatar.ts`, `shared/error-messages.ts`, `shared/ui/avatar-dropdown.tsx`, `shared/ui/toast*`, `shared/ui/sonner.tsx`, `shared/ui/user-display.tsx` — unused after migration

### What `apps/web` becomes

```
apps/web/
├── src/
│   ├── main.tsx    ← imports <App /> from @deploykit/client
│   └── index.css   ← @import only; delegates to client's CSS
├── index.html
├── vite.config.ts
└── package.json    ← add @deploykit/client dependency
```

`main.tsx`:
```tsx
import { App, ApiClientProvider, createFetchApiClient } from '@deploykit/client';
import './index.css';

const client = createFetchApiClient();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ApiClientProvider client={client}>
      <App />
    </ApiClientProvider>
  </StrictMode>
);
```

### What `apps/desktop` changes

`DesktopApp.tsx` — Onboarding page gets styled with shadcn/ui components (Button, Input, Card). The LoginGate section uses shared `LoginPage` component from `@deploykit/client` for the form, while keeping the "Sign in via web page" button.

`ipcApiClient.ts` — unchanged. Already implements `ApiClient` from `@deploykit/client`.

`index.css` — removed. Desktop inherits CSS from `@deploykit/client`.

## Migration Strategy

### Phase 1: API unification (no-op layer)

Web already has `ApiClient` in `packages/client`. The web app's `shared/api/types.ts` is a near-duplicate. Remove the duplicate; web imports from `@deploykit/client`. Add `UploadableFile` and `UploadProgress` re-exports that web was using from its local file.

### Phase 2: CSS & theme

Replace `packages/client/index.css` with `apps/web/index.css` (neutral theme, Geist, 0.5rem radius, sidebar bg pseudo-element, button cursor-pointer).

### Phase 3: shadcn/ui components

Delete `packages/client/shared/ui/*`. Copy `apps/web/components/ui/*` into `packages/client/components/ui/`. Update all internal imports within these components to use relative paths (`@/lib/utils` → `../../lib/utils`).

### Phase 4: Layout & App shell

Copy `AppLayout`, `AppSidebar`, `AppHeader`, `DropdownMenuAvatar` from web into `packages/client/components/`. Rewrite `packages/client/App.tsx` to use `AppLayout`-based layout.

### Phase 5: Features

Copy web features (projects, members, settings, versions, auth) into `packages/client/features/`. Desktop-specific features (ThemeToggle, LanguageToggle, DeployUrl, DesktopAuthorize, TransferOwnership) stay.

### Phase 6: Supporting files

Copy `hooks/`, `lib/`, `shared/format.ts`, `shared/types.ts`, `shared/capabilities.ts`, `shared/preferences.ts` — merge with existing where overlap exists.

### Phase 7: i18n

Web has translations inline in `i18n/index.ts`; client has JSON locale files. Merge web's translations into client's JSON files. Remove web's inline TS file.

### Phase 8: Wire up web app

Replace `apps/web/App.tsx` with thin entry. Add `@deploykit/client` dependency.

### Phase 9: Wire up desktop

Update `DesktopApp.tsx` to remove old onboarding/auth inline code. Use `Input`, `Button` from `@deploykit/client`. Remove `apps/desktop/src/renderer/index.css`.

### Phase 10: Cleanup

Delete all moved files from `apps/web/src/` (keep only `main.tsx`). Delete all replaced files from `packages/client/src/`. Run `bun run typecheck && bun run test && bun run check`.

## Risk Mitigation

- **Web must type-check at each phase** — `@deploykit/client` is imported via workspace reference, changes are live.
- **Desktop must compile at each phase** — verify IPC bridge still works after migration.
- **Biome checks** — run `bun run check:fix` after bulk file moves.
- **Test suite** — both web and client have tests. Run after migration. Desktop has tests too.

## CSS deduplication

After migration, `packages/client` owns the canonical CSS. Desktop's `renderer/index.css` is replaced with a minimal file that only contains the `@font-face` for JetBrainsMapleMono (if keeping that font) and `@import` of the client CSS. Otherwise, both `apps/web` and `apps/desktop` renderers will load duplicate `@import "tailwindcss"` declarations, which may cause build issues.

## Open Questions

- Desktop's onboarding currently uses raw `<input>` + `<button>` tags. After migration, these become shadcn/ui `Input` + `Button`. Trivial change.
- `TransferOwnershipDialog` — web does transfer inline in MemberList; desktop uses a dialog. Keep desktop's dialog component.
- Desktop font — currently JetBrainsMapleMono. Decision: switch to Geist (matching web) or keep monospace. Recommendation: switch to Geist for consistency; desktop is a management tool, not a code editor.
