import { Database } from 'bun:sqlite';
import {
  O_CREAT,
  O_DIRECTORY,
  O_EXCL,
  O_NOFOLLOW,
  O_RDONLY,
  O_WRONLY,
} from 'node:constants';
import { createHash } from 'node:crypto';
import {
  closeSync,
  cpSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { loadRelationalData } from '../repositories/sqliteProjectRepository';
import {
  configureSqlite,
  getRelationalSchemaVersion,
  RELATIONAL_SCHEMA_VERSION,
  upgradeRelationalSchema,
} from '../repositories/sqliteSchema';
import { createId } from '../utils/id';
import {
  canonicalizeResourcePath,
  type RuntimeResourceLayout,
  resolveRuntimeResourceLayout,
  runtimePathsOverlap,
} from '../utils/runtimeResourcePath';
import { safeJoin } from '../utils/safePath';
import { checksumDirectory } from './artifactService';
import {
  acquireRuntimeOwnership,
  assertRuntimeResourceLeavesSafe,
} from './runtimeOwnership';

export interface BackupManifest {
  formatVersion: 1;
  createdAt: string;
  schemaVersion: number;
  databaseFile: string;
  storageDirectory: 'storage';
  metadataCounts: {
    users: number;
    projects: number;
    versions: number;
    artifactAudits: number;
    artifactAuditJobs: number;
    auditEvents: number;
    releases: number;
    sessions: number;
    apiTokens?: number;
    apiTokenSecurityEvents?: number;
    ciIdempotencyRecords?: number;
  };
  artifactCounts: {
    files: number;
    bytes: number;
    deployableVersions: number;
  };
}

export interface BackupVerificationReport {
  valid: boolean;
  errors: string[];
  warnings: string[];
  manifest: BackupManifest | null;
}

export interface BackupRestoreReport {
  restoredFrom: string;
  rollbackPath: string;
  verification: BackupVerificationReport;
}

export interface BackupService {
  createBackup(destination: string): BackupManifest;
  verifyBackup(backupPath: string): BackupVerificationReport;
  restoreBackup(
    backupPath: string,
    options: { force: boolean }
  ): BackupRestoreReport;
}

interface BackupServiceConfig {
  databaseFile: string;
  storageDir: string;
}

interface BackupServiceDependencies {
  now?: () => Date;
  afterCurrentStateMoved?: (rollbackPath: string) => void;
  afterDatabaseInstalled?: (rollbackPath: string) => void;
  afterRestoredStateInstalled?: (rollbackPath: string) => void;
  restoreFileSystem?: RestoreFileSystem;
  acquireOwnership?: (
    databaseFile: string,
    storageDir: string
  ) => RuntimeOwnership;
  createOperationId?: () => string;
  afterInitialBackupVerified?: (backupPath: string) => void;
  afterRestorePayloadStaged?: (
    manifestStage: string,
    databaseStage: string,
    storageStage: string
  ) => void;
  createTemporaryRoot?: (prefix: string) => string;
  cleanupTemporaryRoot?: (temporaryRoot: string) => void;
}

const DATABASE_AUXILIARY_SUFFIXES = ['-journal', '-wal', '-shm'] as const;
type DatabaseAuxiliarySuffix = (typeof DATABASE_AUXILIARY_SUFFIXES)[number];
const BACKUP_DATABASE_SNAPSHOT_UNSAFE = 'BACKUP_DATABASE_SNAPSHOT_UNSAFE';
const BACKUP_SOURCE_UNSAFE = 'BACKUP_SOURCE_UNSAFE';
const BACKUP_MIGRATION_PREFLIGHT_FAILED = 'BACKUP_MIGRATION_PREFLIGHT_FAILED';
const BACKUP_VALIDATION_CLEANUP_FAILED = 'BACKUP_VALIDATION_CLEANUP_FAILED';
const RESTORE_BACKUP_SOURCE_CHANGED = 'RESTORE_BACKUP_SOURCE_CHANGED';
const RESTORE_CONTROL_LAYOUT_UNSAFE = 'RESTORE_CONTROL_LAYOUT_UNSAFE';
const RESTORE_DATABASE_STAGE_UNSAFE = 'RESTORE_DATABASE_STAGE_UNSAFE';

interface RestoreFileSystem {
  rename(source: string, target: string): void;
  copy(
    source: string,
    target: string,
    options?: {
      recursive?: boolean;
      preserveTimestamps?: boolean;
      errorOnExist?: boolean;
      force?: boolean;
    }
  ): void;
  remove(
    target: string,
    options?: { recursive?: boolean; force?: boolean }
  ): void;
}

interface RuntimeOwnership {
  release(): void;
}

interface ResourceMoveProgress {
  rollbackPublished: boolean;
  rollbackAmbiguous: boolean;
  sourceRemoved: boolean;
}

interface PathIdentity {
  dev: bigint;
  ino: bigint;
  kind: 'directory' | 'file';
}

interface BoundRestorePath {
  identity: PathIdentity;
  name: string;
  path: string;
}

interface RestoreControlBinding {
  paths: BoundRestorePath[];
  quarantineOperation: boolean;
  rollbackRootCreated: boolean;
}

interface RuntimeMoveProgress {
  database: ResourceMoveProgress;
  storage: ResourceMoveProgress;
  databaseAuxiliaries: Record<DatabaseAuxiliarySuffix, ResourceMoveProgress>;
}

interface RestoreSecondaryFailure {
  step: string;
  resource: string;
  error: unknown;
}

interface RestoreOperationLayout {
  rollbackRoot: string;
  rollbackPath: string;
  rollbackDatabaseDirectory: string;
  rollbackDatabase: string;
  rollbackStorage: string;
  databaseStage: string;
  databaseStageAuxiliaries: Readonly<Record<DatabaseAuxiliarySuffix, string>>;
  storageStage: string;
  manifestStage: string;
}

interface VerifiedBackupPayload {
  report: BackupVerificationReport;
  fingerprint?: string;
}

const defaultRestoreFileSystem: RestoreFileSystem = {
  rename(source, target) {
    renameSync(source, target);
  },
  copy(source, target, options) {
    cpSync(source, target, options);
  },
  remove(target, options) {
    rmSync(target, options);
  },
};

interface RuntimeStatePresence {
  database: boolean;
  storage: boolean;
  databaseAuxiliaries: Readonly<Record<DatabaseAuxiliarySuffix, boolean>>;
}

interface VersionIntegrityRow {
  id: string;
  project_id: string;
  status: string;
  checksum: string;
  integrity_status: string;
}

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
      if (existsSync(destination)) {
        throw new Error(`Backup destination already exists: ${destination}`);
      }

      mkdirSync(dirname(destination), { recursive: true });
      const temporaryPath = `${destination}.tmp-${createId()}`;
      const databaseDirectory = join(temporaryPath, 'database');
      const snapshotFile = join(
        databaseDirectory,
        basename(layout.databaseFile)
      );
      const backupStorage = join(temporaryPath, 'storage');

      try {
        mkdirSync(databaseDirectory, { recursive: true });
        const database = new Database(layout.databaseFile);
        try {
          database.exec('PRAGMA busy_timeout = 5000');
          database.query('VACUUM INTO ?').run(snapshotFile);
        } finally {
          database.close();
        }

        if (existsSync(layout.storageDir)) {
          cpSync(layout.storageDir, backupStorage, {
            recursive: true,
            preserveTimestamps: true,
          });
        } else {
          mkdirSync(backupStorage, { recursive: true });
        }

        const metadata = inspectDatabase(snapshotFile);
        const artifactTree = inspectTree(backupStorage);
        if (artifactTree.symlinks.length > 0) {
          throw new Error(
            `Artifact storage contains unsupported symbolic links: ${artifactTree.symlinks.join(', ')}`
          );
        }
        const manifest: BackupManifest = {
          formatVersion: 1,
          createdAt: now().toISOString(),
          schemaVersion: metadata.schemaVersion,
          databaseFile: basename(layout.databaseFile),
          storageDirectory: 'storage',
          metadataCounts: metadata.counts,
          artifactCounts: {
            files: artifactTree.files,
            bytes: artifactTree.bytes,
            deployableVersions: countDeployableVersions(
              backupStorage,
              metadata.versions
            ),
          },
        };
        writeFileSync(
          join(temporaryPath, 'manifest.json'),
          JSON.stringify(manifest, null, 2),
          'utf8'
        );

        const verification = verifyBackupAt(temporaryPath, dependencies);
        if (!verification.valid) {
          throw new Error(
            `Backup verification failed: ${verification.errors.join('; ')}`
          );
        }
        renameSync(temporaryPath, destination);
        return manifest;
      } catch (error) {
        rmSync(temporaryPath, { recursive: true, force: true });
        throw error;
      }
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

      const restoreFileSystem =
        dependencies.restoreFileSystem ?? defaultRestoreFileSystem;
      const operation = createRestoreOperationLayout(
        layout,
        `${formatTimestamp(now())}-${
          dependencies.createOperationId?.() ?? createId()
        }`
      );
      assertRestoreControlLayoutSafe(layout, operation);

      const runtimeOwnership = (
        dependencies.acquireOwnership ?? acquireRuntimeOwnership
      )(layout.databaseFile, layout.storageDir);
      let report: BackupRestoreReport | undefined;
      let primaryError: Error | undefined;
      let controlBinding: RestoreControlBinding | undefined;
      try {
        assertRestoreControlLayoutSafe(layout, operation);
        controlBinding = bindRestoreControls(operation);
        const stagedVerification = prepareRestorePayload({
          backupPath,
          dependencies,
          expectedFingerprint: initialVerification.fingerprint,
          operation,
        });
        bindRestoreStages(controlBinding, operation);
        report = executeRestore({
          backupPath,
          dependencies,
          layout,
          now,
          operation,
          restoreFileSystem,
          verification: stagedVerification,
          expectedFingerprint: initialVerification.fingerprint,
          controlBinding,
        });
      } catch (error) {
        primaryError = asError(error);
        cleanupPreparedRestore(operation, primaryError, controlBinding);
      }

      try {
        runtimeOwnership.release();
      } catch (releaseError) {
        if (!primaryError) throw releaseError;
        attachRestoreSecondaryFailures(primaryError, [
          {
            step: 'release',
            resource: 'runtime-ownership',
            error: releaseError,
          },
        ]);
      }

      if (primaryError) throw primaryError;
      if (!report) {
        throw new Error('Restore completed without a report');
      }
      return report;
    },
  };
}

