import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  type ArtifactAuditContext,
  type ArtifactAuditPolicy,
  artifactAuditCheckSchema,
} from '@deploykit/shared';
import {
  ARTIFACT_AUDIT_ENGINE_VERSION,
  ARTIFACT_AUDIT_RULES,
  ARTIFACT_AUDIT_RULESET_ID,
} from '../../src/domain/artifactAuditRules';
import { ErrorCode } from '../../src/errors';
import {
  auditArtifactDirectory,
  MAX_AUDIT_HTML_BYTES,
  summarizeArtifactExtensions,
} from '../../src/services/artifactAuditEngine';
import { artifactAuditExecutionResultSchema } from '../../src/services/artifactAuditProtocol';
import { checksumDirectory } from '../../src/services/artifactService';

const policy: ArtifactAuditPolicy = {
  enforcement: 'advisory',
  maxTotalBytes: 1_000_000,
  maxFileBytes: 500_000,
  maxFileCount: 100,
  maxJavaScriptBytes: 500_000,
  maxStylesheetBytes: 250_000,
  maxFontBytes: 500_000,
};
const staticContext: ArtifactAuditContext = {
  spaMode: false,
  routingType: 'path',
};

let artifactDir: string;

beforeEach(() => {
  artifactDir = mkdtempSync(join(tmpdir(), 'deploykit-artifact-audit-'));
});

afterEach(() => {
  rmSync(artifactDir, { recursive: true, force: true });
});

