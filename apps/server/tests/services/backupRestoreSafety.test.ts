import { expect, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createEmptyData } from '../../src/domain/schema';
import { createSqliteProjectRepository } from '../../src/repositories/sqliteProjectRepository';
import { createBackupService } from '../../src/services/backupService';

interface RestoreFileSystem {
  rename(source: string, target: string): void;
  copy(
    source: string,
    target: string,
    options?: { preserveTimestamps?: boolean; recursive?: boolean }
  ): void;
  remove(
    target: string,
    options?: { force?: boolean; recursive?: boolean }
  ): void;
}

interface RestoreDependencies {
  now?: () => Date;
  createOperationId?: () => string;
  restoreFileSystem?: RestoreFileSystem;
  acquireOwnership?: () => { release(): void };
  afterDatabaseInstalled?: () => void;
  afterRestoredStateInstalled?: () => void;
}

test('EXDEV partial storage copy never publishes rollback or replaces the live source', () => {
  const fixture = createRestoreFixture();
  let rollbackTarget = '';
  let partialTemp = '';
  try {
    rmSync(fixture.databaseFile, { force: true });
    removeDatabaseAuxiliaries(fixture.databaseFile);
    const liveStorageBytes = readFileSync(fixture.storageMarker);
    const partialCopyError = new Error('injected partial cross-volume copy');

    const service = createBackupService(
      fixture,
      restoreDependencies({
        restoreFileSystem: {
          rename(source, target) {
            if (source === fixture.storageDir) {
              rollbackTarget = target;
              throw crossDeviceError();
            }
            renameSync(source, target);
          },
          copy(source, target, options) {
            if (source === fixture.storageDir) {
              partialTemp = target;
              mkdirSync(target, { recursive: true });
              writeFileSync(join(target, 'partial'), 'partial');
              throw partialCopyError;
            }
            cpSync(source, target, options);
          },
          remove: rmSync,
        },
      })
    );

    expect(() =>
      service.restoreBackup(fixture.backupDir, { force: true })
    ).toThrow(partialCopyError.message);
    expect(readFileSync(fixture.storageMarker)).toEqual(liveStorageBytes);
    expect(rollbackTarget).not.toBe('');
    expect(partialTemp).not.toBe('');
    expect(existsSync(rollbackTarget)).toBe(false);
    expect(existsSync(partialTemp)).toBe(false);
  } finally {
    fixture.cleanup();
  }
});

test('a rollback rename that writes and then throws leaves no untrusted final target', () => {
  const fixture = createRestoreFixture();
  let rollbackTarget = '';
  let publishedTemp = '';
  try {
    rmSync(fixture.databaseFile, { force: true });
    removeDatabaseAuxiliaries(fixture.databaseFile);
    const liveStorageBytes = readFileSync(fixture.storageMarker);
    const publicationError = new Error('injected publication ambiguity');

    const service = createBackupService(
      fixture,
      restoreDependencies({
        restoreFileSystem: {
          rename(source, target) {
            if (source === fixture.storageDir) {
              rollbackTarget = target;
              throw crossDeviceError();
            }
            if (target === rollbackTarget) {
              publishedTemp = source;
              renameSync(source, target);
              throw publicationError;
            }
            renameSync(source, target);
          },
          copy: cpSync,
          remove: rmSync,
        },
      })
    );

    expect(() =>
      service.restoreBackup(fixture.backupDir, { force: true })
    ).toThrow(publicationError.message);
    expect(readFileSync(fixture.storageMarker)).toEqual(liveStorageBytes);
    expect(rollbackTarget).not.toBe('');
    expect(publishedTemp).not.toBe('');
    expect(existsSync(rollbackTarget)).toBe(false);
    expect(existsSync(publishedTemp)).toBe(false);
  } finally {
    fixture.cleanup();
  }
});

