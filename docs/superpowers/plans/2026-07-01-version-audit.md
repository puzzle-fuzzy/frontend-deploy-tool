# Version Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 1 of Version Audit: a static artifact audit for uploaded frontend versions, exposed through Hono API and rendered in the right-side management UI.

**Architecture:** Add shared audit schemas/types first, then pure backend scoring and HTML inspection services, then wire an API route into the existing `createApiApp` composition. The frontend consumes the typed Hono client through `apps/web/src/shared/api.ts` and renders a dedicated Audit tab beside the existing Versions panel.

**Tech Stack:** Bun workspace, Hono, `hono/client`, Zod shared schemas, Cheerio for static HTML parsing, React, Vitest/React Testing Library, Bun test, Biome.

## Global Constraints

- Phase 1 only inspects stored artifact files; no Playwright, browser rendering, Lighthouse, public crawling, sitemap, robots.txt crawling, schema.org validation, release gates, or persisted audit history.
- Audit is version-level release quality checking. SEO is one category, not the top-level product concept.
- Default profile is `production-web` when the request omits a profile.
- Reports use explainable scoring: start at 100, subtract 15 per `error`, subtract 5 per `warning`, clamp to 0-100.
- Status rule: any `error` means `failed`; otherwise any `warning` means `warning`; otherwise `passed`.
- Backend services read artifacts from storage directly, not through deploy preview URLs.
- New code must follow existing boundaries: shared types in `packages/shared`, pure domain rules in `apps/server/src/domain`, filesystem-dependent services in `apps/server/src/services`, Hono adapters in `apps/server/src/routes`, React feature code in `apps/web/src/features`.
- Use a mature parser package for HTML parsing. Do not parse HTML with regular expressions.
- Keep reports ephemeral for Phase 1. Do not change the persisted metadata schema.
- Use TDD for each task and commit after each independently working task.
- Current repository may contain unrelated dirty files. Stage only the files listed in each task.

---

## File Structure

Create or modify these files:

- `packages/shared/src/domain.ts`: add audit Zod schemas and exported types.
- `apps/server/src/domain/audit.ts`: pure scoring and status helpers.
- `apps/server/tests/services/auditDomain.test.ts`: backend tests for scoring/status.
- `apps/server/src/services/htmlAuditService.ts`: parse an HTML string and emit audit checks.
- `apps/server/tests/services/htmlAuditService.test.ts`: service tests for metadata, SEO, links, images, social, and assets.
- `apps/server/src/services/auditService.ts`: locate project/version artifacts, read `index.html`, invoke HTML audit, score report.
- `apps/server/tests/services/auditService.test.ts`: tests for artifact resolution and missing entry errors.
- `apps/server/src/routes/audits.ts`: Hono route for `POST /api/projects/:id/versions/:versionId/audit`.
- `apps/server/src/api.ts`: inject `auditService` and mount audit routes.
- `apps/server/src/app.ts`: create `auditService` with repository and storage config.
- `apps/server/src/errors.ts`: add audit error codes.
- `apps/server/tests/api/audits.test.ts`: API contract tests.
- `package.json`: add `cheerio` to the root catalog.
- `apps/server/package.json`: add `cheerio` dependency via `catalog:`.
- `bun.lock`: updated by `bun install`.
- `apps/web/src/shared/api.ts`: add `runVersionAudit`.
- `apps/web/src/features/audit/useVersionAudit.ts`: hook for selected version/profile/report/loading/error state.
- `apps/web/src/features/audit/AuditScore.tsx`: score/status display.
- `apps/web/src/features/audit/AuditCheckList.tsx`: grouped checks.
- `apps/web/src/features/audit/AuditPanel.tsx`: tab content and controls.
- `apps/web/src/pages/DeployPage.tsx`: add Versions/Audit tabs in right pane.
- `apps/web/src/i18n/locales/en.json`: add visible text for the audit UI.
- `apps/web/src/i18n/locales/zh.json`: add matching Chinese copy if the file is already valid UTF-8 in the implementation branch; otherwise use existing project approach for i18n updates without introducing mojibake.
- `apps/web/tests/unit/AuditPanel.test.tsx`: UI behavior tests.
- `apps/web/tests/unit/useVersionAudit.test.ts`: hook tests.

---

### Task 1: Shared Audit Contract And Scoring Domain

**Files:**
- Modify: `packages/shared/src/domain.ts`
- Create: `apps/server/src/domain/audit.ts`
- Create: `apps/server/tests/services/auditDomain.test.ts`

**Interfaces:**
- Produces:
  - `auditProfileSchema`
  - `auditStatusSchema`
  - `auditSeveritySchema`
  - `auditCategorySchema`
  - `auditCheckSchema`
  - `auditReportSchema`
  - `type AuditProfile`
  - `type AuditStatus`
  - `type AuditSeverity`
  - `type AuditCategory`
  - `type AuditCheck`
  - `type AuditReport`
  - `DEFAULT_AUDIT_PROFILE = 'production-web'`
  - `scoreAudit(checks: AuditCheck[]): { score: number; status: AuditStatus }`

- [ ] **Step 1: Add failing domain tests**

Create `apps/server/tests/services/auditDomain.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { AuditCheck } from '@deploykit/shared';
import { scoreAudit } from '../../src/domain/audit';

const check = (severity: AuditCheck['severity']): AuditCheck => ({
  id: `check-${severity}`,
  category: 'metadata',
  severity,
  title: `${severity} check`,
  message: `${severity} message`,
});

describe('scoreAudit', () => {
  test('returns passed with a perfect score when there are no warnings or errors', () => {
    expect(scoreAudit([check('info')])).toEqual({
      score: 100,
      status: 'passed',
    });
  });

  test('subtracts five points per warning and sets warning status', () => {
    expect(scoreAudit([check('warning'), check('warning')])).toEqual({
      score: 90,
      status: 'warning',
    });
  });

  test('subtracts fifteen points per error and sets failed status', () => {
    expect(scoreAudit([check('warning'), check('error')])).toEqual({
      score: 80,
      status: 'failed',
    });
  });

  test('clamps score at zero', () => {
    expect(Array.from({ length: 10 }, () => check('error'))).toHaveLength(10);
    expect(scoreAudit(Array.from({ length: 10 }, () => check('error')))).toEqual({
      score: 0,
      status: 'failed',
    });
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
bun --filter @deploykit/server test tests/services/auditDomain.test.ts
```

Expected: FAIL because `../../src/domain/audit` does not exist.

- [ ] **Step 3: Add shared audit schemas and types**

Modify `packages/shared/src/domain.ts` by appending these schemas before `dataSchema` or near other domain schemas:

