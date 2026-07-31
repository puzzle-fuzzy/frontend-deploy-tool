import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  afterCurrentStateMoved?: (rollbackPath: string) => void;
  afterDatabaseInstalled?: () => void;
  afterRestoredStateInstalled?: () => void;
  afterRestorePayloadStaged?: (
    manifestStage: string,
    databaseStage: string,
    storageStage: string
  ) => void;
  afterInitialBackupVerified?: (backupPath: string) => void;
}

for (const [source, mutate] of [
  [
    'manifest',
    (fixture: ReturnType<typeof createRestoreFixture>) => {
      const manifestPath = join(fixture.backupDir, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        createdAt: string;
      };
      manifest.createdAt = '2026-07-31T23:59:59.999Z';
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    },
  ],
  [
    'database',
    (fixture: ReturnType<typeof createRestoreFixture>) => {
      const database = new Database(
        join(fixture.backupDir, 'database', basename(fixture.databaseFile))
      );
      database.exec('PRAGMA user_version = 42');
      database.close();
    },
  ],
  [
    'storage',
    (fixture: ReturnType<typeof createRestoreFixture>) => {
      writeFileSync(
        join(fixture.backupDir, 'storage', 'marker.txt'),
        'staged storage'
      );
    },
  ],
] as const) {
  test(`restore rejects an independent ${source} swap after initial verification`, () => {
    const fixture = createRestoreFixture();
    let ownershipAttempts = 0;
    let releases = 0;
    try {
      const databaseBytes = readFileSync(fixture.databaseFile);
      const storageBytes = readFileSync(fixture.storageMarker);
      const service = createBackupService(
        fixture,
        restoreDependencies({
          afterInitialBackupVerified() {
            mutate(fixture);
          },
          acquireOwnership: () => {
            ownershipAttempts += 1;
            return {
              release() {
                releases += 1;
              },
            };
          },
        })
      );

      expect(() =>
        service.restoreBackup(fixture.backupDir, { force: true })
      ).toThrow('RESTORE_BACKUP_SOURCE_CHANGED');
      expect(ownershipAttempts).toBe(1);
      expect(releases).toBe(1);
      expect(readFileSync(fixture.databaseFile)).toEqual(databaseBytes);
      expect(readFileSync(fixture.storageMarker)).toEqual(storageBytes);
    } finally {
      fixture.cleanup();
    }
  });
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

test('a fallback rollback rename that commits and throws is compensated from exact identity', () => {
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
    expect(existsSync(rollbackTarget)).toBe(true);
    expect(existsSync(publishedTemp)).toBe(false);
  } finally {
    fixture.cleanup();
  }
});

