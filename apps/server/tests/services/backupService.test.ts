import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Data } from '@deploykit/shared';
import { CURRENT_SCHEMA_VERSION } from '../../src/domain/schema';
import { createSqliteApiTokenRepository } from '../../src/repositories/apiTokenRepository';
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
          maxJavaScriptBytes: 10 * 1024 * 1024,
          maxStylesheetBytes: 2 * 1024 * 1024,
          maxFontBytes: 10 * 1024 * 1024,
        },
        createdBy: 'user-1',
        members: [],
      },
    ],
    users: [
      {
        id: 'user-1',
        name: 'Owner',
        email: 'owner@example.test',
        passwordHash: 'hash',
        role: 'developer',
        createdAt: '2026-07-30T00:00:00.000Z',
        updatedAt: '2026-07-30T00:00:00.000Z',
      },
    ],
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
          maxJavaScriptBytes: 10 * 1024 * 1024,
          maxStylesheetBytes: 2 * 1024 * 1024,
          maxFontBytes: 10 * 1024 * 1024,
        },
        context: { spaMode: false, routingType: 'path' },
        summary: {
          totalBytes: 19,
          fileCount: 1,
          largestFiles: [{ path: 'index.html', size: 19 }],
          extensions: [{ extension: '.html', bytes: 19, count: 1 }],
          assetBytes: {
            javascript: 0,
            stylesheet: 0,
            font: 0,
            image: 0,
          },
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
          maxJavaScriptBytes: 10 * 1024 * 1024,
          maxStylesheetBytes: 2 * 1024 * 1024,
          maxFontBytes: 10 * 1024 * 1024,
        },
        context: { spaMode: false, routingType: 'path' },
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

