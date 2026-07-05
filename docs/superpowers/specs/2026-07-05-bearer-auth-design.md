# Bearer Auth Migration Design

Date: 2026-07-05

## Goal

Replace the current cookie-based session auth with bearer-token auth for the DeployKit web and desktop clients.

The migration must preserve the existing product behavior and role model while removing the dependency on browser/server session cookies for API authentication.

## Current State

The current implementation uses a signed session cookie (`deploykit_session`) issued by the server and read by a Hono session middleware.

This is wired through:

- server auth middleware and route guards in `apps/server/src`
- web client requests in `packages/client/src/api/fetchApiClient.ts`
- desktop IPC requests in `apps/desktop/src/main/serverRequest.ts` and `apps/desktop/src/main/auth.ts`

The main problem is that the current flow depends on cookie persistence and cookie jar behavior, which is fragile in Electron and is the source of the current desktop auth failures.

## Recommended Approach

Adopt a bearer-only auth model for API requests.

### Server

- Login and register return an access token alongside the user payload.
- All protected API routes require an `Authorization: Bearer <token>` header.
- The server no longer reads or writes session cookies for API auth.
- The existing role-based auth model stays unchanged; the token carries the same user identity and role.

### Web client

- The web app keeps using the shared typed client layer.
- A small auth store injects the bearer token into every request.
- The token is stored in memory and rehydrated from `sessionStorage` on reload so the user stays signed in across a tab refresh without relying on cookies.
- Logout clears the token from storage and the in-memory state.

### Desktop client

- The desktop app uses the same bearer token flow over IPC and Electron `net.request`.
- The token is stored in Electron's secure storage (`safeStorage`) or equivalent protected storage for the current user/session.
- No cookie jar logic is used for API auth.

## Authentication Flow

### Login / Register

1. The client posts credentials to `/api/auth/login` or `/api/auth/register`.
2. The server verifies the credentials.
3. The server returns:
   - the authenticated user
   - a signed access token
4. The client stores the token and uses it for subsequent protected requests.

### Protected Requests

Each protected API call sends:

```http
Authorization: Bearer <access-token>
```

### Logout

- The client clears the local token state.
- The server no longer needs to clear a cookie.

## Server-Side Changes

### Auth middleware

The existing session middleware should be replaced or supplemented with a bearer-aware middleware that:

- reads the `Authorization` header
- verifies the signed token
- loads the user into the request context
- rejects the request with `401` when the token is missing or invalid

### Auth endpoints

The login/register/logout endpoints should be updated to:

- return `{ user, token }` on successful login/register
- return `{ ok: true }` on logout without depending on cookie clearing

### Token format

The token can reuse the existing signed-token approach already used for session cookies, but it should be explicitly typed as an access token.

Recommended claims:

- `sub`: user id
- `role`: user role
- `exp`: expiry timestamp
- `type`: `access`

## Client-Side Changes

### Shared client abstraction

The shared client layer should own the bearer token injection instead of each caller handling headers individually.

The flow should be:

- auth layer obtains token from local storage / secure storage
- auth layer injects it into request headers
- request fails with `401` when the token is missing or invalid

### Web client

The web client should:

- read the token from `sessionStorage` on startup
- attach it to all API requests
- clear it on logout or on `401` if the app chooses to force re-auth

### Desktop client

The desktop client should:

- keep the token in Electron protected storage
- attach it to all IPC-backed API requests at the main-process boundary
- avoid any cookie-jar-based auth fallback

## Rollout Plan

### Phase 1

- Implement bearer auth in the server and shared client layer.
- Switch desktop requests to bearer tokens.
- Keep the current UI behavior intact.

### Phase 2

- Switch the web client to bearer tokens.
- Remove any remaining cookie-based auth logic from the API client layer.

### Phase 3

- Remove the old cookie/session code paths once the new bearer flow is stable.

## Error Handling

- Missing or invalid token: return `401 Unauthorized` with the existing `Authentication required` message.
- Expired token: return `401` and clear the token client-side.
- Logout: clear local token state and force the app back to the login screen.

## Testing Plan

Focused tests should cover:

- server middleware accepts a valid bearer token and rejects invalid/missing ones
- login/register return a token and the client stores it correctly
- desktop requests attach the bearer header and do not depend on cookies
- logout clears the token and blocks future authenticated calls

## Non-Goals

This change does not introduce:

- refresh-token rotation
- OAuth provider integration
- multi-device token revocation infrastructure
- a hybrid cookie-plus-bearer compatibility mode

The first implementation should be a straightforward bearer-only migration that makes the auth path predictable and testable.