for (const suffix of ['-journal', '-wal', '-shm']) {
  test(`EXDEV partial ${suffix} copy restores earlier moves without trusting a partial target`, () => {
    const fixture = createRestoreFixture();
    const auxiliaryPath = `${fixture.databaseFile}${suffix}`;
    let rollbackTarget = '';
    let partialTemp = '';
    try {
      removeDatabaseAuxiliaries(fixture.databaseFile);
      const auxiliaryBytes = Buffer.from(`untouched ${suffix}`);
      writeFileSync(auxiliaryPath, auxiliaryBytes);
      const databaseBytes = readFileSync(fixture.databaseFile);
      const storageBytes = readFileSync(fixture.storageMarker);

      const service = createBackupService(
        fixture,
        restoreDependencies({
          restoreFileSystem: {
            rename(source, target) {
              if (source === auxiliaryPath) {
                rollbackTarget = target;
                throw crossDeviceError();
              }
              renameSync(source, target);
            },
            copy(source, target, options) {
              if (source === auxiliaryPath) {
                partialTemp = target;
                writeFileSync(target, 'partial');
                throw new Error(`injected partial ${suffix} copy`);
              }
              cpSync(source, target, options);
            },
            remove: rmSync,
          },
        })
      );

      expect(() =>
        service.restoreBackup(fixture.backupDir, { force: true })
      ).toThrow(`injected partial ${suffix} copy`);
      expect(readFileSync(fixture.databaseFile)).toEqual(databaseBytes);
      expect(readFileSync(auxiliaryPath)).toEqual(auxiliaryBytes);
      expect(readFileSync(fixture.storageMarker)).toEqual(storageBytes);
      expect(existsSync(rollbackTarget)).toBe(false);
      expect(existsSync(partialTemp)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
}

test('EXDEV publication followed by source removal failure restores from the complete rollback copy', () => {
  const fixture = createRestoreFixture();
  let rollbackTarget = '';
  let publishedTemp = '';
  let sourceRemovalAttempts = 0;
  try {
    rmSync(fixture.databaseFile, { force: true });
    removeDatabaseAuxiliaries(fixture.databaseFile);
    const liveStorageBytes = readFileSync(fixture.storageMarker);
    const removeError = new Error('injected source removal failure');

    const service = createBackupService(
      fixture,
      restoreDependencies({
        restoreFileSystem: {
          rename(source, target) {
            if (source === fixture.storageDir) {
              rollbackTarget = target;
              throw crossDeviceError();
            }
            if (target === rollbackTarget) publishedTemp = source;
            renameSync(source, target);
          },
          copy: cpSync,
          remove(target, options) {
            if (
              target === fixture.storageDir &&
              sourceRemovalAttempts++ === 0
            ) {
              throw removeError;
            }
            rmSync(target, options);
          },
        },
      })
    );

    expect(() =>
      service.restoreBackup(fixture.backupDir, { force: true })
    ).toThrow(removeError.message);
    expect(readFileSync(fixture.storageMarker)).toEqual(liveStorageBytes);
    expect(existsSync(rollbackTarget)).toBe(true);
    expect(existsSync(publishedTemp)).toBe(false);
    expect(sourceRemovalAttempts).toBe(2);
  } finally {
    fixture.cleanup();
  }
});

test('restore keeps the finalize error authoritative while attempting every compensation and release', () => {
  const fixture = createRestoreFixture();
  const primaryError = Object.assign(new Error('injected finalize primary'), {
    code: 'RESTORE_FINALIZE_PRIMARY',
  });
  const databaseRecoveryError = new Error('injected database rollback failure');
  const stageCleanupError = new Error(
    'injected database stage cleanup failure'
  );
  const releaseError = new Error('injected ownership release failure');
  const stageCleanupAttempts: string[] = [];
  let databaseRecoveryAttempts = 0;
  let releaseAttempts = 0;
  try {
    writeFileSync(fixture.storageMarker, 'pre-restore storage');

    const service = createBackupService(
      fixture,
      restoreDependencies({
        acquireOwnership: () => ({
          release() {
            releaseAttempts += 1;
            throw releaseError;
          },
        }),
        afterRestoredStateInstalled() {
          throw primaryError;
        },
        restoreFileSystem: {
          rename: renameSync,
          copy(source, target, options) {
            if (
              source.includes('.deploykit-rollback') &&
              basename(source) === basename(fixture.databaseFile)
            ) {
              databaseRecoveryAttempts += 1;
              throw databaseRecoveryError;
            }
            cpSync(source, target, options);
          },
          remove(target, options) {
            if (target.includes('.restore-')) {
              stageCleanupAttempts.push(target);
              if (target.startsWith(fixture.databaseFile)) {
                throw stageCleanupError;
              }
            }
            rmSync(target, options);
          },
        },
      })
    );

    const thrown = captureError(() =>
      service.restoreBackup(fixture.backupDir, { force: true })
    );
    expect(thrown).toBe(primaryError);
    expect(thrown.message).toBe(primaryError.message);
    expect((thrown as Error & { code?: string }).code).toBe(
      'RESTORE_FINALIZE_PRIMARY'
    );
    expect(secondaryMessages(thrown)).toEqual(
      expect.arrayContaining([
        databaseRecoveryError.message,
        stageCleanupError.message,
        releaseError.message,
      ])
    );
    expect(
      (
        thrown as Error & {
          restoreSecondaryFailures?: Array<{
            step: string;
            resource: string;
            error: unknown;
          }>;
        }
      ).restoreSecondaryFailures
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          step: 'recover-resource',
          resource: 'database',
          error: databaseRecoveryError,
        }),
        expect.objectContaining({
          step: 'cleanup-stage',
          resource: 'database-stage',
          error: stageCleanupError,
        }),
        expect.objectContaining({
          step: 'release',
          resource: 'runtime-ownership',
          error: releaseError,
        }),
      ])
    );
    expect(databaseRecoveryAttempts).toBe(1);
    expect(stageCleanupAttempts).toHaveLength(2);
    expect(releaseAttempts).toBe(1);
    expect(readFileSync(fixture.storageMarker, 'utf8')).toBe(
      'pre-restore storage'
    );
  } finally {
    fixture.cleanup();
  }
});