function executeRestore({
  backupPath,
  dependencies,
  layout,
  now,
  operation,
  restoreFileSystem,
  verification,
  expectedFingerprint,
  controlBinding,
}: {
  backupPath: string;
  dependencies: BackupServiceDependencies;
  layout: RuntimeResourceLayout;
  now: () => Date;
  operation: RestoreOperationLayout;
  restoreFileSystem: RestoreFileSystem;
  verification: BackupVerificationReport;
  expectedFingerprint: string;
  controlBinding: RestoreControlBinding;
}): BackupRestoreReport {
  const moveProgress = createRuntimeMoveProgress();
  let preRestoreState: RuntimeStatePresence | undefined;

  try {
    dependencies.afterRestorePayloadStaged?.(
      operation.manifestStage,
      operation.databaseStage,
      operation.storageStage
    );
    assertRestoreDatabaseStageSafe(operation.databaseStage);
    assertDatabaseAuxiliariesAbsent(operation.databaseStage);
    assertRestoreControlsBound(controlBinding);
    const finalVerification = verifyStagedBackupPayload(
      operation.manifestStage,
      operation.databaseStage,
      operation.storageStage,
      dependencies
    );
    if (!finalVerification.report.valid || !finalVerification.fingerprint) {
      throw new Error(
        `Backup verification failed: ${finalVerification.report.errors.join('; ')}`
      );
    }
    if (finalVerification.fingerprint !== expectedFingerprint) {
      throw new Error(
        `[${RESTORE_BACKUP_SOURCE_CHANGED}] Staged backup payload changed before restore`
      );
    }
    verification = finalVerification.report;
    assertRestoreDatabaseStageSafe(operation.databaseStage);
    assertDatabaseAuxiliariesAbsent(operation.databaseStage);
    assertRestoreControlsBound(controlBinding);
    assertRuntimeResourceLeavesSafe(layout);
    preRestoreState = captureRuntimeStatePresence(layout);
    assertRestoreControlsBound(controlBinding);
    assertDatabaseAuxiliariesAbsent(operation.databaseStage);
    moveIfPresent(
      layout.databaseFile,
      operation.rollbackDatabase,
      moveProgress.database,
      restoreFileSystem
    );
    for (const suffix of DATABASE_AUXILIARY_SUFFIXES) {
      moveIfPresent(
        `${layout.databaseFile}${suffix}`,
        `${operation.rollbackDatabase}${suffix}`,
        moveProgress.databaseAuxiliaries[suffix],
        restoreFileSystem
      );
    }
    moveIfPresent(
      layout.storageDir,
      operation.rollbackStorage,
      moveProgress.storage,
      restoreFileSystem
    );
    ensureRollbackManifest(
      operation.rollbackPath,
      basename(layout.databaseFile),
      now()
    );

    dependencies.afterCurrentStateMoved?.(operation.rollbackPath);

    restoreFileSystem.rename(operation.databaseStage, layout.databaseFile);
    dependencies.afterDatabaseInstalled?.(operation.rollbackPath);
    mkdirSync(dirname(layout.storageDir), { recursive: true });
    restoreFileSystem.rename(operation.storageStage, layout.storageDir);
    dependencies.afterRestoredStateInstalled?.(operation.rollbackPath);
    restoreFileSystem.remove(operation.manifestStage, { force: true });
    for (const auxiliary of Object.values(operation.databaseStageAuxiliaries)) {
      restoreFileSystem.remove(auxiliary, { force: true });
    }
  } catch (error) {
    const primaryError = asError(error);
    const secondaryFailures: RestoreSecondaryFailure[] = [];
    controlBinding.quarantineOperation = hasRollbackEvidence(moveProgress);
    if (preRestoreState) {
      recoverCurrentState(
        layout,
        operation,
        {
          moveProgress,
          preRestoreState,
        },
        restoreFileSystem,
        secondaryFailures
      );
    }

    removeBestEffort(
      restoreFileSystem,
      operation.databaseStage,
      { force: true },
      'cleanup-stage',
      'database-stage',
      secondaryFailures
    );
    removeBestEffort(
      restoreFileSystem,
      operation.storageStage,
      { recursive: true, force: true },
      'cleanup-stage',
      'storage-stage',
      secondaryFailures
    );
    removeBestEffort(
      restoreFileSystem,
      operation.manifestStage,
      { force: true },
      'cleanup-stage',
      'manifest-stage',
      secondaryFailures
    );
    for (const [suffix, auxiliary] of Object.entries(
      operation.databaseStageAuxiliaries
    )) {
      removeBestEffort(
        restoreFileSystem,
        auxiliary,
        { force: true },
        'cleanup-stage',
        `database-stage${suffix}`,
        secondaryFailures
      );
    }
    attachRestoreSecondaryFailures(primaryError, secondaryFailures);
    throw primaryError;
  }

  return {
    restoredFrom: backupPath,
    rollbackPath: operation.rollbackPath,
    verification,
  };
}

function createRestoreOperationLayout(
  layout: RuntimeResourceLayout,
  operationId: string
): RestoreOperationLayout {
  const rollbackRoot = join(
    dirname(layout.databaseFile),
    '.deploykit-rollback'
  );
  const rollbackPath = join(rollbackRoot, operationId);
  const rollbackDatabaseDirectory = join(rollbackPath, 'database');
  const databaseStage = `${layout.databaseFile}.restore-${operationId}`;
  return {
    rollbackRoot,
    rollbackPath,
    rollbackDatabaseDirectory,
    rollbackDatabase: join(
      rollbackDatabaseDirectory,
      basename(layout.databaseFile)
    ),
    rollbackStorage: join(rollbackPath, 'storage'),
    databaseStage,
    databaseStageAuxiliaries: {
      '-journal': `${databaseStage}-journal`,
      '-wal': `${databaseStage}-wal`,
      '-shm': `${databaseStage}-shm`,
    },
    storageStage: join(
      dirname(layout.storageDir),
      `.${basename(layout.storageDir)}.restore-${operationId}`
    ),
    manifestStage: `${layout.databaseFile}.manifest-${operationId}`,
  };
}