```ts
export const auditProfileSchema = z.enum([
  'demo',
  'production-web',
  'h5-campaign',
  'admin-app',
  'docs',
]);

export const auditStatusSchema = z.enum(['passed', 'warning', 'failed']);
export const auditSeveritySchema = z.enum(['info', 'warning', 'error']);
export const auditCategorySchema = z.enum([
  'metadata',
  'seo',
  'links',
  'images',
  'social',
  'assets',
  'deploy',
]);

export const auditCheckSchema = z.object({
  id: z.string(),
  category: auditCategorySchema,
  severity: auditSeveritySchema,
  title: z.string(),
  message: z.string(),
  location: z.string().optional(),
});

export const auditReportSchema = z.object({
  projectId: z.string(),
  versionId: z.string(),
  profile: auditProfileSchema,
  status: auditStatusSchema,
  score: z.number().int().min(0).max(100),
  checks: z.array(auditCheckSchema),
  createdAt: z.string(),
});
```

Add these exports at the bottom:

```ts
export type AuditProfile = z.infer<typeof auditProfileSchema>;
export type AuditStatus = z.infer<typeof auditStatusSchema>;
export type AuditSeverity = z.infer<typeof auditSeveritySchema>;
export type AuditCategory = z.infer<typeof auditCategorySchema>;
export type AuditCheck = z.infer<typeof auditCheckSchema>;
export type AuditReport = z.infer<typeof auditReportSchema>;
```

- [ ] **Step 4: Add scoring implementation**

Create `apps/server/src/domain/audit.ts`:

```ts
import type { AuditCheck, AuditStatus } from '@deploykit/shared';

export const DEFAULT_AUDIT_PROFILE = 'production-web' as const;

export function scoreAudit(checks: AuditCheck[]): {
  score: number;
  status: AuditStatus;
} {
  let score = 100;
  let hasWarning = false;
  let hasError = false;

  for (const check of checks) {
    if (check.severity === 'error') {
      score -= 15;
      hasError = true;
    }
    if (check.severity === 'warning') {
      score -= 5;
      hasWarning = true;
    }
  }

  return {
    score: Math.max(0, score),
    status: hasError ? 'failed' : hasWarning ? 'warning' : 'passed',
  };
}
```

- [ ] **Step 5: Verify task**

Run:

```bash
bun --filter @deploykit/server test tests/services/auditDomain.test.ts
bun --filter @deploykit/shared typecheck
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/domain.ts apps/server/src/domain/audit.ts apps/server/tests/services/auditDomain.test.ts
git commit -m "feat: add audit report contract"
```

---

### Task 2: Static HTML Audit Service

**Files:**
- Modify: `package.json`
- Modify: `apps/server/package.json`
- Modify: `bun.lock`
- Create: `apps/server/src/services/htmlAuditService.ts`
- Create: `apps/server/tests/services/htmlAuditService.test.ts`

**Interfaces:**
- Consumes:
  - `AuditCheck`
  - `AuditProfile`
- Produces:
  - `interface HtmlAuditInput { html: string; artifactRoot: string; profile: AuditProfile }`
  - `function auditHtml(input: HtmlAuditInput): AuditCheck[]`

- [ ] **Step 1: Install parser dependency**

Add Cheerio to the workspace:

```bash
bun add cheerio@latest --filter @deploykit/server
```

Then normalize dependency versions:

In root `package.json`, move `cheerio` into `workspaces.catalog`:

```json
"cheerio": "^1.1.2"
```

In `apps/server/package.json`, ensure:

```json
"cheerio": "catalog:"
```

Run:

```bash
bun install
```

Expected: `bun.lock`, root `package.json`, and `apps/server/package.json` are updated.

- [ ] **Step 2: Write failing HTML audit tests**

Create `apps/server/tests/services/htmlAuditService.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditHtml } from '../../src/services/htmlAuditService';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'deploykit-audit-'));
}

describe('auditHtml', () => {
  test('returns no warning checks for basic valid production web metadata', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'app.js'), 'console.log("ok");');

    const checks = auditHtml({
      artifactRoot: root,
      profile: 'production-web',
      html: `
        <!doctype html>
        <html lang="en">
          <head>
            <title>Example Product Landing Page</title>
            <meta name="description" content="A concise product description.">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <link rel="canonical" href="https://example.com/">
            <meta property="og:title" content="Example">
            <meta property="og:description" content="Example description">
            <meta property="og:image" content="https://example.com/og.png">
            <meta name="twitter:card" content="summary_large_image">
            <script src="./app.js"></script>
          </head>
          <body>
            <h1>Example</h1>
            <a href="/docs">Docs</a>
            <img src="https://example.com/image.png" alt="Example image">
          </body>
        </html>
      `,
    });

    expect(checks.filter((check) => check.severity !== 'info')).toEqual([]);
  });

  test('reports missing metadata, missing h1, unsafe links, and missing image alt', () => {
    const checks = auditHtml({
      artifactRoot: makeRoot(),
      profile: 'production-web',
      html: `
        <html>
          <head></head>
          <body>
            <a href="javascript:alert(1)">Bad link</a>
            <a href=""></a>
            <img src="/hero.png">
          </body>
        </html>
      `,
    });

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'metadata.title.missing', severity: 'error' }),
        expect.objectContaining({ id: 'metadata.description.missing', severity: 'warning' }),
        expect.objectContaining({ id: 'metadata.lang.missing', severity: 'warning' }),
        expect.objectContaining({ id: 'metadata.viewport.missing', severity: 'warning' }),
        expect.objectContaining({ id: 'seo.h1.missing', severity: 'warning' }),
        expect.objectContaining({ id: 'links.href.javascript', severity: 'error' }),
        expect.objectContaining({ id: 'links.text.empty', severity: 'warning' }),
        expect.objectContaining({ id: 'images.alt.missing', severity: 'warning' }),
      ])
    );
  });

  test('reports missing relative assets while ignoring absolute remote assets', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'present.css'), 'body {}');

    const checks = auditHtml({
      artifactRoot: root,
      profile: 'h5-campaign',
      html: `
        <html lang="en">
          <head>
            <title>Campaign</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <link rel="stylesheet" href="./present.css">
            <script src="./missing.js"></script>
          </head>
          <body>
            <h1>Campaign</h1>
            <img src="https://cdn.example.com/hero.png" alt="Hero">
          </body>
        </html>
      `,
    });

    expect(checks).toContainEqual(
      expect.objectContaining({
        id: 'assets.reference.missing',
        severity: 'error',
        location: './missing.js',
      })
    );
    expect(checks).not.toContainEqual(
      expect.objectContaining({ location: 'https://cdn.example.com/hero.png' })
    );
  });

  test('expects noindex for admin app profile', () => {
    const checks = auditHtml({
      artifactRoot: makeRoot(),
      profile: 'admin-app',
      html: `
        <html lang="en">
          <head>
            <title>Admin</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
          </head>
          <body><h1>Admin</h1></body>
        </html>
      `,
    });

    expect(checks).toContainEqual(
      expect.objectContaining({
        id: 'seo.robots.noindex.missing',
        severity: 'warning',
      })
    );
  });
});
```