test('a successful restore reports an ownership release failure', () => {
  const fixture = createRestoreFixture();
  const releaseError = Object.assign(new Error('injected ownership release'), {
    code: 'RESTORE_OWNERSHIP_RELEASE_FAILED',
  });
  let releaseAttempts = 0;
  try {
    writeFileSync(fixture.storageMarker, 'mutated');
    const service = createBackupService(
      fixture,
      restoreDependencies({
        acquireOwnership: () => ({
          release() {
            releaseAttempts += 1;
            throw releaseError;
          },
        }),
      })
    );

    expect(() =>
      service.restoreBackup(fixture.backupDir, { force: true })
    ).toThrow(releaseError.message);
    expect(releaseAttempts).toBe(1);
    expect(readFileSync(fixture.storageMarker, 'utf8')).toBe('backup storage');
  } finally {
    fixture.cleanup();
  }
});

test('a frozen initiating Error cannot be masked by a release failure', () => {
  const fixture = createRestoreFixture();
  const primaryError = Object.freeze(
    Object.assign(new Error('frozen restore primary'), {
      code: 'FROZEN_RESTORE_PRIMARY',
    })
  );
  const releaseError = new Error('release must stay secondary');
  let releaseAttempts = 0;
  try {
    const service = createBackupService(
      fixture,
      restoreDependencies({
        acquireOwnership: () => ({
          release() {
            releaseAttempts += 1;
            throw releaseError;
          },
        }),
        afterRestoredStateInstalled() {
          throw primaryError;
        },
      })
    );

    const thrown = captureError(() =>
      service.restoreBackup(fixture.backupDir, { force: true })
    );
    expect(thrown).toBe(primaryError);
    expect(thrown.message).toBe('frozen restore primary');
    expect((thrown as Error & { code?: string }).code).toBe(
      'FROZEN_RESTORE_PRIMARY'
    );
    expect(releaseAttempts).toBe(1);
  } finally {
    fixture.cleanup();
  }
});