function assertRestoreControlLayoutSafe(
  layout: RuntimeResourceLayout,
  operation: RestoreOperationLayout
): void {
  const rollbackRootStats = lstatIfPresent(operation.rollbackRoot);
  if (
    rollbackRootStats &&
    (rollbackRootStats.isSymbolicLink() || !rollbackRootStats.isDirectory())
  ) {
    throw new Error(
      `[${RESTORE_CONTROL_LAYOUT_UNSAFE}] Restore rollback root must be a real directory`
    );
  }

  for (const [controlName, controlPath] of [
    ['rollback-operation', operation.rollbackPath],
    ['database-stage', operation.databaseStage],
    ...DATABASE_AUXILIARY_SUFFIXES.map(
      (suffix) =>
        [
          `database-stage${suffix}`,
          operation.databaseStageAuxiliaries[suffix],
        ] as const
    ),
    ['storage-stage', operation.storageStage],
    ['manifest-stage', operation.manifestStage],
  ] as const) {
    if (pathEntryExistsNoFollow(controlPath)) {
      throw new Error(
        `[${RESTORE_CONTROL_LAYOUT_UNSAFE}] Restore control path already exists: ${controlName}`
      );
    }
  }

  const controlPaths = [
    ['rollback-root', operation.rollbackRoot],
    ['rollback-operation', operation.rollbackPath],
    ['rollback-database-directory', operation.rollbackDatabaseDirectory],
    ['rollback-database', operation.rollbackDatabase],
    ...DATABASE_AUXILIARY_SUFFIXES.map(
      (suffix) =>
        [
          `rollback-database${suffix}`,
          `${operation.rollbackDatabase}${suffix}`,
        ] as const
    ),
    ['rollback-storage', operation.rollbackStorage],
    ['database-stage', operation.databaseStage],
    ...DATABASE_AUXILIARY_SUFFIXES.map(
      (suffix) =>
        [
          `database-stage${suffix}`,
          operation.databaseStageAuxiliaries[suffix],
        ] as const
    ),
    ['storage-stage', operation.storageStage],
    ['manifest-stage', operation.manifestStage],
  ] as const;

  for (const [controlName, controlPath] of controlPaths) {
    const canonicalControlPath = canonicalizeResourcePath(controlPath);
    for (const resource of layout.resources) {
      if (runtimePathsOverlap(canonicalControlPath, resource.path)) {
        throw new Error(
          `[${RESTORE_CONTROL_LAYOUT_UNSAFE}] Restore control path ${controlName} overlaps runtime resource ${resource.name}`
        );
      }
    }
  }
}

function bindRestoreControls(
  operation: RestoreOperationLayout
): RestoreControlBinding {
  const binding: RestoreControlBinding = {
    paths: [],
    quarantineOperation: false,
    rollbackRootCreated: false,
  };
  try {
    bindDirectoryOnce(
      binding,
      'rollback-parent',
      dirname(operation.rollbackRoot)
    );
    bindDirectoryOnce(
      binding,
      'database-stage-parent',
      dirname(operation.databaseStage)
    );
    bindDirectoryOnce(
      binding,
      'storage-stage-parent',
      dirname(operation.storageStage)
    );

    if (!pathEntryExistsNoFollow(operation.rollbackRoot)) {
      mkdirSync(operation.rollbackRoot, {
        recursive: false,
        mode: 0o700,
      });
      binding.rollbackRootCreated = true;
    }
    bindDirectoryOnce(binding, 'rollback-root', operation.rollbackRoot);

    mkdirSync(operation.rollbackPath, { recursive: false, mode: 0o700 });
    bindDirectoryOnce(binding, 'rollback-operation', operation.rollbackPath);
    mkdirSync(operation.rollbackDatabaseDirectory, {
      recursive: false,
      mode: 0o700,
    });
    bindDirectoryOnce(
      binding,
      'rollback-database-directory',
      operation.rollbackDatabaseDirectory
    );
    return binding;
  } catch (error) {
    const primaryError = asError(error);
    const failures: RestoreSecondaryFailure[] = [];
    cleanupBoundRestoreControls(binding, operation, failures);
    attachRestoreSecondaryFailures(primaryError, failures);
    throw primaryError;
  }
}

function bindRestoreStages(
  binding: RestoreControlBinding,
  operation: RestoreOperationLayout
): void {
  assertDatabaseAuxiliariesAbsent(operation.databaseStage);
  bindPathOnce(binding, 'manifest-stage', operation.manifestStage, 'file');
  bindPathOnce(binding, 'database-stage', operation.databaseStage, 'file');
  bindPathOnce(binding, 'storage-stage', operation.storageStage, 'directory');
  assertRestoreControlsBound(binding);
}

function bindDirectoryOnce(
  binding: RestoreControlBinding,
  name: string,
  path: string
): void {
  bindPathOnce(binding, name, path, 'directory');
}

function bindPathOnce(
  binding: RestoreControlBinding,
  name: string,
  path: string,
  kind: PathIdentity['kind']
): void {
  if (binding.paths.some((entry) => entry.path === path)) return;
  binding.paths.push({ identity: capturePathIdentity(path, kind), name, path });
}

function capturePathIdentity(
  path: string,
  expectedKind: PathIdentity['kind']
): PathIdentity {
  const descriptor = openSync(
    path,
    O_RDONLY | O_NOFOLLOW | (expectedKind === 'directory' ? O_DIRECTORY : 0)
  );
  try {
    const descriptorStats = fstatSync(descriptor, { bigint: true });
    const pathStats = lstatSync(path, { bigint: true });
    const descriptorIdentity = pathIdentityFromStats(descriptorStats);
    const pathIdentity = pathIdentityFromStats(pathStats);
    if (
      pathStats.isSymbolicLink() ||
      descriptorIdentity.kind !== expectedKind ||
      pathIdentity.kind !== expectedKind ||
      !samePathIdentity(descriptorIdentity, pathIdentity)
    ) {
      throw new Error(
        `[${RESTORE_CONTROL_LAYOUT_UNSAFE}] Restore control path must remain a real ${expectedKind}: ${path}`
      );
    }
    return descriptorIdentity;
  } finally {
    closeSync(descriptor);
  }
}

function pathIdentityFromStats(stats: {
  dev: bigint;
  ino: bigint;
  isDirectory(): boolean;
  isFile(): boolean;
}): PathIdentity {
  const kind = stats.isDirectory()
    ? 'directory'
    : stats.isFile()
      ? 'file'
      : undefined;
  if (!kind) {
    throw new Error(
      `[${RESTORE_CONTROL_LAYOUT_UNSAFE}] Restore control path has an unsupported type`
    );
  }
  return { dev: stats.dev, ino: stats.ino, kind };
}

function assertRestoreControlsBound(binding: RestoreControlBinding): void {
  for (const bound of binding.paths) {
    let current: PathIdentity;
    try {
      current = capturePathIdentity(bound.path, bound.identity.kind);
    } catch (error) {
      const unsafe = new Error(
        `[${RESTORE_CONTROL_LAYOUT_UNSAFE}] Bound restore control changed: ${bound.name}`
      );
      (unsafe as Error & { cause?: unknown }).cause = error;
      throw unsafe;
    }
    if (!samePathIdentity(bound.identity, current)) {
      throw new Error(
        `[${RESTORE_CONTROL_LAYOUT_UNSAFE}] Bound restore control changed: ${bound.name}`
      );
    }
  }
}

function samePathIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return (
    left.dev === right.dev && left.ino === right.ino && left.kind === right.kind
  );
}

function cleanupBoundRestoreControls(
  binding: RestoreControlBinding,
  operation: RestoreOperationLayout,
  failures: RestoreSecondaryFailure[]
): void {
  const rollbackRoot = binding.paths.find(
    (entry) => entry.name === 'rollback-root'
  );
  if (!rollbackRoot) return;
  if (!boundPathStillMatches(rollbackRoot)) {
    unlinkChangedSymlink(operation.rollbackRoot, 'rollback-root', failures);
    return;
  }

  const rollbackOperation = binding.paths.find(
    (entry) => entry.name === 'rollback-operation'
  );
  if (rollbackOperation && !boundPathStillMatches(rollbackOperation)) {
    unlinkChangedSymlink(
      operation.rollbackPath,
      'rollback-operation',
      failures
    );
  } else if (
    rollbackOperation &&
    boundPathStillMatches(rollbackOperation) &&
    !binding.quarantineOperation &&
    !rollbackOperationContainsEvidence(operation)
  ) {
    try {
      rmSync(operation.rollbackPath, { recursive: true, force: true });
    } catch (error) {
      failures.push({
        step: 'cleanup-operation',
        resource: 'rollback-operation',
        error,
      });
    }
  }

  if (binding.rollbackRootCreated) {
    try {
      rmdirSync(operation.rollbackRoot);
    } catch (error) {
      if (!isMissingPathError(error) && !isDirectoryNotEmptyError(error)) {
        failures.push({
          step: 'cleanup-operation',
          resource: 'rollback-root',
          error,
        });
      }
    }
  }
}

