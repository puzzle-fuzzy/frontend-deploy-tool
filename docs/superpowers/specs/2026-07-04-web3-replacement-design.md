# web3 Replacement Design

Date: 2026-07-04

## Goal

Replace the current `apps/web` management panel with the new `apps/web3`
experience while preserving the existing backend API contract and production
packaging flow.

The replacement must not move web UI components into `packages`. The upgraded
web app should own its application components locally, use shared domain types
from `@deploykit/shared`, and call the same server endpoints the current web
client uses.

## Current State

`apps/web` is the production web package, named `@deploykit/web`. It currently
acts mostly as a thin Vite entry that imports the app implementation from
`packages/client`.

`apps/web3` is an independent Vite app with a newer shell, sidebar, Base UI /
shadcn primitives, and mock data. It is not part of the root Bun workspace or
the root build/package flow yet.

The root production build expects `apps/web/dist`, and
`scripts/package-web.ts` mirrors that directory into `apps/server/public`.

`packages/client` is still used by `apps/desktop`, so this project will not
delete or restructure it as part of the web replacement.

## Recommended Approach

Migrate the web3 source into `apps/web` and keep `apps/web` as the production
package.

This keeps the stable commands and deployment path:

- `bun run dev:web`
- `bun run build`
- `scripts/package-web.ts`
- server static serving from `apps/server/public`

The old `apps/web` thin entry should be replaced by the web3 implementation.
After the migration, `apps/web3` can be removed so there is one production web
surface.

## Architecture

The new `apps/web/src` should be app-local and feature-oriented:

```text
apps/web/src/
  app/
    App.tsx
    providers.tsx
  features/
    auth/
    projects/
    versions/
    members/
    settings/
  shared/
    api/
    capabilities.ts
    errors.ts
    format.ts
    types.ts
    ui/
  components/
    ui/
```

This structure is a target shape, not a requirement to over-refactor in one
step. The implementation should stay close to the existing web3 component
shape where that keeps the change smaller.

UI primitives imported from web3's `src/components/ui` remain inside
`apps/web`. Feature components such as sidebar, project tabs, version rows,
upload dialogs, settings forms, and member screens also remain inside
`apps/web`.

Shared domain data comes from `@deploykit/shared`. The web app may also import
the server API type if needed for typed Hono client usage, but the Bun-free type
boundary must be preserved.

## API Compatibility

The upgraded web must keep using the existing backend endpoints and response
shapes for:

- authentication: login, register, logout, current user
- project listing and creation
- project update and deletion
- project settings update
- artifact upload through ZIP or folder files
- version publish, rollback, activation, and deletion
- member add, remove, and ownership transfer
- user email search

Request bodies should match the current API. Response handling should use
`@deploykit/shared` types where available.

The active version invariant stays unchanged: `project.activeVersionId` is the
single source of truth. The UI must not reintroduce a per-version `active`
boolean.

## Backend Capability Placeholders

Some upgraded UX concepts, such as project archive, are product direction but
may not have backend support yet.

For these, the web app should leave explicit app-local placeholders:

- define a small capability map in `apps/web/src/shared/capabilities.ts`
- render archive-related navigation or actions as disabled or informational
  when the capability is unavailable
- avoid adding fake API calls or optimistic local-only persistence for backend
  features that do not exist
- keep labels and action locations stable so the backend can be wired later

No shared schema or server route should be changed for archive support during
the web replacement unless implementation work explicitly expands scope to the
backend.

## Build And Workspace

`apps/web/package.json` remains the production package manifest and keeps the
name `@deploykit/web`.

Its dependencies should be updated to include the web3 UI stack while preferring
root workspace catalog versions where the repo already uses them.

`apps/web/vite.config.ts` should keep:

- output at `apps/web/dist`
- dev server port `5018`
- `/api` and `/deploy` proxying to the backend
- source aliases that point to `apps/web/src` for app-local code

After migration, `scripts/package-web.ts` should continue copying
`apps/web/dist` to `apps/server/public`.

## UX Scope

The first replacement should deliver functional parity with the current web
client while applying the web3 shell and interaction model:

- authenticated app shell
- project list and project selection
- project detail view with versions, members, and settings
- upload version flow
- version actions for preview, publish, rollback, and delete
- project creation flow
- project settings flow
- member management flow
- clear empty, loading, and error states

Mock tabs such as analytics or reports should either be removed from the first
production replacement or shown as disabled placeholders if they are important
for the intended navigation.

## Testing And Verification

Focused verification should include:

- `bun --filter @deploykit/web typecheck`
- `bun --filter @deploykit/web build`
- root `bun run typecheck`
- root `bun run build`

If the implementation touches API adaptation or complex state transitions, add
focused web tests for the adapter and project/version flows.

The final validation should confirm that `apps/web/dist` is produced and that
the packaging step still mirrors the web assets into `apps/server/public`.

## Non-Goals

This project does not:

- redesign or remove `packages/client`
- move app UI components into `packages`
- implement backend archive routes
- change server storage shape
- change deploy serving semantics
- change desktop client behavior

