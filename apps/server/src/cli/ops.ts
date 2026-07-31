import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { loadConfig } from '../config';
import { createArtifactAuditJobCursorCodec } from '../domain/artifactAuditJobCursor';
import { createSqliteArtifactAuditJobRepository } from '../repositories/sqliteArtifactAuditJobRepository';
import { createSqliteProjectRepository } from '../repositories/sqliteProjectRepository';
import { createArtifactIntegrityService } from '../services/artifactIntegrityService';
import { createBackupService } from '../services/backupService';
import {
  acquireRuntimeOwnership,
  type RuntimeMigrationGuard,
} from '../services/runtimeOwnership';
import { collectStorageGarbage } from '../services/storageGarbageCollector';

const appDir = join(import.meta.dir, '..', '..');
const config = loadConfig({ appDir });
if (!config.databaseFile) {
  throw new Error('DATABASE_FILE is required for operational commands');
}
const databaseFile = config.databaseFile;

const args = process.argv.slice(2).filter((argument) => argument !== '--');
const command = args[0] ?? 'help';
const backupService = createBackupService({
  databaseFile,
  storageDir: config.storageDir,
});
const artifactAuditJobCursorCodec = createArtifactAuditJobCursorCodec(
  config.sessionSecret ?? randomBytes(32).toString('base64url')
);

switch (command) {
  case 'backup': {
    const destination =
      args[1] ??
      join(
        appDir,
        '.voasx',
        'backups',
        `backup-${formatTimestamp(new Date())}`
      );
    output({
      command,
      destination,
      manifest: backupService.createBackup(destination),
    });
    break;
  }
  case 'verify': {
    const backupPath = requireArgument(args[1], 'backup path');
    const report = backupService.verifyBackup(backupPath);
    output({ command, backupPath, report });
    if (!report.valid) process.exitCode = 1;
    break;
  }
  case 'restore': {
    const backupPath = requireArgument(args[1], 'backup path');
    output({
      command,
      ...backupService.restoreBackup(backupPath, {
        force: args.includes('--force'),
      }),
    });
    break;
  }
  case 'gc': {
    output({
      command,
      dryRun: args.includes('--dry-run'),
      report: collectStorageGarbage(config.storageDir, {
        stagingRetentionMs:
          (config.stagingRetentionHours ?? 24) * 60 * 60 * 1000,
        recoveryRetentionMs:
          (config.recoveryRetentionHours ?? 168) * 60 * 60 * 1000,
        dryRun: args.includes('--dry-run'),
      }),
    });
    break;
  }
  case 'audit-jobs-prune': {
    withOperationalOwnership((migrationGuard) => {
      const dryRun = args.includes('--dry-run');
      const cutoff = new Date(
        Date.now() -
          (config.artifactAuditJobRetentionHours ?? 168) * 60 * 60 * 1000
      ).toISOString();
      createSqliteProjectRepository({
        databaseFile,
        legacyDataFile: config.dataFile,
        migrationGuard,
      }).load();
      const repository = createSqliteArtifactAuditJobRepository({
        databaseFile,
        cursorCodec: artifactAuditJobCursorCodec,
      });
      output({
        command,
        dryRun,
        cutoff,
        report: repository.pruneTerminal({
          cutoff,
          batchSize: 1_000,
          dryRun,
        }),
      });
    });
    break;
  }
  case 'inspect': {
    withOperationalOwnership((migrationGuard) => {
      const repository = createSqliteProjectRepository({
        databaseFile,
        legacyDataFile: config.dataFile,
        migrationGuard,
      });
      const inspector = createArtifactIntegrityService(
        repository,
        config.storageDir
      );
      const projectId = args[1];
      const versionId = args[2];
      if ((projectId && !versionId) || (!projectId && versionId)) {
        throw new Error(
          'inspect requires both projectId and versionId, or neither'
        );
      }
      const targets =
        projectId && versionId
          ? [{ projectId, versionId }]
          : repository.load().projects.flatMap((project) =>
              project.versions.map((version) => ({
                projectId: project.id,
                versionId: version.id,
              }))
            );
      output({
        command,
        reports: targets.map((target) =>
          inspector.inspectVersion(target.projectId, target.versionId, 'system')
        ),
      });
    });
    break;
  }
  case 'help': {
    console.log(`DeployKit operations

  bun run ops -- backup [destination]
  bun run ops -- verify <backup-path>
  bun run ops -- restore <backup-path> --force
  bun run ops -- gc [--dry-run]
  bun run ops -- audit-jobs-prune [--dry-run]
  bun run ops -- inspect [projectId versionId]

Stop the DeployKit server before restore. Backup and verify are non-destructive.`);
    break;
  }
  default:
    throw new Error(`Unknown operation: ${command}`);
}

function requireArgument(
  value: string | undefined,
  description: string
): string {
  if (!value) throw new Error(`Missing ${description}`);
  return value;
}

function output(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function withOperationalOwnership<T>(
  operation: (migrationGuard: RuntimeMigrationGuard) => T
): T {
  const ownership = acquireRuntimeOwnership(databaseFile, config.storageDir);
  try {
    return operation(ownership.migrationGuard);
  } finally {
    ownership.release();
  }
}

function formatTimestamp(value: Date): string {
  return value.toISOString().replaceAll(':', '-').replaceAll('.', '-');
}
