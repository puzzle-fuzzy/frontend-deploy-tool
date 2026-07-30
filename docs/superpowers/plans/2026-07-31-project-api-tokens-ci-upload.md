# Project API Tokens and CI Preview Upload Implementation Plan

> **Execution mode:** subagent-driven development with one implementation
> task active at a time, followed by independent specification and quality
> reviews.

**Goal:** Add project-scoped, revocable API credentials and a crash-safe,
idempotent CI endpoint that uploads frontend artifacts as preview versions
without weakening session, release, audit, quota, or storage-recovery
invariants.

**Architecture:** Browser and desktop sessions remain the only credentials for
management APIs. A separate API-token service and middleware authenticate only
the narrow `/api/ci/*` surface. Tokens are bound to one project and v1 grants
only `preview:upload`, because the current domain has no staging environment
and production remains an explicit human-controlled compare-and-set release.
SQLite stores only a versioned SHA-256 digest of a 256-bit random secret;
the public lookup id and redacted prefix are not credentials. CI idempotency is
committed in the same SQLite transaction as version metadata and its history
event, after the existing filesystem staging/finalization path has validated
the artifact.

**Tech Stack:** Bun 1.3, TypeScript, Hono, Zod, `bun:sqlite`, `node:crypto`,
`bun:test`, existing relational aggregate repository and local artifact
storage.

## Direction calibration and explicit non-goals

- The repository currently models preview versions and one production pointer;
  it does not model a staging environment. Do not add `staging:publish` until a
  real environment/pointer/release-ledger design exists.
- Do not expose automated production publish in this phase. First prove token
  revocation, scope isolation, upload quotas, idempotency and recovery. A later
  phase may add `production:publish` only by reusing the existing release
  compare-and-set and blocking-audit policy.
- Do not let API tokens authenticate normal `/api/projects`, token-management,
  member, history, session, or audit-management routes.
- Do not reuse or derive API tokens from `SESSION_SECRET`; rotating a browser
  signing secret must not invalidate CI credentials. A random 256-bit secret
  makes a fast SHA-256 verifier safe against offline guessing without adding
  password-hash CPU denial-of-service risk.
- Do not add a CLI package or webhook system in this phase. The documented HTTP
  contract is sufficient for GitHub Actions, GitLab CI and shell callers; a CLI
  should wrap the stable contract later.
- Do not store raw bearer values, request authorization headers, artifact
  content, or idempotency keys in history, structured logs, metrics or errors.

## Global invariants

- Token plaintext is returned only by create/rotate responses.
- A token is useful for exactly one project and an explicit scope.
- Token management is session-only and requires project owner access (global
  admin keeps the existing bypass).
- CI upload always creates `preview`; it never changes
  `project.activeVersionId`.
- The existing request-body, ZIP, extracted-size, path, file-count,
  compression-ratio, storage-quota and upload-concurrency limits all apply.
- An idempotency record and its version/history metadata either commit
  together or do not commit at all.
- Same token + project + idempotency key + request digest returns the original
  result. A different digest returns `409`.
- A crash after filesystem promotion but before metadata commit leaves only an
  orphan handled by existing reconciliation. A crash after the atomic metadata
  commit can be retried without creating another version.
- Token revocation and expiry take effect before another CI write is accepted.
- SQLite schema upgrades remain backed up, transactional and covered by restore
  verification.
- A backup created on the immediately previous relational schema v5 remains
  verifiable and restorable; startup upgrades the restored database to v6.

---

### Task 1: Relational token and security-audit foundation

**Files:**

- Create: `apps/server/src/domain/apiToken.ts`
- Create: `apps/server/src/repositories/apiTokenRepository.ts`
- Modify: `apps/server/src/repositories/sqliteSchema.ts`
- Modify: `apps/server/src/repositories/sqliteProjectRepository.ts`
- Modify: `apps/server/src/services/backupService.ts`
- Modify: `packages/shared/src/domain.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/errors.ts`
- Test: `apps/server/tests/services/apiTokenRepository.test.ts`
- Test: `apps/server/tests/services/sqliteProjectRepository.test.ts`
- Test: `apps/server/tests/services/backupService.test.ts`

**Step 1: Write failing relational and repository tests**

Cover:

- schema v5 upgrades transactionally to v6 and writes
  `.pre-relational-v6.bak`;
- fresh databases contain `project_api_tokens`,
  `api_token_security_events` and `ci_idempotency_records`;
- token rows never contain plaintext and preserve exact scope, expiry,
  revocation, replacement and last-use metadata;
- create, rotate and revoke write their security event in the same transaction;
- known-token auth failures can be recorded without storing the presented
  secret;
