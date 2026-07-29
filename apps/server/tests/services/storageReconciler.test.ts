import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Data, Project, Version } from '@deploykit/shared';
import type { ProjectRepository } from '../../src/repositories/projectRepository';
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
});