function boundPathStillMatches(bound: BoundRestorePath): boolean {
  try {
    return samePathIdentity(
      bound.identity,
      capturePathIdentity(bound.path, bound.identity.kind)
    );
  } catch {
    return false;
  }
}

function unlinkChangedSymlink(
  path: string,
  resource: string,
  failures: RestoreSecondaryFailure[]
): void {
  try {
    const stats = lstatIfPresent(path);
    if (stats?.isSymbolicLink()) unlinkSync(path);
  } catch (error) {
    failures.push({ step: 'cleanup-operation', resource, error });
  }
}

function rollbackOperationContainsEvidence(
  operation: RestoreOperationLayout
): boolean {
  try {
    return readdirSync(operation.rollbackPath).some((entry) => {
      if (entry !== 'database') return true;
      return readdirSync(operation.rollbackDatabaseDirectory).length > 0;
    });
  } catch {
    return true;
  }
}

function isDirectoryNotEmptyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as Error & { code?: string }).code === 'ENOTEMPTY'
  );
}

function createRuntimeMoveProgress(): RuntimeMoveProgress {
  return {
    database: createResourceMoveProgress(),
    storage: createResourceMoveProgress(),
    databaseAuxiliaries: {
      '-journal': createResourceMoveProgress(),
      '-wal': createResourceMoveProgress(),
      '-shm': createResourceMoveProgress(),
    },
  };
}

function createResourceMoveProgress(): ResourceMoveProgress {
  return {
    rollbackPublished: false,
    rollbackAmbiguous: false,
    sourceRemoved: false,
  };
}

function hasRollbackEvidence(progress: RuntimeMoveProgress): boolean {
  return (
    progress.database.rollbackPublished ||
    progress.database.rollbackAmbiguous ||
    progress.storage.rollbackPublished ||
    progress.storage.rollbackAmbiguous ||
    DATABASE_AUXILIARY_SUFFIXES.some(
      (suffix) =>
        progress.databaseAuxiliaries[suffix].rollbackPublished ||
        progress.databaseAuxiliaries[suffix].rollbackAmbiguous
    )
  );
}

function prepareRestorePayload({
  backupPath,
  dependencies,
  expectedFingerprint,
  operation,
}: {
  backupPath: string;
  dependencies: BackupServiceDependencies;
  expectedFingerprint: string;
  operation: RestoreOperationLayout;
}): BackupVerificationReport {
  captureBackupPayload(backupPath, {
    databaseStage: operation.databaseStage,
    manifestStage: operation.manifestStage,
    storageStage: operation.storageStage,
  });
  const staged = verifyStagedBackupPayload(
    operation.manifestStage,
    operation.databaseStage,
    operation.storageStage,
    dependencies
  );
  if (!staged.report.valid || !staged.fingerprint) {
    throw new Error(
      `Backup verification failed: ${staged.report.errors.join('; ')}`
    );
  }
  if (staged.fingerprint !== expectedFingerprint) {
    throw new Error(
      `[${RESTORE_BACKUP_SOURCE_CHANGED}] Backup payload changed after initial verification`
    );
  }
  return staged.report;
}

function cleanupPreparedRestore(
  operation: RestoreOperationLayout,
  primaryError: Error,
  controlBinding?: RestoreControlBinding
): void {
  const failures: RestoreSecondaryFailure[] = [];
  for (const [path, recursive] of [
    [operation.databaseStage, false],
    [operation.storageStage, true],
    [operation.manifestStage, false],
    ...DATABASE_AUXILIARY_SUFFIXES.map(
      (suffix) => [operation.databaseStageAuxiliaries[suffix], false] as const
    ),
  ] as const) {
    try {
      rmSync(path, { recursive, force: true });
      if (pathEntryExistsNoFollow(path)) {
        throw new Error(`Restore stage cleanup failed: ${path}`);
      }
    } catch (error) {
      failures.push({
        step: 'cleanup-stage',
        resource: path,
        error,
      });
    }
  }
  if (controlBinding) {
    cleanupBoundRestoreControls(controlBinding, operation, failures);
  }
  attachRestoreSecondaryFailures(primaryError, failures);
}

function captureBackupPayload(
  backupPath: string,
  stages: {
    manifestStage: string;
    databaseStage?: string;
    databaseStageDirectory?: string;
    storageStage: string;
  }
): void {
  captureRegularFileNoFollow(
    join(backupPath, 'manifest.json'),
    stages.manifestStage
  );
  const manifest = parseManifest(
    JSON.parse(readFileSync(stages.manifestStage, 'utf8'))
  );
  const sourceDatabase = join(backupPath, 'database', manifest.databaseFile);
  assertDatabaseAuxiliariesAbsent(sourceDatabase);
  const databaseStage =
    stages.databaseStage ??
    join(stages.databaseStageDirectory ?? '', manifest.databaseFile);
  captureRegularFileNoFollow(
    sourceDatabase,
    databaseStage,
    BACKUP_DATABASE_SNAPSHOT_UNSAFE
  );
  assertDatabaseAuxiliariesAbsent(sourceDatabase);
  captureDirectoryNoFollow(
    join(backupPath, manifest.storageDirectory),
    stages.storageStage
  );
}

function captureRegularFileNoFollow(
  source: string,
  target: string,
  unsafeCode = BACKUP_SOURCE_UNSAFE
): void {
  let sourceDescriptor: number;
  try {
    const pathStats = lstatSync(source, { bigint: true });
    assertSingleLinkRegularFile(source, pathStats, unsafeCode);
    sourceDescriptor = openSync(source, O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ELOOP' || error.code === 'EMLINK')
    ) {
      throw new Error(
        `[${unsafeCode}] Backup source must not be a symbolic link: ${source}`
      );
    }
    throw error;
  }
  let targetDescriptor: number | undefined;
  try {
    const before = fstatSync(sourceDescriptor, { bigint: true });
    assertSingleLinkRegularFile(source, before, unsafeCode);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    targetDescriptor = openSync(
      target,
      O_CREAT | O_EXCL | O_NOFOLLOW | O_WRONLY,
      0o600
    );
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let totalBytes = 0n;
    while (true) {
      const bytesRead = readSync(
        sourceDescriptor,
        chunk,
        0,
        chunk.length,
        null
      );
      if (bytesRead === 0) break;
      let offset = 0;
      while (offset < bytesRead) {
        const written = writeSync(
          targetDescriptor,
          chunk,
          offset,
          bytesRead - offset
        );
        if (written === 0) {
          throw new Error(`Backup stage write stalled: ${target}`);
        }
        offset += written;
      }
      totalBytes += BigInt(bytesRead);
    }
    fsyncSync(targetDescriptor);
    const after = fstatSync(sourceDescriptor, { bigint: true });
    assertSingleLinkRegularFile(source, after, unsafeCode);
    if (!sameCapturedIdentity(before, after) || totalBytes !== after.size) {
      throw new Error(`Backup source changed while reading: ${source}`);
    }
    const pathStats = lstatSync(source, { bigint: true });
    if (pathStats.isSymbolicLink() || !sameCapturedIdentity(after, pathStats)) {
      throw new Error(`Backup source changed while reading: ${source}`);
    }
  } finally {
    if (targetDescriptor !== undefined) closeSync(targetDescriptor);
    closeSync(sourceDescriptor);
  }
}

function captureDirectoryNoFollow(source: string, target: string): void {
  const before = lstatSync(source, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(
      `Backup storage must be a non-symbolic directory: ${source}`
    );
  }
  mkdirSync(target, { recursive: false, mode: 0o700 });
  for (const entry of readdirSync(source).sort()) {
    const sourceEntry = join(source, entry);
    const targetEntry = join(target, entry);
    const stats = lstatSync(sourceEntry, { bigint: true });
    if (stats.isSymbolicLink()) {
      throw new Error(
        `Backup contains unsupported symbolic link: ${sourceEntry}`
      );
    }
    if (stats.isDirectory()) {
      captureDirectoryNoFollow(sourceEntry, targetEntry);
    } else if (stats.isFile()) {
      captureRegularFileNoFollow(sourceEntry, targetEntry);
    } else {
      throw new Error(`Backup contains unsupported file type: ${sourceEntry}`);
    }
  }
  const after = lstatSync(source, { bigint: true });
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    !sameCapturedIdentity(before, after)
  ) {
    throw new Error(`Backup storage changed while reading: ${source}`);
  }
}

function assertSingleLinkRegularFile(
  path: string,
  stats: ReturnType<typeof fstatSync> & { nlink: bigint },
  unsafeCode: string
): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n) {
    throw new Error(
      `[${unsafeCode}] Backup source must be a single-link regular file: ${path}`
    );
  }
}

