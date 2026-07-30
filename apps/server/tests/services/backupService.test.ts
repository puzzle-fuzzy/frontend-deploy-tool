import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Data } from '@deploykit/shared';
import { CURRENT_SCHEMA_VERSION } from '../../src/domain/schema';
import { createSqliteProjectRepository } from '../../src/repositories/sqliteProjectRepository';
import { checksumDirectory } from '../../src/services/artifactService';
import { createBackupService } from '../../src/services/backupService';
import { acquireRuntimeOwnership } from '../../src/services/runtimeOwnership';

function createFixture(tempDir: string) {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const storageDir = join(tempDir, 'storage');
  const artifactDir = join(storageDir, 'p1', 'v1');
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, 'index.html'), '<html>backup</html>');
  const checksum = checksumDirectory(artifactDir);
  const data: Data = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projects: [
      {
        id: 'p1',
        name: 'Original',
        slug: 'original',
        description: '',
        createdAt: '2026-07-30T00:00:00.000Z',
        updatedAt: '2026-07-30T00:00:00.000Z',
        versions: [
          {
            id: 'v1',
            name: 'v1',
            description: '',
            createdAt: '2026-07-30T00:00:00.000Z',
            size: 19,
            fileCount: 1,
            sourceType: 'folder',
            status: 'production',
            publishedAt: '2026-07-30T00:00:00.000Z',
            publishedBy: 'user-1',
            checksum,
            integrityStatus: 'verified',
            integrityCheckedAt: '2026-07-30T00:00:00.000Z',
          },
        ],
        activeVersionId: 'v1',
        settings: { spaMode: false, routingType: 'path' },
        auditPolicy: {
          enforcement: 'advisory',
          maxTotalBytes: 50 * 1024 * 1024,
          maxFileBytes: 10 * 1024 * 1024,
          maxFileCount: 1_000,
        },
        createdBy: 'user-1',
        members: [],
      },
    ],
    users: [],
    history: [],
    artifactAudits: [
      {
        id: 'audit-1',
        projectId: 'p1',
        versionId: 'v1',
        artifactChecksum: checksum,
        status: 'warning',
        score: 90,
        createdAt: '2026-07-30T00:00:00.000Z',
        createdBy: 'user-1',
        engineVersion: 1,
        policy: {
          enforcement: 'advisory',
          maxTotalBytes: 50 * 1024 * 1024,
          maxFileBytes: 10 * 1024 * 1024,
          maxFileCount: 1_000,
        },
        summary: {
          totalBytes: 19,
          fileCount: 1,
          largestFiles: [{ path: 'index.html', size: 19 }],
          extensions: [{ extension: '.html', bytes: 19, count: 1 }],
        },
        checks: [],
      },
    ],
    artifactAuditJobs: [
      {
        id: 'job-1',
        projectId: 'p1',
        versionId: 'v1',
        requestedBy: 'user-1',
        status: 'succeeded',
        priority: 0,
        attempts: 1,
        maxAttempts: 3,
        nextRunAt: '2026-07-30T00:00:00.000Z',
        lockedBy: null,
        lockedUntil: null,
        artifactChecksum: checksum,
        engineVersion: 1,
        policy: {
          enforcement: 'advisory',
          maxTotalBytes: 50 * 1024 * 1024,
          maxFileBytes: 10 * 1024 * 1024,
          maxFileCount: 1_000,
        },
        reportId: 'audit-1',
        errorCode: null,
        errorMessage: null,
        createdAt: '2026-07-30T00:00:00.000Z',
        updatedAt: '2026-07-30T00:00:01.000Z',
        startedAt: '2026-07-30T00:00:00.000Z',
        completedAt: '2026-07-30T00:00:01.000Z',
      },
    ],
  };
  const repository = createSqliteProjectRepository({ databaseFile });
  repository.save(data);
  return { databaseFile, storageDir, repository };
}

