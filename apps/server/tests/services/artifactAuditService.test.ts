import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ArtifactAuditReport,
  Data,
  Project,
  Version,
} from '@deploykit/shared';
import { assertArtifactAuditAllowsRelease } from '../../src/domain/artifactAudit';
import { createEmptyData } from '../../src/domain/schema';
import { ErrorCode } from '../../src/errors';
import { createJsonProjectRepository } from '../../src/repositories/jsonProjectRepository';
import {
  ARTIFACT_AUDIT_ENGINE_VERSION,
  auditArtifactDirectory,
} from '../../src/services/artifactAuditEngine';
import { createArtifactAuditService } from '../../src/services/artifactAuditService';
import { checksumDirectory } from '../../src/services/artifactService';

let tempDir: string;
let storageDir: string;
let dataFile: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'deploykit-audit-service-'));
  storageDir = join(tempDir, 'storage');
  dataFile = join(tempDir, 'data.json');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('createArtifactAuditService', () => {
  test('persists one current report and appends compact history for every run', () => {
    const { repo } = createFixture();
    const service = createArtifactAuditService(repo, storageDir, {
      now: () => new Date('2026-07-30T00:00:00.000Z'),
    });

    const first = service.runArtifactAudit('project-1', 'version-1', 'owner-1');
    const second = service.runArtifactAudit(
      'project-1',
      'version-1',
      'owner-1'
    );
    const stored = repo.load();

    expect(first.status).toBe('warning');
    expect(second.id).not.toBe(first.id);
    expect(stored.artifactAudits).toEqual([second]);
    expect(
      stored.history.filter((event) => event.action === 'version.audit')
    ).toHaveLength(2);
    expect(stored.history[0]).toMatchObject({
      action: 'version.audit',
      versionId: 'version-1',
      metadata: {
        reportId: second.id,
        status: second.status,
        score: second.score,
        totalBytes: second.summary.totalBytes,
        fileCount: second.summary.fileCount,
        engineVersion: ARTIFACT_AUDIT_ENGINE_VERSION,
      },
    });
    expect(service.getArtifactAudit('project-1', 'version-1')).toEqual(second);
  });

  test('rejects a missing report and does not disclose a cross-project version', () => {
    const { repo, data } = createFixture();
    data.projects.push(projectFixture('project-2', 'version-2'));
    repo.save(data);
    const service = createArtifactAuditService(repo, storageDir);

    expect(() => service.getArtifactAudit('project-1', 'version-1')).toThrow(
      expect.objectContaining({ code: ErrorCode.AUDIT_NOT_FOUND })
    );
    expect(() => service.getArtifactAudit('project-2', 'version-1')).toThrow(
      expect.objectContaining({ code: ErrorCode.VERSION_NOT_FOUND })
    );
  });

  test('rejects a result when files change during the audit', () => {
    const { repo, artifactDir } = createFixture();
    const service = createArtifactAuditService(repo, storageDir, {
      audit(path, checksum, policy) {
        const result = auditArtifactDirectory(path, checksum, policy);
        writeFileSync(join(artifactDir, 'changed.js'), 'changed');
        return result;
      },
    });

    expect(() =>
      service.runArtifactAudit('project-1', 'version-1', 'owner-1')
    ).toThrow(expect.objectContaining({ code: ErrorCode.AUDIT_FAILED }));
    expect(repo.load().artifactAudits).toEqual([]);
  });

  test('rejects a result when the project policy changes during the audit', () => {
    const { repo } = createFixture();
    const service = createArtifactAuditService(repo, storageDir, {
      audit(path, checksum, policy) {
        const result = auditArtifactDirectory(path, checksum, policy);
        repo.mutate((data) => {
          data.projects[0].auditPolicy.maxTotalBytes -= 1;
        });
        return result;
      },
    });

    expect(() =>
      service.runArtifactAudit('project-1', 'version-1', 'owner-1')
    ).toThrow(expect.objectContaining({ code: ErrorCode.AUDIT_FAILED }));
    expect(repo.load().artifactAudits).toEqual([]);
  });
});

