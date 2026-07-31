import { O_DIRECTORY, O_NOFOLLOW, O_RDONLY } from 'node:constants';
import {
  closeSync,
  cpSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createId } from '../utils/id';
import {
  canonicalizeResourcePath,
  type RuntimeResourceLayout,
  runtimePathsOverlap,
} from '../utils/runtimeResourcePath';
import {
  assertDatabaseAuxiliariesAbsent,
  captureBackupPayload,
  ensureRollbackManifest,
} from './backupSnapshot';
import type {
  BackupRestoreReport,
  BackupServiceConfig,
  BackupServiceDependencies,
  BackupVerificationReport,
  DatabaseAuxiliarySuffix,
  RestoreFileSystem,
} from './backupTypes';
import { DATABASE_AUXILIARY_SUFFIXES } from './backupTypes';
import {
  fingerprintBackupPayload,
  fingerprintRuntimeResource,
  isMissingPathError,
  lstatIfPresent,
  pathEntryExistsNoFollow,
  verifyStagedBackupPayload,
} from './backupVerification';
import {
  acquireRuntimeOwnership,
  assertRuntimeResourceLeavesSafe,
} from './runtimeOwnership';

const RESTORE_BACKUP_SOURCE_CHANGED = 'RESTORE_BACKUP_SOURCE_CHANGED';
const RESTORE_CONTROL_LAYOUT_UNSAFE = 'RESTORE_CONTROL_LAYOUT_UNSAFE';
const RESTORE_DATABASE_STAGE_UNSAFE = 'RESTORE_DATABASE_STAGE_UNSAFE';

interface ResourceMoveProgress {
  rollbackPublished: boolean;
  rollbackAmbiguous: boolean;
  rollbackDigest?: string;
  rollbackIdentity?: PathIdentity;
  sourceIdentity?: PathIdentity;
  sourceRemoved: boolean;
}

interface PathIdentity {
  dev: bigint;
  ino: bigint;
  kind: 'directory' | 'file';
}

interface RestorePathBindingBase {
  identity: PathIdentity;
  name: string;
  path: string;
}

type BoundRestorePath =
  | (RestorePathBindingBase & { phase: 'active' })
  | (RestorePathBindingBase & {
      phase: 'installed';
      stagedPath: string;
    })
  | (RestorePathBindingBase & { phase: 'consumed' });

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

interface RestoreLivePayloadDigests {
  database: string;
  storage: string;
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

export function restoreVerifiedBackup({
  backupPath,
  dependencies,
  expectedFingerprint,
  layout,
  now,
  verification,
}: {
  backupPath: string;
  dependencies: BackupServiceDependencies;
  expectedFingerprint: string;
  layout: RuntimeResourceLayout;
  now: () => Date;
  verification: BackupVerificationReport;
}): BackupRestoreReport {
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
    verification = prepareRestorePayload({
      backupPath,
      controlBinding,
      dependencies,
      expectedFingerprint,
      operation,
    });
    report = executeRestore({
      backupPath,
      dependencies,
      layout,
      now,
      operation,
      restoreFileSystem,
      verification,
      expectedFingerprint,
      controlBinding,
    });
  } catch (error) {
    primaryError = asError(error);
    cleanupPreparedRestore(
      operation,
      primaryError,
      controlBinding,
      restoreFileSystem
    );
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
  let restoreCommitted = false;

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
    const expectedLivePayloadDigests =
      captureRestoreLivePayloadDigests(controlBinding);
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
      restoreFileSystem,
      controlBinding,
      'database-stage-parent',
      [
        'rollback-parent',
        'rollback-root',
        'rollback-operation',
        'rollback-database-directory',
      ]
    );
    for (const suffix of DATABASE_AUXILIARY_SUFFIXES) {
      moveIfPresent(
        `${layout.databaseFile}${suffix}`,
        `${operation.rollbackDatabase}${suffix}`,
        moveProgress.databaseAuxiliaries[suffix],
        restoreFileSystem,
        controlBinding,
        'database-stage-parent',
        [
          'rollback-parent',
          'rollback-root',
          'rollback-operation',
          'rollback-database-directory',
        ]
      );
    }
    moveIfPresent(
      layout.storageDir,
      operation.rollbackStorage,
      moveProgress.storage,
      restoreFileSystem,
      controlBinding,
      'storage-stage-parent',
      ['rollback-parent', 'rollback-root', 'rollback-operation']
    );
    ensureRollbackManifest(
      operation.rollbackPath,
      basename(layout.databaseFile),
      now()
    );