- [ ] **Step 3: Run failing tests**

Run:

```bash
bun --filter @deploykit/server test tests/services/htmlAuditService.test.ts
```

Expected: FAIL because `htmlAuditService.ts` does not exist.

- [ ] **Step 4: Implement HTML audit service**

Create `apps/server/src/services/htmlAuditService.ts`:

```ts
import { existsSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { load } from 'cheerio';
import type { AuditCheck, AuditProfile } from '@deploykit/shared';
import { safeJoin } from '../utils/safePath';

export interface HtmlAuditInput {
  html: string;
  artifactRoot: string;
  profile: AuditProfile;
}

export function auditHtml({
  html,
  artifactRoot,
  profile,
}: HtmlAuditInput): AuditCheck[] {
  const $ = load(html);
  const checks: AuditCheck[] = [];

  const title = $('head title').first().text().trim();
  if (!title) {
    checks.push(check('metadata.title.missing', 'metadata', 'error', 'Missing title', 'Add a <title> tag to the document head.'));
  } else if (title.length < 10 || title.length > 70) {
    checks.push(check('metadata.title.length', 'metadata', 'warning', 'Title length may be suboptimal', 'Keep the title roughly between 10 and 70 characters.', '<title>'));
  }

  if (!$('meta[name="description"]').attr('content')?.trim()) {
    checks.push(check('metadata.description.missing', 'metadata', 'warning', 'Missing meta description', 'Add <meta name="description"> for search snippets and sharing previews.'));
  }

  if (!$('html').attr('lang')?.trim()) {
    checks.push(check('metadata.lang.missing', 'metadata', 'warning', 'Missing html lang', 'Add a lang attribute to the <html> element.'));
  }

  if (!$('meta[name="viewport"]').attr('content')?.trim()) {
    checks.push(check('metadata.viewport.missing', 'metadata', 'warning', 'Missing viewport meta', 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.'));
  }

  if (profile === 'production-web' || profile === 'docs') {
    if (!$('link[rel="canonical"]').attr('href')?.trim()) {
      checks.push(check('metadata.canonical.missing', 'metadata', 'warning', 'Missing canonical URL', 'Add <link rel="canonical"> for production website pages.'));
    }
  }

  const h1Count = $('h1').length;
  if (h1Count === 0) {
    checks.push(check('seo.h1.missing', 'seo', 'warning', 'Missing h1', 'Add one clear <h1> for the primary page heading.'));
  } else if (h1Count > 1) {
    checks.push(check('seo.h1.multiple', 'seo', 'warning', 'Multiple h1 elements', 'Use one primary <h1> unless this page intentionally has multiple document sections.', 'h1'));
  }

  auditHeadingOrder($('h1,h2,h3,h4,h5,h6').toArray().map((el) => Number(el.tagName.slice(1))), checks);
  auditRobots($, profile, checks);
  auditLinks($, checks);
  auditImages($, checks);
  auditSocial($, checks);
  auditAssetReferences($, artifactRoot, checks);

  return checks;
}

function auditHeadingOrder(levels: number[], checks: AuditCheck[]) {
  for (let i = 1; i < levels.length; i += 1) {
    if (levels[i] - levels[i - 1] > 1) {
      checks.push(check('seo.heading.order.skip', 'seo', 'warning', 'Heading level skipped', `Heading order jumps from h${levels[i - 1]} to h${levels[i]}.`));
      return;
    }
  }
}

function auditRobots(
  $: ReturnType<typeof load>,
  profile: AuditProfile,
  checks: AuditCheck[]
) {
  const robots = $('meta[name="robots"]').attr('content')?.toLowerCase() ?? '';
  if (profile === 'admin-app' && !robots.includes('noindex')) {
    checks.push(check('seo.robots.noindex.missing', 'seo', 'warning', 'Admin app is indexable', 'Admin applications should normally include <meta name="robots" content="noindex">.'));
  }
}

function auditLinks($: ReturnType<typeof load>, checks: AuditCheck[]) {
  $('a').each((index, el) => {
    const link = $(el);
    const href = link.attr('href')?.trim() ?? '';
    const label = link.text().trim() || link.attr('aria-label')?.trim() || link.attr('title')?.trim();

    if (!href) {
      checks.push(check('links.href.missing', 'links', 'warning', 'Anchor missing href', 'Anchor tags should include a non-empty href.', `a[${index}]`));
    }
    if (!label) {
      checks.push(check('links.text.empty', 'links', 'warning', 'Anchor has no accessible text', 'Add visible text, aria-label, or title to the link.', href || `a[${index}]`));
    }
    if (href.toLowerCase().startsWith('javascript:')) {
      checks.push(check('links.href.javascript', 'links', 'error', 'Unsafe javascript link', 'Avoid javascript: URLs in deployed artifacts.', href));
    }
    if (link.attr('target') === '_blank') {
      const rel = link.attr('rel') ?? '';
      if (!rel.includes('noopener') || !rel.includes('noreferrer')) {
        checks.push(check('links.external.rel.missing', 'links', 'warning', 'Blank target missing safe rel', 'Use rel="noopener noreferrer" with target="_blank".', href));
      }
    }
  });
}

function auditImages($: ReturnType<typeof load>, checks: AuditCheck[]) {
  $('img').each((index, el) => {
    const image = $(el);
    const src = image.attr('src')?.trim() ?? '';
    const alt = image.attr('alt');

    if (!src) {
      checks.push(check('images.src.missing', 'images', 'error', 'Image missing src', 'Image tags should include a non-empty src.', `img[${index}]`));
    }
    if (alt === undefined || alt.trim() === '') {
      checks.push(check('images.alt.missing', 'images', 'warning', 'Image missing alt text', 'Add alt text, or use alt="" only when the image is decorative.', src || `img[${index}]`));
    }
  });
}

function auditSocial($: ReturnType<typeof load>, checks: AuditCheck[]) {
  const required = [
    ['social.og.title.missing', 'og:title'],
    ['social.og.description.missing', 'og:description'],
    ['social.og.image.missing', 'og:image'],
  ] as const;

  for (const [id, property] of required) {
    if (!$(`meta[property="${property}"]`).attr('content')?.trim()) {
      checks.push(check(id, 'social', 'warning', `Missing ${property}`, `Add meta property="${property}" for social previews.`));
    }
  }

  if (!$('meta[name="twitter:card"]').attr('content')?.trim()) {
    checks.push(check('social.twitter.card.missing', 'social', 'warning', 'Missing twitter card', 'Add meta name="twitter:card" for social previews.'));
  }
}

function auditAssetReferences(
  $: ReturnType<typeof load>,
  artifactRoot: string,
  checks: AuditCheck[]
) {
  const references = [
    ...$('script[src]').toArray().map((el) => $(el).attr('src') ?? ''),
    ...$('link[href]').toArray().map((el) => $(el).attr('href') ?? ''),
    ...$('img[src]').toArray().map((el) => $(el).attr('src') ?? ''),
  ];

  for (const ref of references) {
    if (!isLocalReference(ref)) continue;
    const normalized = normalize(ref.split('#')[0].split('?')[0]).replace(/^[/\\]+/, '');
    if (!normalized || isAbsolute(normalized)) continue;
    const filePath = safeJoin(artifactRoot, normalized);
    if (!filePath || !existsSync(filePath)) {
      checks.push(check('assets.reference.missing', 'assets', 'error', 'Referenced asset is missing', 'A local asset referenced by HTML was not found in this version.', ref));
    }
  }
}

function isLocalReference(value: string): boolean {
  if (!value) return false;
  if (value.startsWith('#')) return false;
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) return false;
  if (value.startsWith('//')) return false;
  return true;
}

function check(
  id: AuditCheck['id'],
  category: AuditCheck['category'],
  severity: AuditCheck['severity'],
  title: string,
  message: string,
  location?: string
): AuditCheck {
  return { id, category, severity, title, message, location };
}
```

