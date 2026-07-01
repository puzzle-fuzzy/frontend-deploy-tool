import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Data } from '@deploykit/shared';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError, ErrorCode } from '../../src/errors';
import type { ProjectRepository } from '../../src/repositories/projectRepository';
import { createAuditService } from '../../src/services/auditService';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'deploykit-version-audit-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeData(): Data {
  return {
    schemaVersion: 1,
    projects: [
      {
        id: 'project-1',
        name: 'Demo Project',
        slug: 'demo-project',
        description: '',
        createdAt: '2026-06-30T00:00:00.000Z',
        updatedAt: '2026-06-30T00:00:00.000Z',
        activeVersionId: null,
        settings: { spaMode: false, routingType: 'path' },
        versions: [
          {
            id: 'version-1',
            name: 'Initial',
            description: '',
            createdAt: '2026-06-30T00:00:00.000Z',
            size: 0,
            fileCount: 0,
            sourceType: 'folder',
          },
        ],
      },
    ],
    history: [],
  };
}

function makeRepo(data = makeData()): ProjectRepository {
  return {
    load: () => data,
    save: () => {
      throw new Error('audit reports are ephemeral and should not be saved');
    },
  };
}

function writeIndex(
  html: string,
  projectId = 'project-1',
  versionId = 'version-1'
) {
  const artifactRoot = join(tempDir, projectId, versionId);
  mkdirSync(artifactRoot, { recursive: true });
  writeFileSync(join(artifactRoot, 'index.html'), html);
  return artifactRoot;
}

function validHtml(): string {
  return `
    <!doctype html>
    <html lang="en">
      <head>
        <title>Demo</title>
        <meta name="description" content="Demo description.">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="canonical" href="https://example.com/">
        <meta property="og:title" content="Demo">
        <meta property="og:description" content="Demo description">
        <meta property="og:image" content="https://example.com/og.png">
        <meta name="twitter:card" content="summary_large_image">
      </head>
      <body>
        <h1>Demo</h1>
        <a href="/docs">Docs</a>
      </body>
    </html>
  `;
}

describe('createAuditService', () => {
  test('audits index.html for a known version', () => {
    writeIndex(validHtml());

    const report = createAuditService(makeRepo(), tempDir).runVersionAudit(
      'project-1',
      'version-1',
      'demo'
    );

    expect(report).toMatchObject({
      projectId: 'project-1',
      versionId: 'version-1',
      profile: 'demo',
      status: 'passed',
      score: 100,
      checks: [],
    });
    expect(new Date(report.createdAt).toString()).not.toBe('Invalid Date');
  });

  test('defaults omitted profile to production-web', () => {
    writeIndex(validHtml());

    const report = createAuditService(makeRepo(), tempDir).runVersionAudit(
      'project-1',
      'version-1'
    );

    expect(report.profile).toBe('production-web');
  });

  test('throws VERSION_NOT_FOUND for unknown version', () => {
    const service = createAuditService(makeRepo(), tempDir);

    const error = catchApiError(() =>
      service.runVersionAudit('project-1', 'missing-version')
    );

    expect(error.code).toBe(ErrorCode.VERSION_NOT_FOUND);
    expect(error.status).toBe(404);
  });

  test('throws AUDIT_ENTRY_NOT_FOUND when index.html is missing', () => {
    mkdirSync(join(tempDir, 'project-1', 'version-1'), { recursive: true });
    const service = createAuditService(makeRepo(), tempDir);

    const error = catchApiError(() =>
      service.runVersionAudit('project-1', 'version-1')
    );

    expect(error.code).toBe(ErrorCode.AUDIT_ENTRY_NOT_FOUND);
    expect(error.status).toBe(404);
  });

  test('throws AUDIT_PROFILE_INVALID for invalid profile', () => {
    writeIndex(validHtml());
    const service = createAuditService(makeRepo(), tempDir);

    const error = catchApiError(() =>
      service.runVersionAudit(
        'project-1',
        'version-1',
        'invalid-profile' as never
      )
    );

    expect(error.code).toBe(ErrorCode.AUDIT_PROFILE_INVALID);
    expect(error.status).toBe(400);
  });
});

function catchApiError(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error('Expected ApiError');
}