for (const resource of [
  'database',
  'storage',
  '-journal',
  '-wal',
  '-shm',
] as const) {
  test(`a direct ${resource} rollback rename that commits and throws is compensated from exact identity`, () => {
    const fixture = createRestoreFixture();
    const commitError = new Error(`injected committed ${resource} rename`);
    let rollbackTarget = '';
    try {
      removeDatabaseAuxiliaries(fixture.databaseFile);
      const auxiliaryBytes = new Map<string, Buffer>();
      for (const suffix of ['-journal', '-wal', '-shm']) {
        const bytes = Buffer.from(`live ${suffix}`);
        writeFileSync(`${fixture.databaseFile}${suffix}`, bytes);
        auxiliaryBytes.set(suffix, bytes);
      }
      const databaseBytes = readFileSync(fixture.databaseFile);
      const storageBytes = readFileSync(fixture.storageMarker);
      const selectedSource =
        resource === 'database'
          ? fixture.databaseFile
          : resource === 'storage'
            ? fixture.storageDir
            : `${fixture.databaseFile}${resource}`;

      const service = createBackupService(
        fixture,
        restoreDependencies({
          restoreFileSystem: {
            rename(source, target) {
              renameSync(source, target);
              if (source === selectedSource) {
                rollbackTarget = target;
                throw commitError;
              }
            },
            copy: cpSync,
            remove: rmSync,
          },
        })
      );

      expect(
        captureError(() =>
          service.restoreBackup(fixture.backupDir, { force: true })
        )
      ).toBe(commitError);
      expect(readFileSync(fixture.databaseFile)).toEqual(databaseBytes);
      expect(readFileSync(fixture.storageMarker)).toEqual(storageBytes);
      for (const [suffix, bytes] of auxiliaryBytes) {
        expect(
          readFileSync(`${fixture.databaseFile}${suffix}`).toString('hex')
        ).toBe(bytes.toString('hex'));
      }
      expect(rollbackTarget).not.toBe('');
      expect(existsSync(rollbackTarget)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
}

test('an unproven direct rollback rename retains quarantined operation evidence', () => {
  const fixture = createRestoreFixture();
  const ambiguityError = new Error('injected unproven direct rename');
  let rollbackTarget = '';
  try {
    const liveStorageBytes = readFileSync(fixture.storageMarker);
    const service = createBackupService(
      fixture,
      restoreDependencies({
        restoreFileSystem: {
          rename(source, target) {
            if (source === fixture.storageDir) {
              rollbackTarget = target;
              mkdirSync(target, { recursive: true });
              writeFileSync(join(target, 'uncertain'), 'quarantined');
              throw ambiguityError;
            }
            renameSync(source, target);
          },
          copy: cpSync,
          remove: rmSync,
        },
      })
    );

    expect(
      captureError(() =>
        service.restoreBackup(fixture.backupDir, { force: true })
      )
    ).toBe(ambiguityError);
    expect(readFileSync(fixture.storageMarker)).toEqual(liveStorageBytes);
    expect(readFileSync(join(rollbackTarget, 'uncertain'), 'utf8')).toBe(
      'quarantined'
    );
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
          resource: 'database-stage-journal',
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
    expect(stageCleanupAttempts).toHaveLength(3);
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

test('verify and restore reject hard-linked backup storage before ownership or mutation', () => {
  const fixture = createRestoreFixture();
  const backupMarker = join(fixture.backupDir, 'storage', 'marker.txt');
  const externalMarker = join(dirname(fixture.backupDir), 'external-marker');
  let ownershipAttempts = 0;
  try {
    const databaseBytes = readFileSync(fixture.databaseFile);
    const storageBytes = readFileSync(fixture.storageMarker);
    renameSync(backupMarker, externalMarker);
    linkSync(externalMarker, backupMarker);
    const service = createBackupService(
      fixture,
      restoreDependencies({
        acquireOwnership: () => {
          ownershipAttempts += 1;
          return { release() {} };
        },
      })
    );

    const verification = service.verifyBackup(fixture.backupDir);
    expect(verification.valid).toBe(false);
    expect(verification.errors.join('\n')).toContain('BACKUP_SOURCE_UNSAFE');
    expect(() =>
      service.restoreBackup(fixture.backupDir, { force: true })
    ).toThrow('BACKUP_SOURCE_UNSAFE');
    expect(ownershipAttempts).toBe(0);
    expect(readFileSync(fixture.databaseFile)).toEqual(databaseBytes);
    expect(readFileSync(fixture.storageMarker)).toEqual(storageBytes);
  } finally {
    fixture.cleanup();
  }
});

test('restore revalidates and cleans a replaced database stage before moving live state', () => {
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
        afterRestorePayloadStaged(_manifestStage, stagedDatabase) {
          expect(stagedDatabase).toBe(databaseStage);
          rmSync(stagedDatabase, { force: true });
          symlinkSync(
            join(fixture.backupDir, 'database', basename(fixture.databaseFile)),
            stagedDatabase
          );
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

for (const swappedControl of ['rollback-root', 'rollback-operation'] as const) {
  test(`restore rejects a late ${swappedControl} symlink without touching its target or live state`, () => {
    const fixture = createRestoreFixture();
    const fixedNow = new Date('2026-07-30T12:34:56.789Z');
    const operationId = `late-${swappedControl}`;
    const operationName = `2026-07-30T12-34-56-789Z-${operationId}`;
    const rollbackRoot = join(
      dirname(fixture.databaseFile),
      '.deploykit-rollback'
    );
    const rollbackPath = join(rollbackRoot, operationName);
    const external = join(
      dirname(fixture.backupDir),
      `external-${swappedControl}`
    );
    try {
      const databaseBytes = readFileSync(fixture.databaseFile);
      const storageBytes = readFileSync(fixture.storageMarker);
      mkdirSync(external);
      const service = createBackupService(
        fixture,
        restoreDependencies({
          now: () => fixedNow,
          createOperationId: () => operationId,
          afterRestorePayloadStaged() {
            const swappedPath =
              swappedControl === 'rollback-root' ? rollbackRoot : rollbackPath;
            rmSync(swappedPath, { recursive: true, force: true });
            symlinkSync(external, swappedPath);
          },
        })
      );

      expect(() =>
        service.restoreBackup(fixture.backupDir, { force: true })
      ).toThrow('RESTORE_CONTROL_LAYOUT_UNSAFE');
      expect(readFileSync(fixture.databaseFile)).toEqual(databaseBytes);
      expect(readFileSync(fixture.storageMarker)).toEqual(storageBytes);
      expect(lstatSync(external).isDirectory()).toBe(true);
      expect(readdirSync(external)).toEqual([]);
      expect(existsSync(rollbackRoot)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
}

for (const suffix of ['-journal', '-wal', '-shm']) {
  test(`restore rejects and cleans an injected database stage ${suffix} file`, () => {
    const fixture = createRestoreFixture();
    const fixedNow = new Date('2026-07-30T12:34:56.789Z');
    const operationId = `stage${suffix.slice(1)}`;
    const operationName = `2026-07-30T12-34-56-789Z-${operationId}`;
    const rollbackRoot = join(
      dirname(fixture.databaseFile),
      '.deploykit-rollback'
    );
    const databaseStage = `${fixture.databaseFile}.restore-${operationName}`;
    const storageStage = join(
      dirname(fixture.storageDir),
      `.${basename(fixture.storageDir)}.restore-${operationName}`
    );
    const manifestStage = `${fixture.databaseFile}.manifest-${operationName}`;
    try {
      const databaseBytes = readFileSync(fixture.databaseFile);
      const storageBytes = readFileSync(fixture.storageMarker);
      const service = createBackupService(
        fixture,
        restoreDependencies({
          now: () => fixedNow,
          createOperationId: () => operationId,
          afterRestorePayloadStaged(_manifest, stagedDatabase) {
            writeFileSync(`${stagedDatabase}${suffix}`, 'injected sidecar');
          },
        })
      );

      expect(() =>
        service.restoreBackup(fixture.backupDir, { force: true })
      ).toThrow('BACKUP_DATABASE_SNAPSHOT_UNSAFE');
      expect(readFileSync(fixture.databaseFile)).toEqual(databaseBytes);
      expect(readFileSync(fixture.storageMarker)).toEqual(storageBytes);
      for (const control of [
        databaseStage,
        `${databaseStage}${suffix}`,
        storageStage,
        manifestStage,
        rollbackRoot,
      ]) {
        expect(existsSync(control)).toBe(false);
      }
    } finally {
      fixture.cleanup();
    }
  });
}

test('post-move database parent replacement cannot redirect recovery or either cleanup pass', () => {
  const fixture = createRestoreFixture({ separateParents: true });
  const fixedNow = new Date('2026-07-30T12:34:56.789Z');
  const operationId = 'database-parent-post-move';
  const operationName = `2026-07-30T12-34-56-789Z-${operationId}`;
  const databaseParent = dirname(fixture.databaseFile);
  const retainedParent = `${databaseParent}-retained`;
  const externalParent = `${databaseParent}-external`;
  const externalDatabase = join(externalParent, basename(fixture.databaseFile));
  const databaseStage = `${fixture.databaseFile}.restore-${operationName}`;
  const externalDatabaseStage = join(externalParent, basename(databaseStage));
  const manifestStage = `${fixture.databaseFile}.manifest-${operationName}`;
  const externalManifestStage = join(externalParent, basename(manifestStage));
  const externalRollbackDatabase = join(
    externalParent,
    '.deploykit-rollback',
    operationName,
    'database',
    basename(fixture.databaseFile)
  );
  try {
    mkdirSync(dirname(externalRollbackDatabase), { recursive: true });
    const sentinels = new Map<string, Buffer>([
      [externalDatabase, Buffer.from('external live database')],
      [externalDatabaseStage, Buffer.from('external database stage')],
      [`${externalDatabaseStage}-journal`, Buffer.from('external journal')],
      [`${externalDatabaseStage}-wal`, Buffer.from('external wal')],
      [`${externalDatabaseStage}-shm`, Buffer.from('external shm')],
      [externalManifestStage, Buffer.from('external manifest stage')],
      [externalRollbackDatabase, Buffer.from('external rollback database')],
    ]);
    for (const [path, bytes] of sentinels) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }
    const service = createBackupService(
      fixture,
      restoreDependencies({
        now: () => fixedNow,
        createOperationId: () => operationId,
        acquireOwnership: () => ({ release() {} }),
        afterCurrentStateMoved() {
          renameSync(databaseParent, retainedParent);
          symlinkSync(externalParent, databaseParent);
        },
      })
    );

    expect(() =>
      service.restoreBackup(fixture.backupDir, { force: true })
    ).toThrow('RESTORE_CONTROL_LAYOUT_UNSAFE');
    for (const [path, bytes] of sentinels) {
      expect(readFileSync(path).toString('hex')).toBe(bytes.toString('hex'));
    }
    const retainedRollback = join(
      retainedParent,
      '.deploykit-rollback',
      operationName
    );
    expect(
      readFileSync(
        join(retainedRollback, 'database', basename(fixture.databaseFile))
      ).byteLength
    ).toBeGreaterThan(0);
    expect(
      readFileSync(join(retainedRollback, 'storage', 'marker.txt'), 'utf8')
    ).toBe('live storage');
  } finally {
    fixture.cleanup();
  }
});

test('post-database-install storage parent replacement cannot redirect recovery or cleanup', () => {
  const fixture = createRestoreFixture({ separateParents: true });
  const fixedNow = new Date('2026-07-30T12:34:56.789Z');
  const operationId = 'storage-parent-post-database';
  const operationName = `2026-07-30T12-34-56-789Z-${operationId}`;
  const storageParent = dirname(fixture.storageDir);
  const retainedParent = `${storageParent}-retained`;
  const externalParent = `${storageParent}-external`;
  const storageStage = join(
    storageParent,
    `.${basename(fixture.storageDir)}.restore-${operationName}`
  );
  const externalStorageMarker = join(
    externalParent,
    basename(fixture.storageDir),
    'marker.txt'
  );
  const externalStageMarker = join(
    externalParent,
    basename(storageStage),
    'sentinel.txt'
  );
  try {
    const databaseBytes = readFileSync(fixture.databaseFile);
    const sentinels = new Map<string, Buffer>([
      [externalStorageMarker, Buffer.from('external live storage')],
      [externalStageMarker, Buffer.from('external storage stage')],
    ]);
    for (const [path, bytes] of sentinels) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }
    const service = createBackupService(
      fixture,
      restoreDependencies({
        now: () => fixedNow,
        createOperationId: () => operationId,
        acquireOwnership: () => ({ release() {} }),
        afterDatabaseInstalled() {
          renameSync(storageParent, retainedParent);
          symlinkSync(externalParent, storageParent);
        },
      })
    );

    expect(() =>
      service.restoreBackup(fixture.backupDir, { force: true })
    ).toThrow('RESTORE_CONTROL_LAYOUT_UNSAFE');
    expect(readFileSync(fixture.databaseFile)).toEqual(databaseBytes);
    for (const [path, bytes] of sentinels) {
      expect(readFileSync(path).toString('hex')).toBe(bytes.toString('hex'));
    }
    expect(
      readFileSync(
        join(
          dirname(fixture.databaseFile),
          '.deploykit-rollback',
          operationName,
          'storage',
          'marker.txt'
        ),
        'utf8'
      )
    ).toBe('live storage');
    expect(
      readFileSync(
        join(retainedParent, basename(storageStage), 'marker.txt'),
        'utf8'
      )
    ).toBe('backup storage');
  } finally {
    fixture.cleanup();
  }
});

test('a database stage swapped after current-state move is never installed', () => {
  const fixture = createRestoreFixture();
  const fixedNow = new Date('2026-07-30T12:34:56.789Z');
  const operationId = 'late-database-stage';
  const operationName = `2026-07-30T12-34-56-789Z-${operationId}`;
  const databaseStage = `${fixture.databaseFile}.restore-${operationName}`;
  const retainedStage = `${databaseStage}.trusted`;
  const externalDatabase = join(
    dirname(fixture.backupDir),
    'late-external-database.sqlite'
  );
  try {
    const databaseBytes = readFileSync(fixture.databaseFile);
    const storageBytes = readFileSync(fixture.storageMarker);
    const externalBytes = Buffer.from('external database replacement');
    writeFileSync(externalDatabase, externalBytes);
    const service = createBackupService(
      fixture,
      restoreDependencies({
        now: () => fixedNow,
        createOperationId: () => operationId,
        acquireOwnership: () => ({ release() {} }),
        afterCurrentStateMoved() {
          renameSync(databaseStage, retainedStage);
          symlinkSync(externalDatabase, databaseStage);
        },
      })
    );

    expect(() =>
      service.restoreBackup(fixture.backupDir, { force: true })
    ).toThrow('RESTORE_CONTROL_LAYOUT_UNSAFE');
    expect(readFileSync(fixture.databaseFile)).toEqual(databaseBytes);
    expect(readFileSync(fixture.storageMarker)).toEqual(storageBytes);
    expect(readFileSync(externalDatabase)).toEqual(externalBytes);
    expect(existsSync(retainedStage)).toBe(true);
  } finally {
    fixture.cleanup();
  }
});

test('a storage stage swapped after database install is never installed', () => {
  const fixture = createRestoreFixture();
  const fixedNow = new Date('2026-07-30T12:34:56.789Z');
  const operationId = 'late-storage-stage';
  const operationName = `2026-07-30T12-34-56-789Z-${operationId}`;
  const storageStage = join(
    dirname(fixture.storageDir),
    `.${basename(fixture.storageDir)}.restore-${operationName}`
  );
  const retainedStage = `${storageStage}.trusted`;
  const externalStorage = join(
    dirname(fixture.backupDir),
    'late-external-storage'
  );
  const externalMarker = join(externalStorage, 'sentinel.txt');
  try {
    const databaseBytes = readFileSync(fixture.databaseFile);
    const storageBytes = readFileSync(fixture.storageMarker);
    mkdirSync(externalStorage, { recursive: true });
    writeFileSync(externalMarker, 'external storage replacement', {
      flag: 'wx',
    });
    const service = createBackupService(
      fixture,
      restoreDependencies({
        now: () => fixedNow,
        createOperationId: () => operationId,
        acquireOwnership: () => ({ release() {} }),
        afterDatabaseInstalled() {
          renameSync(storageStage, retainedStage);
          symlinkSync(externalStorage, storageStage);
        },
      })
    );

    expect(() =>
      service.restoreBackup(fixture.backupDir, { force: true })
    ).toThrow('RESTORE_CONTROL_LAYOUT_UNSAFE');
    expect(readFileSync(fixture.databaseFile)).toEqual(databaseBytes);
    expect(readFileSync(fixture.storageMarker)).toEqual(storageBytes);
    expect(readFileSync(externalMarker, 'utf8')).toBe(
      'external storage replacement'
    );
    expect(readFileSync(join(retainedStage, 'marker.txt'), 'utf8')).toBe(
      'backup storage'
    );
  } finally {
    fixture.cleanup();
  }
});

test('post-move rollback operation replacement is never read or cleaned as trusted evidence', () => {
  const fixture = createRestoreFixture();
  const fixedNow = new Date('2026-07-30T12:34:56.789Z');
  const operationId = 'post-move-rollback-operation';
  const operationName = `2026-07-30T12-34-56-789Z-${operationId}`;
  const rollbackPath = join(
    dirname(fixture.databaseFile),
    '.deploykit-rollback',
    operationName
  );
  const retainedRollback = `${rollbackPath}.trusted`;
  const externalRollback = join(
    dirname(fixture.backupDir),
    'external-rollback-operation'
  );
  const externalDatabase = join(
    externalRollback,
    'database',
    basename(fixture.databaseFile)
  );
  const externalStorageMarker = join(externalRollback, 'storage', 'marker.txt');
  try {
    const externalSentinels = new Map<string, Buffer>([
      [externalDatabase, Buffer.from('external rollback database')],
      [externalStorageMarker, Buffer.from('external rollback storage')],
    ]);
    for (const [path, bytes] of externalSentinels) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }
    const service = createBackupService(
      fixture,
      restoreDependencies({
        now: () => fixedNow,
        createOperationId: () => operationId,
        acquireOwnership: () => ({ release() {} }),
        afterCurrentStateMoved(currentRollbackPath) {
          expect(currentRollbackPath).toBe(rollbackPath);
          renameSync(rollbackPath, retainedRollback);
          symlinkSync(externalRollback, rollbackPath);
        },
      })
    );

    const thrown = captureError(() =>
      service.restoreBackup(fixture.backupDir, { force: true })
    );
    expect(thrown.message).toContain('RESTORE_CONTROL_LAYOUT_UNSAFE');
    for (const [path, bytes] of externalSentinels) {
      expect(readFileSync(path).toString('hex')).toBe(bytes.toString('hex'));
    }
    expect(
      readFileSync(
        join(retainedRollback, 'database', basename(fixture.databaseFile))
      ).byteLength
    ).toBeGreaterThan(0);
    expect(
      readFileSync(join(retainedRollback, 'storage', 'marker.txt'), 'utf8')
    ).toBe('live storage');
  } finally {
    fixture.cleanup();
  }
});

function createRestoreFixture(options: { separateParents?: boolean } = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-restore-safety-'));
  const databaseParent = options.separateParents
    ? join(tempDir, 'database-runtime')
    : tempDir;
  const storageParent = options.separateParents
    ? join(tempDir, 'storage-runtime')
    : tempDir;
  mkdirSync(databaseParent, { recursive: true });
  mkdirSync(storageParent, { recursive: true });
  const databaseFile = join(databaseParent, 'deploykit.sqlite');
  const storageDir = join(storageParent, 'storage');
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