- [ ] **Step 5: Verify task**

Run:

```bash
bun --filter @deploykit/server test tests/services/htmlAuditService.test.ts
bun --filter @deploykit/server typecheck
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add package.json apps/server/package.json bun.lock apps/server/src/services/htmlAuditService.ts apps/server/tests/services/htmlAuditService.test.ts
git commit -m "feat: audit static html metadata"
```

---

### Task 3: Version Audit Service

**Files:**
- Modify: `apps/server/src/errors.ts`
- Create: `apps/server/src/services/auditService.ts`
- Create: `apps/server/tests/services/auditService.test.ts`

**Interfaces:**
- Consumes:
  - `ProjectRepository` from `apps/server/src/repositories/projectRepository.ts`
  - `auditHtml(input: HtmlAuditInput): AuditCheck[]`
  - `scoreAudit(checks: AuditCheck[])`
- Produces:
  - `interface AuditService { runVersionAudit(projectId: string, versionId: string, profile?: AuditProfile): AuditReport }`
  - `function createAuditService(repo: ProjectRepository, storageDir: string): AuditService`

- [ ] **Step 1: Write failing service tests**

Create `apps/server/tests/services/auditService.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Data } from '@deploykit/shared';
import { ApiError, ErrorCode } from '../../src/errors';
import type { ProjectRepository } from '../../src/repositories/projectRepository';
import { createAuditService } from '../../src/services/auditService';

function makeData(): Data {
  return {
    schemaVersion: 2,
    history: [],
    projects: [
      {
        id: 'project-1',
        name: 'Project',
        slug: 'project',
        description: '',
        createdAt: '',
        updatedAt: '',
        activeVersionId: 'version-1',
        settings: { spaMode: false, routingType: 'path' },
        versions: [
          {
            id: 'version-1',
            name: 'v1',
            description: '',
            createdAt: '',
            size: 0,
            fileCount: 0,
            sourceType: 'folder',
          },
        ],
      },
    ],
  };
}

function repo(data: Data): ProjectRepository {
  return {
    load: () => data,
    save: (next) => {
      data.projects = next.projects;
      data.history = next.history;
      data.schemaVersion = next.schemaVersion;
    },
  };
}

describe('createAuditService', () => {
  test('audits index.html for a known version', () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'deploykit-audit-service-'));
    const versionDir = join(storageDir, 'project-1', 'version-1');
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(
      join(versionDir, 'index.html'),
      '<html lang="en"><head><title>Audit Title</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><h1>Audit</h1></body></html>'
    );

    const report = createAuditService(repo(makeData()), storageDir).runVersionAudit(
      'project-1',
      'version-1',
      'demo'
    );

    expect(report).toEqual(
      expect.objectContaining({
        projectId: 'project-1',
        versionId: 'version-1',
        profile: 'demo',
        createdAt: expect.any(String),
      })
    );
    expect(report.score).toBeGreaterThanOrEqual(0);
  });

  test('defaults profile to production-web', () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'deploykit-audit-service-'));
    const versionDir = join(storageDir, 'project-1', 'version-1');
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(join(versionDir, 'index.html'), '<html><head></head><body></body></html>');

    const report = createAuditService(repo(makeData()), storageDir).runVersionAudit(
      'project-1',
      'version-1'
    );

    expect(report.profile).toBe('production-web');
  });

  test('throws VERSION_NOT_FOUND for an unknown version', () => {
    expect(() =>
      createAuditService(repo(makeData()), mkdtempSync(join(tmpdir(), 'deploykit-audit-service-'))).runVersionAudit(
        'project-1',
        'missing-version'
      )
    ).toThrow(new ApiError(ErrorCode.VERSION_NOT_FOUND, 'Version not found', 404));
  });

  test('throws AUDIT_ENTRY_NOT_FOUND when index.html is missing', () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'deploykit-audit-service-'));
    mkdirSync(join(storageDir, 'project-1', 'version-1'), { recursive: true });

    try {
      createAuditService(repo(makeData()), storageDir).runVersionAudit(
        'project-1',
        'version-1'
      );
      throw new Error('Expected audit to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe(ErrorCode.AUDIT_ENTRY_NOT_FOUND);
    }
  });
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
bun --filter @deploykit/server test tests/services/auditService.test.ts
```

Expected: FAIL because `auditService.ts` and audit error codes do not exist.

- [ ] **Step 3: Add audit error codes**

Modify `apps/server/src/errors.ts` and add these entries before `INTERNAL_ERROR`:

```ts
  AUDIT_ARTIFACT_NOT_FOUND: 'AUDIT_ARTIFACT_NOT_FOUND',
  AUDIT_ENTRY_NOT_FOUND: 'AUDIT_ENTRY_NOT_FOUND',
  AUDIT_UNREADABLE_HTML: 'AUDIT_UNREADABLE_HTML',
  AUDIT_PROFILE_INVALID: 'AUDIT_PROFILE_INVALID',
```

- [ ] **Step 4: Implement audit service**

Create `apps/server/src/services/auditService.ts`:

```ts
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AuditProfile, AuditReport } from '@deploykit/shared';
import { auditProfileSchema } from '@deploykit/shared';
import { DEFAULT_AUDIT_PROFILE, scoreAudit } from '../domain/audit';
import { ApiError, ErrorCode } from '../errors';
import type { ProjectRepository } from '../repositories/projectRepository';
import { auditHtml } from './htmlAuditService';

export interface AuditService {
  runVersionAudit(
    projectId: string,
    versionId: string,
    profile?: AuditProfile
  ): AuditReport;
}

export function createAuditService(
  repo: ProjectRepository,
  storageDir: string
): AuditService {
  return {
    runVersionAudit(projectId, versionId, profile = DEFAULT_AUDIT_PROFILE) {
      const parsedProfile = auditProfileSchema.safeParse(profile);
      if (!parsedProfile.success) {
        throw new ApiError(
          ErrorCode.AUDIT_PROFILE_INVALID,
          'Invalid audit profile'
        );
      }

      const data = repo.load();
      const project = data.projects.find((p) => p.id === projectId);
      if (!project) {
        throw new ApiError(ErrorCode.PROJECT_NOT_FOUND, 'Project not found', 404);
      }

      const version = project.versions.find((v) => v.id === versionId);
      if (!version) {
        throw new ApiError(ErrorCode.VERSION_NOT_FOUND, 'Version not found', 404);
      }

      const versionRoot = join(storageDir, project.id, version.id);
      if (!existsSync(versionRoot) || !statSync(versionRoot).isDirectory()) {
        throw new ApiError(
          ErrorCode.AUDIT_ARTIFACT_NOT_FOUND,
          'Version artifact directory not found',
          404
        );
      }

      const indexPath = join(versionRoot, 'index.html');
      if (!existsSync(indexPath) || !statSync(indexPath).isFile()) {
        throw new ApiError(
          ErrorCode.AUDIT_ENTRY_NOT_FOUND,
          'Version index.html not found',
          404
        );
      }

      let html: string;
      try {
        html = readFileSync(indexPath, 'utf8');
      } catch {
        throw new ApiError(
          ErrorCode.AUDIT_UNREADABLE_HTML,
          'Version index.html could not be read'
        );
      }

      const checks = auditHtml({
        html,
        artifactRoot: versionRoot,
        profile: parsedProfile.data,
      });
      const result = scoreAudit(checks);

      return {
        projectId,
        versionId,
        profile: parsedProfile.data,
        status: result.status,
        score: result.score,
        checks,
        createdAt: new Date().toISOString(),
      };
    },
  };
}
```

- [ ] **Step 5: Verify task**

Run:

```bash
bun --filter @deploykit/server test tests/services/auditService.test.ts
bun --filter @deploykit/server typecheck
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/errors.ts apps/server/src/services/auditService.ts apps/server/tests/services/auditService.test.ts
git commit -m "feat: add version audit service"
```

---

### Task 4: Hono Audit API Route

**Files:**
- Modify: `apps/server/src/services/contracts.ts`
- Create: `apps/server/src/routes/audits.ts`
- Modify: `apps/server/src/api.ts`
- Modify: `apps/server/src/app.ts`
- Create: `apps/server/tests/api/audits.test.ts`

**Interfaces:**
- Consumes:
  - `AuditService.runVersionAudit(projectId, versionId, profile?)`
- Produces:
  - `POST /api/projects/:id/versions/:versionId/audit`
  - typed route included in `ApiApp`

- [ ] **Step 1: Add service contract**

Modify the existing import in `apps/server/src/services/contracts.ts` so it becomes:

```ts
import type { AuditProfile, AuditReport } from '@deploykit/shared';
```

Add:

```ts
export interface AuditService {
  runVersionAudit(
    projectId: string,
    versionId: string,
    profile?: AuditProfile
  ): AuditReport;
}
```

Because `contracts.ts` already imports from `@deploykit/shared`, the final import should be:

```ts
import type {
  AuditProfile,
  AuditReport,
  CreateProjectInput,
  HistoryEvent,
  Project,
  Settings,
} from '@deploykit/shared';
```

- [ ] **Step 2: Write failing API tests**

Create `apps/server/tests/api/audits.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testClient } from 'hono/testing';
import { createApp } from '../../src/app';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'deploykit-audit-api-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function client() {
  return testClient(
    createApp({
      dataFile: join(tempDir, 'data.json'),
      storageDir: join(tempDir, 'storage'),
      publicDir: join(tempDir, 'public'),
    })
  );
}

async function createProject(api: ReturnType<typeof client>) {
  const res = await api.api.projects.$post({
    json: { name: 'Audit App', slug: 'audit-app', description: '' },
  });
  expect(res.status).toBe(201);
  return res.json();
}

test('runs a version audit through the API', async () => {
  const api = client();
  const project = await createProject(api);
  const upload = await api.api.projects[':id'].versions.$post({
    param: { id: project.id },
    form: {
      folderFiles: new File(
        [
          '<html lang="en"><head><title>Audit App</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><h1>Audit</h1></body></html>',
        ],
        'index.html'
      ),
      versionDesc: 'audit build',
    },
  });
  expect(upload.status).toBe(201);
  const created = await upload.json();

  const res = await api.api.projects[':id'].versions[':versionId'].audit.$post({
    param: { id: project.id, versionId: created.version.id },
    json: { profile: 'demo' },
  });

  expect(res.status).toBe(200);
  const report = await res.json();
  expect(report).toEqual(
    expect.objectContaining({
      projectId: project.id,
      versionId: created.version.id,
      profile: 'demo',
      score: expect.any(Number),
      checks: expect.any(Array),
    })
  );
});

test('rejects an invalid audit profile', async () => {
  const api = client();
  const project = await createProject(api);

  const res = await api.api.projects[':id'].versions[':versionId'].audit.$post({
    param: { id: project.id, versionId: 'missing-version' },
    json: { profile: 'invalid-profile' },
  });

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: {
      code: 'AUDIT_PROFILE_INVALID',
      message: 'Invalid audit profile',
    },
  });
});
```

- [ ] **Step 3: Run failing API tests**

Run:

```bash
bun --filter @deploykit/server test tests/api/audits.test.ts
```

Expected: FAIL because audit route is not mounted.

- [ ] **Step 4: Create audit route**

Create `apps/server/src/routes/audits.ts`:

```ts
import { Hono } from 'hono';
import { auditProfileSchema } from '@deploykit/shared';
import { parseIdParam } from '../domain/schemas';
import { ApiError, ErrorCode } from '../errors';
import type { AuditService } from '../services/contracts';

export function createAuditRoutes(deps: { auditService: AuditService }) {
  return new Hono().post(
    '/api/projects/:id/versions/:versionId/audit',
    async (c) => {
      const projectId = parseIdParam(c.req.param('id'));
      const versionId = parseIdParam(c.req.param('versionId'));
      const body = await c.req.json().catch(() => ({}));
      const profileInput =
        typeof body === 'object' && body && 'profile' in body
          ? (body as { profile?: unknown }).profile
          : undefined;

      const profile =
        profileInput === undefined
          ? undefined
          : auditProfileSchema.safeParse(profileInput);

      if (profile && !profile.success) {
        throw new ApiError(
          ErrorCode.AUDIT_PROFILE_INVALID,
          'Invalid audit profile'
        );
      }

      return c.json(
        deps.auditService.runVersionAudit(
          projectId,
          versionId,
          profile?.data
        )
      );
    }
  );
}
```

- [ ] **Step 5: Wire API composition**

Modify `apps/server/src/api.ts`:

```ts
import { createAuditRoutes } from './routes/audits';
import type { AuditService, ProjectService, VersionService } from './services/contracts';
```

Add `auditService` to `ApiDeps`:

```ts
  auditService: AuditService;
```

Mount the route after version routes:

```ts
    .route('/', createAuditRoutes({ auditService: deps.auditService }))
```

Modify `apps/server/src/app.ts`:

```ts
import { createAuditService } from './services/auditService';
```

Create the service:

```ts
  const auditService = createAuditService(repo, config.storageDir);
```

Pass it to `createApiApp`:

```ts
    auditService,
```

- [ ] **Step 6: Verify task**

Run:

```bash
bun --filter @deploykit/server test tests/api/audits.test.ts
bun --filter @deploykit/server typecheck
```

Expected: both pass.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/services/contracts.ts apps/server/src/routes/audits.ts apps/server/src/api.ts apps/server/src/app.ts apps/server/tests/api/audits.test.ts
git commit -m "feat: expose version audit api"
```

---

### Task 5: Web API Client And Audit Hook

**Files:**
- Modify: `apps/web/src/shared/api.ts`
- Create: `apps/web/src/features/audit/useVersionAudit.ts`
- Create: `apps/web/tests/unit/useVersionAudit.test.ts`

**Interfaces:**
- Consumes:
  - `api.runVersionAudit(projectId, versionId, profile)`
- Produces:
  - `useVersionAudit(project: Project | null)` with `{ selectedVersionId, setSelectedVersionId, profile, setProfile, report, loading, error, runAudit }`

- [ ] **Step 1: Add failing hook tests**

Create `apps/web/tests/unit/useVersionAudit.test.ts`:

```ts
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Project } from '@/shared/types';
import { useVersionAudit } from '@/features/audit/useVersionAudit';

vi.mock('@/shared/api', () => ({
  api: {
    runVersionAudit: vi.fn(),
  },
}));

const { api } = await import('@/shared/api');

const project: Project = {
  id: 'project-1',
  name: 'Project',
  slug: 'project',
  description: '',
  createdAt: '',
  updatedAt: '',
  activeVersionId: 'version-2',
  settings: { spaMode: false, routingType: 'path' },
  versions: [
    {
      id: 'version-1',
      name: 'v1',
      description: '',
      createdAt: '',
      size: 0,
      fileCount: 0,
      sourceType: 'folder',
    },
    {
      id: 'version-2',
      name: 'v2',
      description: '',
      createdAt: '',
      size: 0,
      fileCount: 0,
      sourceType: 'folder',
    },
  ],
};

describe('useVersionAudit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('selects the active version by default', () => {
    const { result } = renderHook(() => useVersionAudit(project));
    expect(result.current.selectedVersionId).toBe('version-2');
    expect(result.current.profile).toBe('production-web');
  });

  test('runs audit and stores the report', async () => {
    vi.mocked(api.runVersionAudit).mockResolvedValue({
      projectId: 'project-1',
      versionId: 'version-2',
      profile: 'production-web',
      status: 'passed',
      score: 100,
      checks: [],
      createdAt: '2026-07-01T00:00:00.000Z',
    });

    const { result } = renderHook(() => useVersionAudit(project));
    await act(async () => {
      await result.current.runAudit();
    });

    expect(api.runVersionAudit).toHaveBeenCalledWith(
      'project-1',
      'version-2',
      'production-web'
    );
    await waitFor(() => expect(result.current.report?.score).toBe(100));
  });
});
```

- [ ] **Step 2: Run failing hook tests**

Run:

```bash
bun --filter @deploykit/web test tests/unit/useVersionAudit.test.ts
```

Expected: FAIL because `useVersionAudit` and `runVersionAudit` do not exist.

- [ ] **Step 3: Add shared API method**

Modify `apps/web/src/shared/api.ts`:

```ts
import type { AuditProfile, AuditReport, Project, Settings } from './types';
```

Add inside `api`:

```ts
  runVersionAudit: async (
    projectId: string,
    versionId: string,
    profile: AuditProfile
  ): Promise<AuditReport> => {
    const res = await client.api.projects[':id'].versions[
      ':versionId'
    ].audit.$post({
      param: { id: projectId, versionId },
      json: { profile },
    });
    await checkOk(res);
    return res.json();
  },
```

If `apps/web/src/shared/types.ts` does not re-export audit types from `@deploykit/shared`, add:

```ts
export type {
  AuditCategory,
  AuditCheck,
  AuditProfile,
  AuditReport,
  AuditSeverity,
  AuditStatus,
} from '@deploykit/shared';
```

- [ ] **Step 4: Implement hook**

Create `apps/web/src/features/audit/useVersionAudit.ts`:

```ts
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/shared/api';
import type { AuditProfile, AuditReport, Project } from '@/shared/types';

export function useVersionAudit(project: Project | null) {
  const defaultVersionId = useMemo(() => {
    if (!project) return '';
    return project.activeVersionId ?? project.versions[0]?.id ?? '';
  }, [project]);

  const [selectedVersionId, setSelectedVersionId] = useState(defaultVersionId);
  const [profile, setProfile] = useState<AuditProfile>('production-web');
  const [report, setReport] = useState<AuditReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedVersionId(defaultVersionId);
    setReport(null);
    setError(null);
  }, [defaultVersionId]);

  const runAudit = async () => {
    if (!project || !selectedVersionId) return;
    setLoading(true);
    setError(null);
    try {
      const nextReport = await api.runVersionAudit(
        project.id,
        selectedVersionId,
        profile
      );
      setReport(nextReport);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Audit failed');
    } finally {
      setLoading(false);
    }
  };

  return {
    selectedVersionId,
    setSelectedVersionId,
    profile,
    setProfile,
    report,
    loading,
    error,
    runAudit,
  };
}
```

- [ ] **Step 5: Verify task**

Run:

```bash
bun --filter @deploykit/web test tests/unit/useVersionAudit.test.ts
bun --filter @deploykit/web typecheck
```

Expected: hook test passes. If existing unrelated web tests fail, record them but do not fix them in this task.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/shared/api.ts apps/web/src/shared/types.ts apps/web/src/features/audit/useVersionAudit.ts apps/web/tests/unit/useVersionAudit.test.ts
git commit -m "feat: add version audit client hook"
```

---

### Task 6: Audit UI Panel

**Files:**
- Create: `apps/web/src/features/audit/AuditScore.tsx`
- Create: `apps/web/src/features/audit/AuditCheckList.tsx`
- Create: `apps/web/src/features/audit/AuditPanel.tsx`
- Create: `apps/web/tests/unit/AuditPanel.test.tsx`
- Modify: `apps/web/src/i18n/locales/en.json`
- Modify: `apps/web/src/i18n/locales/zh.json`

**Interfaces:**
- Consumes:
  - `useVersionAudit(project)`
  - `Project`
  - audit report types