- project deletion cascades live token and idempotency state;
- schema v6 backup manifests count the three new durable tables and
  verification detects count drift;
- existing schema v5/manifest-v1 backups remain verifiable and restorable even
  though they do not contain the v6 table counts; the restored database is
  upgraded by normal startup before serving traffic.

Run:

```bash
bun --filter @deploykit/server test \
  tests/services/apiTokenRepository.test.ts \
  tests/services/sqliteProjectRepository.test.ts \
  tests/services/backupService.test.ts
```

Expected: fail because schema v6 and the repository do not exist.

**Step 2: Add shared metadata and error contracts**

Define a strict `apiTokenScopeSchema` with only `preview:upload` for v1, plus
redacted token metadata and security-event schemas. Add stable error codes for
invalid token credentials, expired/revoked credentials, insufficient token
scope, invalid idempotency keys and idempotency conflicts. Do not add token
tables to the legacy `Data` aggregate.

**Step 3: Implement schema v6**

Add:

- `project_api_tokens`: public id, project id, name, hash version, digest,
  redacted prefix, JSON scope set, created-by/at, expires-at, last-used-at,
  revoked-at and replacement link;
- `api_token_security_events`: append-only project/token snapshot metadata,
  action, outcome, actor/reason and timestamp, without bearer data;
- `ci_idempotency_records`: project/token/key tuple, canonical request digest,
  original version id/name, created-at and expires-at.

Use foreign keys for live token/idempotency ownership. Security-event rows keep
project/token snapshots so incident history survives later token or project
removal. Add lookup, expiry and project-history indexes.

**Step 4: Implement memory and SQLite token repositories**

Keep crypto out of persistence. Repository operations accept already-digested
secrets and own atomic lifecycle/security-event writes. List results must be
redacted at the type boundary. Bound security-event reads to the newest 100
items.

**Step 5: Extend backup evidence without breaking old backups**

Include token, token-security-event and CI-idempotency row counts in backup
manifests and verification. Parse metadata counts according to the manifest's
relational schema: v6 requires the new counts, while v5 accepts the previous
shape and treats the new counts as absent rather than zero. Verification and
restore accept the supported v5-v6 range; after restoring v5, normal
`createSqliteProjectRepository` startup performs the backed-up v5-to-v6
migration before the application becomes ready. Schema v6 backups must
round-trip the new rows.

**Step 6: Verify and commit**

```bash
bun --filter @deploykit/server test \
  tests/services/apiTokenRepository.test.ts \
  tests/services/sqliteProjectRepository.test.ts \
  tests/services/backupService.test.ts
bun --filter @deploykit/server typecheck
bun --filter @deploykit/shared typecheck
bun run check
git diff --check
git add apps/server packages/shared
git commit -m "feat: add project API token persistence"
```

Pause and review the database model, plaintext boundary and migration/backup
behavior before starting Task 2.

---

### Task 2: Session-only token lifecycle API

**Files:**

- Create: `apps/server/src/services/apiTokenService.ts`
- Create: `apps/server/src/routes/apiTokens.ts`
- Modify: `apps/server/src/domain/schemas.ts`
- Modify: `apps/server/src/services/contracts.ts`
- Modify: `apps/server/src/api.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/tests/services/apiTokenService.test.ts`
- Test: `apps/server/tests/api/apiTokens.test.ts`
- Test: `apps/server/tests/api/securityBoundary.test.ts`

**Step 1: Write failing crypto/lifecycle/API tests**

Cover:

- token format `dpk_v1.<publicId>.<256-bit-secret>` and constant-time digest
  verification;
- only a versioned SHA-256 digest and redacted prefix reach persistence;
- default expiry is 90 days and explicit expiry must be in the future and no
  more than one year away;
- rotation preserves the scope set, supports a bounded 0–24 hour overlap
  (default 15 minutes), links the replacement and returns plaintext only once;
- revoke is immediate and idempotent;
- list/security-event responses never expose digest or plaintext;
- project members and viewers cannot manage tokens; owners and global admins
  can;
- an API token sent to any ordinary management endpoint receives `401`;
- a browser/desktop session sent to the CI surface cannot authenticate.

Run:

```bash
bun --filter @deploykit/server test \
  tests/services/apiTokenService.test.ts \
  tests/api/apiTokens.test.ts \
  tests/api/securityBoundary.test.ts
```

Expected: fail because the service and routes do not exist.

**Step 2: Implement token generation and verification**

Generate 32 random bytes per token. Hash the complete canonical token with
SHA-256 and domain separation. Parse exact versioned token syntax, lookup by
public id, compare fixed-size digests with `timingSafeEqual`, then enforce
project, expiry, revocation and scope. Never include a submitted token in an
exception or event.

