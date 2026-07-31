import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ArtifactAuditAssessment,
  ArtifactAuditReport,
  Data,
  Project,
  Version,
} from '@deploykit/shared';
import {
  assertArtifactAuditAllowsRelease,
  assessArtifactAudit,
} from '../../src/domain/artifactAudit';
import { createEmptyData } from '../../src/domain/schema';
import { ErrorCode } from '../../src/errors';
import { createJsonProjectRepository } from '../../src/repositories/jsonProjectRepository';
import {
  ARTIFACT_AUDIT_ENGINE_VERSION,
  ArtifactAuditInspectionError,
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

  test('maps only typed inspection failures to the safe synchronous AUDIT_FAILED contract', () => {
    const { repo, artifactDir } = createFixture();
    const service = createArtifactAuditService(repo, storageDir, {
      audit() {
        const error = new ArtifactAuditInspectionError('AUDIT_ARTIFACT_UNSAFE');
        error.message = `unsafe entry at ${artifactDir}`;
        throw error;
      },
    });

    expect(() =>
      service.runArtifactAudit('project-1', 'version-1', 'owner-1')
    ).toThrow(
      expect.objectContaining({
        code: ErrorCode.AUDIT_FAILED,
        message: 'Artifact contains an unsafe filesystem entry',
        status: 409,
      })
    );
  });

  test('does not convert unexpected synchronous engine exceptions', () => {
    const { repo, artifactDir } = createFixture();
    const unexpected = new Error(`unexpected engine failure at ${artifactDir}`);
    const service = createArtifactAuditService(repo, storageDir, {
      audit() {
        throw unexpected;
      },
    });

    expect(() =>
      service.runArtifactAudit('project-1', 'version-1', 'owner-1')
    ).toThrow(unexpected);
  });

  test('passes the snapshotted routing context into the synchronous engine', () => {
    const { repo } = createFixture();
    repo.mutate((data) => {
      data.projects[0].settings.spaMode = true;
      data.projects[0].settings.routingType = 'hash';
    });
    const observed: { context: Project['settings'] | null } = {
      context: null,
    };
    const service = createArtifactAuditService(repo, storageDir, {
      audit(path, checksum, policy, context) {
        observed.context = structuredClone(context);
        return auditArtifactDirectory(path, checksum, policy, context);
      },
    });

    service.runArtifactAudit('project-1', 'version-1', 'owner-1');

    expect(observed.context).toEqual({
      spaMode: true,
      routingType: 'hash',
    });
  });
});

describe('assertArtifactAuditAllowsRelease', () => {
  test('returns the complete freshness and release matrix', () => {
    const { data, project, version } = createInMemoryData();
    const missing: ArtifactAuditAssessment = assessArtifactAudit(
      data,
      project,
      version
    );
    expect(missing).toEqual({
      report: null,
      freshness: 'missing',
      staleReasons: [],
      currentEngineVersion: ARTIFACT_AUDIT_ENGINE_VERSION,
      release: { allowed: true, reason: 'advisory' },
    });

    project.auditPolicy.enforcement = 'blocking';
    expect(assessArtifactAudit(data, project, version)).toMatchObject({
      freshness: 'missing',
      release: { allowed: false, reason: 'audit_required' },
    });

    const report = reportFixture(project, version);
    data.artifactAudits.push(report);
    for (const status of ['passed', 'warning'] as const) {
      report.status = status;
      expect(assessArtifactAudit(data, project, version)).toMatchObject({
        report,
        freshness: 'current',
        staleReasons: [],
        release: { allowed: true, reason: 'current_report' },
      });
    }

    report.status = 'failed';
    expect(assessArtifactAudit(data, project, version)).toMatchObject({
      freshness: 'current',
      release: { allowed: false, reason: 'audit_blocked' },
    });

    project.auditPolicy.enforcement = 'advisory';
    expect(assessArtifactAudit(data, project, version)).toMatchObject({
      freshness: 'current',
      release: { allowed: true, reason: 'advisory' },
    });
  });

  test('selects the current report by both project and version id', () => {
    const { data, project, version } = createInMemoryData();
    const otherProject = projectFixture('project-2', version.id);
    data.projects.push(otherProject);
    data.artifactAudits.push(
      reportFixture(otherProject, otherProject.versions[0])
    );

    expect(assessArtifactAudit(data, project, version)).toMatchObject({
      report: null,
      freshness: 'missing',
      staleReasons: [],
    });
  });

  test('compares every scan input while excluding enforcement', () => {
    const mutations: Array<{
      name: string;
      reason: ArtifactAuditAssessment['staleReasons'][number];
      mutate: (report: ArtifactAuditReport, project: Project) => void;
    }> = [
      {
        name: 'checksum',
        reason: 'checksum_changed',
        mutate: (report) => {
          report.artifactChecksum = 'old-checksum';
        },
      },
      {
        name: 'engine',
        reason: 'engine_changed',
        mutate: (report) => {
          report.engineVersion = 1;
        },
      },
      ...(
        [
          'maxTotalBytes',
          'maxFileBytes',
          'maxFileCount',
          'maxJavaScriptBytes',
          'maxStylesheetBytes',
          'maxFontBytes',
        ] as const
      ).map((field) => ({
        name: field,
        reason: 'rule_config_changed' as const,
        mutate: (report: ArtifactAuditReport) => {
          report.policy[field] -= 1;
        },
      })),
      {
        name: 'spa mode',
        reason: 'context_changed',
        mutate: (report) => {
          report.context.spaMode = true;
        },
      },
      {
        name: 'routing type',
        reason: 'context_changed',
        mutate: (report) => {
          report.context.routingType = 'hash';
        },
      },
    ];

    for (const scenario of mutations) {
      const { data, project, version } = createInMemoryData();
      const report = reportFixture(project, version);
      data.artifactAudits.push(report);
      scenario.mutate(report, project);
      expect(assessArtifactAudit(data, project, version)).toMatchObject({
        freshness: 'stale',
        staleReasons: [scenario.reason],
      });
    }

    const { data, project, version } = createInMemoryData();
    const report = reportFixture(project, version);
    data.artifactAudits.push(report);
    report.policy.enforcement = 'blocking';
    expect(assessArtifactAudit(data, project, version)).toMatchObject({
      freshness: 'current',
      staleReasons: [],
      release: { allowed: true, reason: 'advisory' },
    });
  });

  test('orders multiple stale reasons and requires a fresh scan before blocking findings', () => {
    const { data, project, version } = createInMemoryData();
    project.auditPolicy.enforcement = 'blocking';
    const report = reportFixture(project, version);
    report.status = 'failed';
    report.artifactChecksum = 'old-checksum';
    report.engineVersion = 1;
    report.policy.maxFontBytes -= 1;
    report.context.routingType = 'hash';
    data.artifactAudits.push(report);

    expect(assessArtifactAudit(data, project, version)).toMatchObject({
      freshness: 'stale',
      staleReasons: [
        'checksum_changed',
        'engine_changed',
        'rule_config_changed',
        'context_changed',
      ],
      release: { allowed: false, reason: 'audit_required' },
    });

    expect(() =>
      assertArtifactAuditAllowsRelease(data, project, version)
    ).toThrow(expect.objectContaining({ code: ErrorCode.AUDIT_REQUIRED }));
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
