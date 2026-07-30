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
import { safeJoin } from '../utils/safePath';
import { checksumDirectory } from './artifactService';
import { acquireRuntimeOwnership } from './runtimeOwnership';

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
      if (!existsSync(config.databaseFile)) {
        throw new Error(`Database does not exist: ${config.databaseFile}`);
      }
      if (existsSync(destination)) {
        throw new Error(`Backup destination already exists: ${destination}`);
      }

      mkdirSync(dirname(destination), { recursive: true });
      const temporaryPath = `${destination}.tmp-${createId()}`;
      const databaseDirectory = join(temporaryPath, 'database');
      const snapshotFile = join(
        databaseDirectory,
        basename(config.databaseFile)
      );
      const backupStorage = join(temporaryPath, 'storage');

      try {
        mkdirSync(databaseDirectory, { recursive: true });
        const database = new Database(config.databaseFile);
        try {
          database.exec('PRAGMA busy_timeout = 5000');
          database.query('VACUUM INTO ?').run(snapshotFile);
        } finally {
          database.close();
        }

        if (existsSync(config.storageDir)) {
          cpSync(config.storageDir, backupStorage, {
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
          databaseFile: basename(config.databaseFile),
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
      if (!options.force) {
        throw new Error('Restore requires an explicit force flag');
      }
      const verification = verifyBackupAt(backupPath);
      if (!verification.valid || !verification.manifest) {
        throw new Error(
          `Backup verification failed: ${verification.errors.join('; ')}`
        );
      }

      const runtimeOwnership = acquireRuntimeOwnership(
        config.databaseFile,
        config.storageDir
      );
      try {
        const operationId = `${formatTimestamp(now())}-${createId()}`;
        const rollbackPath = join(
          dirname(config.databaseFile),
          '.deploykit-rollback',
          operationId
        );
        const databaseStage = `${config.databaseFile}.restore-${operationId}`;
        const storageStage = join(
          dirname(config.storageDir),
          `.${basename(config.storageDir)}.restore-${operationId}`
        );
        let rollbackStarted = false;

        try {
          mkdirSync(dirname(databaseStage), { recursive: true });
          cpSync(
            join(backupPath, 'database', verification.manifest.databaseFile),
            databaseStage,
            { preserveTimestamps: true }
          );
          cpSync(join(backupPath, 'storage'), storageStage, {
            recursive: true,
            preserveTimestamps: true,
          });

          mkdirSync(join(rollbackPath, 'database'), { recursive: true });
          rollbackStarted = true;
          moveIfPresent(
            config.databaseFile,
            join(rollbackPath, 'database', basename(config.databaseFile))
          );
          moveIfPresent(
            `${config.databaseFile}-wal`,
            join(
              rollbackPath,
              'database',
              `${basename(config.databaseFile)}-wal`
            )
          );
          moveIfPresent(
            `${config.databaseFile}-shm`,
            join(
              rollbackPath,
              'database',
              `${basename(config.databaseFile)}-shm`
            )
          );
          moveIfPresent(config.storageDir, join(rollbackPath, 'storage'));
          ensureRollbackManifest(
            rollbackPath,
            basename(config.databaseFile),
            now()
          );

          dependencies.afterCurrentStateMoved?.(rollbackPath);

          renameSync(databaseStage, config.databaseFile);
          mkdirSync(dirname(config.storageDir), { recursive: true });
          renameSync(storageStage, config.storageDir);
        } catch (error) {
          if (rollbackStarted) {
            recoverCurrentState(config, rollbackPath);
          }
          rmSync(databaseStage, { force: true });
          rmSync(storageStage, { recursive: true, force: true });
          throw error;
        }

        return {
          restoredFrom: backupPath,
          rollbackPath,
          verification,
        };
      } finally {
        runtimeOwnership.release();
      }
    },
  };
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
  if (!existsSync(databaseFile)) errors.push('Database snapshot is missing');
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

function moveIfPresent(source: string, target: string): void {
  if (!existsSync(source)) return;
  mkdirSync(dirname(target), { recursive: true });
  try {
    renameSync(source, target);
  } catch (error) {
    if (!isCrossDeviceError(error)) throw error;
    const isDirectory = lstatSync(source).isDirectory();
    cpSync(source, target, {
      recursive: isDirectory,
      preserveTimestamps: true,
    });
    rmSync(source, { recursive: isDirectory, force: true });
  }
}

function recoverCurrentState(
  config: BackupServiceConfig,
  rollbackPath: string
): void {
  const rollbackDatabase = join(
    rollbackPath,
    'database',
    basename(config.databaseFile)
  );
  if (existsSync(rollbackDatabase)) {
    rmSync(config.databaseFile, { force: true });
    cpSync(rollbackDatabase, config.databaseFile, { preserveTimestamps: true });
  }
  for (const suffix of ['-wal', '-shm']) {
    const rollbackSidecar = `${rollbackDatabase}${suffix}`;
    if (existsSync(rollbackSidecar)) {
      rmSync(`${config.databaseFile}${suffix}`, { force: true });
      cpSync(rollbackSidecar, `${config.databaseFile}${suffix}`, {
        preserveTimestamps: true,
      });
    }
  }
  const rollbackStorage = join(rollbackPath, 'storage');
  if (existsSync(rollbackStorage)) {
    mkdirSync(dirname(config.storageDir), { recursive: true });
    rmSync(config.storageDir, { recursive: true, force: true });
    cpSync(rollbackStorage, config.storageDir, {
      recursive: true,
      preserveTimestamps: true,
    });
  }
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
