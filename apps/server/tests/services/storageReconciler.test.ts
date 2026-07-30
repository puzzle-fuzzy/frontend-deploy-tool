import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Data, Project, Version } from '@deploykit/shared';
import type { ProjectRepository } from '../../src/repositories/projectRepository';
import { createArtifactRecoveryService } from '../../src/services/artifactRecovery';
import { collectStorageGarbage } from '../../src/services/storageGarbageCollector';
import { reconcileStorage } from '../../src/services/storageReconciler';

function version(id: string, status: Version['status'] = 'preview'): Version {
  return {
    id,
    name: id,
    description: '',
    createdAt: '2026-07-24T00:00:00.000Z',
    size: 1,
    fileCount: 1,
    sourceType: 'folder',
    status,
    publishedAt: status === 'production' ? '2026-07-24T00:00:00.000Z' : null,
    publishedBy: status === 'production' ? 'user-1' : null,
    checksum: id,
    integrityStatus: 'unknown',
    integrityCheckedAt: null,
  };
}

function project(): Project {
  return {
    id: 'p1',
    name: 'Demo',
    slug: 'demo',
    description: '',
    createdAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:00.000Z',
    versions: [
      version('missing-active', 'production'),
      version('missing-preview'),
      version('healthy-preview'),
    ],
    activeVersionId: 'missing-active',
    settings: { spaMode: false, routingType: 'path' },
    auditPolicy: {
      enforcement: 'advisory',
      maxTotalBytes: 50 * 1024 * 1024,
      maxFileBytes: 10 * 1024 * 1024,
      maxFileCount: 1_000,
    },
    createdBy: 'user-1',
    members: [
      {
        userId: 'user-1',
        role: 'owner',
        invitedAt: '2026-07-24T00:00:00.000Z',
      },
    ],
  };
}

function repository(data: Data): ProjectRepository {
  return {
    load: () => data,
    save: () => {},
    mutate: (operation) => operation(data),
  };
}

