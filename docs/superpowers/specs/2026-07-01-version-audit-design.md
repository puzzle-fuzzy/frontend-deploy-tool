# Version Audit Design

## Background

DeployKit is moving toward an enterprise-grade frontend deployment platform. Uploaded artifacts may be Vite demos, production H5 pages, corporate websites, documentation sites, admin apps, or future micro-frontend bundles. A narrow "SEO checker" would be too small for that direction.

The feature should be designed as a version-level release quality audit system. SEO metadata is one audit category, not the whole product.

## Goals

- Add a version audit capability that can inspect uploaded artifacts before a version is promoted or shared.
- Start with static artifact inspection so the first implementation stays fast, deterministic, and safe.
- Support multiple project profiles so admin apps are not judged by website SEO rules.
- Keep the design extensible for rendered DOM audits, historical reports, release gates, and CI usage later.

## Non-Goals For Phase 1

- No browser automation or Playwright rendering yet.
- No Lighthouse-style performance scoring.
- No external crawling of public websites.
- No sitemap, robots.txt, schema.org, or multi-page site crawling.
- No automatic blocking of activation.
- No persisted audit history.

## Product Model

The UI should call the feature "Version Audit" or "Release Check". The panel may show an SEO section, but the top-level concept should remain broader than SEO.

Each project eventually gets an audit profile:

```ts
type AuditProfile =
  | 'demo'
  | 'production-web'
  | 'h5-campaign'
  | 'admin-app'
  | 'docs';
```

Phase 1 can avoid adding project settings by defaulting to `production-web` in the audit request/response. Profile persistence can be added later when project settings are expanded.

Recommended default rule posture:

| Profile | Primary Concern | SEO Strictness |
| --- | --- | --- |
| `demo` | artifact integrity, preview sanity | low |
| `production-web` | SEO, metadata, social sharing, links | high |
| `h5-campaign` | mobile metadata, sharing cards, viewport | medium |
| `admin-app` | noindex/security/basic artifact health | low |
| `docs` | headings, links, canonical metadata | medium-high |

## Phase 1 Audit Scope

Phase 1 should inspect a selected version's stored artifact directory, starting from `index.html`.

Checks:

- Metadata
  - `<title>` exists and has reasonable length.
  - `<meta name="description">` exists.
  - `<html lang>` exists.
  - `<meta name="viewport">` exists.
  - `<link rel="canonical">` exists for strict website profiles.
- SEO
  - H1 count is zero, one, or multiple.
  - Heading order has obvious jumps, such as H1 to H4.
  - `robots` meta has `noindex` when the selected profile expects it.
- Links
  - Anchor tags have non-empty text or accessible labels.
  - `href` exists.
  - `javascript:` URLs are reported.
  - External links without safe `rel` are warnings when `target="_blank"` is used.
- Images
  - `img[src]` exists.
  - Missing or empty `alt` is reported.
- Social Sharing
  - `og:title`, `og:description`, `og:image`.
  - `twitter:card`.
- Assets
  - Local `script[src]`, `link[href]`, and `img[src]` targets exist when they are relative paths.
  - Missing `index.html` is an error.
- Deploy Compatibility
  - The requested version belongs to the project.
  - The artifact path resolves through existing safe path utilities.
  - SPA fallback configuration is reported as informational context.

## Result Shape

Shared types should live in `packages/shared` so the Hono API and React client use the same contract.

```ts
type AuditStatus = 'passed' | 'warning' | 'failed';
type AuditSeverity = 'info' | 'warning' | 'error';
type AuditCategory =
  | 'metadata'
  | 'seo'
  | 'links'
  | 'images'
  | 'social'
  | 'assets'
  | 'deploy';

interface AuditCheck {
  id: string;
  category: AuditCategory;
  severity: AuditSeverity;
  title: string;
  message: string;
  location?: string;
}

interface AuditReport {
  projectId: string;
  versionId: string;
  profile: AuditProfile;
  status: AuditStatus;
  score: number;
  checks: AuditCheck[];
  createdAt: string;
}
```

Scoring should be simple and explainable:

- Start from 100.
- Each `error` subtracts 15.
- Each `warning` subtracts 5.
- `info` does not affect score.
- Clamp to 0-100.
- Any error sets status to `failed`; any warning without errors sets `warning`; otherwise `passed`.

This is intentionally conservative and easy to replace later.

## Backend Architecture

Add focused modules:

```txt
apps/server/src/domain/audit.ts
apps/server/src/services/auditService.ts
apps/server/src/services/htmlAuditService.ts
apps/server/src/routes/audits.ts
apps/server/tests/services/htmlAuditService.test.ts
apps/server/tests/api/audits.test.ts
```

Responsibilities:

- `domain/audit.ts`: pure scoring and report status rules.
- `htmlAuditService.ts`: parse HTML and produce checks. It should depend on a mature parser, not regular expressions.
- `auditService.ts`: locate the project/version artifact directory, read `index.html`, call the HTML audit service, and return the report.
- `routes/audits.ts`: HTTP adapter for Hono.

The service should not use the deploy URL as the source of truth in Phase 1. It should read the stored artifact directory directly. That avoids network requests, avoids server self-calls, and keeps tests deterministic.

## API Design

Phase 1 endpoint:

```txt
POST /api/projects/:id/versions/:versionId/audit
```

Request body:

```json
{
  "profile": "production-web"
}
```

The profile field can be optional and default to `production-web`.

Response:

```json
{
  "projectId": "project-id",
  "versionId": "version-id",
  "profile": "production-web",
  "status": "warning",
  "score": 82,
  "checks": []
}
```

Errors should use the existing API error shape:

```json
{
  "error": {
    "code": "VERSION_NOT_FOUND",
    "message": "Version not found"
  }
}
```

New error codes may be needed:

- `AUDIT_ARTIFACT_NOT_FOUND`
- `AUDIT_ENTRY_NOT_FOUND`
- `AUDIT_UNREADABLE_HTML`
- `AUDIT_PROFILE_INVALID`

## Frontend Architecture

Add an audit feature area:

```txt
apps/web/src/features/audit/
  AuditPanel.tsx
  AuditScore.tsx
  AuditCheckList.tsx
  useVersionAudit.ts
```

Recommended placement:

- Keep `ProjectList` on the left.
- Keep the selected project header at the top of the right pane.
- In the right pane, introduce tabs:
  - `Versions`
  - `Audit`

For Phase 1, the Audit tab can show:

- selected version picker, defaulting to active version
- profile selector
- "Run audit" button
- score/status summary
- grouped check list by category
- empty state when no version exists

This avoids adding another action button to every version row and leaves room for future audit history.

## Data Flow

```txt
User opens Audit tab
  -> useVersionAudit selects active version by default
  -> user clicks Run audit
  -> web client POSTs audit request
  -> route validates project id, version id, profile
  -> auditService loads project/version from repository
  -> auditService reads artifact index.html safely
  -> htmlAuditService parses HTML and emits checks
  -> domain/audit scores report
  -> UI renders grouped result
```

## Testing Plan

Backend service tests:

- Missing `index.html` returns an artifact error.
- Valid HTML with title, description, h1, viewport, lang returns passed or warning-free metadata checks.
- Missing title/description/h1 emits expected checks.
- Anchor/image/social checks produce expected severities.
- Relative asset existence checks work and stay inside the artifact root.
- Score/status logic is deterministic.

Backend API tests:

- Unknown project returns 404.
- Unknown version returns 404.
- Invalid profile returns 400.
- Valid version returns `AuditReport`.

Frontend unit tests:

- Audit panel empty state when no selected project/version exists.
- Run audit calls the client with project id, version id, and profile.
- Report renders score, status, grouped categories, and check severity.
- Failed request displays an error state.

## Future Phases

Phase 2: rendered DOM audit.

- Add a job-like API for Playwright-based inspection.
- Use deploy preview URLs.
- Add timeout, max redirects, max page size, and browser isolation.
- Compare static and rendered results.

Phase 3: persisted audit reports.

- Store latest report per version.
- Add audit history.
- Show report timestamp and changed status after re-upload or re-run.

Phase 4: release gates.

- Project setting: block activation when audit has errors.
- Profile-specific severity overrides.
- Manual override with history event.

Phase 5: CI/API integration.

- CLI or API token flow.
- Machine-readable reports.
- Optional GitHub check annotations later.

## Risks And Decisions

- Static HTML audits can produce false warnings for SPAs that generate metadata after hydration. This must be shown clearly in the UI.
- Enterprise deployments need configurable profiles; one fixed SEO score would be misleading.
- Browser rendering should wait until the static audit contract and UI are stable.
- The first implementation should not persist reports; avoiding schema churn is better until the result shape stabilizes.
- The feature should use parser libraries, safe path utilities, and existing service/repository boundaries instead of ad hoc file scanning.
