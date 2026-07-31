import { Database } from 'bun:sqlite';
import { O_NOFOLLOW, O_RDONLY } from 'node:constants';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { loadRelationalData } from '../repositories/sqliteProjectRepository';
import {
  configureSqlite,
  getRelationalSchemaVersion,
  RELATIONAL_SCHEMA_VERSION,
  upgradeRelationalSchema,
} from '../repositories/sqliteSchema';
import { safeJoin } from '../utils/safePath';
import { checksumDirectory } from './artifactService';
import {
  assertDatabaseAuxiliariesAbsent,
  captureBackupDatabaseForValidation,
  captureBackupPayload,
  countDeployableVersions,
  inspectTree,
  parseManifest,
} from './backupSnapshot';
import type {
  BackupManifest,
  BackupServiceDependencies,
  BackupVerificationReport,
  VerifiedBackupPayload,
} from './backupTypes';

const BACKUP_DATABASE_SNAPSHOT_UNSAFE = 'BACKUP_DATABASE_SNAPSHOT_UNSAFE';
const BACKUP_SOURCE_UNSAFE = 'BACKUP_SOURCE_UNSAFE';
const BACKUP_MIGRATION_PREFLIGHT_FAILED = 'BACKUP_MIGRATION_PREFLIGHT_FAILED';
const BACKUP_VALIDATION_CLEANUP_FAILED = 'BACKUP_VALIDATION_CLEANUP_FAILED';

interface VersionIntegrityRow {
  id: string;
  project_id: string;
  status: string;
  checksum: string;
  integrity_status: string;
}

export function verifyBackupAt(
  backupPath: string,
  dependencies: BackupServiceDependencies
): BackupVerificationReport {
  return verifyBackupDetailedAt(backupPath, dependencies).report;
}

export function verifyBackupDetailedAt(
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

export function verifyStagedBackupPayload(
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
    captureBackupDatabaseForValidation(
      sourceDatabaseFile,
      temporaryDatabaseFile
    );

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

export function fingerprintBackupPayload(
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

export function fingerprintRuntimeResource(
  path: string,
  kind: 'directory' | 'file'
): string {
  const hash = createHash('sha256');
  hashFrame(hash, 'runtime-resource-kind', Buffer.from(kind));
  if (kind === 'file') hashFileFrame(hash, 'runtime-resource-file', path);
  else hashDirectory(path, '', hash);
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

export function lstatIfPresent(
  path: string
): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

export function pathEntryExistsNoFollow(path: string): boolean {
  return lstatIfPresent(path) !== undefined;
}

export function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}
