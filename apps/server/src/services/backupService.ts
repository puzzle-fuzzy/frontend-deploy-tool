import { existsSync } from 'node:fs';
import { resolveRuntimeResourceLayout } from '../utils/runtimeResourcePath';
import { attachBackupSecondaryFailures } from './backupFailure';
import { restoreVerifiedBackup } from './backupRestoreTransaction';
import {
  assertBackupDestinationSafe,
  createBackupSnapshotAt,
} from './backupSnapshot';
import type {
  BackupManifest,
  BackupService,
  BackupServiceConfig,
  BackupServiceDependencies,
} from './backupTypes';
import { verifyBackupAt, verifyBackupDetailedAt } from './backupVerification';
import {
  acquireRuntimeOwnership,
  assertRuntimeResourceLeavesSafe,
} from './runtimeOwnership';

export type {
  BackupManifest,
  BackupRestoreReport,
  BackupService,
  BackupVerificationReport,
} from './backupTypes';

type BackupOutcome =
  | { kind: 'success'; manifest: BackupManifest }
  | { kind: 'failure'; error: unknown };

export function createBackupService(
  config: BackupServiceConfig,
  dependencies: BackupServiceDependencies = {}
): BackupService {
  const now = dependencies.now ?? (() => new Date());

  return {
    createBackup(destination) {
      const layout = resolveRuntimeResourceLayout(
        config.databaseFile,
        config.storageDir
      );
      assertRuntimeResourceLeavesSafe(layout);
      if (!existsSync(layout.databaseFile)) {
        throw new Error(`Database does not exist: ${layout.databaseFile}`);
      }
      assertBackupDestinationSafe(destination, layout);

      const ownership = (
        dependencies.acquireOwnership ?? acquireRuntimeOwnership
      )(layout.databaseFile, layout.storageDir);
      let outcome: BackupOutcome;
      try {
        assertRuntimeResourceLeavesSafe(layout);
        if (!existsSync(layout.databaseFile)) {
          throw new Error(`Database does not exist: ${layout.databaseFile}`);
        }
        assertBackupDestinationSafe(destination, layout);
        outcome = {
          kind: 'success',
          manifest: createBackupSnapshotAt({
            destination,
            layout,
            now,
            createTemporaryId: dependencies.createBackupTemporaryId,
            removeTemporaryPath: dependencies.removeBackupTemporaryPath,
            verifyPreparedBackup: (path) => verifyBackupAt(path, dependencies),
          }),
        };
      } catch (error) {
        outcome = { kind: 'failure', error };
      }

      try {
        ownership.release();
      } catch (releaseError) {
        if (outcome.kind === 'success') throw releaseError;
        attachBackupSecondaryFailures(outcome.error, [
          {
            step: 'release',
            resource: 'runtime-ownership',
            error: releaseError,
          },
        ]);
      }

      if (outcome.kind === 'failure') throw outcome.error;
      return outcome.manifest;
    },

    verifyBackup(backupPath) {
      return verifyBackupAt(backupPath, dependencies);
    },

    restoreBackup(backupPath, options) {
      const layout = resolveRuntimeResourceLayout(
        config.databaseFile,
        config.storageDir
      );
      assertRuntimeResourceLeavesSafe(layout);
      if (!options.force) {
        throw new Error('Restore requires an explicit force flag');
      }
      const initialVerification = verifyBackupDetailedAt(
        backupPath,
        dependencies
      );
      const verification = initialVerification.report;
      if (
        !verification.valid ||
        !verification.manifest ||
        !initialVerification.fingerprint
      ) {
        throw new Error(
          `Backup verification failed: ${verification.errors.join('; ')}`
        );
      }
      dependencies.afterInitialBackupVerified?.(backupPath);

      return restoreVerifiedBackup({
        backupPath,
        dependencies,
        expectedFingerprint: initialVerification.fingerprint,
        layout,
        now,
      });
    },
  };
}