test('restore preserves database auxiliaries when the database itself was absent', () => {
  const fixture = createRestoreFixture();
  const auxiliaryBytes = new Map<string, Buffer>();
  try {
    rmSync(fixture.databaseFile, { force: true });
    removeDatabaseAuxiliaries(fixture.databaseFile);
    for (const suffix of ['-journal', '-wal', '-shm']) {
      const bytes = Buffer.from(`orphan ${suffix}`);
      writeFileSync(`${fixture.databaseFile}${suffix}`, bytes);
      auxiliaryBytes.set(suffix, bytes);
    }
    writeFileSync(fixture.storageMarker, 'pre-restore storage');

    const service = createBackupService(fixture, {
      afterDatabaseInstalled() {
        throw new Error('injected post-database failure');
      },
    });

    expect(() =>
      service.restoreBackup(fixture.backupDir, { force: true })
    ).toThrow('injected post-database failure');
    expect(existsSync(fixture.databaseFile)).toBe(false);
    for (const [suffix, bytes] of auxiliaryBytes) {
      expect(
        readFileSync(`${fixture.databaseFile}${suffix}`).toString('hex')
      ).toBe(bytes.toString('hex'));
    }
    expect(readFileSync(fixture.storageMarker, 'utf8')).toBe(
      'pre-restore storage'
    );
  } finally {
    fixture.cleanup();
  }
});

test('restore rejects rollback control roots equal to or above live storage before mutation', () => {
  const fixture = createRestoreFixture();
  try {
    const databaseBytes = readFileSync(fixture.databaseFile);
    const rollbackRoot = join(
      dirname(fixture.databaseFile),
      '.deploykit-rollback'
    );
    for (const storageDir of [rollbackRoot, join(rollbackRoot, 'live')]) {
      const unsafeService = createBackupService({
        databaseFile: fixture.databaseFile,
        storageDir,
      });

      expect(() =>
        unsafeService.restoreBackup(fixture.backupDir, { force: true })
      ).toThrow('RESTORE_CONTROL_LAYOUT_UNSAFE');
      expect(readFileSync(fixture.databaseFile)).toEqual(databaseBytes);
      expect(existsSync(rollbackRoot)).toBe(false);
      expect(existsSync(`${fixture.databaseFile}.runtime-lock.sqlite`)).toBe(
        false
      );
      expect(existsSync(`${storageDir}.runtime-lock.sqlite`)).toBe(false);
    }
  } finally {
    fixture.cleanup();
  }
});

test('restore rejects a live-storage ancestor of the rollback root without mutation', () => {
  const fixture = createRestoreFixture();
  try {
    const databaseBytes = readFileSync(fixture.databaseFile);
    const rollbackRoot = join(
      dirname(fixture.databaseFile),
      '.deploykit-rollback'
    );
    const unsafeService = createBackupService({
      databaseFile: fixture.databaseFile,
      storageDir: dirname(rollbackRoot),
    });

    expect(() =>
      unsafeService.restoreBackup(fixture.backupDir, { force: true })
    ).toThrow('DATABASE_STORAGE_OVERLAP');
    expect(readFileSync(fixture.databaseFile)).toEqual(databaseBytes);
    expect(existsSync(rollbackRoot)).toBe(false);
    expect(existsSync(`${fixture.databaseFile}.runtime-lock.sqlite`)).toBe(
      false
    );
  } finally {
    fixture.cleanup();
  }
});