function seedAutomationMetadata(databaseFile: string): void {
  createSqliteApiTokenRepository(databaseFile).create({
    token: {
      id: 'token-1',
      projectId: 'p1',
      name: 'CI',
      hashVersion: 1,
      secretDigest: 'a'.repeat(64),
      prefix: 'dpk_v1.token-1.alpha',
      scopes: ['preview:upload'],
      createdAt: '2026-07-30T00:00:00.000Z',
      createdBy: 'user-1',
      expiresAt: '2026-10-30T00:00:00.000Z',
      lastUsedAt: null,
      revokedAt: null,
      replacedByTokenId: null,
    },
    projectName: 'Original',
  });
  const database = new Database(databaseFile);
  database
    .query(
      `INSERT INTO ci_idempotency_records (
         project_id, token_id, idempotency_key, request_digest, version_id,
         version_name, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'p1',
      'token-1',
      'ci-run-1',
      'b'.repeat(64),
      'v1',
      'v1',
      '2026-07-30T00:00:00.000Z',
      '2026-07-31T00:00:00.000Z'
    );
  database.close();
}

describe('createBackupService', () => {
  test('creates a self-describing backup and verifies database and artifacts', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-backup-'));
    try {
      const fixture = createFixture(tempDir);
      seedAutomationMetadata(fixture.databaseFile);
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
          apiTokens: 1,
          apiTokenSecurityEvents: 1,
          ciIdempotencyRecords: 1,
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

      const manifestPath = join(backupDir, 'manifest.json');
      const drifted = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        metadataCounts: { apiTokens: number };
      };
      drifted.metadataCounts.apiTokens += 1;
      writeFileSync(manifestPath, JSON.stringify(drifted, null, 2));
      expect(service.verifyBackup(backupDir)).toMatchObject({
        valid: false,
        errors: ['metadata count apiTokens mismatch: expected 2, received 1'],
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('restores token, security-event, and idempotency rows from schema v6', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-backup-v6-'));
    try {
      const fixture = createFixture(tempDir);
      seedAutomationMetadata(fixture.databaseFile);
      const backupDir = join(tempDir, 'backups', 'backup-v6');
      const service = createBackupService(fixture);
      service.createBackup(backupDir);

      const database = new Database(fixture.databaseFile);
      database.exec(`
        DELETE FROM ci_idempotency_records;
        DELETE FROM project_api_tokens;
        DELETE FROM api_token_security_events;
      `);
      database.close();

      service.restoreBackup(backupDir, { force: true });

      const tokenRepository = createSqliteApiTokenRepository(
        fixture.databaseFile
      );
      expect(tokenRepository.list('p1')).toEqual([
        expect.objectContaining({ id: 'token-1', projectId: 'p1' }),
      ]);
      expect(tokenRepository.listSecurityEvents('p1')).toEqual([
        expect.objectContaining({
          tokenId: 'token-1',
          action: 'api_token.create',
        }),
      ]);
      const restored = new Database(fixture.databaseFile);
      const idempotencyCount = restored
        .query<{ count: number }, []>(
          'SELECT COUNT(*) AS count FROM ci_idempotency_records'
        )
        .get()?.count;
      restored.close();
      expect(idempotencyCount).toBe(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('verifies and restores a schema v5 backup before normal startup migrates it', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-backup-v5-'));
    try {
      const fixture = createFixture(tempDir);
      const backupDir = join(tempDir, 'backups', 'backup-v5');
      const service = createBackupService(fixture);
      service.createBackup(backupDir);

      const backupDatabase = join(backupDir, 'database', 'deploykit.sqlite');
      downgradeBackupToSchemaV5(backupDir);
      const sourceBytes = readFileSync(backupDatabase);

      expect(service.verifyBackup(backupDir)).toMatchObject({
        valid: true,
        errors: [],
      });
      expect(readFileSync(backupDatabase)).toEqual(sourceBytes);
      expectDatabaseAuxiliariesAbsent(backupDatabase);
      service.restoreBackup(backupDir, { force: true });

      const ownership = acquireRuntimeOwnership(
        fixture.databaseFile,
        fixture.storageDir
      );
      try {
        createSqliteProjectRepository({
          databaseFile: fixture.databaseFile,
          migrationGuard: ownership.migrationGuard,
        }).load();
      } finally {
        ownership.release();
      }
      const migrated = new Database(fixture.databaseFile);
      const version = migrated
        .query<{ version: number | null }, []>(
          'SELECT MAX(version) AS version FROM schema_migrations'
        )
        .get()?.version;
      const tokenTable = migrated
        .query<{ present: number }, []>(
          `SELECT 1 AS present
           FROM sqlite_master
           WHERE type = 'table' AND name = 'project_api_tokens'`
        )
        .get()?.present;
      migrated.close();

      expect(version).toBe(7);
      expect(tokenTable).toBe(1);
      expect(existsSync(`${fixture.databaseFile}.pre-relational-v7.bak`)).toBe(
        true
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rejects schema v5 migration conflicts before acquiring or moving live state', () => {
    const tempDir = mkdtempSync(
      join(tmpdir(), 'deploykit-backup-v5-conflict-')
    );
    let ownershipAcquisitions = 0;
    try {
      const fixture = createFixture(tempDir);
      const backupDir = join(tempDir, 'backups', 'backup-v5-conflict');
      createBackupService(fixture).createBackup(backupDir);
      downgradeBackupToSchemaV5(backupDir);

      const backupDatabase = join(backupDir, 'database', 'deploykit.sqlite');
      const drifted = new Database(backupDatabase);
      drifted.exec(`
        CREATE TABLE project_api_tokens (
          id TEXT PRIMARY KEY
        );
      `);
      drifted.close();

      const backupBytes = readFileSync(backupDatabase);
      const liveDatabaseBytes = readFileSync(fixture.databaseFile);
      const liveArtifact = join(fixture.storageDir, 'p1', 'v1', 'index.html');
      const liveArtifactBytes = readFileSync(liveArtifact);
      const service = createBackupService(fixture, {
        acquireOwnership() {
          ownershipAcquisitions += 1;
          throw new Error('live ownership must not be acquired');
        },
      });

      const verification = service.verifyBackup(backupDir);
      expect(verification.valid).toBe(false);
      expect(verification.errors).toHaveLength(1);
      expect(verification.errors[0]).toContain(
        'BACKUP_MIGRATION_PREFLIGHT_FAILED'
      );
      expect(verification.errors[0]).toContain('project_api_tokens');
      expect(() => service.restoreBackup(backupDir, { force: true })).toThrow(
        'BACKUP_MIGRATION_PREFLIGHT_FAILED'
      );

      expect(ownershipAcquisitions).toBe(0);
      expect(readFileSync(fixture.databaseFile)).toEqual(liveDatabaseBytes);
      expect(readFileSync(liveArtifact)).toEqual(liveArtifactBytes);
      expect(readFileSync(backupDatabase)).toEqual(backupBytes);
      expectDatabaseAuxiliariesAbsent(backupDatabase);
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
      const journalPath = `${fixture.databaseFile}-journal`;
      const journalMarker = Buffer.alloc(512);
      writeFileSync(journalPath, journalMarker);

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
      expect(
        readFileSync(
          join(result.rollbackPath, 'database', 'deploykit.sqlite-journal')
        )
      ).toEqual(journalMarker);
      expect(existsSync(journalPath)).toBe(false);
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
      const journalPath = `${fixture.databaseFile}-journal`;
      const journalMarker = Buffer.alloc(512);
      writeFileSync(journalPath, journalMarker);

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
      expect(
        readFileSync(join(rollbackPath, 'database', 'deploykit.sqlite-journal'))
      ).toEqual(journalMarker);
      expect(readFileSync(journalPath)).toEqual(journalMarker);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('restores an absent database when storage installation fails after database install', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-backup-'));
    let rollbackPath = '';
    try {
      const fixture = createFixture(tempDir);
      const backupDir = join(tempDir, 'backups', 'backup-1');
      createBackupService(fixture).createBackup(backupDir);
      writeFileSync(
        join(fixture.storageDir, 'p1', 'v1', 'index.html'),
        '<html>pre-restore storage</html>'
      );
      rmSync(fixture.databaseFile, { force: true });
      for (const suffix of ['-journal', '-wal', '-shm']) {
        rmSync(`${fixture.databaseFile}${suffix}`, { force: true });
      }

      const failingService = createBackupService(fixture, {
        afterCurrentStateMoved(path) {
          rollbackPath = path;
          mkdirSync(fixture.storageDir, { recursive: true });
          writeFileSync(join(fixture.storageDir, 'install-blocker'), 'blocked');
        },
      });

      expect(() =>
        failingService.restoreBackup(backupDir, { force: true })
      ).toThrow();
      expect(existsSync(fixture.databaseFile)).toBe(false);
      for (const suffix of ['-journal', '-wal', '-shm']) {
        expect(existsSync(`${fixture.databaseFile}${suffix}`)).toBe(false);
      }
      expect(
        readFileSync(join(fixture.storageDir, 'p1', 'v1', 'index.html'), 'utf8')
      ).toBe('<html>pre-restore storage</html>');
      expect(existsSync(join(fixture.storageDir, 'install-blocker'))).toBe(
        false
      );
      expect(existsSync(join(rollbackPath, 'storage'))).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('restores an existing database and partial auxiliaries without creating absent storage', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-backup-'));
    try {
      const fixture = createFixture(tempDir);
      const backupDir = join(tempDir, 'backups', 'backup-1');
      createBackupService(fixture).createBackup(backupDir);
      fixture.repository.mutate((data) => {
        data.projects[0].name = 'Database Before Failed Install';
      });
      checkpointDatabase(fixture.databaseFile);
      for (const suffix of ['-journal', '-wal', '-shm']) {
        rmSync(`${fixture.databaseFile}${suffix}`, { force: true });
      }
      const journalPath = `${fixture.databaseFile}-journal`;
      const journalMarker = Buffer.alloc(512);
      writeFileSync(journalPath, journalMarker);
      rmSync(fixture.storageDir, { recursive: true, force: true });

      const failingService = createBackupService(fixture, {
        afterDatabaseInstalled() {
          throw new Error('injected post-database failure');
        },
      });

      expect(() =>
        failingService.restoreBackup(backupDir, { force: true })
      ).toThrow('injected post-database failure');
      expect(existsSync(fixture.databaseFile)).toBe(true);
      expect(readFileSync(journalPath)).toEqual(journalMarker);
      expect(existsSync(`${fixture.databaseFile}-wal`)).toBe(false);
      expect(existsSync(`${fixture.databaseFile}-shm`)).toBe(false);
      expect(existsSync(fixture.storageDir)).toBe(false);
      expect(fixture.repository.load().projects[0].name).toBe(
        'Database Before Failed Install'
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('preserves absent database and storage after a post-database install failure', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-backup-'));
    try {
      const fixture = createFixture(tempDir);
      const backupDir = join(tempDir, 'backups', 'backup-1');
      createBackupService(fixture).createBackup(backupDir);
      rmSync(fixture.databaseFile, { force: true });
      for (const suffix of ['-journal', '-wal', '-shm']) {
        rmSync(`${fixture.databaseFile}${suffix}`, { force: true });
      }
      rmSync(fixture.storageDir, { recursive: true, force: true });

      const failingService = createBackupService(fixture, {
        afterDatabaseInstalled() {
          throw new Error('injected post-database failure');
        },
      });

      expect(() =>
        failingService.restoreBackup(backupDir, { force: true })
      ).toThrow('injected post-database failure');
      expect(existsSync(fixture.databaseFile)).toBe(false);
      for (const suffix of ['-journal', '-wal', '-shm']) {
        expect(existsSync(`${fixture.databaseFile}${suffix}`)).toBe(false);
      }
      expect(existsSync(fixture.storageDir)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('restores the exact prior state after all restored resources are installed', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-backup-'));
    try {
      const fixture = createFixture(tempDir);
      const backupDir = join(tempDir, 'backups', 'backup-1');
      createBackupService(fixture).createBackup(backupDir);
      fixture.repository.mutate((data) => {
        data.projects[0].name = 'State Before Finalize Failure';
      });
      checkpointDatabase(fixture.databaseFile);
      for (const suffix of ['-journal', '-wal', '-shm']) {
        rmSync(`${fixture.databaseFile}${suffix}`, { force: true });
      }
      const journalPath = `${fixture.databaseFile}-journal`;
      const journalMarker = Buffer.alloc(512);
      writeFileSync(journalPath, journalMarker);
      writeFileSync(
        join(fixture.storageDir, 'p1', 'v1', 'index.html'),
        '<html>state before finalize failure</html>'
      );

      const failingService = createBackupService(fixture, {
        afterRestoredStateInstalled() {
          throw new Error('injected restore finalize failure');
        },
      });

      expect(() =>
        failingService.restoreBackup(backupDir, { force: true })
      ).toThrow('injected restore finalize failure');
      expect(readFileSync(journalPath)).toEqual(journalMarker);
      expect(existsSync(`${fixture.databaseFile}-wal`)).toBe(false);
      expect(existsSync(`${fixture.databaseFile}-shm`)).toBe(false);
      expect(
        readFileSync(join(fixture.storageDir, 'p1', 'v1', 'index.html'), 'utf8')
      ).toBe('<html>state before finalize failure</html>');
      expect(fixture.repository.load().projects[0].name).toBe(
        'State Before Finalize Failure'
      );
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

  test('refuses restore when the database is nested inside artifact storage', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-backup-'));
    try {
      const fixture = createFixture(tempDir);
      const backupDir = join(tempDir, 'backups', 'backup-1');
      createBackupService(fixture).createBackup(backupDir);
      const unsafeStorageDir = join(tempDir, 'unsafe-storage');
      const unsafeDatabaseFile = join(unsafeStorageDir, 'deploykit.sqlite');
      mkdirSync(unsafeStorageDir, { recursive: true });
      copyFileSync(fixture.databaseFile, unsafeDatabaseFile);
      const unsafeService = createBackupService({
        databaseFile: unsafeDatabaseFile,
        storageDir: unsafeStorageDir,
      });

      expect(() =>
        unsafeService.restoreBackup(backupDir, { force: true })
      ).toThrow('DATABASE_STORAGE_OVERLAP');
      expect(existsSync(unsafeDatabaseFile)).toBe(true);
      expect(existsSync(join(unsafeStorageDir, '.deploykit-rollback'))).toBe(
        false
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rejects case-folded missing resource overlap before backup or restore mutation', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-backup-casefold-'));
    try {
      if (!isCaseInsensitiveVolume(tempDir)) return;

      const storageDir = join(tempDir, 'Storage');
      const databaseFile = join(tempDir, 'storage', 'metadata.sqlite');
      const destination = join(tempDir, 'backups', 'backup-1');
      const service = createBackupService({ databaseFile, storageDir });

      expect(() => service.createBackup(destination)).toThrow(
        'DATABASE_STORAGE_OVERLAP'
      );
      expect(() =>
        service.restoreBackup(join(tempDir, 'missing-backup'), { force: true })
      ).toThrow('DATABASE_STORAGE_OVERLAP');
      expect(existsSync(storageDir)).toBe(false);
      expect(existsSync(databaseFile)).toBe(false);
      expect(existsSync(destination)).toBe(false);
      expect(existsSync(`${databaseFile}.runtime-lock.sqlite`)).toBe(false);
      expect(existsSync(`${storageDir}.runtime-lock.sqlite`)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rejects an aliased database auxiliary before opening the backup source', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-backup-db-aux-'));
    try {
      const fixture = createFixture(tempDir);
      const externalDatabase = join(tempDir, 'external.sqlite');
      const destination = join(tempDir, 'backups', 'backup-1');
      copyFileSync(fixture.databaseFile, externalDatabase);
      const externalBytes = readFileSync(externalDatabase);
      symlinkSync(externalDatabase, `${fixture.databaseFile}-journal`);

      expect(() =>
        createBackupService(fixture).createBackup(destination)
      ).toThrow('RUNTIME_OWNERSHIP_LAYOUT_UNSAFE');
      expect(readFileSync(externalDatabase)).toEqual(externalBytes);
      expect(existsSync(destination)).toBe(false);
      expect(existsSync(`${fixture.databaseFile}.runtime-lock.sqlite`)).toBe(
        false
      );
      expect(existsSync(`${fixture.storageDir}.runtime-lock.sqlite`)).toBe(
        false
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function isCaseInsensitiveVolume(directory: string): boolean {
  const probe = join(directory, 'DeployKit-Case-Probe');
  mkdirSync(probe);
  try {
    return existsSync(join(directory, 'deploykit-case-probe'));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

function checkpointDatabase(databaseFile: string): void {
  const database = new Database(databaseFile);
  try {
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    database.exec('PRAGMA journal_mode = DELETE');
  } finally {
    database.close();
  }
}

function downgradeBackupToSchemaV5(backupDir: string): void {
  const manifestPath = join(backupDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    schemaVersion: number;
    metadataCounts: Record<string, number>;
  };
  const backupDatabase = join(backupDir, 'database', 'deploykit.sqlite');
  const database = new Database(backupDatabase);
  try {
    database.exec(`
      DROP TABLE ci_idempotency_records;
      DROP TABLE api_token_security_events;
      DROP TABLE project_api_tokens;
      ALTER TABLE projects DROP COLUMN audit_max_javascript_bytes;
      ALTER TABLE projects DROP COLUMN audit_max_stylesheet_bytes;
      ALTER TABLE projects DROP COLUMN audit_max_font_bytes;
      ALTER TABLE artifact_audits DROP COLUMN context_json;
      ALTER TABLE artifact_audit_jobs DROP COLUMN context_json;
      DELETE FROM schema_migrations WHERE version >= 6;
    `);
  } finally {
    database.close();
  }
  manifest.schemaVersion = 5;
  delete manifest.metadataCounts.apiTokens;
  delete manifest.metadataCounts.apiTokenSecurityEvents;
  delete manifest.metadataCounts.ciIdempotencyRecords;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

function expectDatabaseAuxiliariesAbsent(databaseFile: string): void {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    expect(existsSync(`${databaseFile}${suffix}`)).toBe(false);
  }
}