describe('reconcileStorage', () => {
  test('cleans incomplete and orphan artifacts, then marks missing metadata failed', () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'deploykit-reconcile-'));
    const demoProject = project();
    const data: Data = {
      schemaVersion: 5,
      projects: [demoProject],
      users: [],
      history: [],
      artifactAudits: [],
      artifactAuditJobs: [],
    };

    mkdirSync(join(storageDir, '.staging', 'incomplete'), {
      recursive: true,
    });
    writeFileSync(
      join(storageDir, '.staging', 'incomplete', 'index.html'),
      'partial'
    );
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(join(storageDir, '.staging', 'incomplete'), stale, stale);
    mkdirSync(join(storageDir, 'p1', 'healthy-preview'), { recursive: true });
    writeFileSync(
      join(storageDir, 'p1', 'healthy-preview', 'index.html'),
      'healthy'
    );
    mkdirSync(join(storageDir, 'p1', 'orphan-version'), { recursive: true });
    writeFileSync(
      join(storageDir, 'p1', 'orphan-version', 'index.html'),
      'orphan'
    );
    mkdirSync(join(storageDir, 'orphan-project', 'orphan-version'), {
      recursive: true,
    });
    writeFileSync(
      join(storageDir, 'orphan-project', 'orphan-version', 'index.html'),
      'orphan'
    );
    const ancient = new Date('2000-01-01T00:00:00.000Z');
    utimesSync(join(storageDir, 'orphan-project'), ancient, ancient);

    try {
      const report = reconcileStorage(repository(data), storageDir);

      expect(report).toEqual({
        restoredInterruptedOperations: 0,
        committedInterruptedOperations: 0,
        recoveryConflicts: 0,
        removedStagingEntries: 1,
        removedCommittedTrashEntries: 0,
        removedOrphanEntries: 0,
        quarantinedOrphanVersions: 2,
        markedFailedVersions: 2,
        deactivatedProjects: 1,
      });
      expect(existsSync(join(storageDir, '.staging'))).toBe(false);
      expect(existsSync(join(storageDir, 'p1', 'orphan-version'))).toBe(false);
      expect(existsSync(join(storageDir, 'orphan-project'))).toBe(false);
      expect(
        existsSync(
          join(
            storageDir,
            '.recovery',
            'orphans',
            'p1',
            'orphan-version',
            'index.html'
          )
        )
      ).toBe(true);
      expect(
        collectStorageGarbage(storageDir, {
          now: new Date(Date.now() + 60 * 60 * 1000),
        }).removedOrphanEntries
      ).toBe(0);
      expect(
        existsSync(
          join(
            storageDir,
            '.recovery',
            'orphans',
            'orphan-project',
            'orphan-version',
            'index.html'
          )
        )
      ).toBe(true);
      expect(
        existsSync(
          join(
            storageDir,
            '.recovery',
            'orphans',
            'orphan-project',
            'orphan-version',
            'index.html'
          )
        )
      ).toBe(true);
      expect(
        existsSync(join(storageDir, 'p1', 'healthy-preview', 'index.html'))
      ).toBe(true);
      expect(demoProject.activeVersionId).toBeNull();
      expect(
        demoProject.versions
          .filter((item) => item.status === 'failed')
          .map((item) => item.id)
      ).toEqual(['missing-active', 'missing-preview']);
      expect(data.history.map((event) => event.action)).toEqual([
        'version.reconcile',
        'version.reconcile',
      ]);
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  test('is idempotent and does not append duplicate recovery history', () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'deploykit-reconcile-'));
    const demoProject = project();
    const data: Data = {
      schemaVersion: 5,
      projects: [demoProject],
      users: [],
      history: [],
      artifactAudits: [],
      artifactAuditJobs: [],
    };
    mkdirSync(join(storageDir, 'p1', 'healthy-preview'), { recursive: true });
    writeFileSync(
      join(storageDir, 'p1', 'healthy-preview', 'index.html'),
      'healthy'
    );

    try {
      const repo = repository(data);
      reconcileStorage(repo, storageDir);
      const historyLength = data.history.length;

      expect(reconcileStorage(repo, storageDir)).toEqual({
        restoredInterruptedOperations: 0,
        committedInterruptedOperations: 0,
        recoveryConflicts: 0,
        removedStagingEntries: 0,
        removedCommittedTrashEntries: 0,
        removedOrphanEntries: 0,
        quarantinedOrphanVersions: 0,
        markedFailedVersions: 0,
        deactivatedProjects: 0,
      });
      expect(data.history).toHaveLength(historyLength);
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  test('preserves fresh staging work during startup reconciliation', () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'deploykit-reconcile-'));
    const stagingDir = join(storageDir, '.staging', 'active-upload');
    const data: Data = {
      schemaVersion: 5,
      projects: [],
      users: [],
      history: [],
      artifactAudits: [],
      artifactAuditJobs: [],
    };
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, 'index.html'), 'partial');

    try {
      expect(reconcileStorage(repository(data), storageDir)).toMatchObject({
        removedStagingEntries: 0,
      });
      expect(existsSync(stagingDir)).toBe(true);
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  test('restores an interrupted deletion before missing-artifact reconciliation', () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'deploykit-reconcile-'));
    const demoProject = project();
    demoProject.versions = [version('healthy-preview')];
    demoProject.activeVersionId = 'healthy-preview';
    const data: Data = {
      schemaVersion: 5,
      projects: [demoProject],
      users: [],
      history: [],
      artifactAudits: [],
      artifactAuditJobs: [],
    };
    const artifactDir = join(storageDir, 'p1', 'healthy-preview');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, 'index.html'), 'healthy');
    createArtifactRecoveryService(storageDir).stageVersionDeletion(
      'p1',
      'healthy-preview'
    );

    try {
      expect(reconcileStorage(repository(data), storageDir)).toMatchObject({
        restoredInterruptedOperations: 1,
        committedInterruptedOperations: 0,
        recoveryConflicts: 0,
        markedFailedVersions: 0,
        deactivatedProjects: 0,
      });
      expect(existsSync(join(artifactDir, 'index.html'))).toBe(true);
      expect(demoProject.activeVersionId).toBe('healthy-preview');
      expect(data.history).toHaveLength(0);
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  test('finalizes an interrupted deletion when metadata no longer references it', () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'deploykit-reconcile-'));
    const data: Data = {
      schemaVersion: 5,
      projects: [],
      users: [],
      history: [],
      artifactAudits: [],
      artifactAuditJobs: [],
    };
    const artifactDir = join(storageDir, 'deleted-project', 'deleted-version');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, 'index.html'), 'deleted');
    const lease = createArtifactRecoveryService(
      storageDir
    ).stageVersionDeletion('deleted-project', 'deleted-version');

    try {
      expect(reconcileStorage(repository(data), storageDir)).toMatchObject({
        restoredInterruptedOperations: 0,
        committedInterruptedOperations: 1,
        recoveryConflicts: 0,
      });
      expect(existsSync(join(lease.recoveryPath ?? '', 'COMMITTED'))).toBe(
        true
      );
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  test('quarantines conflicting sources and keeps the conflict unresolved', () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'deploykit-reconcile-'));
    const demoProject = project();
    demoProject.versions = [version('healthy-preview')];
    demoProject.activeVersionId = 'healthy-preview';
    const data: Data = {
      schemaVersion: 5,
      projects: [demoProject],
      users: [],
      history: [],
      artifactAudits: [],
      artifactAuditJobs: [],
    };
    const artifactDir = join(storageDir, 'p1', 'healthy-preview');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, 'index.html'), 'original');
    createArtifactRecoveryService(storageDir).stageVersionDeletion(
      'p1',
      'healthy-preview'
    );
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, 'index.html'), 'replacement');

    try {
      expect(reconcileStorage(repository(data), storageDir)).toMatchObject({
        restoredInterruptedOperations: 0,
        recoveryConflicts: 1,
        markedFailedVersions: 0,
      });
      expect(existsSync(join(storageDir, '.recovery', 'conflicts'))).toBe(true);
      expect(reconcileStorage(repository(data), storageDir)).toMatchObject({
        recoveryConflicts: 1,
      });
      expect(readFileSync(join(artifactDir, 'index.html'), 'utf8')).toBe(
        'replacement'
      );
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  test('freezes orphan quarantine and metadata repair while any recovery conflict exists', () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'deploykit-reconcile-'));
    const demoProject = project();
    const data: Data = {
      schemaVersion: 5,
      projects: [demoProject],
      users: [],
      history: [],
      artifactAudits: [],
      artifactAuditJobs: [],
    };
    const orphanArtifact = join(
      storageDir,
      'orphan-project',
      'orphan-version',
      'index.html'
    );
    const conflictMarker = join(
      storageDir,
      '.recovery',
      'conflicts',
      'unresolved-operation',
      'manifest.json'
    );
    const staleStaging = join(storageDir, '.staging', 'stale-upload');
    const committedTrash = join(
      storageDir,
      '.recovery',
      'trash',
      'committed-operation'
    );
    const staleRecoveryOrphan = join(
      storageDir,
      '.recovery',
      'orphans',
      'stale-orphan'
    );
    const ancient = new Date('2000-01-01T00:00:00.000Z');
    mkdirSync(join(storageDir, 'orphan-project', 'orphan-version'), {
      recursive: true,
    });
    writeFileSync(orphanArtifact, 'orphan');
    mkdirSync(staleStaging, { recursive: true });
    writeFileSync(join(staleStaging, 'payload.txt'), 'stale');
    utimesSync(staleStaging, ancient, ancient);
    mkdirSync(committedTrash, { recursive: true });
    writeFileSync(
      join(committedTrash, 'manifest.json'),
      JSON.stringify({
        version: 2,
        operation: 'delete',
        kind: 'version',
        target: { projectId: 'deleted-project', versionId: 'deleted-version' },
        originalPath: 'deleted-project/deleted-version',
        recoveryPath:
          '.recovery/trash/committed-operation/artifacts/deleted-project/deleted-version',
        committed: true,
        stagedAt: ancient.toISOString(),
        committedAt: ancient.toISOString(),
      })
    );
    writeFileSync(join(committedTrash, 'COMMITTED'), ancient.toISOString());
    utimesSync(join(committedTrash, 'COMMITTED'), ancient, ancient);
    mkdirSync(staleRecoveryOrphan, { recursive: true });
    writeFileSync(join(staleRecoveryOrphan, 'payload.txt'), 'stale orphan');
    utimesSync(staleRecoveryOrphan, ancient, ancient);
    mkdirSync(
      join(storageDir, '.recovery', 'conflicts', 'unresolved-operation'),
      {
        recursive: true,
      }
    );
    writeFileSync(conflictMarker, 'unresolved');
    const metadataBefore = JSON.stringify(data);

    try {
      expect(reconcileStorage(repository(data), storageDir)).toEqual({
        restoredInterruptedOperations: 0,
        committedInterruptedOperations: 0,
        recoveryConflicts: 1,
        removedStagingEntries: 0,
        removedCommittedTrashEntries: 0,
        removedOrphanEntries: 0,
        quarantinedOrphanVersions: 0,
        markedFailedVersions: 0,
        deactivatedProjects: 0,
      });
      expect(readFileSync(orphanArtifact, 'utf8')).toBe('orphan');
      expect(readFileSync(conflictMarker, 'utf8')).toBe('unresolved');
      expect(readFileSync(join(staleStaging, 'payload.txt'), 'utf8')).toBe(
        'stale'
      );
      expect(readFileSync(join(committedTrash, 'COMMITTED'), 'utf8')).toBe(
        ancient.toISOString()
      );
      expect(
        readFileSync(join(staleRecoveryOrphan, 'payload.txt'), 'utf8')
      ).toBe('stale orphan');
      expect(JSON.stringify(data)).toBe(metadataBefore);
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  test('quarantines a manifest whose relative paths do not match its target', () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'deploykit-reconcile-'));
    const operationDir = join(
      storageDir,
      '.recovery',
      'trash',
      'malicious-operation'
    );
    mkdirSync(join(operationDir, 'artifacts', 'p1', 'healthy-preview'), {
      recursive: true,
    });
    writeFileSync(
      join(operationDir, 'manifest.json'),
      JSON.stringify({
        version: 2,
        operation: 'delete',
        kind: 'version',
        target: { projectId: 'p1', versionId: 'healthy-preview' },
        originalPath: '../outside',
        recoveryPath:
          '.recovery/trash/malicious-operation/artifacts/p1/healthy-preview',
        committed: false,
        stagedAt: '2026-07-30T00:00:00.000Z',
        committedAt: null,
      })
    );
    const data: Data = {
      schemaVersion: 5,
      projects: [],
      users: [],
      history: [],
      artifactAudits: [],
      artifactAuditJobs: [],
    };

    try {
      expect(reconcileStorage(repository(data), storageDir)).toMatchObject({
        recoveryConflicts: 1,
      });
      expect(existsSync(join(storageDir, '..', 'outside'))).toBe(false);
      expect(
        existsSync(
          join(storageDir, '.recovery', 'conflicts', 'malicious-operation')
        )
      ).toBe(true);
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });
});