test('restore never reuses a pre-existing rollback operation or acquires ownership', () => {
  const fixture = createRestoreFixture();
  const fixedNow = new Date('2026-07-30T12:34:56.789Z');
  const operationId = 'stale-operation';
  const rollbackPath = join(
    dirname(fixture.databaseFile),
    '.deploykit-rollback',
    '2026-07-30T12-34-56-789Z-stale-operation'
  );
  const staleRollbackTarget = join(
    rollbackPath,
    'database',
    basename(fixture.databaseFile)
  );
  let ownershipAttempts = 0;
  try {
    const databaseBytes = readFileSync(fixture.databaseFile);
    const storageBytes = readFileSync(fixture.storageMarker);
    mkdirSync(dirname(staleRollbackTarget), { recursive: true });
    writeFileSync(staleRollbackTarget, 'stale rollback data');

    const service = createBackupService(
      fixture,
      restoreDependencies({
        now: () => fixedNow,
        createOperationId: () => operationId,
        acquireOwnership: () => {
          ownershipAttempts += 1;
          return { release() {} };
        },
      })
    );

    expect(() =>
      service.restoreBackup(fixture.backupDir, { force: true })
    ).toThrow('RESTORE_CONTROL_LAYOUT_UNSAFE');
    expect(ownershipAttempts).toBe(0);
    expect(readFileSync(fixture.databaseFile)).toEqual(databaseBytes);
    expect(readFileSync(fixture.storageMarker)).toEqual(storageBytes);
    expect(readFileSync(staleRollbackTarget, 'utf8')).toBe(
      'stale rollback data'
    );
  } finally {
    fixture.cleanup();
  }
});

test('restore rejects dangling control symlinks before ownership or mutation', () => {
  const fixture = createRestoreFixture();
  const fixedNow = new Date('2026-07-30T12:34:56.789Z');
  const operationId = 'dangling-control';
  const operationName = '2026-07-30T12-34-56-789Z-dangling-control';
  const rollbackRoot = join(
    dirname(fixture.databaseFile),
    '.deploykit-rollback'
  );
  const rollbackPath = join(rollbackRoot, operationName);
  const databaseStage = `${fixture.databaseFile}.restore-${operationName}`;
  const storageStage = join(
    dirname(fixture.storageDir),
    `.${basename(fixture.storageDir)}.restore-${operationName}`
  );
  const controls = [
    ['rollback-root', rollbackRoot],
    ['rollback-operation', rollbackPath],
    ['database-stage', databaseStage],
    ['storage-stage', storageStage],
  ] as const;
  try {
    const databaseBytes = readFileSync(fixture.databaseFile);
    const storageBytes = readFileSync(fixture.storageMarker);

    for (const [controlName, controlPath] of controls) {
      rmSync(rollbackRoot, { recursive: true, force: true });
      rmSync(databaseStage, { recursive: true, force: true });
      rmSync(storageStage, { recursive: true, force: true });
      mkdirSync(dirname(controlPath), { recursive: true });
      symlinkSync(
        join(dirname(controlPath), `${controlName}-missing-target`),
        controlPath
      );
      let ownershipAttempts = 0;
      const service = createBackupService(
        fixture,
        restoreDependencies({
          now: () => fixedNow,
          createOperationId: () => operationId,
          acquireOwnership: () => {
            ownershipAttempts += 1;
            return { release() {} };
          },
        })
      );

      expect(existsSync(controlPath)).toBe(false);
      expect(() =>
        service.restoreBackup(fixture.backupDir, { force: true })
      ).toThrow('RESTORE_CONTROL_LAYOUT_UNSAFE');
      expect(ownershipAttempts).toBe(0);
      expect(lstatSync(controlPath).isSymbolicLink()).toBe(true);
      expect(readFileSync(fixture.databaseFile)).toEqual(databaseBytes);
      expect(readFileSync(fixture.storageMarker)).toEqual(storageBytes);
      expect(existsSync(`${fixture.databaseFile}.runtime-lock.sqlite`)).toBe(
        false
      );
      expect(existsSync(`${fixture.storageDir}.runtime-lock.sqlite`)).toBe(
        false
      );
    }
  } finally {
    fixture.cleanup();
  }
});