describe('createBackupService', () => {
  test('creates a self-describing backup and verifies database and artifacts', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-backup-'));
    try {
      const fixture = createFixture(tempDir);
      const backupDir = join(tempDir, 'backups', 'backup-1');
      const service = createBackupService(fixture);

      const manifest = service.createBackup(backupDir);
      const verification = service.verifyBackup(backupDir);

      expect(manifest).toMatchObject({
        formatVersion: 1,
        databaseFile: 'deploykit.sqlite',
        storageDirectory: 'storage',
        metadataCounts: {
          projects: 1,
          versions: 1,
          artifactAudits: 1,
          artifactAuditJobs: 1,
        },
        artifactCounts: { files: 1, deployableVersions: 1 },
      });
      expect(verification).toMatchObject({
        valid: true,
        errors: [],
      });
      expect(existsSync(join(backupDir, 'manifest.json'))).toBe(true);
      expect(
        existsSync(join(backupDir, 'storage', 'p1', 'v1', 'index.html'))
      ).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('restores a verified backup and keeps the replaced state as rollback', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-backup-'));
    try {
      const fixture = createFixture(tempDir);
      const backupDir = join(tempDir, 'backups', 'backup-1');
      const service = createBackupService(fixture);
      service.createBackup(backupDir);

      fixture.repository.mutate((data) => {
        data.projects[0].name = 'Mutated';
      });
      writeFileSync(
        join(fixture.storageDir, 'p1', 'v1', 'index.html'),
        '<html>mutated</html>'
      );

      const result = service.restoreBackup(backupDir, { force: true });

      expect(fixture.repository.load().projects[0].name).toBe('Original');
      expect(fixture.repository.load().artifactAudits).toHaveLength(1);
      expect(
        readFileSync(join(fixture.storageDir, 'p1', 'v1', 'index.html'), 'utf8')
      ).toBe('<html>backup</html>');
      expect(existsSync(result.rollbackPath)).toBe(true);
      expect(existsSync(join(result.rollbackPath, 'manifest.json'))).toBe(true);
      expect(
        existsSync(join(result.rollbackPath, 'database', 'deploykit.sqlite'))
      ).toBe(true);
      expect(
        readFileSync(
          join(result.rollbackPath, 'storage', 'p1', 'v1', 'index.html'),
          'utf8'
        )
      ).toBe('<html>mutated</html>');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('restores the current state after an injected install failure and retains rollback', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-backup-'));
    let rollbackPath = '';
    try {
      const fixture = createFixture(tempDir);
      const backupDir = join(tempDir, 'backups', 'backup-1');
      createBackupService(fixture).createBackup(backupDir);
      fixture.repository.mutate((data) => {
        data.projects[0].name = 'Current Before Failure';
      });

      const failingService = createBackupService(fixture, {
        afterCurrentStateMoved(path) {
          rollbackPath = path;
          throw new Error('injected restore failure');
        },
      });

      expect(() =>
        failingService.restoreBackup(backupDir, { force: true })
      ).toThrow('injected restore failure');
      expect(fixture.repository.load().projects[0].name).toBe(
        'Current Before Failure'
      );
      expect(existsSync(rollbackPath)).toBe(true);
      expect(
        existsSync(join(rollbackPath, 'database', 'deploykit.sqlite'))
      ).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rejects a corrupted backup before moving the current state', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-backup-'));
    try {
      const fixture = createFixture(tempDir);
      const backupDir = join(tempDir, 'backups', 'backup-1');
      const service = createBackupService(fixture);
      service.createBackup(backupDir);
      writeFileSync(
        join(backupDir, 'storage', 'p1', 'v1', 'index.html'),
        'corrupted'
      );

      expect(service.verifyBackup(backupDir).valid).toBe(false);
      expect(() => service.restoreBackup(backupDir, { force: true })).toThrow(
        'Backup verification failed'
      );
      expect(fixture.repository.load().projects[0].name).toBe('Original');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('refuses restore while a live runtime owns the database and storage pair', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-backup-'));
    try {
      const fixture = createFixture(tempDir);
      const backupDir = join(tempDir, 'backups', 'backup-1');
      const service = createBackupService(fixture);
      service.createBackup(backupDir);
      const ownership = acquireRuntimeOwnership(
        fixture.databaseFile,
        fixture.storageDir
      );

      try {
        expect(() => service.restoreBackup(backupDir, { force: true })).toThrow(
          'RUNTIME_OWNERSHIP_HELD'
        );
        expect(fixture.repository.load().projects[0].name).toBe('Original');
      } finally {
        ownership.release();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
