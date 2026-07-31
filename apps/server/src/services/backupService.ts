import { existsSync } from 'node:fs';
import { resolveRuntimeResourceLayout } from '../utils/runtimeResourcePath';
import { restoreVerifiedBackup } from './backupRestoreTransaction';
import { createBackupSnapshotAt } from './backupSnapshot';
import type {
  BackupService,
  BackupServiceConfig,
  BackupServiceDependencies,
} from './backupTypes';
import { verifyBackupAt, verifyBackupDetailedAt } from './backupVerification';
import { assertRuntimeResourceLeavesSafe } from './runtimeOwnership';

export type {
  BackupManifest,
  BackupRestoreReport,
  BackupService,
  BackupVerificationReport,
} from './backupTypes';

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
      return createBackupSnapshotAt({
        destination,
        layout,
        now,
        verifyPreparedBackup: (path) => verifyBackupAt(path, dependencies),
      });
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
