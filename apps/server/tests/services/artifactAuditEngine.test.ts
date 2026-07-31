import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactAuditPolicy } from '@deploykit/shared';
import { ErrorCode } from '../../src/errors';
import {
  auditArtifactDirectory,
  MAX_AUDIT_HTML_BYTES,
} from '../../src/services/artifactAuditEngine';
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

let artifactDir: string;

beforeEach(() => {
  artifactDir = mkdtempSync(join(tmpdir(), 'deploykit-artifact-audit-'));
});

afterEach(() => {
  rmSync(artifactDir, { recursive: true, force: true });
});

describe('auditArtifactDirectory', () => {
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