test('restore fully stages a verified backup located inside live storage before moving it', () => {
  const fixture = createRestoreFixture();
  try {
    const nestedBackup = join(fixture.storageDir, 'retained', 'backup-1');
    mkdirSync(dirname(nestedBackup), { recursive: true });
    renameSync(fixture.backupDir, nestedBackup);
    writeFileSync(fixture.storageMarker, 'pre-restore mutation');

    const result = createBackupService(fixture).restoreBackup(nestedBackup, {
      force: true,
    });

    expect(result.restoredFrom).toBe(nestedBackup);
    expect(readFileSync(fixture.storageMarker, 'utf8')).toBe('backup storage');
    expect(
      readFileSync(join(result.rollbackPath, 'storage', 'marker.txt'), 'utf8')
    ).toBe('pre-restore mutation');
    expect(
      existsSync(join(result.rollbackPath, 'storage', 'retained', 'backup-1'))
    ).toBe(true);
  } finally {
    fixture.cleanup();
  }
});

test('verify and restore reject a symlinked backup database before ownership or mutation', () => {
  const fixture = createRestoreFixture();
  const fixedNow = new Date('2026-07-30T12:34:56.789Z');
  const operationId = 'backup-db-symlink';
  const operationName = '2026-07-30T12-34-56-789Z-backup-db-symlink';
  const backupDatabase = join(
    fixture.backupDir,
    'database',
    basename(fixture.databaseFile)
  );
  const externalDatabase = join(
    dirname(fixture.backupDir),
    'external-snapshot.sqlite'
  );
  const rollbackRoot = join(
    dirname(fixture.databaseFile),
    '.deploykit-rollback'
  );
  const databaseStage = `${fixture.databaseFile}.restore-${operationName}`;
  const storageStage = join(
    dirname(fixture.storageDir),
    `.${basename(fixture.storageDir)}.restore-${operationName}`
  );
  let ownershipAttempts = 0;
  try {
    const databaseBytes = readFileSync(fixture.databaseFile);
    const storageBytes = readFileSync(fixture.storageMarker);
    renameSync(backupDatabase, externalDatabase);
    symlinkSync(externalDatabase, backupDatabase);
    const service = createBackupService(
      fixture,
      restoreDependencies({
        now: () => fixedNow,
        createOperationId: () => operationId,
        acquireOwnership: () => {
          ownershipAttempts += 1;
          return { release() {} };
        },
      })
    );

    const verification = service.verifyBackup(fixture.backupDir);
    expect(verification.valid).toBe(false);
    expect(verification.errors.join('\n')).toContain(
      'BACKUP_DATABASE_SNAPSHOT_UNSAFE'
    );
    expect(() =>
      service.restoreBackup(fixture.backupDir, { force: true })
    ).toThrow('BACKUP_DATABASE_SNAPSHOT_UNSAFE');
    expect(ownershipAttempts).toBe(0);
    expect(lstatSync(backupDatabase).isSymbolicLink()).toBe(true);
    expect(lstatSync(fixture.databaseFile).isSymbolicLink()).toBe(false);
    expect(readFileSync(fixture.databaseFile)).toEqual(databaseBytes);
    expect(readFileSync(fixture.storageMarker)).toEqual(storageBytes);
    expect(existsSync(rollbackRoot)).toBe(false);
    expect(existsSync(databaseStage)).toBe(false);
    expect(existsSync(storageStage)).toBe(false);
    expect(existsSync(`${fixture.databaseFile}.runtime-lock.sqlite`)).toBe(
      false
    );
    expect(existsSync(`${fixture.storageDir}.runtime-lock.sqlite`)).toBe(false);
  } finally {
    fixture.cleanup();
  }
});