- Produces:
  - `AuditPanel({ project }: { project: Project })`

- [ ] **Step 1: Write failing UI tests**

Create `apps/web/tests/unit/AuditPanel.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { AuditPanel } from '@/features/audit/AuditPanel';
import type { Project } from '@/shared/types';

vi.mock('@/shared/api', () => ({
  api: {
    runVersionAudit: vi.fn(),
  },
}));

const { api } = await import('@/shared/api');

const project: Project = {
  id: 'project-1',
  name: 'Project',
  slug: 'project',
  description: '',
  createdAt: '',
  updatedAt: '',
  activeVersionId: 'version-1',
  settings: { spaMode: false, routingType: 'path' },
  versions: [
    {
      id: 'version-1',
      name: 'v1',
      description: '',
      createdAt: '',
      size: 0,
      fileCount: 0,
      sourceType: 'folder',
    },
  ],
};

describe('AuditPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('renders an empty state when there are no versions', () => {
    render(<AuditPanel project={{ ...project, versions: [], activeVersionId: null }} />);
    expect(screen.getByText('audit.empty')).toBeInTheDocument();
  });

  test('runs an audit and renders grouped checks', async () => {
    vi.mocked(api.runVersionAudit).mockResolvedValue({
      projectId: 'project-1',
      versionId: 'version-1',
      profile: 'production-web',
      status: 'warning',
      score: 95,
      createdAt: '2026-07-01T00:00:00.000Z',
      checks: [
        {
          id: 'metadata.description.missing',
          category: 'metadata',
          severity: 'warning',
          title: 'Missing meta description',
          message: 'Add meta description.',
        },
      ],
    });

    render(<AuditPanel project={project} />);
    fireEvent.click(screen.getByRole('button', { name: 'audit.run' }));

    await waitFor(() => {
      expect(screen.getByText('95')).toBeInTheDocument();
      expect(screen.getByText('Missing meta description')).toBeInTheDocument();
      expect(screen.getByText('Add meta description.')).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 2: Run failing UI tests**

Run:

```bash
bun --filter @deploykit/web test tests/unit/AuditPanel.test.tsx
```

Expected: FAIL because UI files do not exist.

- [ ] **Step 3: Add i18n keys**

Modify `apps/web/src/i18n/locales/en.json` and add:

```json
"audit": {
  "title": "Audit",
  "versions": "Version",
  "profile": "Profile",
  "run": "Run audit",
  "running": "Auditing...",
  "empty": "Upload a version before running an audit.",
  "noReport": "Run an audit to inspect this version.",
  "score": "Score",
  "passed": "Passed",
  "warning": "Warnings",
  "failed": "Failed"
}
```

Modify `apps/web/src/i18n/locales/zh.json` with matching keys. If the file is valid UTF-8 in the implementation branch, use Chinese strings. If the branch still has mojibake, first fix the locale encoding in a separate commit, then add these keys.

- [ ] **Step 4: Implement score component**

Create `apps/web/src/features/audit/AuditScore.tsx`:

```tsx
import type { AuditReport } from '@/shared/types';

export function AuditScore({ report }: { report: AuditReport }) {
  const tone =
    report.status === 'failed'
      ? 'text-destructive'
      : report.status === 'warning'
        ? 'text-amber-600'
        : 'text-emerald-600';

  return (
    <div className="flex items-center gap-3">
      <div className={`text-3xl font-semibold ${tone}`}>{report.score}</div>
      <div className="text-sm text-muted-foreground">{report.status}</div>
    </div>
  );
}
```

- [ ] **Step 5: Implement check list**

Create `apps/web/src/features/audit/AuditCheckList.tsx`:

```tsx
import type { AuditCategory, AuditCheck } from '@/shared/types';

const categories: AuditCategory[] = [
  'metadata',
  'seo',
  'links',
  'images',
  'social',
  'assets',
  'deploy',
];