describe('auditArtifactDirectory', () => {
  test('publishes a stable v2 catalog and derives every emitted check metadata from it', () => {
    writeCompleteArtifact();
    const result = auditArtifactDirectory(
      artifactDir,
      checksumDirectory(artifactDir),
      policy,
      staticContext
    );
    const ruleIds = Object.keys(ARTIFACT_AUDIT_RULES);

    expect(ARTIFACT_AUDIT_RULESET_ID).toBe('deploykit-static');
    expect(ARTIFACT_AUDIT_ENGINE_VERSION).toBe(2);
    expect(new Set(ruleIds).size).toBe(ruleIds.length);
    for (const check of result.checks) {
      const rule =
        ARTIFACT_AUDIT_RULES[check.id as keyof typeof ARTIFACT_AUDIT_RULES];
      expect(rule).toBeDefined();
      expect(check).toMatchObject({
        ruleVersion: rule.version,
        category: rule.category,
        severity: check.passed ? 'info' : rule.failureSeverity,
      });
    }
  });

  test('passes a complete static document and reports a deterministic inventory', () => {
    writeCompleteArtifact();
    const checksum = checksumDirectory(artifactDir);

    const first = auditArtifactDirectory(artifactDir, checksum, policy);
    const second = auditArtifactDirectory(artifactDir, checksum, policy);

    expect(first).toEqual(second);
    expect(first.status).toBe('passed');
    expect(first.score).toBe(100);
    expect(first.summary.fileCount).toBe(4);
    expect(first.summary.largestFiles.map((file) => file.path)).toContain(
      'index.html'
    );
    expect(first.summary.extensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ extension: '.html', count: 1 }),
        expect.objectContaining({ extension: '.txt', count: 1 }),
        expect.objectContaining({ extension: '.xml', count: 1 }),
      ])
    );
    expect(first.checks.every((check) => check.passed)).toBe(true);
  });

  test('returns warnings for incomplete SEO without treating them as structural failure', () => {
    writeFileSync(
      join(artifactDir, 'index.html'),
      '<html><head><title>Short</title></head><body></body></html>'
    );
    const result = auditArtifactDirectory(
      artifactDir,
      checksumDirectory(artifactDir),
      policy
    );

    expect(result.status).toBe('warning');
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'seo.description',
          passed: false,
          severity: 'warning',
        }),
        expect.objectContaining({
          id: 'seo.h1',
          passed: false,
          severity: 'warning',
        }),
      ])
    );
  });

  test('fails hard budgets and an artifact checksum mismatch', () => {
    writeFileSync(join(artifactDir, 'index.html'), 'x'.repeat(200));
    writeFileSync(join(artifactDir, 'large.js'), 'x'.repeat(300));

    const result = auditArtifactDirectory(artifactDir, 'old-checksum', {
      ...policy,
      maxTotalBytes: 400,
      maxFileBytes: 250,
      maxFileCount: 1,
    });

    expect(result.status).toBe('failed');
    for (const id of [
      'structure.checksum',
      'size.total',
      'size.file_count',
      'size.largest_file',
    ]) {
      expect(result.checks).toContainEqual(
        expect.objectContaining({ id, passed: false, severity: 'error' })
      );
    }
  });

  test('reports invalid JSON-LD as a warning', () => {
    writeFileSync(
      join(artifactDir, 'index.html'),
      `<html lang="en"><head>
        <title>A complete document title</title>
        <script type="application/ld+json">{bad json}</script>
      </head><body><h1>Heading</h1></body></html>`
    );

    const result = auditArtifactDirectory(
      artifactDir,
      checksumDirectory(artifactDir),
      policy
    );

    expect(result.checks).toContainEqual(
      expect.objectContaining({
        id: 'seo.json_ld',
        passed: false,
        severity: 'warning',
        message: 'At least one JSON-LD document is invalid JSON',
      })
    );
  });

  test('does not parse an index document beyond the hard parser budget', () => {
    writeFileSync(
      join(artifactDir, 'index.html'),
      'x'.repeat(MAX_AUDIT_HTML_BYTES + 1)
    );
    const result = auditArtifactDirectory(
      artifactDir,
      checksumDirectory(artifactDir),
      {
        ...policy,
        maxTotalBytes: MAX_AUDIT_HTML_BYTES + 100,
        maxFileBytes: MAX_AUDIT_HTML_BYTES + 100,
      }
    );

    expect(result.status).toBe('failed');
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        id: 'structure.index_html_size',
        passed: false,
        severity: 'error',
      })
    );
    expect(result.checks.some((check) => check.category === 'seo')).toBe(false);
  });

  test('rejects symbolic links instead of following them', () => {
    writeFileSync(join(artifactDir, 'index.html'), '<html></html>');
    symlinkSync(
      join(artifactDir, 'index.html'),
      join(artifactDir, 'alias.html')
    );

    expect(() =>
      auditArtifactDirectory(artifactDir, 'checksum', policy)
    ).toThrow(
      expect.objectContaining({
        code: ErrorCode.AUDIT_FAILED,
      })
    );
  });

  test('totals explicit asset extensions using raw bytes and enforces each asset budget', () => {
    writeFileSync(join(artifactDir, 'index.html'), '<html></html>');
    writeFileSync(join(artifactDir, 'app.js'), 'j'.repeat(11));
    writeFileSync(join(artifactDir, 'app.css'), 'c'.repeat(7));
    writeFileSync(join(artifactDir, 'font.woff2'), 'f'.repeat(5));
    writeFileSync(join(artifactDir, 'image.webp'), 'i'.repeat(3));
    writeFileSync(join(artifactDir, 'not-js.json'), 'n'.repeat(13));

    const result = auditArtifactDirectory(
      artifactDir,
      checksumDirectory(artifactDir),
      {
        ...policy,
        maxJavaScriptBytes: 10,
        maxStylesheetBytes: 6,
        maxFontBytes: 4,
      },
      staticContext
    );

    expect(result.summary.assetBytes).toEqual({
      javascript: 11,
      stylesheet: 7,
      font: 5,
      image: 3,
    });
    for (const id of [
      'assets.javascript_budget',
      'assets.stylesheet_budget',
      'assets.font_budget',
    ]) {
      expect(result.checks).toContainEqual(
        expect.objectContaining({ id, passed: false, severity: 'error' })
      );
    }
  });

  test('resolves local asset and image targets after query, fragment, base, and percent decoding', () => {
    mkdirSync(join(artifactDir, 'nested', 'assets'), { recursive: true });
    writeFileSync(join(artifactDir, 'nested', 'assets', 'app.js'), '');
    writeFileSync(join(artifactDir, 'nested', 'assets', 'app.css'), '');
    writeFileSync(join(artifactDir, 'nested', 'assets', 'photo.png'), '');
    writeFileSync(
      join(artifactDir, 'index.html'),
      `<html><head>
        <base href="/nested/">
        <base href="https://ignored.example/">
        <script src="assets&sol;app.js?v=1#boot"></script>
        <link rel="preload stylesheet" href="assets&#47;app.css?theme=dark#main">
      </head><body>
        <img src="assets&sol;photo%2Epng?size=2#hero" alt="">
      </body></html>`
    );

    const result = auditArtifactDirectory(
      artifactDir,
      checksumDirectory(artifactDir),
      policy,
      staticContext
    );

    for (const id of [
      'assets.script_target',
      'assets.stylesheet_target',
      'images.source',
      'images.alt_attribute',
      'images.local_target',
    ]) {
      expect(result.checks).toContainEqual(
        expect.objectContaining({ id, passed: true, severity: 'info' })
      );
    }
  });

  test('aggregates traversal and malformed local targets without escaping or leaking details', () => {
    const outsidePath = join(
      artifactDir,
      '..',
      `${basename(artifactDir)}-outside.js`
    );
    writeFileSync(outsidePath, 'must not be reachable');
    try {
      writeFileSync(
        join(artifactDir, 'index.html'),
        `<html><head>
          <script src="/%2e%2e/${basename(outsidePath)}"></script>
          <script src="%E0%A4%A"></script>
          <link rel="stylesheet" href="http://[malformed">
        </head><body>
          <img src="/%2e%2e/secret.png" alt="">
          <a href="%E0%A4%A">malformed link</a>
        </body></html>`
      );

      const result = auditArtifactDirectory(
        artifactDir,
        checksumDirectory(artifactDir),
        policy,
        staticContext
      );

      expect(result.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'assets.script_target',
            passed: false,
            actual: 2,
          }),
          expect.objectContaining({
            id: 'assets.stylesheet_target',
            passed: false,
            actual: 1,
          }),
          expect.objectContaining({
            id: 'images.local_target',
            passed: false,
            actual: 1,
          }),
          expect.objectContaining({
            id: 'links.local_target',
            passed: false,
            actual: 1,
          }),
        ])
      );
      expect(JSON.stringify(result.checks)).not.toContain(artifactDir);
      expect(JSON.stringify(result.checks)).not.toContain(outsidePath);
      expect(JSON.stringify(result.checks)).not.toContain('%E0%A4%A');
    } finally {
      rmSync(outsidePath, { force: true });
    }
  });

  test('accepts decorative alt text and aggregates only missing image attributes', () => {
    writeFileSync(join(artifactDir, 'photo.png'), '');
    writeFileSync(
      join(artifactDir, 'index.html'),
      `<html><body>
        <img src="/photo.png" alt="">
        <img src="/photo.png">
        <img alt="missing source">
      </body></html>`
    );

    const result = auditArtifactDirectory(
      artifactDir,
      checksumDirectory(artifactDir),
      policy,
      staticContext
    );

    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'images.source',
          passed: false,
          actual: 1,
        }),
        expect.objectContaining({
          id: 'images.alt_attribute',
          passed: false,
          actual: 1,
        }),
        expect.objectContaining({
          id: 'images.local_target',
          passed: true,
        }),
      ])
    );
  });

  test('warns for javascript anchors and only high-confidence missing static links', () => {
    mkdirSync(join(artifactDir, 'docs'), { recursive: true });
    writeFileSync(join(artifactDir, 'docs', 'index.html'), '');
    writeFileSync(join(artifactDir, 'feed.xml'), '');
    writeFileSync(
      join(artifactDir, 'index.html'),
      `<html><body>
        <a href="javascript:void(0)">unsafe</a>
        <a href="/">root</a>
        <a href="/docs/">docs</a>
        <a href="/feed.xml?view=full#top">feed</a>
        <a href="/missing/">missing directory</a>
        <a href="/missing.html">missing file</a>
        <a href="/dynamic-route">unknown route</a>
        <a href="#local">fragment</a>
        <a href="data:text/plain,ignored">data</a>
        <a href="blob:https://example.com/id">blob</a>
        <a href="//example.com/external">external</a>
        <a href="https://example.com/external">external</a>
      </body></html>`
    );

    const result = auditArtifactDirectory(
      artifactDir,
      checksumDirectory(artifactDir),
      policy,
      staticContext
    );
    const spaResult = auditArtifactDirectory(
      artifactDir,
      checksumDirectory(artifactDir),
      policy,
      { ...staticContext, spaMode: true }
    );

    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'links.javascript_url',
          passed: false,
          actual: 1,
        }),
        expect.objectContaining({
          id: 'links.local_target',
          passed: false,
          actual: 2,
        }),
      ])
    );
    expect(spaResult.checks).toContainEqual(
      expect.objectContaining({
        id: 'links.local_target',
        passed: true,
        actual: 0,
      })
    );
  });

  test('normalizes browser-equivalent entity and control encodings before javascript classification', () => {
    writeFileSync(
      join(artifactDir, 'index.html'),
      `<html><body>
        <a href="javascript&#58;void(0)">named colon</a>
        <a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;void(0)">numeric scheme</a>
        <a href="java&#10;script:alert(1)">newline</a>
        <a href="java&#9;script:alert(1)">tab</a>
        <a href="java&#x0A;script&#x3A;alert(1)">hex controls</a>
        <a href="javascript&colon;alert(1)">named entity</a>
      </body></html>`
    );

    const result = auditArtifactDirectory(
      artifactDir,
      checksumDirectory(artifactDir),
      policy,
      staticContext
    );
    const javascriptCheck = result.checks.find(
      (check) => check.id === 'links.javascript_url'
    );

    expect(javascriptCheck).toMatchObject({
      passed: false,
      actual: 6,
    });
    expect(JSON.stringify(javascriptCheck)).not.toContain('void(0)');
    expect(JSON.stringify(javascriptCheck)).not.toContain(artifactDir);
  });

  test('treats relative references under an external base as unverifiable external targets', () => {
    writeFileSync(
      join(artifactDir, 'index.html'),
      `<html><head>
        <base href="https://cdn.example/assets/">
        <script src="missing.js"></script>
        <link rel="stylesheet" href="missing.css">
      </head><body>
        <img src="missing.png" alt="">
        <a href="missing.html">missing</a>
      </body></html>`
    );

    const result = auditArtifactDirectory(
      artifactDir,
      checksumDirectory(artifactDir),
      policy,
      staticContext
    );

    for (const id of [
      'assets.script_target',
      'assets.stylesheet_target',
      'images.local_target',
      'links.local_target',
    ]) {
      expect(result.checks).toContainEqual(
        expect.objectContaining({ id, passed: true, actual: 0 })
      );
    }
  });

  test('keeps relative references external under an entity-encoded external base', () => {
    writeFileSync(
      join(artifactDir, 'index.html'),
      `<html><head>
        <base href="https&colon;&sol;&sol;cdn.example&sol;assets&sol;">
        <script src="missing.js"></script>
        <link rel="stylesheet" href="missing.css">
      </head><body>
        <img src="missing.png" alt="">
        <a href="missing.html">missing</a>
      </body></html>`
    );

    const result = auditArtifactDirectory(
      artifactDir,
      checksumDirectory(artifactDir),
      policy,
      staticContext
    );

    for (const id of [
      'assets.script_target',
      'assets.stylesheet_target',
      'images.local_target',
      'links.local_target',
    ]) {
      expect(result.checks).toContainEqual(
        expect.objectContaining({ id, passed: true, actual: 0 })
      );
    }
  });

  test('caps extension summaries at a deterministic top 50 plus other bucket', () => {
    const extensions = Array.from({ length: 100_000 }, (_, index) => ({
      extension: `.x${index.toString().padStart(6, '0')}`,
      bytes: 1,
      count: 1,
    }));

    const first = summarizeArtifactExtensions(extensions);
    const second = summarizeArtifactExtensions([...extensions].reverse());

    expect(first).toEqual(second);
    expect(first).toHaveLength(51);
    expect(first.slice(0, 50).map((entry) => entry.extension)).toEqual(
      extensions.slice(0, 50).map((entry) => entry.extension)
    );
    expect(first[50]).toEqual({
      extension: '(other)',
      bytes: 99_950,
      count: 99_950,
    });
  });

  test('keeps thousands of bad references bounded to one check per rule', () => {
    const repeated = Array.from(
      { length: 4_000 },
      (_, index) =>
        `<script src="/missing-${index}.js"></script>` +
        `<img src="/missing-${index}.png">` +
        `<a href="/missing-${index}.html">missing</a>`
    ).join('');
    writeFileSync(join(artifactDir, 'index.html'), `<html>${repeated}</html>`);

    const result = auditArtifactDirectory(
      artifactDir,
      checksumDirectory(artifactDir),
      policy,
      staticContext
    );

    for (const id of [
      'assets.script_target',
      'images.alt_attribute',
      'images.local_target',
      'links.local_target',
    ]) {
      expect(result.checks.filter((check) => check.id === id)).toHaveLength(1);
      expect(result.checks.find((check) => check.id === id)?.actual).toBe(
        4_000
      );
    }
    expect(result.checks.length).toBeLessThan(1_000);
  });

  test('validates new executor output against the catalog while historic checks remain readable', () => {
    writeFileSync(
      join(artifactDir, 'index.html'),
      '<html><head><title>Short</title></head><body></body></html>'
    );
    const valid = auditArtifactDirectory(
      artifactDir,
      checksumDirectory(artifactDir),
      policy,
      staticContext
    );
    expect(artifactAuditExecutionResultSchema.safeParse(valid).success).toBe(
      true
    );

    const first = valid.checks[0];
    const failed = valid.checks.find((check) => !check.passed);
    if (!first || !failed) throw new Error('protocol fixture is incomplete');
    const invalidChecks = [
      [...valid.checks, first],
      [{ ...first, id: 'unknown.rule' }, ...valid.checks.slice(1)],
      [{ ...first, ruleVersion: 999 }, ...valid.checks.slice(1)],
      [{ ...first, category: 'seo' as const }, ...valid.checks.slice(1)],
      valid.checks.map((check) =>
        check.id === failed.id
          ? { ...check, severity: 'error' as const }
          : check
      ),
    ];
    for (const checks of invalidChecks) {
      expect(
        artifactAuditExecutionResultSchema.safeParse({ ...valid, checks })
          .success
      ).toBe(false);
    }

    expect(
      artifactAuditCheckSchema.safeParse({
        id: 'historic.removed_rule',
        ruleVersion: 1,
        category: 'structure',
        severity: 'warning',
        passed: false,
        message: 'Historic persisted finding',
      }).success
    ).toBe(true);
  });
});

function writeCompleteArtifact(): void {
  mkdirSync(join(artifactDir, 'assets'), { recursive: true });
  writeFileSync(
    join(artifactDir, 'index.html'),
    `<!doctype html>
    <html lang="en">
      <head>
        <title>DeployKit artifact audit reference page</title>
        <meta name="description" content="${'A'.repeat(80)}">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="robots" content="index,follow">
        <meta property="og:title" content="DeployKit artifact audit">
        <meta property="og:description" content="A deployable reference page">
        <meta property="og:image" content="https://example.com/cover.png">
        <link rel="canonical" href="https://example.com/reference">
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"WebSite"}
        </script>
      </head>
      <body><h1>DeployKit artifact audit</h1></body>
    </html>`
  );
  writeFileSync(join(artifactDir, 'robots.txt'), 'User-agent: *\\nAllow: /');
  writeFileSync(
    join(artifactDir, 'sitemap.xml'),
    '<urlset><url><loc>https://example.com/</loc></url></urlset>'
  );
  writeFileSync(join(artifactDir, 'assets', 'app.js'), 'console.log("ok")');
}