function sameCapturedIdentity(
  left: {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  },
  right: {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  }
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertDatabaseAuxiliariesAbsent(databaseFile: string): void {
  for (const suffix of DATABASE_AUXILIARY_SUFFIXES) {
    if (pathEntryExistsNoFollow(`${databaseFile}${suffix}`)) {
      throw new Error(
        `[${BACKUP_DATABASE_SNAPSHOT_UNSAFE}] Database snapshot must not include ${suffix}`
      );
    }
  }
}

function verifyBackupAt(
  backupPath: string,
  dependencies: BackupServiceDependencies
): BackupVerificationReport {
  return verifyBackupDetailedAt(backupPath, dependencies).report;
}

function verifyBackupDetailedAt(
  backupPath: string,
  dependencies: BackupServiceDependencies
): VerifiedBackupPayload {
  let temporaryRoot: string | undefined;
  let result: VerifiedBackupPayload = {
    report: { valid: false, errors: [], warnings: [], manifest: null },
  };
  try {
    temporaryRoot = createValidationTemporaryRoot(dependencies);
    const capturedRoot = join(temporaryRoot, 'backup');
    const manifestStage = join(capturedRoot, 'manifest.json');
    captureBackupPayload(backupPath, {
      databaseStageDirectory: join(capturedRoot, 'database'),
      manifestStage,
      storageStage: join(capturedRoot, 'storage'),
    });
    const manifest = parseManifest(
      JSON.parse(readFileSync(manifestStage, 'utf8'))
    );
    result = verifyStagedBackupPayload(
      manifestStage,
      join(capturedRoot, 'database', manifest.databaseFile),
      join(capturedRoot, manifest.storageDirectory),
      dependencies
    );
  } catch (error) {
    result.report.errors.push(
      `Backup capture failed: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    if (temporaryRoot) {
      try {
        cleanupValidationTemporaryRoot(temporaryRoot, dependencies);
      } catch (error) {
        result.report.errors.push(
          `[${BACKUP_VALIDATION_CLEANUP_FAILED}] Temporary validation cleanup failed: ${migrationPreflightErrorMessage(
            error,
            temporaryRoot
          )}`
        );
      }
    }
  }
  result.report.valid = result.report.errors.length === 0;
  if (!result.report.valid) delete result.fingerprint;
  return result;
}

function verifyStagedBackupPayload(
  manifestPath: string,
  databaseFile: string,
  storageDir: string,
  dependencies: BackupServiceDependencies
): VerifiedBackupPayload {
  const errors: string[] = [];
  const warnings: string[] = [];
  let manifest: BackupManifest | null = null;
  try {
    manifest = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  } catch (error) {
    errors.push(
      `Invalid backup manifest: ${error instanceof Error ? error.message : String(error)}`
    );
    return { report: { valid: false, errors, warnings, manifest } };
  }

  if (
    manifest.schemaVersion < 5 ||
    manifest.schemaVersion > RELATIONAL_SCHEMA_VERSION
  ) {
    errors.push(
      `Unsupported relational schema version ${manifest.schemaVersion}; supported range is 5-${RELATIONAL_SCHEMA_VERSION}`
    );
  }
  try {
    assertDatabaseAuxiliariesAbsent(databaseFile);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const databaseSnapshotError = inspectBackupDatabaseSnapshot(databaseFile);
  if (databaseSnapshotError) errors.push(databaseSnapshotError);
  if (!existsSync(storageDir)) errors.push('Artifact storage is missing');
  if (errors.length > 0) {
    return { report: { valid: false, errors, warnings, manifest } };
  }

  try {
    const database = new Database(databaseFile, { readonly: true });
    let metadata: ReturnType<typeof inspectOpenDatabase>;
    try {
      const integrity = database
        .query<{ integrity_check: string }, []>('PRAGMA integrity_check')
        .get();
      if (integrity?.integrity_check !== 'ok') {
        errors.push(
          `SQLite integrity check failed: ${integrity?.integrity_check}`
        );
      }
      const foreignKeyFailures = database
        .query<Record<string, unknown>, []>('PRAGMA foreign_key_check')
        .all();
      if (foreignKeyFailures.length > 0) {
        errors.push(
          `SQLite foreign key check found ${foreignKeyFailures.length} violation(s)`
        );
      }
      metadata = inspectOpenDatabase(database);
      if (metadata.schemaVersion === RELATIONAL_SCHEMA_VERSION) {
        loadRelationalData(database);
      }
    } finally {
      database.close();
    }
    assertDatabaseAuxiliariesAbsent(databaseFile);

    if (metadata.schemaVersion !== manifest.schemaVersion) {
      errors.push('Manifest schema version does not match the database');
    }
    compareCounts(manifest.metadataCounts, metadata.counts, 'metadata', errors);
    if (
      metadata.schemaVersion === manifest.schemaVersion &&
      manifest.schemaVersion < RELATIONAL_SCHEMA_VERSION
    ) {
      const migrationError = verifyBackupMigration(
        databaseFile,
        manifest,
        dependencies
      );
      if (migrationError) errors.push(migrationError);
    }

    const artifactTree = inspectTree(storageDir);
    if (artifactTree.symlinks.length > 0) {
      errors.push(
        `Backup contains unsupported symbolic links: ${artifactTree.symlinks.join(', ')}`
      );
    }
    const artifactCounts = {
      files: artifactTree.files,
      bytes: artifactTree.bytes,
      deployableVersions: countDeployableVersions(
        storageDir,
        metadata.versions
      ),
    };
    compareCounts(manifest.artifactCounts, artifactCounts, 'artifact', errors);
    verifyVersionArtifacts(storageDir, metadata.versions, errors, warnings);
  } catch (error) {
    errors.push(
      `Backup database inspection failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  let fingerprint: string | undefined;
  if (errors.length === 0) {
    try {
      fingerprint = fingerprintBackupPayload(
        manifestPath,
        databaseFile,
        storageDir
      );
      assertDatabaseAuxiliariesAbsent(databaseFile);
    } catch (error) {
      errors.push(
        `Backup fingerprint failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  const report = {
    valid: errors.length === 0,
    errors,
    warnings,
    manifest,
  };
  return {
    report,
    ...(report.valid && fingerprint ? { fingerprint } : {}),
  };
}

function verifyBackupMigration(
  sourceDatabaseFile: string,
  manifest: BackupManifest,
  dependencies: BackupServiceDependencies
): string | undefined {
  let temporaryRoot: string | undefined;
  let failure: unknown;
  let cleanupFailure: unknown;
  try {
    temporaryRoot = createValidationTemporaryRoot(
      dependencies,
      'deploykit-backup-migration-preflight-'
    );
    const temporaryDatabaseFile = join(
      temporaryRoot,
      basename(sourceDatabaseFile)
    );
    captureRegularFileNoFollow(sourceDatabaseFile, temporaryDatabaseFile);

    const database = new Database(temporaryDatabaseFile);
    try {
      configureSqlite(database);
      const sourceVersion = getRelationalSchemaVersion(database);
      if (sourceVersion !== manifest.schemaVersion) {
        throw new Error(
          `copied database reports schema v${sourceVersion}, expected v${manifest.schemaVersion}`
        );
      }
      const migrate = database.transaction(() => {
        upgradeRelationalSchema(database, sourceVersion);
      });
      migrate.immediate();

      const migratedVersion = getRelationalSchemaVersion(database);
      if (migratedVersion !== RELATIONAL_SCHEMA_VERSION) {
        throw new Error(
          `migration ended at schema v${migratedVersion}, expected v${RELATIONAL_SCHEMA_VERSION}`
        );
      }
      // Use the exact production hydrator after the exact production migration.
      loadRelationalData(database);

      const integrityRows = database
        .query<{ integrity_check: string }, []>('PRAGMA integrity_check')
        .all();
      if (
        integrityRows.length !== 1 ||
        integrityRows[0]?.integrity_check !== 'ok'
      ) {
        throw new Error(
          `migrated SQLite integrity check failed: ${
            integrityRows.map((row) => row.integrity_check).join(', ') ||
            'no result'
          }`
        );
      }
      const foreignKeyFailures = database
        .query<Record<string, unknown>, []>('PRAGMA foreign_key_check')
        .all();
      if (foreignKeyFailures.length > 0) {
        throw new Error(
          `migrated SQLite foreign key check found ${foreignKeyFailures.length} violation(s)`
        );
      }
    } finally {
      database.close();
    }
  } catch (error) {
    failure = error;
  } finally {
    if (temporaryRoot) {
      try {
        cleanupValidationTemporaryRoot(temporaryRoot, dependencies);
      } catch (error) {
        cleanupFailure = error;
      }
    }
  }

  if (!failure && !cleanupFailure) return undefined;
  const failureMessage = failure
    ? migrationPreflightErrorMessage(failure, temporaryRoot)
    : 'migration checks completed';
  const cleanupMessage = cleanupFailure
    ? `; temporary cleanup failed: ${migrationPreflightErrorMessage(
        cleanupFailure,
        temporaryRoot
      )}`
    : '';
  return `[${BACKUP_MIGRATION_PREFLIGHT_FAILED}] Schema v${manifest.schemaVersion} migration dry-run to v${RELATIONAL_SCHEMA_VERSION} failed: ${failureMessage}${cleanupMessage}`;
}

function createValidationTemporaryRoot(
  dependencies: BackupServiceDependencies,
  prefix = 'deploykit-backup-validation-'
): string {
  const temporaryRoot = dependencies.createTemporaryRoot
    ? dependencies.createTemporaryRoot(prefix)
    : mkdtempSync(join(tmpdir(), prefix));
  const stats = lstatSync(temporaryRoot);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(
      'Backup validation temporary root must be a real directory'
    );
  }
  if (readdirSync(temporaryRoot).length > 0) {
    throw new Error('Backup validation temporary root must be empty');
  }
  return temporaryRoot;
}

function cleanupValidationTemporaryRoot(
  temporaryRoot: string,
  dependencies: BackupServiceDependencies
): void {
  (
    dependencies.cleanupTemporaryRoot ??
    ((path) => {
      rmSync(path, { recursive: true, force: true });
    })
  )(temporaryRoot);
  if (pathEntryExistsNoFollow(temporaryRoot)) {
    throw new Error('temporary root still exists after cleanup');
  }
}

function fingerprintBackupPayload(
  manifestPath: string,
  databaseFile: string,
  storageDir: string
): string {
  const hash = createHash('sha256');
  hashFileFrame(hash, 'manifest', manifestPath);
  hashFileFrame(hash, 'database', databaseFile);
  hashDirectory(storageDir, '', hash);
  return hash.digest('hex');
}

function hashDirectory(
  directory: string,
  relativePath: string,
  hash: ReturnType<typeof createHash>
): void {
  for (const entry of readdirSync(directory).sort()) {
    const path = join(directory, entry);
    const relativeEntry = relativePath ? `${relativePath}/${entry}` : entry;
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      throw new Error(`Cannot fingerprint symbolic link: ${relativeEntry}`);
    }
    if (stats.isDirectory()) {
      hashFrame(hash, 'directory', Buffer.from(relativeEntry));
      hashDirectory(path, relativeEntry, hash);
    } else if (stats.isFile()) {
      hashFrame(hash, 'file-path', Buffer.from(relativeEntry));
      hashFileFrame(hash, 'file-bytes', path);
    } else {
      throw new Error(`Cannot fingerprint unsupported file: ${relativeEntry}`);
    }
  }
}

function hashFrame(
  hash: ReturnType<typeof createHash>,
  domain: string,
  payload: Buffer
): void {
  const domainBytes = Buffer.from(domain);
  hash.update(createHashFrameHeader(domainBytes, BigInt(payload.byteLength)));
  hash.update(domainBytes);
  hash.update(payload);
}

function hashFileFrame(
  hash: ReturnType<typeof createHash>,
  domain: string,
  path: string
): void {
  const descriptor = openSync(path, O_RDONLY | O_NOFOLLOW);
  try {
    const stats = fstatSync(descriptor, { bigint: true });
    assertSingleLinkRegularFile(path, stats, BACKUP_SOURCE_UNSAFE);
    const domainBytes = Buffer.from(domain);
    hash.update(createHashFrameHeader(domainBytes, stats.size));
    hash.update(domainBytes);
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let totalBytes = 0n;
    while (true) {
      const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      totalBytes += BigInt(bytesRead);
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameCapturedIdentity(stats, after) || totalBytes !== after.size) {
      throw new Error(`Staged backup changed while hashing: ${path}`);
    }
    const pathStats = lstatSync(path, { bigint: true });
    if (pathStats.isSymbolicLink() || !sameCapturedIdentity(after, pathStats)) {
      throw new Error(`Staged backup path changed while hashing: ${path}`);
    }
  } finally {
    closeSync(descriptor);
  }
}

function createHashFrameHeader(
  domainBytes: Buffer,
  payloadLength: bigint
): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.writeUInt32BE(domainBytes.byteLength, 0);
  header.writeBigUInt64BE(payloadLength, 4);
  return header;
}

function migrationPreflightErrorMessage(
  error: unknown,
  temporaryRoot: string | undefined
): string {
  const message = error instanceof Error ? error.message : String(error);
  return temporaryRoot
    ? message.replaceAll(temporaryRoot, '<temporary>')
    : message;
}

function inspectBackupDatabaseSnapshot(
  databaseFile: string
): string | undefined {
  let stats: ReturnType<typeof lstatSync> | undefined;
  try {
    stats = lstatIfPresent(databaseFile);
  } catch {
    return `[${BACKUP_DATABASE_SNAPSHOT_UNSAFE}] Database snapshot identity could not be verified`;
  }
  if (!stats) return 'Database snapshot is missing';
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return `[${BACKUP_DATABASE_SNAPSHOT_UNSAFE}] Database snapshot must be a non-symbolic regular file`;
  }
  return undefined;
}

function assertRestoreDatabaseStageSafe(databaseStage: string): void {
  let stats: ReturnType<typeof lstatSync> | undefined;
  try {
    stats = lstatIfPresent(databaseStage);
  } catch (error) {
    const stageError = new Error(
      `[${RESTORE_DATABASE_STAGE_UNSAFE}] Database restore stage identity could not be verified`
    );
    (stageError as Error & { cause?: unknown }).cause = error;
    throw stageError;
  }
  if (
    !stats ||
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    stats.nlink !== 1
  ) {
    throw new Error(
      `[${RESTORE_DATABASE_STAGE_UNSAFE}] Database restore stage must be a single-link regular file`
    );
  }
}

function inspectDatabase(databaseFile: string) {
  const database = new Database(databaseFile, { readonly: true });
  try {
    return inspectOpenDatabase(database);
  } finally {
    database.close();
  }
}

function inspectOpenDatabase(database: Database) {
  const count = (table: string): number =>
    database
      .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`)
      .get()?.count ?? 0;
  const schemaVersion =
    database
      .query<{ version: number | null }, []>(
        'SELECT MAX(version) AS version FROM schema_migrations'
      )
      .get()?.version ?? 0;
  const versions = database
    .query<VersionIntegrityRow, []>(
      `SELECT id, project_id, status, checksum, integrity_status
       FROM versions
       ORDER BY project_id, sort_order`
    )
    .all();
  return {
    schemaVersion,
    versions,
    counts: {
      users: count('users'),
      projects: count('projects'),
      versions: count('versions'),
      artifactAudits: count('artifact_audits'),
      artifactAuditJobs: count('artifact_audit_jobs'),
      auditEvents: count('audit_events'),
      releases: count('releases'),
      sessions: count('sessions'),
      ...(schemaVersion >= 6
        ? {
            apiTokens: count('project_api_tokens'),
            apiTokenSecurityEvents: count('api_token_security_events'),
            ciIdempotencyRecords: count('ci_idempotency_records'),
          }
        : {}),
    },
  };
}

function verifyVersionArtifacts(
  storageDir: string,
  versions: VersionIntegrityRow[],
  errors: string[],
  warnings: string[]
): void {
  for (const version of versions) {
    const versionDir = safeJoin(
      storageDir,
      `${version.project_id}/${version.id}`
    );
    if (!versionDir) {
      errors.push(
        `Unsafe artifact identity ${version.project_id}/${version.id}`
      );
      continue;
    }
    const knownDamaged =
      version.status === 'failed' ||
      version.integrity_status === 'missing' ||
      version.integrity_status === 'corrupted';
    if (!existsSync(join(versionDir, 'index.html'))) {
      const issue = `Version ${version.project_id}/${version.id} is missing index.html`;
      (knownDamaged ? warnings : errors).push(issue);
      continue;
    }
    if (version.checksum === '') {
      warnings.push(
        `Version ${version.project_id}/${version.id} has no legacy checksum`
      );
      continue;
    }
    const actualChecksum = checksumDirectory(versionDir);
    if (actualChecksum !== version.checksum) {
      const issue = `Version ${version.project_id}/${version.id} checksum mismatch`;
      (knownDamaged ? warnings : errors).push(issue);
    }
  }
}

function countDeployableVersions(
  storageDir: string,
  versions: VersionIntegrityRow[]
): number {
  return versions.filter((version) => {
    const versionDir = safeJoin(
      storageDir,
      `${version.project_id}/${version.id}`
    );
    return versionDir ? existsSync(join(versionDir, 'index.html')) : false;
  }).length;
}

function inspectTree(root: string): {
  files: number;
  bytes: number;
  symlinks: string[];
} {
  const report = { files: 0, bytes: 0, symlinks: [] as string[] };
  const walk = (path: string, relativePath: string) => {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      report.symlinks.push(relativePath);
      return;
    }
    if (stats.isDirectory()) {
      for (const entry of readdirSync(path)) {
        walk(
          join(path, entry),
          relativePath ? `${relativePath}/${entry}` : entry
        );
      }
      return;
    }
    if (stats.isFile()) {
      report.files += 1;
      report.bytes += stats.size;
    }
  };
  walk(root, '');
  return report;
}

function parseManifest(value: unknown): BackupManifest {
  if (!value || typeof value !== 'object')
    throw new Error('expected an object');
  const candidate = value as Record<string, unknown>;
  if (candidate.formatVersion !== 1) {
    throw new Error('unsupported formatVersion');
  }
  if (
    typeof candidate.createdAt !== 'string' ||
    Number.isNaN(Date.parse(candidate.createdAt))
  ) {
    throw new Error('invalid createdAt');
  }
  if (
    !Number.isSafeInteger(candidate.schemaVersion) ||
    (candidate.schemaVersion as number) <= 0
  ) {
    throw new Error('invalid schemaVersion');
  }
  if (
    typeof candidate.databaseFile !== 'string' ||
    basename(candidate.databaseFile) !== candidate.databaseFile ||
    candidate.databaseFile.length === 0
  ) {
    throw new Error('invalid databaseFile');
  }
  if (candidate.storageDirectory !== 'storage') {
    throw new Error('invalid storageDirectory');
  }
  const metadataCountKeys = [
    'users',
    'projects',
    'versions',
    'artifactAudits',
    'artifactAuditJobs',
    'auditEvents',
    'releases',
    'sessions',
    ...((candidate.schemaVersion as number) >= 6
      ? ['apiTokens', 'apiTokenSecurityEvents', 'ciIdempotencyRecords']
      : []),
  ];
  const metadataCounts = parseCounts(
    candidate.metadataCounts,
    metadataCountKeys
  );
  const artifactCounts = parseCounts(candidate.artifactCounts, [
    'files',
    'bytes',
    'deployableVersions',
  ]);
  return {
    formatVersion: 1,
    createdAt: candidate.createdAt,
    schemaVersion: candidate.schemaVersion as number,
    databaseFile: candidate.databaseFile,
    storageDirectory: 'storage',
    metadataCounts: metadataCounts as BackupManifest['metadataCounts'],
    artifactCounts: artifactCounts as BackupManifest['artifactCounts'],
  };
}

function parseCounts(value: unknown, keys: string[]): Record<string, number> {
  if (!value || typeof value !== 'object') throw new Error('invalid counts');
  const candidate = value as Record<string, unknown>;
  const counts: Record<string, number> = {};
  for (const key of keys) {
    const count = candidate[key];
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new Error(`invalid count ${key}`);
    }
    counts[key] = count as number;
  }
  return counts;
}

function compareCounts(
  expected: Record<string, number>,
  actual: Record<string, number>,
  label: string,
  errors: string[]
): void {
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (actual[key] !== expectedValue) {
      errors.push(
        `${label} count ${key} mismatch: expected ${expectedValue}, received ${actual[key]}`
      );
    }
  }
}

function moveIfPresent(
  source: string,
  target: string,
  progress: ResourceMoveProgress,
  restoreFileSystem: RestoreFileSystem
): void {
  if (!pathEntryExistsNoFollow(source)) return;
  const sourceIdentity = captureMoveIdentity(source);
  mkdirSync(dirname(target), { recursive: true });
  if (pathEntryExistsNoFollow(target)) {
    throw new Error(
      `[RESTORE_ROLLBACK_TARGET_EXISTS] Refusing to reuse rollback target for ${source}`
    );
  }
  try {
    restoreFileSystem.rename(source, target);
    progress.rollbackPublished = true;
    progress.sourceRemoved = true;
    return;
  } catch (error) {
    const commitState = inspectRenameCommit(source, target, sourceIdentity);
    if (commitState === 'committed') {
      progress.rollbackPublished = true;
      progress.sourceRemoved = true;
      throw error;
    }
    if (commitState === 'ambiguous') {
      progress.rollbackAmbiguous = true;
      throw error;
    }
    if (!isCrossDeviceError(error)) throw error;
  }

  const isDirectory = sourceIdentity.kind === 'directory';
  const temporaryTarget = createUnusedSiblingPath(target, 'pending');
  try {
    restoreFileSystem.copy(source, temporaryTarget, {
      errorOnExist: true,
      force: false,
      recursive: isDirectory,
      preserveTimestamps: true,
    });
  } catch (error) {
    const primaryError = asError(error);
    const secondaryFailures: RestoreSecondaryFailure[] = [];
    removeBestEffort(
      restoreFileSystem,
      temporaryTarget,
      { recursive: isDirectory, force: true },
      'cleanup-move-temp',
      source,
      secondaryFailures
    );
    attachRestoreSecondaryFailures(primaryError, secondaryFailures);
    throw primaryError;
  }

  if (pathEntryExistsNoFollow(target)) {
    progress.rollbackAmbiguous = true;
    throw new Error(
      `[RESTORE_ROLLBACK_TARGET_EXISTS] Refusing to overwrite rollback target for ${source}`
    );
  }
  const temporaryIdentity = captureMoveIdentity(temporaryTarget);
  try {
    restoreFileSystem.rename(temporaryTarget, target);
  } catch (error) {
    const commitState = inspectRenameCommit(
      temporaryTarget,
      target,
      temporaryIdentity
    );
    if (commitState === 'committed') {
      progress.rollbackPublished = true;
      throw error;
    }
    if (commitState === 'ambiguous') {
      progress.rollbackAmbiguous = true;
      throw error;
    }
    const primaryError = asError(error);
    const secondaryFailures: RestoreSecondaryFailure[] = [];
    removeBestEffort(
      restoreFileSystem,
      temporaryTarget,
      { recursive: isDirectory, force: true },
      'cleanup-move-temp',
      source,
      secondaryFailures
    );
    attachRestoreSecondaryFailures(primaryError, secondaryFailures);
    throw primaryError;
  }

  // Publication is atomic and authoritative from this point onward. If
  // source removal fails or only partially completes, compensation restores
  // from this known-complete rollback copy.
  progress.rollbackPublished = true;
  restoreFileSystem.remove(source, {
    recursive: isDirectory,
    force: true,
  });
  progress.sourceRemoved = true;
}

function captureMoveIdentity(path: string): PathIdentity {
  const stats = lstatSync(path, { bigint: true });
  if (stats.isSymbolicLink()) {
    throw new Error(
      `[RESTORE_CONTROL_LAYOUT_UNSAFE] Refusing to move a symbolic link: ${path}`
    );
  }
  const kind = stats.isDirectory()
    ? 'directory'
    : stats.isFile()
      ? 'file'
      : undefined;
  if (!kind) {
    throw new Error(
      `[RESTORE_CONTROL_LAYOUT_UNSAFE] Refusing to move an unsupported path: ${path}`
    );
  }
  return { dev: stats.dev, ino: stats.ino, kind };
}

function inspectRenameCommit(
  source: string,
  target: string,
  expected: PathIdentity
): 'ambiguous' | 'committed' | 'not-committed' {
  const sourceState = inspectMovePath(source);
  const targetState = inspectMovePath(target);
  if (
    sourceState.status === 'missing' &&
    targetState.status === 'identity' &&
    samePathIdentity(expected, targetState.identity)
  ) {
    return 'committed';
  }
  if (
    sourceState.status === 'identity' &&
    samePathIdentity(expected, sourceState.identity) &&
    targetState.status === 'missing'
  ) {
    return 'not-committed';
  }
  return 'ambiguous';
}

function inspectMovePath(
  path: string
):
  | { status: 'identity'; identity: PathIdentity }
  | { status: 'missing' | 'unknown' } {
  try {
    return { status: 'identity', identity: captureMoveIdentity(path) };
  } catch (error) {
    return { status: isMissingPathError(error) ? 'missing' : 'unknown' };
  }
}

function recoverCurrentState(
  layout: RuntimeResourceLayout,
  operation: RestoreOperationLayout,
  options: {
    moveProgress: RuntimeMoveProgress;
    preRestoreState: RuntimeStatePresence;
  },
  restoreFileSystem: RestoreFileSystem,
  failures: RestoreSecondaryFailure[]
): void {
  recoverRuntimeResource(
    {
      existedBeforeRestore: options.preRestoreState.database,
      isDirectory: false,
      progress: options.moveProgress.database,
      resource: 'database',
      rollbackPath: operation.rollbackDatabase,
      targetPath: layout.databaseFile,
    },
    restoreFileSystem,
    failures
  );
  // These are rollback-state companions only. Backup payloads contain the
  // verified VACUUM snapshot and never install auxiliary files.
  for (const suffix of DATABASE_AUXILIARY_SUFFIXES) {
    recoverRuntimeResource(
      {
        existedBeforeRestore:
          options.preRestoreState.databaseAuxiliaries[suffix],
        isDirectory: false,
        progress: options.moveProgress.databaseAuxiliaries[suffix],
        resource: `database${suffix}`,
        rollbackPath: `${operation.rollbackDatabase}${suffix}`,
        targetPath: `${layout.databaseFile}${suffix}`,
      },
      restoreFileSystem,
      failures
    );
  }
  recoverRuntimeResource(
    {
      existedBeforeRestore: options.preRestoreState.storage,
      isDirectory: true,
      progress: options.moveProgress.storage,
      resource: 'storage',
      rollbackPath: operation.rollbackStorage,
      targetPath: layout.storageDir,
    },
    restoreFileSystem,
    failures
  );
}

function captureRuntimeStatePresence(
  config: BackupServiceConfig
): RuntimeStatePresence {
  return {
    database: existsSync(config.databaseFile),
    storage: existsSync(config.storageDir),
    databaseAuxiliaries: {
      '-journal': existsSync(`${config.databaseFile}-journal`),
      '-wal': existsSync(`${config.databaseFile}-wal`),
      '-shm': existsSync(`${config.databaseFile}-shm`),
    },
  };
}

function recoverRuntimeResource(
  {
    existedBeforeRestore,
    isDirectory,
    progress,
    resource,
    rollbackPath,
    targetPath,
  }: {
    existedBeforeRestore: boolean;
    isDirectory: boolean;
    progress: ResourceMoveProgress;
    resource: string;
    rollbackPath: string;
    targetPath: string;
  },
  restoreFileSystem: RestoreFileSystem,
  failures: RestoreSecondaryFailure[]
): void {
  if (!existedBeforeRestore) {
    removeBestEffort(
      restoreFileSystem,
      targetPath,
      { recursive: isDirectory, force: true },
      'recover-absent-resource',
      resource,
      failures
    );
    return;
  }

  if (progress.sourceRemoved && !progress.rollbackPublished) {
    failures.push({
      step: 'recover-resource',
      resource,
      error: new Error(
        `[RESTORE_ROLLBACK_INCOMPLETE] Invalid move state for ${resource}`
      ),
    });
    return;
  }

  if (!progress.rollbackPublished) {
    if (!existsSync(targetPath)) {
      failures.push({
        step: 'recover-resource',
        resource,
        error: incompleteRollbackError(resource),
      });
    }
    return;
  }

  // A published copy is authoritative even when sourceRemoved is false:
  // removal may have failed after deleting only part of the live resource.
  try {
    restorePublishedRollback(
      rollbackPath,
      targetPath,
      isDirectory,
      resource,
      restoreFileSystem,
      failures
    );
  } catch (error) {
    failures.push({
      step: 'recover-resource',
      resource,
      error,
    });
  }
}

function restorePublishedRollback(
  rollbackPath: string,
  targetPath: string,
  isDirectory: boolean,
  resource: string,
  restoreFileSystem: RestoreFileSystem,
  failures: RestoreSecondaryFailure[]
): void {
  if (!existsSync(rollbackPath)) {
    throw incompleteRollbackError(resource);
  }
  const recoveryStage = createUnusedSiblingPath(targetPath, 'recover');
  try {
    restoreFileSystem.copy(rollbackPath, recoveryStage, {
      errorOnExist: true,
      force: false,
      recursive: isDirectory,
      preserveTimestamps: true,
    });
    restoreFileSystem.remove(targetPath, {
      recursive: isDirectory,
      force: true,
    });
    mkdirSync(dirname(targetPath), { recursive: true });
    restoreFileSystem.rename(recoveryStage, targetPath);
  } catch (error) {
    removeBestEffort(
      restoreFileSystem,
      recoveryStage,
      { recursive: isDirectory, force: true },
      'cleanup-recovery-stage',
      resource,
      failures
    );
    throw error;
  }
}

function createUnusedSiblingPath(target: string, label: string): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = `${target}.${label}-${createId()}`;
    if (!pathEntryExistsNoFollow(candidate)) return candidate;
  }
  throw new Error(
    `[RESTORE_CONTROL_LAYOUT_UNSAFE] Could not allocate a fresh ${label} path`
  );
}

