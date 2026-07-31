import { Database } from 'bun:sqlite';
import {
  O_CREAT,
  O_EXCL,
  O_NOFOLLOW,
  O_RDONLY,
  O_WRONLY,
} from 'node:constants';
import {
  closeSync,
  cpSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createId } from '../utils/id';
import type { RuntimeResourceLayout } from '../utils/runtimeResourcePath';
import { safeJoin } from '../utils/safePath';
import {
  assertSingleLinkRegularFile,
  BACKUP_DATABASE_SNAPSHOT_UNSAFE,
  BACKUP_SOURCE_UNSAFE,
  pathEntryExistsNoFollow,
  sameCapturedIdentity,
} from './backupFileSafety';
import type { BackupManifest, BackupVerificationReport } from './backupTypes';
import { DATABASE_AUXILIARY_SUFFIXES } from './backupTypes';

interface RestoreStageCaptureCallbacks {
  database(): void;
  manifest(): void;
  storage(): void;
}

interface VersionIntegrityRow {
  id: string;
  project_id: string;
  status: string;
  checksum: string;
  integrity_status: string;
}

export function createBackupSnapshotAt(input: {
  destination: string;
  layout: RuntimeResourceLayout;
  now: () => Date;
  verifyPreparedBackup: (backupPath: string) => BackupVerificationReport;
}): BackupManifest {
  const { destination, layout, now, verifyPreparedBackup } = input;
  if (existsSync(destination)) {
    throw new Error(`Backup destination already exists: ${destination}`);
  }

  mkdirSync(dirname(destination), { recursive: true });
  const temporaryPath = `${destination}.tmp-${createId()}`;
  const databaseDirectory = join(temporaryPath, 'database');
  const snapshotFile = join(databaseDirectory, basename(layout.databaseFile));
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

    const verification = verifyPreparedBackup(temporaryPath);
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
}

export function captureBackupPayload(
  backupPath: string,
  stages: {
    manifestStage: string;
    databaseStage?: string;
    databaseStageDirectory?: string;
    storageStage: string;
  },
  onStageCreated?: RestoreStageCaptureCallbacks
): void {
  captureRegularFileNoFollow(
    join(backupPath, 'manifest.json'),
    stages.manifestStage,
    BACKUP_SOURCE_UNSAFE,
    onStageCreated?.manifest
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
    BACKUP_DATABASE_SNAPSHOT_UNSAFE,
    onStageCreated?.database
  );
  assertDatabaseAuxiliariesAbsent(sourceDatabase);
  captureDirectoryNoFollow(
    join(backupPath, manifest.storageDirectory),
    stages.storageStage,
    onStageCreated?.storage
  );
}

export function captureBackupDatabaseForValidation(
  source: string,
  target: string
): void {
  captureRegularFileNoFollow(source, target);
}

function captureRegularFileNoFollow(
  source: string,
  target: string,
  unsafeCode = BACKUP_SOURCE_UNSAFE,
  onTargetCreated?: () => void
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
    onTargetCreated?.();
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

function captureDirectoryNoFollow(
  source: string,
  target: string,
  onTargetCreated?: () => void
): void {
  const before = lstatSync(source, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(
      `Backup storage must be a non-symbolic directory: ${source}`
    );
  }
  mkdirSync(target, { recursive: false, mode: 0o700 });
  onTargetCreated?.();
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

export function assertDatabaseAuxiliariesAbsent(databaseFile: string): void {
  for (const suffix of DATABASE_AUXILIARY_SUFFIXES) {
    if (pathEntryExistsNoFollow(`${databaseFile}${suffix}`)) {
      throw new Error(
        `[${BACKUP_DATABASE_SNAPSHOT_UNSAFE}] Database snapshot must not include ${suffix}`
      );
    }
  }
}

export function inspectDatabase(databaseFile: string) {
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

export function countDeployableVersions(
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

export function inspectTree(root: string): {
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

export function parseManifest(value: unknown): BackupManifest {
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

export function ensureRollbackManifest(
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