describe('assertArtifactAuditAllowsRelease', () => {
  test('advisory policy never introduces an audit release gate', () => {
    const { data, project, version } = createInMemoryData();
    expect(() =>
      assertArtifactAuditAllowsRelease(data, project, version)
    ).not.toThrow();
  });

  test('blocking policy requires a current report with current budgets and engine', () => {
    const { data, project, version } = createInMemoryData();
    project.auditPolicy.enforcement = 'blocking';

    expect(() =>
      assertArtifactAuditAllowsRelease(data, project, version)
    ).toThrow(expect.objectContaining({ code: ErrorCode.AUDIT_REQUIRED }));

    const report = reportFixture(project, version);
    data.artifactAudits.push(report);
    expect(() =>
      assertArtifactAuditAllowsRelease(data, project, version)
    ).not.toThrow();

    report.policy.maxTotalBytes -= 1;
    expect(() =>
      assertArtifactAuditAllowsRelease(data, project, version)
    ).toThrow(expect.objectContaining({ code: ErrorCode.AUDIT_REQUIRED }));
  });

  test('blocking policy rejects a current report with error findings', () => {
    const { data, project, version } = createInMemoryData();
    project.auditPolicy.enforcement = 'blocking';
    data.artifactAudits.push({
      ...reportFixture(project, version),
      status: 'failed',
    });

    expect(() =>
      assertArtifactAuditAllowsRelease(data, project, version)
    ).toThrow(expect.objectContaining({ code: ErrorCode.AUDIT_BLOCKED }));
  });
});

function createFixture() {
  const repo = createJsonProjectRepository(dataFile);
  const data = createEmptyData();
  const artifactDir = join(storageDir, 'project-1', 'version-1');
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    join(artifactDir, 'index.html'),
    '<html><head><title>Preview</title></head><body></body></html>'
  );
  const project = projectFixture('project-1', 'version-1');
  project.versions[0].checksum = checksumDirectory(artifactDir);
  project.versions[0].size = 61;
  data.projects.push(project);
  repo.save(data);
  return { repo, data, artifactDir };
}

function createInMemoryData(): {
  data: Data;
  project: Project;
  version: Version;
} {
  const data = createEmptyData();
  const project = projectFixture('project-1', 'version-1');
  data.projects.push(project);
  return { data, project, version: project.versions[0] };
}

function projectFixture(projectId: string, versionId: string): Project {
  return {
    id: projectId,
    name: projectId,
    slug: projectId,
    description: '',
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    versions: [
      {
        id: versionId,
        name: versionId,
        description: '',
        createdAt: '2026-07-30T00:00:00.000Z',
        size: 0,
        fileCount: 1,
        sourceType: 'folder',
        status: 'preview',
        publishedAt: null,
        publishedBy: null,
        checksum: 'checksum-1',
        integrityStatus: 'unknown',
        integrityCheckedAt: null,
      },
    ],
    activeVersionId: null,
    settings: { spaMode: false, routingType: 'path' },
    auditPolicy: {
      enforcement: 'advisory',
      maxTotalBytes: 50 * 1024 * 1024,
      maxFileBytes: 10 * 1024 * 1024,
      maxFileCount: 1_000,
      maxJavaScriptBytes: 10 * 1024 * 1024,
      maxStylesheetBytes: 2 * 1024 * 1024,
      maxFontBytes: 10 * 1024 * 1024,
    },
    createdBy: 'owner-1',
    members: [
      {
        userId: 'owner-1',
        role: 'owner',
        invitedAt: '2026-07-30T00:00:00.000Z',
      },
    ],
  };
}

function reportFixture(
  project: Project,
  version: Version
): ArtifactAuditReport {
  return {
    id: 'report-1',
    projectId: project.id,
    versionId: version.id,
    artifactChecksum: version.checksum,
    status: 'warning',
    score: 90,
    createdAt: '2026-07-30T00:00:00.000Z',
    createdBy: 'owner-1',
    engineVersion: ARTIFACT_AUDIT_ENGINE_VERSION,
    policy: structuredClone(project.auditPolicy),
    context: structuredClone(project.settings),
    summary: {
      totalBytes: version.size,
      fileCount: version.fileCount,
      largestFiles: [],
      extensions: [],
      assetBytes: {
        javascript: 0,
        stylesheet: 0,
        font: 0,
        image: 0,
      },
    },
    checks: [],
  };
}
