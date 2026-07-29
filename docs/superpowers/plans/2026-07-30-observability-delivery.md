# DeployKit Observability and Delivery Hardening Plan

> Execution rule: complete and verify each task before moving to the next one.

**Goal:** Make DeployKit observable and operationally predictable without
leaking management data through the untrusted deployment origin, while fixing
cache behavior that could make a manual rollback appear ineffective.

**Architecture:** Keep all metrics low-cardinality and process-local. The
management origin may expose Prometheus text only when metrics are enabled;
production additionally requires a bearer token. Request logs are structured
JSON and carry the same request ID returned to callers. Mutable active aliases
must revalidate, while explicit immutable version URLs may be cached for one
year. Shutdown stops accepting work, drains requests, checkpoints SQLite, and
then exits, with a bounded force-close fallback.

**Tech stack:** Bun, Hono, TypeScript, SQLite, Vitest, GitHub Actions.

---

## Task 1: Structured request logs and secured metrics

**Files:**

- Create: `apps/server/src/services/metrics.ts`
- Create: `apps/server/src/middleware/observability.ts`
- Create: `apps/server/src/services/metrics.test.ts`
- Create: `apps/server/src/middleware/observability.test.ts`
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/api.ts`
- Modify: `apps/server/src/config.test.ts`

**Acceptance criteria:**

- [x] Every response has an `X-Request-Id` and one JSON access-log event.
- [x] Log fields use normalized route names and status classes, not user IDs,
      project slugs, filenames, or other unbounded labels.
- [x] `/metrics` is unreachable from the deployment origin.
- [x] Production rejects enabled metrics without a strong bearer token.
- [x] Prometheus output includes request count, latency, failures, storage
      bytes, and SQLite bytes.

## Task 2: Correct deployment cache semantics

**Files:**

- Modify: `apps/server/src/services/deployResolver.ts`
- Modify: `apps/server/src/services/artifactService.ts`
- Modify: `apps/server/src/routes/deploy.ts`
- Modify: `apps/server/src/routes/deploy.test.ts`
- Modify: `apps/server/src/services/deployResolver.test.ts`

**Acceptance criteria:**

- [x] Active-alias responses use revalidation rather than immutable caching.
- [x] Explicit version URLs are immutable and cacheable for one year.
- [x] Active responses include an ETag and honor `If-None-Match` with `304`.
- [x] Changing or rolling back the active version cannot reuse the old ETag.

## Task 3: Graceful shutdown and SQLite checkpoint

**Files:**

- Create: `apps/server/src/runtime.ts`
- Create: `apps/server/src/runtime.test.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/config.test.ts`

**Acceptance criteria:**

- [x] `SIGINT` and `SIGTERM` initiate shutdown only once.
- [x] The server first stops accepting new work and drains in-flight requests.
- [x] SQLite WAL is checkpointed after the drain.
- [x] A configurable timeout force-closes stuck connections and exits non-zero.

## Task 4: Security and regression CI gates

**Files:**

- Create: `.github/workflows/codeql.yml`
- Create: `scripts/scan-secrets.ts`
- Create: `scripts/scan-secrets.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`

**Acceptance criteria:**

- [x] CI runs dependency vulnerability auditing.
- [x] CI performs CodeQL analysis for JavaScript/TypeScript.
- [x] CI runs a deterministic repository secret scan.
- [x] Existing malicious ZIP, recovery, backup, and crash-safe persistence tests
      remain part of the main verification gate.

## Task 5: Operations documentation and phase gate

**Files:**

- Modify: `README.md`
- Modify: `apps/server/README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/roadmap.md`
- Modify: `.env.example`

**Acceptance criteria:**

- [ ] Metrics access, alert signals, cache rules, and shutdown behavior are
      documented.
- [ ] `bun run verify` passes from a clean checkout.
- [ ] A production build is started and smoke-tested on management and deploy
      origins.
- [ ] Changes are committed to `main` and pushed to `origin/main`.
