import { Database } from 'bun:sqlite';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { RELATIONAL_SCHEMA_VERSION } from '../repositories/sqliteSchema';
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
}

const DATABASE_AUXILIARY_SUFFIXES = ['-journal', '-wal', '-shm'] as const;
type DatabaseAuxiliarySuffix = (typeof DATABASE_AUXILIARY_SUFFIXES)[number];
const BACKUP_DATABASE_SNAPSHOT_UNSAFE = 'BACKUP_DATABASE_SNAPSHOT_UNSAFE';
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
  sourceRemoved: boolean;
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
  storageStage: string;
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

        const verification = verifyBackupAt(temporaryPath);
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
      return verifyBackupAt(backupPath);
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
      const verification = verifyBackupAt(backupPath);
      if (!verification.valid || !verification.manifest) {
        throw new Error(
          `Backup verification failed: ${verification.errors.join('; ')}`
        );
      }

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
      try {
        report = executeRestore({
          backupPath,
          dependencies,
          layout,
          manifest: verification.manifest,
          now,
          operation,
          restoreFileSystem,
          verification,
        });
      } catch (error) {
        primaryError = asError(error);
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
  manifest,
  now,
  operation,
  restoreFileSystem,
  verification,
}: {
  backupPath: string;
  dependencies: BackupServiceDependencies;
  layout: RuntimeResourceLayout;
  manifest: BackupManifest;
  now: () => Date;
  operation: RestoreOperationLayout;
  restoreFileSystem: RestoreFileSystem;
  verification: BackupVerificationReport;
}): BackupRestoreReport {
  const moveProgress = createRuntimeMoveProgress();
  let preRestoreState: RuntimeStatePresence | undefined;

  try {
    mkdirSync(dirname(operation.databaseStage), { recursive: true });
    // Both backup sources are fully staged into control paths that were
    // validated outside the live runtime layout before any live resource moves.
    // This also makes a backup located inside storage safe for this operation.
    restoreFileSystem.copy(
      join(backupPath, 'database', manifest.databaseFile),
      operation.databaseStage,
      {
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      }
    );
    restoreFileSystem.copy(
      join(backupPath, manifest.storageDirectory),
      operation.storageStage,
      {
        errorOnExist: true,
        force: false,
        recursive: true,
        preserveTimestamps: true,
      }
    );

    assertRestoreDatabaseStageSafe(operation.databaseStage);
    assertRuntimeResourceLeavesSafe(layout);
    preRestoreState = captureRuntimeStatePresence(layout);
    mkdirSync(operation.rollbackDatabaseDirectory, { recursive: true });
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
  } catch (error) {
    const primaryError = asError(error);
    const secondaryFailures: RestoreSecondaryFailure[] = [];
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
    if (!hasPublishedRollback(moveProgress)) {
      removeBestEffort(
        restoreFileSystem,
        operation.rollbackPath,
        { recursive: true, force: true },
        'cleanup-operation',
        'rollback-operation',
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
  return {
    rollbackRoot,
    rollbackPath,
    rollbackDatabaseDirectory,
    rollbackDatabase: join(
      rollbackDatabaseDirectory,
      basename(layout.databaseFile)
    ),
    rollbackStorage: join(rollbackPath, 'storage'),
    databaseStage: `${layout.databaseFile}.restore-${operationId}`,
    storageStage: join(
      dirname(layout.storageDir),
      `.${basename(layout.storageDir)}.restore-${operationId}`
    ),
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
    ['storage-stage', operation.storageStage],
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
    ['storage-stage', operation.storageStage],
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
    sourceRemoved: false,
  };
}

function hasPublishedRollback(progress: RuntimeMoveProgress): boolean {
  return (
    progress.database.rollbackPublished ||
    progress.storage.rollbackPublished ||
    DATABASE_AUXILIARY_SUFFIXES.some(
      (suffix) => progress.databaseAuxiliaries[suffix].rollbackPublished
    )
  );
}

function verifyBackupAt(backupPath: string): BackupVerificationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  let manifest: BackupManifest | null = null;
  try {
    manifest = parseManifest(
      JSON.parse(readFileSync(join(backupPath, 'manifest.json'), 'utf8'))
    );
  } catch (error) {
    errors.push(
      `Invalid backup manifest: ${error instanceof Error ? error.message : String(error)}`
    );
    return { valid: false, errors, warnings, manifest };
  }

  const databaseFile = join(backupPath, 'database', manifest.databaseFile);
  const storageDir = join(backupPath, manifest.storageDirectory);
  if (manifest.schemaVersion !== RELATIONAL_SCHEMA_VERSION) {
    errors.push(
      `Unsupported relational schema version ${manifest.schemaVersion}; expected ${RELATIONAL_SCHEMA_VERSION}`
    );
  }
  const databaseSnapshotError = inspectBackupDatabaseSnapshot(databaseFile);
  if (databaseSnapshotError) errors.push(databaseSnapshotError);
  if (!existsSync(storageDir)) errors.push('Artifact storage is missing');
  if (errors.length > 0) return { valid: false, errors, warnings, manifest };

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
    } finally {
      database.close();
    }

    if (metadata.schemaVersion !== manifest.schemaVersion) {
      errors.push('Manifest schema version does not match the database');
    }
    compareCounts(manifest.metadataCounts, metadata.counts, 'metadata', errors);

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

  return { valid: errors.length === 0, errors, warnings, manifest };
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
  const metadataCounts = parseCounts(candidate.metadataCounts, [
    'users',
    'projects',
    'versions',
    'artifactAudits',
    'artifactAuditJobs',
    'auditEvents',
    'releases',
    'sessions',
  ]);
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
  if (!existsSync(source)) return;
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
    if (!isCrossDeviceError(error)) throw error;
  }

  const isDirectory = lstatSync(source).isDirectory();
  const temporaryTarget = createUnusedSiblingPath(target, 'pending');
  try {
    restoreFileSystem.copy(source, temporaryTarget, {
      errorOnExist: true,
      force: false,
      recursive: isDirectory,
      preserveTimestamps: true,
    });
    if (pathEntryExistsNoFollow(target)) {
      throw new Error(
        `[RESTORE_ROLLBACK_TARGET_EXISTS] Refusing to overwrite rollback target for ${source}`
      );
    }
    restoreFileSystem.rename(temporaryTarget, target);
    // Publication is atomic and authoritative from this point onward. If
    // source removal fails or only partially completes, compensation restores
    // from this known-complete rollback copy.
    progress.rollbackPublished = true;
    restoreFileSystem.remove(source, {
      recursive: isDirectory,
      force: true,
    });
    progress.sourceRemoved = true;
  } catch (error) {
    const primaryError = asError(error);
    if (!progress.rollbackPublished) {
      const secondaryFailures: RestoreSecondaryFailure[] = [];
      removeBestEffort(
        restoreFileSystem,
        temporaryTarget,
        { recursive: isDirectory, force: true },
        'cleanup-move-temp',
        source,
        secondaryFailures
      );
      // A final target that appeared before publication was recorded is
      // untrusted, including an injected rename that wrote and then failed.
      removeBestEffort(
        restoreFileSystem,
        target,
        { recursive: isDirectory, force: true },
        'cleanup-unpublished-rollback',
        source,
        secondaryFailures
      );
      attachRestoreSecondaryFailures(primaryError, secondaryFailures);
    }
    throw primaryError;
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