Throttle `lastUsedAt` persistence to at most once every five minutes per token
to avoid turning every artifact request into unnecessary SQLite write
contention.

**Step 3: Add owner-only lifecycle routes**

Add:

- `GET /api/projects/:id/api-tokens`
- `POST /api/projects/:id/api-tokens`
- `POST /api/projects/:id/api-tokens/:tokenId/rotate`
- `DELETE /api/projects/:id/api-tokens/:tokenId`
- `GET /api/projects/:id/api-tokens/security-events`

All five routes use the existing session middleware plus
`requireProjectRole('owner')`. Token bearer authentication is never considered
on these routes. Creation accepts a human label and optional expiry; v1 always
grants only `preview:upload`.

**Step 4: Compose dependencies without crossing the Bun-free type boundary**

Keep crypto and SQLite implementations in `app.ts` dependencies. Route/service
interfaces in `services/contracts.ts` remain free of Node/Bun runtime imports
so `ApiApp` continues to type-check in the Web client.

**Step 5: Verify and commit**

```bash
bun --filter @deploykit/server test \
  tests/services/apiTokenService.test.ts \
  tests/api/apiTokens.test.ts \
  tests/api/securityBoundary.test.ts
bun run typecheck
bun run check
git diff --check
git add apps/server packages/shared
git commit -m "feat: add API token lifecycle endpoints"
```

Pause and independently review route isolation, owner authorization, expiry,
rotation and secret-redaction behavior before starting Task 3.

---

### Task 3: Dedicated CI authentication and idempotent preview upload

**Files:**

- Create: `apps/server/src/middleware/apiToken.ts`
- Create: `apps/server/src/routes/ciVersions.ts`
- Modify: `apps/server/src/middleware/auth.ts`
- Modify: `apps/server/src/middleware/session.ts`
- Modify: `apps/server/src/middleware/uploadLimits.ts`
- Modify: `apps/server/src/services/contracts.ts`
- Modify: `apps/server/src/services/versionService.ts`
- Modify: `apps/server/src/repositories/projectRepository.ts`
- Modify: `apps/server/src/repositories/jsonProjectRepository.ts`
- Modify: `apps/server/src/repositories/sqliteProjectRepository.ts`
- Modify: `apps/server/src/api.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/tests/services/versionService.test.ts`
- Test: `apps/server/tests/api/ciUpload.test.ts`
- Test: `apps/server/tests/api/uploadLimits.test.ts`
- Test: `apps/server/tests/api/securityBoundary.test.ts`

**Step 1: Write failing authentication and idempotency tests**

Cover:

- `POST /api/ci/projects/:id/versions` requires an API token, matching project,
  `preview:upload`, and a valid `Idempotency-Key`;
- session cookies and browser/desktop bearer tokens do not work on the CI
  endpoint;
- API tokens do not work on normal version upload/publish/history/token routes;
- upload limits, quota, ZIP safety, path safety and per-project concurrency are
  identical to interactive upload;
- first request creates one preview version and leaves the active pointer
  unchanged;
- same token/project/key and same canonical artifact request returns the
  original version with `replayed: true`;
- same tuple with a different artifact checksum or normalized description
  returns `409 IDEMPOTENCY_CONFLICT`;
- the same key can be used by a different token or project without collision;
- revoked/expired credentials fail before a version is committed;
- an injected transaction failure persists neither version, history nor
  idempotency record and removes the promoted artifact;
- replay after an injected response loss removes the duplicate promoted
  artifact and returns the original metadata;
- restart/repository recreation preserves the replay result.

Run:

```bash
bun --filter @deploykit/server test \
  tests/services/versionService.test.ts \
  tests/api/ciUpload.test.ts \
  tests/api/uploadLimits.test.ts \
  tests/api/securityBoundary.test.ts
```

Expected: fail because the CI route and atomic idempotency commit do not exist.

**Step 2: Add an automation principal without impersonating a user**

Extend `AppEnv` with a nullable, redacted API-token principal. The session
middleware initializes only session identity. The CI token middleware reads
the `Authorization: Bearer` header itself, authorizes the route project and
scope, and sets only the automation principal.

Allow `/api/ci/*` past the global session requirement only because every
registered CI route has its own fail-closed token middleware. Unknown paths
remain harmless 404s. Ordinary management routes continue to require a session.

**Step 3: Generalize upload admission identity**

The upload gate should derive a bounded principal key from either the
authenticated user or API-token principal while retaining global, per-project
and per-principal counters. It must never use the bearer value as a map key or
metric label.

**Step 4: Add repository-owned atomic upload idempotency**

Add a specialized `commitVersionUpload` operation to `ProjectRepository`.
SQLite implementation:

1. starts `BEGIN IMMEDIATE`;
2. deletes only expired idempotency rows;
3. checks the project/token/key tuple;
4. returns the stored version for the same digest or throws conflict for a
   different digest;
5. otherwise applies the existing synchronous aggregate mutation;
6. persists version/history metadata and the idempotency row in that same
   transaction.

The JSON test repository implements equivalent in-memory semantics. Retain
records for 24 hours. Do not add a separate pre-claim state: it would create a
new stuck-request recovery protocol without improving correctness under the
existing per-project upload gate.

**Step 5: Reuse the existing artifact pipeline**

`versionService.uploadVersion` remains the only file validation, extraction,
flattening, quota and metadata path. For CI calls it computes a canonical
request digest from the normalized description plus extracted artifact
checksum/source/size/file count, invokes `commitVersionUpload`, and:

- returns the new result with `replayed: false`; or
- deletes the just-promoted duplicate directory and returns the original result
  with `replayed: true`.

Use the redacted actor id `api-token:<publicId>` in the existing atomic
`version.upload` history event. Do not add raw idempotency keys to metadata.

**Step 6: Verify and commit**

```bash
bun --filter @deploykit/server test \
  tests/services/versionService.test.ts \
  tests/api/ciUpload.test.ts \
  tests/api/uploadLimits.test.ts \
  tests/api/securityBoundary.test.ts
bun run typecheck
bun run check
git diff --check
git add apps/server packages/shared
git commit -m "feat: add idempotent CI preview uploads"
```

Pause and independently review transaction/cleanup behavior for every crash
boundary before starting Task 4.

---

### Task 4: Operational contract, smoke evidence and delivery

**Files:**

- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/development.md`
- Modify: `docs/backend-hardening-roadmap.md`
- Modify: `docs/enterprise-frontend-deploy-plan.md`
- Modify: `TODO.md`
- Modify: `.github/workflows/ci.yml` only if a new dedicated gate is required
- Test: `apps/server/tests/api/ciUpload.test.ts`
- Test: `apps/server/tests/services/backupService.test.ts`
- Test: `apps/server/tests/api/relationalMigrationSmoke.test.ts`

**Step 1: Document the stable CI contract**

Document:

- owner-only create/list/rotate/revoke workflow;
- one-time secret handling and leak response (rotate/revoke immediately);
- `curl` examples using environment variables and `Idempotency-Key`;
- the 24-hour idempotency window and digest-conflict behavior;
- preview URL/result fields and the explicit manual publish boundary;
- scope matrix showing v1 supports only `preview:upload`;
- GitHub Actions/GitLab CI secret-storage guidance without committing a token.

**Step 2: Add a real-process smoke test**

Against an isolated production process and temporary SQLite/storage:

1. login as admin and create a project;
2. create one project API token;
3. upload a valid ZIP through the CI endpoint;
4. retry the exact request and prove the same version is returned;
5. retry the key with changed content and prove `409`;
6. restart the process and prove replay still returns the original;
7. rotate with overlap, prove both credentials briefly work, then revoke the
   old credential and prove it fails;
8. prove no upload changed production;
9. backup, verify and restore; prove token metadata, security events and
   idempotency counts survive and SQLite integrity/foreign keys are clean.
10. verify and restore a preserved schema v5 backup fixture, then restart and
    prove the normal migration produces a healthy schema v6 database.

No plaintext token may appear in captured logs, manifest, database query output
or test snapshots.

**Step 3: Run full gates**

```bash
bun run check:fix
bun run verify
npm_config_registry=https://registry.npmjs.org bun run security:audit
git diff --check
git status --short
```

Expected:

- all workspace tests/typechecks/builds pass;
- secret scan passes;
- high/critical dependency audit reports zero findings;
- Web production bundle still packages into `apps/server/public`;
- worktree contains only this phase's intended changes.

**Step 4: Final independent review**

Review the complete branch against:

- session/API-token credential separation;
- owner-only lifecycle management;
- project/scope/expiry/revocation enforcement;
- no plaintext persistence/logging;
- upload safety/quota/concurrency reuse;
- atomic idempotency and all crash boundaries;
- no implicit production release;
- schema migration and backup/restore compatibility;
- continued verification/restoration of supported schema v5 backups;
- Bun-free typed API boundary.

Fix every Critical or Important issue and rerun affected tests plus full
`bun run verify`.

**Step 5: Record evidence and synchronize main**

```bash
git add README.md TODO.md docs .github apps packages
git commit -m "docs: publish CI deployment token contract"
git pull --rebase origin main
bun run verify
git push origin main
git status --short --branch
```

Record the exact commits, final local/remote SHA, local verify evidence and
remote CI/CodeQL status. Do not claim staging or automated production release
support.
