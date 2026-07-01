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
        expect.objectContaining({
          id: 'metadata.title.missing',
          severity: 'error',
        }),
        expect.objectContaining({
          id: 'metadata.description.missing',
          severity: 'warning',
        }),
        expect.objectContaining({
          id: 'metadata.lang.missing',
          severity: 'warning',
        }),
        expect.objectContaining({
          id: 'metadata.viewport.missing',
          severity: 'warning',
        }),
        expect.objectContaining({ id: 'seo.h1.missing', severity: 'warning' }),
        expect.objectContaining({
          id: 'links.href.javascript',
          severity: 'error',
        }),
        expect.objectContaining({
          id: 'links.text.empty',
          severity: 'warning',
        }),
        expect.objectContaining({
          id: 'images.alt.missing',
          severity: 'warning',
        }),
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