test('restore rejects and cleans a symlinked database stage before moving live state', () => {
  const fixture = createRestoreFixture();
  const fixedNow = new Date('2026-07-30T12:34:56.789Z');
  const operationId = 'database-stage-symlink';
  const operationName = '2026-07-30T12-34-56-789Z-database-stage-symlink';
  const rollbackRoot = join(
    dirname(fixture.databaseFile),
    '.deploykit-rollback'
  );
  const databaseStage = `${fixture.databaseFile}.restore-${operationName}`;
  const storageStage = join(
    dirname(fixture.storageDir),
    `.${basename(fixture.storageDir)}.restore-${operationName}`
  );
  let ownershipAttempts = 0;
  let releaseAttempts = 0;
  try {
    const databaseBytes = readFileSync(fixture.databaseFile);
    const storageBytes = readFileSync(fixture.storageMarker);
    const service = createBackupService(
      fixture,
      restoreDependencies({
        now: () => fixedNow,
        createOperationId: () => operationId,
        acquireOwnership: () => {
          ownershipAttempts += 1;
          return {
            release() {
              releaseAttempts += 1;
            },
          };
        },
        restoreFileSystem: {
          rename: renameSync,
          copy(source, target, options) {
            if (target === databaseStage) {
              symlinkSync(source, target);
              return;
            }
            cpSync(source, target, options);
          },
          remove: rmSync,
        },
      })
    );

    expect(() =>
      service.restoreBackup(fixture.backupDir, { force: true })
    ).toThrow('RESTORE_DATABASE_STAGE_UNSAFE');
    expect(ownershipAttempts).toBe(1);
    expect(releaseAttempts).toBe(1);
    expect(lstatSync(fixture.databaseFile).isSymbolicLink()).toBe(false);
    expect(readFileSync(fixture.databaseFile)).toEqual(databaseBytes);
    expect(readFileSync(fixture.storageMarker)).toEqual(storageBytes);
    expect(existsSync(databaseStage)).toBe(false);
    expect(existsSync(storageStage)).toBe(false);
    expect(existsSync(rollbackRoot)).toBe(false);
    expect(existsSync(`${fixture.databaseFile}.runtime-lock.sqlite`)).toBe(
      false
    );
    expect(existsSync(`${fixture.storageDir}.runtime-lock.sqlite`)).toBe(false);
  } finally {
    fixture.cleanup();
  }
});

function createRestoreFixture() {
  const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-restore-safety-'));
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const storageDir = join(tempDir, 'storage');
  const storageMarker = join(storageDir, 'marker.txt');
  mkdirSync(storageDir);
  writeFileSync(storageMarker, 'backup storage');
  createSqliteProjectRepository({ databaseFile }).save(createEmptyData());
  const backupDir = join(tempDir, 'backups', 'backup-1');
  createBackupService({ databaseFile, storageDir }).createBackup(backupDir);
  const canonicalDatabaseFile = realpathSync.native(databaseFile);
  const canonicalStorageDir = realpathSync.native(storageDir);
  const canonicalStorageMarker = join(canonicalStorageDir, 'marker.txt');
  writeFileSync(canonicalStorageMarker, 'live storage');
  return {
    backupDir,
    databaseFile: canonicalDatabaseFile,
    storageDir: canonicalStorageDir,
    storageMarker: canonicalStorageMarker,
    cleanup() {
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function restoreDependencies(
  dependencies: RestoreDependencies
): Parameters<typeof createBackupService>[1] {
  return dependencies as Parameters<typeof createBackupService>[1];
}

function crossDeviceError(): Error {
  return Object.assign(new Error('cross-device move'), { code: 'EXDEV' });
}

function removeDatabaseAuxiliaries(databaseFile: string): void {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    rmSync(`${databaseFile}${suffix}`, { force: true });
  }
}

function captureError(operation: () => unknown): Error {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`Expected Error, received ${String(error)}`);
  }
  throw new Error('Expected operation to throw');
}

function secondaryMessages(error: Error): string[] {
  const cause = (error as Error & { cause?: unknown }).cause;
  if (!(cause instanceof AggregateError)) return [];
  return cause.errors.map((entry) =>
    entry instanceof Error ? entry.message : String(entry)
  );
}