function lstatIfPresent(
  path: string
): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

function pathEntryExistsNoFollow(path: string): boolean {
  return lstatIfPresent(path) !== undefined;
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as Error & { code?: string }).code === 'ENOENT'
  );
}

function incompleteRollbackError(resource: string): Error {
  return new Error(
    `[RESTORE_ROLLBACK_INCOMPLETE] Missing pre-restore rollback copy for ${resource}`
  );
}

function removeBestEffort(
  restoreFileSystem: RestoreFileSystem,
  target: string,
  options: { recursive?: boolean; force?: boolean },
  step: string,
  resource: string,
  failures: RestoreSecondaryFailure[]
): void {
  try {
    restoreFileSystem.remove(target, options);
  } catch (error) {
    failures.push({ step, resource, error });
  }
}

function attachRestoreSecondaryFailures(
  primaryError: Error,
  newFailures: RestoreSecondaryFailure[]
): Error {
  if (newFailures.length === 0) return primaryError;
  const errorWithFailures = primaryError as Error & {
    cause?: unknown;
    restoreSecondaryFailures?: RestoreSecondaryFailure[];
  };
  let existingFailures: RestoreSecondaryFailure[] = [];
  let previousCause: unknown;
  try {
    existingFailures = errorWithFailures.restoreSecondaryFailures ?? [];
  } catch {
    // A hostile or frozen Error must still remain the authoritative failure.
  }
  try {
    previousCause = errorWithFailures.cause;
  } catch {
    // Preserve primary error authority even when cause is an accessor.
  }
  const failures = [...existingFailures, ...newFailures];
  try {
    errorWithFailures.restoreSecondaryFailures = failures;
  } catch {
    // Structured metadata is best effort for a non-extensible Error object.
  }
  const aggregate = new AggregateError(
    failures.map((failure) => failure.error),
    'Restore encountered secondary compensation failures'
  );
  if (previousCause !== undefined) {
    (aggregate as AggregateError & { cause?: unknown }).cause = previousCause;
  }
  try {
    errorWithFailures.cause = aggregate;
  } catch {
    // Never replace the initiating failure with a metadata-assignment error.
  }
  return primaryError;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function ensureRollbackManifest(
  rollbackPath: string,
  databaseFileName: string,
  createdAt: Date
): void {
  const databaseFile = join(rollbackPath, 'database', databaseFileName);
  if (!existsSync(databaseFile)) return;
  const storageDir = join(rollbackPath, 'storage');
  mkdirSync(storageDir, { recursive: true });
  const metadata = inspectDatabase(databaseFile);
  const artifactTree = inspectTree(storageDir);
  const manifest: BackupManifest = {
    formatVersion: 1,
    createdAt: createdAt.toISOString(),
    schemaVersion: metadata.schemaVersion,
    databaseFile: databaseFileName,
    storageDirectory: 'storage',
    metadataCounts: metadata.counts,
    artifactCounts: {
      files: artifactTree.files,
      bytes: artifactTree.bytes,
      deployableVersions: countDeployableVersions(
        storageDir,
        metadata.versions
      ),
    },
  };
  writeFileSync(
    join(rollbackPath, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  );
}

function isCrossDeviceError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as Error & { code?: string }).code === 'EXDEV'
  );
}

function formatTimestamp(value: Date): string {
  return value.toISOString().replaceAll(':', '-').replaceAll('.', '-');
}