    dependencies.afterCurrentStateMoved?.(operation.rollbackPath);
    assertRestorePayloadFingerprint(controlBinding, expectedFingerprint);
    installBoundRestoreStage(
      controlBinding,
      'database-stage-parent',
      'database-stage',
      operation.databaseStage,
      layout.databaseFile,
      restoreFileSystem
    );
    dependencies.afterDatabaseInstalled?.(operation.rollbackPath);
    assertRestorePayloadFingerprint(controlBinding, expectedFingerprint);
    installBoundRestoreStage(
      controlBinding,
      'storage-stage-parent',
      'storage-stage',
      operation.storageStage,
      layout.storageDir,
      restoreFileSystem
    );
    dependencies.afterRestoredStateInstalled?.(operation.rollbackPath);
    assertRestorePayloadFingerprint(controlBinding, expectedFingerprint);
    const cleanupFailures: RestoreSecondaryFailure[] = [];
    cleanupRestoreStages(
      operation,
      controlBinding,
      restoreFileSystem,
      cleanupFailures
    );
    if (cleanupFailures.length > 0) {
      const [firstFailure, ...remainingFailures] = cleanupFailures;
      const cleanupError = asError(firstFailure.error);
      attachRestoreSecondaryFailures(cleanupError, remainingFailures);
      throw cleanupError;
    }
    assertRestoreLivePayloadDigests(controlBinding, expectedLivePayloadDigests);
    assertDatabaseAuxiliariesAbsent(layout.databaseFile);
    commitInstalledRestoreStages(controlBinding);
    restoreCommitted = true;
  } catch (error) {
    const primaryError = asError(error);
    const secondaryFailures: RestoreSecondaryFailure[] = [];
    controlBinding.quarantineOperation ||= hasRollbackEvidence(moveProgress);
    if (preRestoreState && !restoreCommitted) {
      recoverCurrentState(
        layout,
        operation,
        {
          moveProgress,
          preRestoreState,
          controlBinding,
        },
        restoreFileSystem,
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
  binding.paths.push({
    identity: capturePathIdentity(path, kind),
    name,
    path,
    phase: 'active',
  });
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
    if (bound.phase !== 'consumed') assertRestorePathBound(bound);
  }
}

function assertRestorePathBound(bound: BoundRestorePath): void {
  let current: PathIdentity;
  try {
    current = capturePathIdentity(bound.path, bound.identity.kind);
  } catch (error) {
    const unsafe = changedRestoreControlError(bound.name);
    (unsafe as Error & { cause?: unknown }).cause = error;
    throw unsafe;
  }
  if (!samePathIdentity(bound.identity, current)) {
    throw changedRestoreControlError(bound.name);
  }
}

function changedRestoreControlError(name: string): Error {
  return new Error(
    `[${RESTORE_CONTROL_LAYOUT_UNSAFE}] Bound restore control changed: ${name}`
  );
}

function assertRestoreTargetAbsent(path: string, name: string): void {
  if (inspectMovePath(path).status !== 'missing') {
    throw changedRestoreControlError(name);
  }
}

function requireRestoreBinding(
  binding: RestoreControlBinding,
  name: string
): BoundRestorePath {
  const bound = binding.paths.find((entry) => entry.name === name);
  if (!bound) {
    throw new Error(
      `[${RESTORE_CONTROL_LAYOUT_UNSAFE}] Missing restore binding: ${name}`
    );
  }
  return bound;
}

function assertActiveRestoreBinding(
  binding: RestoreControlBinding,
  name: string
): Extract<BoundRestorePath, { phase: 'active' }> {
  const bound = requireRestoreBinding(binding, name);
  if (bound.phase !== 'active') {
    throw new Error(
      `[${RESTORE_CONTROL_LAYOUT_UNSAFE}] Restore binding is not active: ${name}`
    );
  }
  assertRestorePathBound(bound);
  return bound;
}

function assertInstalledRestoreBinding(
  binding: RestoreControlBinding,
  name: string,
  expectedPath?: string
): Extract<BoundRestorePath, { phase: 'installed' }> {
  const bound = requireRestoreBinding(binding, name);
  if (
    bound.phase !== 'installed' ||
    (expectedPath !== undefined && bound.path !== expectedPath)
  ) {
    throw new Error(
      `[${RESTORE_CONTROL_LAYOUT_UNSAFE}] Restore binding is not installed at the expected target: ${name}`
    );
  }
  assertRestorePathBound(bound);
  return bound;
}

function replaceRestoreBinding(
  binding: RestoreControlBinding,
  current: BoundRestorePath,
  replacement: BoundRestorePath
): void {
  const index = binding.paths.indexOf(current);
  if (index < 0) {
    throw new Error(
      `[${RESTORE_CONTROL_LAYOUT_UNSAFE}] Restore binding disappeared: ${current.name}`
    );
  }
  binding.paths[index] = replacement;
}

function consumeRestoreBinding(
  binding: RestoreControlBinding,
  current: BoundRestorePath
): void {
  replaceRestoreBinding(binding, current, {
    identity: current.identity,
    name: current.name,
    path: current.path,
    phase: 'consumed',
  });
}

function installBoundRestoreStage(
  binding: RestoreControlBinding,
  parentName: string,
  stageName: string,
  stagePath: string,
  targetPath: string,
  restoreFileSystem: RestoreFileSystem
): void {
  assertActiveRestoreBinding(binding, parentName);
  const stage = assertActiveRestoreBinding(binding, stageName);
  try {
    assertRestoreTargetAbsent(targetPath, `${stageName}-install-target`);
  } catch (error) {
    binding.quarantineOperation = true;
    throw error;
  }
  try {
    restoreFileSystem.rename(stagePath, targetPath);
  } catch (error) {
    const primaryError = asError(error);
    const commitState = inspectRenameCommit(
      stagePath,
      targetPath,
      stage.identity
    );
    if (commitState === 'committed') {
      markRestoreStageInstalled(binding, stage, targetPath);
    } else if (commitState === 'ambiguous') {
      binding.quarantineOperation = true;
    }
    try {
      assertActiveRestoreBinding(binding, parentName);
    } catch (bindingError) {
      binding.quarantineOperation = true;
      attachRestoreSecondaryFailures(primaryError, [
        {
          step: 'install-stage',
          resource: stageName,
          error: bindingError,
        },
      ]);
    }
    throw primaryError;
  }
  if (
    inspectRenameCommit(stagePath, targetPath, stage.identity) !== 'committed'
  ) {
    binding.quarantineOperation = true;
    throw new Error(
      `[${RESTORE_CONTROL_LAYOUT_UNSAFE}] Installed restore stage identity changed: ${stageName}`
    );
  }
  markRestoreStageInstalled(binding, stage, targetPath);
  assertActiveRestoreBinding(binding, parentName);
}

function markRestoreStageInstalled(
  binding: RestoreControlBinding,
  stage: Extract<BoundRestorePath, { phase: 'active' }>,
  targetPath: string
): void {
  replaceRestoreBinding(binding, stage, {
    identity: stage.identity,
    name: stage.name,
    path: targetPath,
    phase: 'installed',
    stagedPath: stage.path,
  });
}

function commitInstalledRestoreStages(binding: RestoreControlBinding): void {
  const installedStages = ['database-stage', 'storage-stage'].map((name) =>
    assertInstalledRestoreBinding(binding, name)
  );
  for (const installed of installedStages) {
    consumeRestoreBinding(binding, installed);
  }
}

function restorePayloadPath(
  binding: RestoreControlBinding,
  name: 'database-stage' | 'manifest-stage' | 'storage-stage'
): string {
  const bound = requireRestoreBinding(binding, name);
  if (bound.phase === 'consumed') {
    throw new Error(
      `[${RESTORE_CONTROL_LAYOUT_UNSAFE}] Restore payload binding was consumed before commit validation: ${name}`
    );
  }
  return bound.path;
}

function assertRestorePayloadFingerprint(
  binding: RestoreControlBinding,
  expectedFingerprint: string
): void {
  assertRestoreControlsBound(binding);
  const manifestPath = restorePayloadPath(binding, 'manifest-stage');
  const databaseBinding = requireRestoreBinding(binding, 'database-stage');
  if (databaseBinding.phase === 'consumed') {
    throw new Error(
      `[${RESTORE_CONTROL_LAYOUT_UNSAFE}] Restore payload binding was consumed before commit validation: database-stage`
    );
  }
  const databaseFile = databaseBinding.path;
  const reservedDatabaseStage =
    databaseBinding.phase === 'installed'
      ? databaseBinding.stagedPath
      : databaseBinding.path;
  const storageDir = restorePayloadPath(binding, 'storage-stage');
  assertRestoreDatabaseStageSafe(databaseFile);
  assertDatabaseAuxiliariesAbsent(databaseFile);
  if (reservedDatabaseStage !== databaseFile) {
    assertDatabaseAuxiliariesAbsent(reservedDatabaseStage);
  }
  let fingerprint: string;
  try {
    fingerprint = fingerprintBackupPayload(
      manifestPath,
      databaseFile,
      storageDir
    );
  } catch (error) {
    const changed = restorePayloadChangedError();
    (changed as Error & { cause?: unknown }).cause = error;
    throw changed;
  }
  assertDatabaseAuxiliariesAbsent(databaseFile);
  if (reservedDatabaseStage !== databaseFile) {
    assertDatabaseAuxiliariesAbsent(reservedDatabaseStage);
  }
  assertRestoreControlsBound(binding);
  if (fingerprint !== expectedFingerprint) throw restorePayloadChangedError();
}

function restorePayloadChangedError(): Error {
  return new Error(
    `[${RESTORE_BACKUP_SOURCE_CHANGED}] Bound restore payload content changed`
  );
}

function captureRestoreLivePayloadDigests(
  binding: RestoreControlBinding
): RestoreLivePayloadDigests {
  return {
    database: fingerprintRestoreBinding(binding, 'database-stage'),
    storage: fingerprintRestoreBinding(binding, 'storage-stage'),
  };
}

function assertRestoreLivePayloadDigests(
  binding: RestoreControlBinding,
  expected: RestoreLivePayloadDigests
): void {
  const current = captureRestoreLivePayloadDigests(binding);
  if (
    current.database !== expected.database ||
    current.storage !== expected.storage
  ) {
    throw restorePayloadChangedError();
  }
}

function fingerprintRestoreBinding(
  binding: RestoreControlBinding,
  name: 'database-stage' | 'storage-stage'
): string {
  const bound = requireRestoreBinding(binding, name);
  if (bound.phase === 'consumed') {
    throw new Error(
      `[${RESTORE_CONTROL_LAYOUT_UNSAFE}] Restore payload binding was consumed before live validation: ${name}`
    );
  }
  assertRestorePathBound(bound);
  const digest = fingerprintRuntimeResource(bound.path, bound.identity.kind);
  assertRestorePathBound(bound);
  return digest;
}

function validateRestoreBindingsForSecondaryAction(
  binding: RestoreControlBinding,
  names: string[],
  step: string,
  resource: string,
  failures: RestoreSecondaryFailure[]
): boolean {
  try {
    for (const name of names) assertActiveRestoreBinding(binding, name);
    return true;
  } catch (error) {
    binding.quarantineOperation = true;
    failures.push({ step, resource, error });
    return false;
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
  const rollbackParent = binding.paths.find(
    (entry) => entry.name === 'rollback-parent'
  );
  if (!rollbackParent || !boundPathStillMatches(rollbackParent)) {
    binding.quarantineOperation = true;
    failures.push({
      step: 'cleanup-operation',
      resource: 'rollback-parent',
      error: changedRestoreControlError('rollback-parent'),
    });
    return;
  }
  const rollbackRoot = binding.paths.find(
    (entry) => entry.name === 'rollback-root'
  );
  if (!rollbackRoot) {
    binding.quarantineOperation = true;
    failures.push({
      step: 'cleanup-operation',
      resource: 'rollback-root',
      error: changedRestoreControlError('rollback-root'),
    });
    return;
  }
  if (!boundPathStillMatches(rollbackRoot)) {
    binding.quarantineOperation = true;
    unlinkChangedSymlink(operation.rollbackRoot, 'rollback-root', failures);
    failures.push({
      step: 'cleanup-operation',
      resource: 'rollback-root',
      error: changedRestoreControlError('rollback-root'),
    });
    return;
  }

  const rollbackOperation = binding.paths.find(
    (entry) => entry.name === 'rollback-operation'
  );
  if (!rollbackOperation) {
    binding.quarantineOperation = true;
    failures.push({
      step: 'cleanup-operation',
      resource: 'rollback-operation',
      error: changedRestoreControlError('rollback-operation'),
    });
  } else if (!boundPathStillMatches(rollbackOperation)) {
    binding.quarantineOperation = true;
    unlinkChangedSymlink(
      operation.rollbackPath,
      'rollback-operation',
      failures
    );
    failures.push({
      step: 'cleanup-operation',
      resource: 'rollback-operation',
      error: changedRestoreControlError('rollback-operation'),
    });
  } else if (boundPathStillMatches(rollbackOperation)) {
    const databaseDirectoryBound = rollbackDatabaseDirectoryStillBound(
      binding,
      operation,
      failures
    );
    if (
      databaseDirectoryBound &&
      !binding.quarantineOperation &&
      !rollbackOperationContainsEvidence(operation, binding)
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

function rollbackDatabaseDirectoryStillBound(
  binding: RestoreControlBinding,
  operation: RestoreOperationLayout,
  failures: RestoreSecondaryFailure[]
): boolean {
  const databaseDirectory = binding.paths.find(
    (entry) => entry.name === 'rollback-database-directory'
  );
  if (databaseDirectory && boundPathStillMatches(databaseDirectory)) {
    return true;
  }
  binding.quarantineOperation = true;
  if (databaseDirectory) {
    unlinkChangedSymlink(
      operation.rollbackDatabaseDirectory,
      'rollback-database-directory',
      failures
    );
  }
  failures.push({
    step: 'cleanup-operation',
    resource: 'rollback-database-directory',
    error: changedRestoreControlError('rollback-database-directory'),
  });
  return false;
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
  operation: RestoreOperationLayout,
  binding: RestoreControlBinding
): boolean {
  try {
    for (const name of [
      'rollback-parent',
      'rollback-root',
      'rollback-operation',
      'rollback-database-directory',
    ]) {
      assertActiveRestoreBinding(binding, name);
    }
    const containsEvidence = readdirSync(operation.rollbackPath).some(
      (entry) => {
        if (entry !== 'database') return true;
        return readdirSync(operation.rollbackDatabaseDirectory).length > 0;
      }
    );
    for (const name of [
      'rollback-parent',
      'rollback-root',
      'rollback-operation',
      'rollback-database-directory',
    ]) {
      assertActiveRestoreBinding(binding, name);
    }
    return containsEvidence;
  } catch {
    binding.quarantineOperation = true;
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
  controlBinding,
  dependencies,
  expectedFingerprint,
  operation,
}: {
  backupPath: string;
  controlBinding: RestoreControlBinding;
  dependencies: BackupServiceDependencies;
  expectedFingerprint: string;
  operation: RestoreOperationLayout;
}): BackupVerificationReport {
  captureBackupPayload(
    backupPath,
    {
      databaseStage: operation.databaseStage,
      manifestStage: operation.manifestStage,
      storageStage: operation.storageStage,
    },
    {
      manifest() {
        bindPathOnce(
          controlBinding,
          'manifest-stage',
          operation.manifestStage,
          'file'
        );
      },
      database() {
        bindPathOnce(
          controlBinding,
          'database-stage',
          operation.databaseStage,
          'file'
        );
      },
      storage() {
        bindPathOnce(
          controlBinding,
          'storage-stage',
          operation.storageStage,
          'directory'
        );
        dependencies.afterRestoreStorageStageCreated?.(operation.storageStage);
        assertActiveRestoreBinding(controlBinding, 'storage-stage');
      },
    }
  );
  assertDatabaseAuxiliariesAbsent(operation.databaseStage);
  assertRestoreControlsBound(controlBinding);
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
  controlBinding: RestoreControlBinding | undefined,
  restoreFileSystem: RestoreFileSystem
): void {
  const failures: RestoreSecondaryFailure[] = [];
  if (controlBinding) {
    cleanupRestoreStages(
      operation,
      controlBinding,
      restoreFileSystem,
      failures
    );
    cleanupBoundRestoreControls(controlBinding, operation, failures);
  }
  attachRestoreSecondaryFailures(primaryError, failures);
}

function cleanupRestoreStages(
  operation: RestoreOperationLayout,
  binding: RestoreControlBinding,
  restoreFileSystem: RestoreFileSystem,
  failures: RestoreSecondaryFailure[]
): void {
  cleanupBoundRestoreStage(
    binding,
    'database-stage-parent',
    'database-stage',
    operation.databaseStage,
    false,
    restoreFileSystem,
    failures
  );
  cleanupBoundRestoreStage(
    binding,
    'storage-stage-parent',
    'storage-stage',
    operation.storageStage,
    true,
    restoreFileSystem,
    failures
  );
  cleanupBoundRestoreStage(
    binding,
    'database-stage-parent',
    'manifest-stage',
    operation.manifestStage,
    false,
    restoreFileSystem,
    failures
  );
  cleanupRestoreAuxiliaryStages(
    operation,
    binding,
    restoreFileSystem,
    failures
  );
}

function cleanupRestoreAuxiliaryStages(
  operation: RestoreOperationLayout,
  binding: RestoreControlBinding,
  restoreFileSystem: RestoreFileSystem,
  failures: RestoreSecondaryFailure[]
): void {
  for (const suffix of DATABASE_AUXILIARY_SUFFIXES) {
    cleanupReservedRestoreFile(
      binding,
      'database-stage-parent',
      `database-stage${suffix}`,
      operation.databaseStageAuxiliaries[suffix],
      restoreFileSystem,
      failures
    );
  }
}

function cleanupBoundRestoreStage(
  binding: RestoreControlBinding,
  parentName: string,
  stageName: string,
  stagePath: string,
  recursive: boolean,
  restoreFileSystem: RestoreFileSystem,
  failures: RestoreSecondaryFailure[]
): void {
  const stage = binding.paths.find((entry) => entry.name === stageName);
  if (!stage) {
    cleanupUnboundRestoreStage(
      binding,
      parentName,
      stageName,
      stagePath,
      recursive,
      restoreFileSystem,
      failures
    );
    return;
  }
  if (stage.phase !== 'active') return;
  if (
    !validateRestoreBindingsForSecondaryAction(
      binding,
      [parentName],
      'cleanup-stage',
      stageName,
      failures
    )
  ) {
    return;
  }
  if (!boundPathStillMatches(stage)) {
    try {
      const replacement = lstatIfPresent(stagePath);
      if (replacement?.isSymbolicLink()) unlinkSync(stagePath);
      else binding.quarantineOperation = true;
    } catch (error) {
      binding.quarantineOperation = true;
      failures.push({
        step: 'cleanup-stage',
        resource: stageName,
        error,
      });
    }
    consumeRestoreBinding(binding, stage);
    failures.push({
      step: 'cleanup-stage',
      resource: stageName,
      error: changedRestoreControlError(stageName),
    });
    return;
  }
  try {
    restoreFileSystem.remove(stagePath, { recursive, force: true });
    assertActiveRestoreBinding(binding, parentName);
    if (pathEntryExistsNoFollow(stagePath)) {
      throw new Error(`Restore stage cleanup failed: ${stagePath}`);
    }
    consumeRestoreBinding(binding, stage);
  } catch (error) {
    failures.push({ step: 'cleanup-stage', resource: stageName, error });
  }
}

function cleanupUnboundRestoreStage(
  binding: RestoreControlBinding,
  parentName: string,
  stageName: string,
  stagePath: string,
  recursive: boolean,
  restoreFileSystem: RestoreFileSystem,
  failures: RestoreSecondaryFailure[]
): void {
  void parentName;
  void stagePath;
  void recursive;
  void restoreFileSystem;
  binding.quarantineOperation = true;
  failures.push({
    step: 'cleanup-stage',
    resource: stageName,
    error: new Error(
      `[${RESTORE_CONTROL_LAYOUT_UNSAFE}] Refusing to clean an unbound restore stage: ${stageName}`
    ),
  });
}

function cleanupReservedRestoreFile(
  binding: RestoreControlBinding,
  parentName: string,
  resource: string,
  path: string,
  restoreFileSystem: RestoreFileSystem,
  failures: RestoreSecondaryFailure[]
): void {
  if (
    !validateRestoreBindingsForSecondaryAction(
      binding,
      [parentName],
      'cleanup-stage',
      resource,
      failures
    )
  ) {
    return;
  }
  try {
    const stats = lstatIfPresent(path);
    if (stats?.isDirectory()) {
      throw new Error(
        `[${RESTORE_CONTROL_LAYOUT_UNSAFE}] Reserved restore file became a directory: ${resource}`
      );
    }
    if (stats?.isSymbolicLink()) unlinkSync(path);
    else restoreFileSystem.remove(path, { force: true });
    assertActiveRestoreBinding(binding, parentName);
    if (pathEntryExistsNoFollow(path)) {
      throw new Error(`Restore stage cleanup failed: ${path}`);
    }
  } catch (error) {
    failures.push({ step: 'cleanup-stage', resource, error });
  }
}

function assertRuntimeResourceDigest(
  path: string,
  expectedIdentity: PathIdentity,
  expectedDigest: string,
  resource: string
): void {
  const before = captureMoveIdentity(path);
  if (!samePathIdentity(expectedIdentity, before)) {
    throw incompleteRollbackError(resource);
  }
  const digest = fingerprintRuntimeResource(path, expectedIdentity.kind);
  const after = captureMoveIdentity(path);
  if (!samePathIdentity(expectedIdentity, after) || digest !== expectedDigest) {
    throw incompleteRollbackError(resource);
  }
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

function moveIfPresent(
  source: string,
  target: string,
  progress: ResourceMoveProgress,
  restoreFileSystem: RestoreFileSystem,
  controlBinding: RestoreControlBinding,
  sourceParentName: string,
  targetControlNames: string[]
): void {
  assertMoveBindings(controlBinding, sourceParentName, targetControlNames);
  if (!pathEntryExistsNoFollow(source)) return;
  const sourceIdentity = captureMoveIdentity(source);
  progress.sourceIdentity = sourceIdentity;
  const sourceDigest = fingerprintRuntimeResource(source, sourceIdentity.kind);
  assertRuntimeResourceDigest(source, sourceIdentity, sourceDigest, source);
  if (pathEntryExistsNoFollow(target)) {
    throw new Error(
      `[RESTORE_ROLLBACK_TARGET_EXISTS] Refusing to reuse rollback target for ${source}`
    );
  }
  try {
    restoreFileSystem.rename(source, target);
    assertMoveBindings(controlBinding, sourceParentName, targetControlNames);
    if (inspectRenameCommit(source, target, sourceIdentity) !== 'committed') {
      progress.rollbackAmbiguous = true;
      controlBinding.quarantineOperation = true;
      throw changedRestoreControlError('rollback-publication');
    }
    recordPublishedRollback(
      progress,
      target,
      sourceIdentity,
      sourceDigest,
      true,
      source
    );
    return;
  } catch (error) {
    assertMoveBindings(controlBinding, sourceParentName, targetControlNames);
    const commitState = inspectRenameCommit(source, target, sourceIdentity);
    if (commitState === 'committed') {
      recordPublishedRollback(
        progress,
        target,
        sourceIdentity,
        sourceDigest,
        true,
        source
      );
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
    cleanupMoveTemporary(
      temporaryTarget,
      undefined,
      isDirectory,
      source,
      controlBinding,
      targetControlNames,
      restoreFileSystem,
      secondaryFailures
    );
    attachRestoreSecondaryFailures(primaryError, secondaryFailures);
    throw primaryError;
  }

  assertMoveBindings(controlBinding, sourceParentName, targetControlNames);

  if (pathEntryExistsNoFollow(target)) {
    progress.rollbackAmbiguous = true;
    throw new Error(
      `[RESTORE_ROLLBACK_TARGET_EXISTS] Refusing to overwrite rollback target for ${source}`
    );
  }
  const temporaryIdentity = captureMoveIdentity(temporaryTarget);
  assertRuntimeResourceDigest(
    temporaryTarget,
    temporaryIdentity,
    sourceDigest,
    source
  );
  assertRuntimeResourceDigest(source, sourceIdentity, sourceDigest, source);
  try {
    restoreFileSystem.rename(temporaryTarget, target);
  } catch (error) {
    for (const name of targetControlNames) {
      assertActiveRestoreBinding(controlBinding, name);
    }
    const commitState = inspectRenameCommit(
      temporaryTarget,
      target,
      temporaryIdentity
    );
    if (commitState === 'committed') {
      recordPublishedRollback(
        progress,
        target,
        temporaryIdentity,
        sourceDigest,
        false,
        source
      );
      throw error;
    }
    if (commitState === 'ambiguous') {
      progress.rollbackAmbiguous = true;
      throw error;
    }
    const primaryError = asError(error);
    const secondaryFailures: RestoreSecondaryFailure[] = [];
    cleanupMoveTemporary(
      temporaryTarget,
      temporaryIdentity,
      isDirectory,
      source,
      controlBinding,
      targetControlNames,
      restoreFileSystem,
      secondaryFailures
    );
    attachRestoreSecondaryFailures(primaryError, secondaryFailures);
    throw primaryError;
  }

  // Publication is atomic and authoritative from this point onward. If
  // source removal fails or only partially completes, compensation restores
  // from this known-complete rollback copy.
  recordPublishedRollback(
    progress,
    target,
    temporaryIdentity,
    sourceDigest,
    false,
    source
  );
  assertMoveBindings(controlBinding, sourceParentName, targetControlNames);
  try {
    assertRuntimeResourceDigest(source, sourceIdentity, sourceDigest, source);
  } catch (error) {
    progress.rollbackAmbiguous = true;
    controlBinding.quarantineOperation = true;
    throw error;
  }
  restoreFileSystem.remove(source, {
    recursive: isDirectory,
    force: true,
  });
  progress.sourceRemoved = true;
}

function recordPublishedRollback(
  progress: ResourceMoveProgress,
  rollbackPath: string,
  rollbackIdentity: PathIdentity,
  rollbackDigest: string,
  sourceRemoved: boolean,
  resource: string
): void {
  progress.rollbackPublished = true;
  progress.rollbackIdentity = rollbackIdentity;
  progress.rollbackDigest = rollbackDigest;
  progress.sourceRemoved = sourceRemoved;
  try {
    assertRuntimeResourceDigest(
      rollbackPath,
      rollbackIdentity,
      rollbackDigest,
      resource
    );
  } catch (error) {
    delete progress.rollbackDigest;
    throw error;
  }
}

function assertMoveBindings(
  binding: RestoreControlBinding,
  sourceParentName: string,
  targetControlNames: string[]
): void {
  try {
    for (const name of [sourceParentName, ...targetControlNames]) {
      assertActiveRestoreBinding(binding, name);
    }
  } catch (error) {
    binding.quarantineOperation = true;
    throw error;
  }
}

function cleanupMoveTemporary(
  temporaryTarget: string,
  temporaryIdentity: PathIdentity | undefined,
  isDirectory: boolean,
  resource: string,
  binding: RestoreControlBinding,
  targetControlNames: string[],
  restoreFileSystem: RestoreFileSystem,
  failures: RestoreSecondaryFailure[]
): void {
  if (
    !validateRestoreBindingsForSecondaryAction(
      binding,
      targetControlNames,
      'cleanup-move-temp',
      resource,
      failures
    )
  ) {
    return;
  }
  try {
    const stats = lstatIfPresent(temporaryTarget);
    if (temporaryIdentity) {
      const current = captureMoveIdentity(temporaryTarget);
      if (!samePathIdentity(temporaryIdentity, current)) {
        throw changedRestoreControlError(`${resource}-move-temp`);
      }
    }
    if (stats?.isSymbolicLink()) unlinkSync(temporaryTarget);
    else
      restoreFileSystem.remove(temporaryTarget, {
        recursive: isDirectory,
        force: true,
      });
  } catch (error) {
    if (!isMissingPathError(error)) {
      failures.push({
        step: 'cleanup-move-temp',
        resource,
        error,
      });
    }
  }
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
    controlBinding: RestoreControlBinding;
    moveProgress: RuntimeMoveProgress;
    preRestoreState: RuntimeStatePresence;
  },
  restoreFileSystem: RestoreFileSystem,
  failures: RestoreSecondaryFailure[]
): void {
  recoverRuntimeResource(
    {
      existedBeforeRestore: options.preRestoreState.database,
      installedBindingName: 'database-stage',
      isDirectory: false,
      progress: options.moveProgress.database,
      resource: 'database',
      rollbackPath: operation.rollbackDatabase,
      rollbackControlNames: [
        'rollback-parent',
        'rollback-root',
        'rollback-operation',
        'rollback-database-directory',
      ],
      targetPath: layout.databaseFile,
      targetParentName: 'database-stage-parent',
    },
    options.controlBinding,
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
        rollbackControlNames: [
          'rollback-parent',
          'rollback-root',
          'rollback-operation',
          'rollback-database-directory',
        ],
        targetPath: `${layout.databaseFile}${suffix}`,
        targetParentName: 'database-stage-parent',
      },
      options.controlBinding,
      restoreFileSystem,
      failures
    );
  }
  recoverRuntimeResource(
    {
      existedBeforeRestore: options.preRestoreState.storage,
      installedBindingName: 'storage-stage',
      isDirectory: true,
      progress: options.moveProgress.storage,
      resource: 'storage',
      rollbackPath: operation.rollbackStorage,
      rollbackControlNames: [
        'rollback-parent',
        'rollback-root',
        'rollback-operation',
      ],
      targetPath: layout.storageDir,
      targetParentName: 'storage-stage-parent',
    },
    options.controlBinding,
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

function validateRecoveryTargetBinding(
  binding: RestoreControlBinding,
  installedBindingName: 'database-stage' | 'storage-stage' | undefined,
  targetPath: string,
  targetParentName: string,
  resource: string,
  failures: RestoreSecondaryFailure[]
): boolean {
  try {
    assertRecoveryTargetBinding(
      binding,
      installedBindingName,
      targetPath,
      targetParentName
    );
    return true;
  } catch (error) {
    binding.quarantineOperation = true;
    failures.push({ step: 'recover-resource', resource, error });
    return false;
  }
}

function assertRecoveryTargetBinding(
  binding: RestoreControlBinding,
  installedBindingName: 'database-stage' | 'storage-stage' | undefined,
  targetPath: string,
  targetParentName: string,
  activeTargetIdentity?: PathIdentity | null
): Extract<BoundRestorePath, { phase: 'installed' }> | undefined {
  assertActiveRestoreBinding(binding, targetParentName);
  if (!installedBindingName) {
    assertActiveRecoveryTargetBinding(
      targetPath,
      activeTargetIdentity,
      'database-auxiliary-active-target'
    );
    return undefined;
  }
  const target = requireRestoreBinding(binding, installedBindingName);
  if (target.phase === 'active') {
    assertActiveRecoveryTargetBinding(
      targetPath,
      activeTargetIdentity,
      `${installedBindingName}-active-target`
    );
    return undefined;
  }
  if (target.phase === 'installed') {
    return assertInstalledRestoreBinding(
      binding,
      installedBindingName,
      targetPath
    );
  }
  throw new Error(
    `[${RESTORE_CONTROL_LAYOUT_UNSAFE}] Restore target was consumed before recovery: ${installedBindingName}`
  );
}

function assertActiveRecoveryTargetBinding(
  targetPath: string,
  expectedIdentity: PathIdentity | null | undefined,
  name: string
): void {
  if (expectedIdentity === undefined) return;
  const state = inspectMovePath(targetPath);
  if (state.status === 'missing') return;
  if (
    expectedIdentity &&
    state.status === 'identity' &&
    samePathIdentity(expectedIdentity, state.identity)
  ) {
    return;
  }
  throw changedRestoreControlError(name);
}

function recoverRuntimeResource(
  {
    existedBeforeRestore,
    installedBindingName,
    isDirectory,
    progress,
    resource,
    rollbackPath,
    rollbackControlNames,
    targetPath,
    targetParentName,
  }: {
    existedBeforeRestore: boolean;
    installedBindingName?: 'database-stage' | 'storage-stage';
    isDirectory: boolean;
    progress: ResourceMoveProgress;
    resource: string;
    rollbackPath: string;
    rollbackControlNames: string[];
    targetPath: string;
    targetParentName: string;
  },
  controlBinding: RestoreControlBinding,
  restoreFileSystem: RestoreFileSystem,
  failures: RestoreSecondaryFailure[]
): void {
  if (
    !validateRecoveryTargetBinding(
      controlBinding,
      installedBindingName,
      targetPath,
      targetParentName,
      resource,
      failures
    )
  ) {
    return;
  }
  if (!existedBeforeRestore) {
    try {
      const installedTarget = assertRecoveryTargetBinding(
        controlBinding,
        installedBindingName,
        targetPath,
        targetParentName,
        null
      );
      removeRecoveryTargetNoFollow(targetPath, isDirectory, restoreFileSystem);
      assertRestoreTargetAbsent(targetPath, `${resource}-removed-target`);
      if (installedTarget) {
        consumeRestoreBinding(controlBinding, installedTarget);
      }
    } catch (error) {
      controlBinding.quarantineOperation = true;
      failures.push({
        step: 'recover-absent-resource',
        resource,
        error,
      });
    }
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
    if (!pathEntryExistsNoFollow(targetPath)) {
      failures.push({
        step: 'recover-resource',
        resource,
        error: incompleteRollbackError(resource),
      });
    }
    return;
  }

  if (
    !progress.rollbackIdentity ||
    !progress.rollbackDigest ||
    !validateRestoreBindingsForSecondaryAction(
      controlBinding,
      rollbackControlNames,
      'recover-resource',
      resource,
      failures
    )
  ) {
    if (!progress.rollbackIdentity || !progress.rollbackDigest) {
      failures.push({
        step: 'recover-resource',
        resource,
        error: incompleteRollbackError(resource),
      });
    }
    controlBinding.quarantineOperation = true;
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
      progress.rollbackIdentity,
      progress.rollbackDigest,
      controlBinding,
      rollbackControlNames,
      installedBindingName,
      progress.sourceRemoved ? null : (progress.sourceIdentity ?? null),
      targetParentName,
      restoreFileSystem,
      failures
    );
  } catch (error) {
    controlBinding.quarantineOperation = true;
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
  rollbackIdentity: PathIdentity,
  rollbackDigest: string,
  controlBinding: RestoreControlBinding,
  rollbackControlNames: string[],
  installedBindingName: 'database-stage' | 'storage-stage' | undefined,
  activeTargetIdentity: PathIdentity | null,
  targetParentName: string,
  restoreFileSystem: RestoreFileSystem,
  failures: RestoreSecondaryFailure[]
): void {
  assertRecoveryBindings(
    controlBinding,
    rollbackControlNames,
    targetParentName
  );
  assertRecoveryTargetBinding(
    controlBinding,
    installedBindingName,
    targetPath,
    targetParentName,
    activeTargetIdentity
  );
  assertRuntimeResourceDigest(
    rollbackPath,
    rollbackIdentity,
    rollbackDigest,
    resource
  );
  const recoveryStage = createUnusedSiblingPath(targetPath, 'recover');
  let recoveryIdentity: PathIdentity | undefined;
  try {
    restoreFileSystem.copy(rollbackPath, recoveryStage, {
      errorOnExist: true,
      force: false,
      recursive: isDirectory,
      preserveTimestamps: true,
    });
    recoveryIdentity = captureMoveIdentity(recoveryStage);
    const recoveryDigest = fingerprintRuntimeResource(
      recoveryStage,
      recoveryIdentity.kind
    );
    if (recoveryDigest !== rollbackDigest) {
      throw incompleteRollbackError(resource);
    }
    assertRecoveryBindings(
      controlBinding,
      rollbackControlNames,
      targetParentName
    );
    assertRuntimeResourceDigest(
      rollbackPath,
      rollbackIdentity,
      rollbackDigest,
      resource
    );
    assertRuntimeResourceDigest(
      recoveryStage,
      recoveryIdentity,
      rollbackDigest,
      resource
    );
    const installedTarget = assertRecoveryTargetBinding(
      controlBinding,
      installedBindingName,
      targetPath,
      targetParentName,
      activeTargetIdentity
    );
    removeRecoveryTargetNoFollow(targetPath, isDirectory, restoreFileSystem);
    assertRestoreTargetAbsent(targetPath, `${resource}-removed-target`);
    if (installedTarget) {
      consumeRestoreBinding(controlBinding, installedTarget);
    }
    assertActiveRestoreBinding(controlBinding, targetParentName);
    assertRuntimeResourceDigest(
      rollbackPath,
      rollbackIdentity,
      rollbackDigest,
      resource
    );
    assertRuntimeResourceDigest(
      recoveryStage,
      recoveryIdentity,
      rollbackDigest,
      resource
    );
    assertRestoreTargetAbsent(targetPath, `${resource}-recovery-target`);
    publishRecoveryStage(
      recoveryStage,
      targetPath,
      recoveryIdentity,
      rollbackDigest,
      resource,
      controlBinding,
      targetParentName,
      restoreFileSystem
    );
  } catch (error) {
    cleanupRecoveryStage(
      recoveryStage,
      recoveryIdentity,
      isDirectory,
      resource,
      controlBinding,
      targetParentName,
      restoreFileSystem,
      failures
    );
    throw error;
  }
}

function publishRecoveryStage(
  recoveryStage: string,
  targetPath: string,
  recoveryIdentity: PathIdentity,
  rollbackDigest: string,
  resource: string,
  controlBinding: RestoreControlBinding,
  targetParentName: string,
  restoreFileSystem: RestoreFileSystem
): void {
  let committedRenameError: Error | undefined;
  try {
    restoreFileSystem.rename(recoveryStage, targetPath);
  } catch (error) {
    const renameError = asError(error);
    const commitState = inspectRenameCommit(
      recoveryStage,
      targetPath,
      recoveryIdentity
    );
    if (commitState !== 'committed') {
      if (commitState === 'ambiguous') {
        controlBinding.quarantineOperation = true;
      }
      throw renameError;
    }
    committedRenameError = renameError;
  }

  try {
    assertActiveRestoreBinding(controlBinding, targetParentName);
    assertRuntimeResourceDigest(
      targetPath,
      recoveryIdentity,
      rollbackDigest,
      resource
    );
  } catch (error) {
    if (!committedRenameError) throw error;
    controlBinding.quarantineOperation = true;
    attachRestoreSecondaryFailures(committedRenameError, [
      {
        step: 'recover-publication',
        resource,
        error,
      },
    ]);
    throw committedRenameError;
  }
}

function removeRecoveryTargetNoFollow(
  targetPath: string,
  isDirectory: boolean,
  restoreFileSystem: RestoreFileSystem
): void {
  const stats = lstatIfPresent(targetPath);
  if (stats?.isSymbolicLink()) {
    unlinkSync(targetPath);
    return;
  }
  restoreFileSystem.remove(targetPath, {
    recursive: isDirectory,
    force: true,
  });
}

function assertRecoveryBindings(
  binding: RestoreControlBinding,
  rollbackControlNames: string[],
  targetParentName: string
): void {
  for (const name of [...rollbackControlNames, targetParentName]) {
    assertActiveRestoreBinding(binding, name);
  }
}

function cleanupRecoveryStage(
  recoveryStage: string,
  recoveryIdentity: PathIdentity | undefined,
  isDirectory: boolean,
  resource: string,
  binding: RestoreControlBinding,
  targetParentName: string,
  restoreFileSystem: RestoreFileSystem,
  failures: RestoreSecondaryFailure[]
): void {
  if (
    !recoveryIdentity ||
    !validateRestoreBindingsForSecondaryAction(
      binding,
      [targetParentName],
      'cleanup-recovery-stage',
      resource,
      failures
    )
  ) {
    return;
  }
  try {
    const current = captureMoveIdentity(recoveryStage);
    if (!samePathIdentity(recoveryIdentity, current)) {
      throw changedRestoreControlError(`${resource}-recovery-stage`);
    }
    restoreFileSystem.remove(recoveryStage, {
      recursive: isDirectory,
      force: true,
    });
  } catch (error) {
    if (!isMissingPathError(error)) {
      failures.push({
        step: 'cleanup-recovery-stage',
        resource,
        error,
      });
    }
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

function incompleteRollbackError(resource: string): Error {
  return new Error(
    `[RESTORE_ROLLBACK_INCOMPLETE] Missing pre-restore rollback copy for ${resource}`
  );
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