export function AuditCheckList({ checks }: { checks: AuditCheck[] }) {
  return (
    <div className="space-y-4">
      {categories.map((category) => {
        const categoryChecks = checks.filter((check) => check.category === category);
        if (categoryChecks.length === 0) return null;

        return (
          <section key={category} className="space-y-2">
            <h3 className="text-xs font-medium uppercase text-muted-foreground">
              {category}
            </h3>
            <div className="space-y-2">
              {categoryChecks.map((check) => (
                <div key={`${check.id}-${check.location ?? ''}`} className="rounded-md border border-border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium">{check.title}</p>
                    <span className="text-xs text-muted-foreground">
                      {check.severity}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {check.message}
                  </p>
                  {check.location && (
                    <code className="mt-2 block text-xs text-muted-foreground">
                      {check.location}
                    </code>
                  )}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 6: Implement audit panel**

Create `apps/web/src/features/audit/AuditPanel.tsx`:

```tsx
import { useTranslation } from 'react-i18next';
import { Button } from '@/shared/ui/button';
import type { AuditProfile, Project } from '@/shared/types';
import { AuditCheckList } from './AuditCheckList';
import { AuditScore } from './AuditScore';
import { useVersionAudit } from './useVersionAudit';

const profiles: AuditProfile[] = [
  'demo',
  'production-web',
  'h5-campaign',
  'admin-app',
  'docs',
];

export function AuditPanel({ project }: { project: Project }) {
  const { t } = useTranslation();
  const audit = useVersionAudit(project);

  if (project.versions.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        {t('audit.empty')}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-5 space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1">
          <span className="block text-xs font-medium text-muted-foreground">
            {t('audit.versions')}
          </span>
          <select
            value={audit.selectedVersionId}
            onChange={(event) => audit.setSelectedVersionId(event.target.value)}
            className="h-8 rounded-md border border-border bg-background px-2 text-sm"
          >
            {project.versions.map((version) => (
              <option key={version.id} value={version.id}>
                {version.name}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1">
          <span className="block text-xs font-medium text-muted-foreground">
            {t('audit.profile')}
          </span>
          <select
            value={audit.profile}
            onChange={(event) =>
              audit.setProfile(event.target.value as AuditProfile)
            }
            className="h-8 rounded-md border border-border bg-background px-2 text-sm"
          >
            {profiles.map((profile) => (
              <option key={profile} value={profile}>
                {profile}
              </option>
            ))}
          </select>
        </label>

        <Button onClick={audit.runAudit} disabled={audit.loading}>
          {audit.loading ? t('audit.running') : t('audit.run')}
        </Button>
      </div>

      {audit.error && (
        <p className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
          {audit.error}
        </p>
      )}

      {audit.report ? (
        <>
          <AuditScore report={audit.report} />
          <AuditCheckList checks={audit.report.checks} />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t('audit.noReport')}</p>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Verify task**

Run:

```bash
bun --filter @deploykit/web test tests/unit/AuditPanel.test.tsx
bun --filter @deploykit/web typecheck
```

Expected: test and typecheck pass, unless existing unrelated React invalid hook call failures remain outside this test file.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/features/audit apps/web/tests/unit/AuditPanel.test.tsx apps/web/src/i18n/locales/en.json apps/web/src/i18n/locales/zh.json
git commit -m "feat: add version audit panel"
```

---

### Task 7: Integrate Audit Tab Into Deploy Page

**Files:**
- Modify: `apps/web/src/pages/DeployPage.tsx`
- Modify: `apps/web/tests/unit/DeployPage.test.tsx` if this test file exists; otherwise create `apps/web/tests/unit/DeployPageAuditTab.test.tsx`

**Interfaces:**
- Consumes:
  - `AuditPanel({ project })`
  - `VersionList`
- Produces:
  - Right pane tabs: Versions and Audit.

- [ ] **Step 1: Write failing integration test**

If `apps/web/tests/unit/DeployPage.test.tsx` does not exist, create `apps/web/tests/unit/DeployPageAuditTab.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { DeployPage } from '@/pages/DeployPage';

vi.mock('@/shared/api', () => ({
  api: {
    listProjects: vi.fn(),
    activateVersion: vi.fn(),
    deleteVersion: vi.fn(),
    runVersionAudit: vi.fn(),
  },
}));

const { api } = await import('@/shared/api');

describe('DeployPage audit tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listProjects).mockResolvedValue([
      {
        id: 'project-1',
        name: 'Project',
        slug: 'project',
        description: '',
        createdAt: '',
        updatedAt: '',
        activeVersionId: 'version-1',
        settings: { spaMode: false, routingType: 'path' },
        versions: [
          {
            id: 'version-1',
            name: 'v1',
            description: '',
            createdAt: '',
            size: 0,
            fileCount: 0,
            sourceType: 'folder',
          },
        ],
      },
    ]);
  });

  test('shows audit panel when the audit tab is selected', async () => {
    render(<DeployPage />);

    await waitFor(() => expect(screen.getByText('Project')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Project'));
    fireEvent.click(screen.getByRole('tab', { name: 'audit.title' }));

    expect(screen.getByRole('button', { name: 'audit.run' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
bun --filter @deploykit/web test tests/unit/DeployPageAuditTab.test.tsx
```

Expected: FAIL because tabs are not implemented.

- [ ] **Step 3: Add local tab state and render AuditPanel**

Modify `apps/web/src/pages/DeployPage.tsx`:

```tsx
import { AuditPanel } from '@/features/audit/AuditPanel';
```

Inside `DeployPage`:

```tsx
const [rightTab, setRightTab] = useState<'versions' | 'audit'>('versions');
```

Replace the direct `VersionList` render with:

```tsx
<div className="flex border-b border-border px-5">
  <button
    type="button"
    role="tab"
    aria-selected={rightTab === 'versions'}
    className={`px-3 py-2 text-sm ${rightTab === 'versions' ? 'text-foreground' : 'text-muted-foreground'}`}
    onClick={() => setRightTab('versions')}
  >
    {t('versions.title')}
  </button>
  <button
    type="button"
    role="tab"
    aria-selected={rightTab === 'audit'}
    className={`px-3 py-2 text-sm ${rightTab === 'audit' ? 'text-foreground' : 'text-muted-foreground'}`}
    onClick={() => setRightTab('audit')}
  >
    {t('audit.title')}
  </button>
</div>

{rightTab === 'versions' ? (
  <VersionList
    project={selectedProject}
    pendingVersionId={pendingVersionId}
    onActivate={activateVersion}
    onDelete={deleteVersion}
  />
) : (
  <AuditPanel project={selectedProject} />
)}
```

- [ ] **Step 4: Verify task**

Run:

```bash
bun --filter @deploykit/web test tests/unit/DeployPageAuditTab.test.tsx
bun --filter @deploykit/web typecheck
```

Expected: new integration test passes.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/DeployPage.tsx apps/web/tests/unit/DeployPageAuditTab.test.tsx
git commit -m "feat: show version audit tab"
```

---

### Task 8: End-To-End Verification And Documentation Notes

**Files:**
- Modify: `TODO.md`
- Optional Modify: `docs/architecture.md` only if its encoding has been repaired in the implementation branch; otherwise leave it untouched.

**Interfaces:**
- Consumes all prior tasks.
- Produces a verified feature branch with TODO status updated.

- [ ] **Step 1: Update TODO**

Add or mark a section in `TODO.md`:

```md
- [x] Add Phase 1 Version Audit.
  - [x] Shared audit report contract.
  - [x] Static HTML audit service.
  - [x] Version audit API endpoint.
  - [x] Frontend audit panel.
  - [ ] Rendered DOM audit later.
  - [ ] Persisted audit reports later.
  - [ ] Release gates later.
```

- [ ] **Step 2: Run full verification**

Run:

```bash
bun run format:check
bun run check
bun run typecheck
bun run lint
bun --filter @deploykit/server test
bun --filter @deploykit/web test tests/unit/useVersionAudit.test.ts tests/unit/AuditPanel.test.tsx tests/unit/DeployPageAuditTab.test.tsx
bun run build
git diff --check
```

Expected:

- All new backend tests pass.
- All new frontend audit tests pass.
- `bun run build` passes.
- If full `bun run test` still fails because of pre-existing unrelated React invalid hook call failures, document the exact failing command and confirm the targeted audit tests pass.

- [ ] **Step 3: Commit verification/doc update**

```bash
git add TODO.md
git commit -m "docs: track version audit progress"
```

- [ ] **Step 4: Final implementation summary**

Prepare final summary with:

- API endpoint added.
- Audit categories implemented.
- UI entry point added.
- Verification commands and results.
- Explicit note if pre-existing web test failures remain outside the new audit tests.

---

## Self-Review

Spec coverage:

- Version-level release quality audit: Tasks 1-7.
- Static artifact inspection: Tasks 2-4.
- Multiple audit profiles with `production-web` default: Tasks 1, 3, 5, 6.
- No browser rendering, no persistence, no release gate: preserved by task scope.
- Shared contract: Task 1.
- Backend domain/service/route split: Tasks 1-4.
- Frontend audit feature area and right-pane tab: Tasks 5-7.
- Testing plan: Tasks 1-8.

Placeholder scan:

- This plan intentionally avoids vague tokens, deferred-work phrases, and vague "add tests" steps.
- Every task has exact file paths, concrete code snippets, commands, expected outcomes, and commit commands.

Type consistency:

- `AuditProfile`, `AuditCheck`, and `AuditReport` originate from `packages/shared/src/domain.ts`.
- `scoreAudit` is defined in `apps/server/src/domain/audit.ts` and consumed by `auditService.ts`.
- `auditHtml` is defined in `htmlAuditService.ts` and consumed by `auditService.ts`.
- `runVersionAudit` is the service, route, and frontend client method name.
