import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
import type { ProjectRepository } from '../repositories/projectRepository';
import { createId } from '../utils/id';

export interface ArtifactRecoveryLease {
  readonly moved: boolean;
  /** Operation directory containing manifest, marker, and recoverable bytes. */
  readonly recoveryPath: string | null;
  commit(): void;
  rollback(): void;
}

export interface ArtifactRecoveryService {
  stageProjectDeletion(projectId: string): ArtifactRecoveryLease;
  stageVersionDeletion(
    projectId: string,
    versionId: string
  ): ArtifactRecoveryLease;
}

export interface InterruptedArtifactRecoveryReport {
  restored: number;
  committed: number;
  /** Total unresolved conflict directories after this recovery pass. */
  conflicts: number;
}

interface RecoveryManifest {
  version: 2;
  operation: 'delete';
  kind: 'project' | 'version';
  target: {
    projectId: string;
    versionId: string | null;
  };
  originalPath: string;
  recoveryPath: string;
  committed: boolean;
  stagedAt: string;
  committedAt: string | null;
}

interface LegacyRecoveryManifest {
  version: 1;
  kind: 'project' | 'version';
  projectId: string;
  versionId: string | null;
  sourcePath: string;
  artifactPath: string;
  stagedAt: string;
}

export function createArtifactRecoveryService(
  storageDir: string
): ArtifactRecoveryService {
  const stage = (
    kind: RecoveryManifest['kind'],
    projectId: string,
    versionId: string | null
  ): ArtifactRecoveryLease => {
    const sourcePath =
      versionId === null
        ? join(storageDir, projectId)
        : join(storageDir, projectId, versionId);
    if (!existsSync(sourcePath)) return createNoopLease();

    const operationId = `${Date.now()}-${createId()}`;
    const operationDir = join(storageDir, '.recovery', 'trash', operationId);
    const artifactPath =
      versionId === null
        ? join(operationDir, 'artifacts', projectId)
        : join(operationDir, 'artifacts', projectId, versionId);
    let manifest: RecoveryManifest = {
      version: 2,
      operation: 'delete',
      kind,
      target: { projectId, versionId },
      originalPath: relative(storageDir, sourcePath),
      recoveryPath: relative(storageDir, artifactPath),
      committed: false,
      stagedAt: new Date().toISOString(),
      committedAt: null,
    };

    mkdirSync(dirname(artifactPath), { recursive: true });
    writeRecoveryManifest(operationDir, manifest);
    try {
      renameSync(sourcePath, artifactPath);
    } catch (error) {
      rmSync(operationDir, { recursive: true, force: true });
      throw error;
    }

    let state: 'staged' | 'committed' | 'rolled-back' = 'staged';
    return {
      moved: true,
      recoveryPath: operationDir,
      commit() {
        if (state !== 'staged') return;
        const committedAt = new Date().toISOString();
        manifest = { ...manifest, committed: true, committedAt };
        writeRecoveryManifest(operationDir, manifest);
        writeFileSync(join(operationDir, 'COMMITTED'), committedAt, 'utf8');
        state = 'committed';
      },
      rollback() {
        if (state === 'rolled-back') return;
        if (state === 'committed') {
          throw new Error('Cannot roll back a committed artifact deletion');
        }
        if (existsSync(sourcePath)) {
          throw new Error(
            'Cannot restore artifacts because the original path exists'
          );
        }
        mkdirSync(dirname(sourcePath), { recursive: true });
        renameSync(artifactPath, sourcePath);
        rmSync(operationDir, { recursive: true, force: true });
        state = 'rolled-back';
      },
    };
  };

  return {
    stageProjectDeletion(projectId) {
      return stage('project', projectId, null);
    },
    stageVersionDeletion(projectId, versionId) {
      return stage('version', projectId, versionId);
    },
  };
}

/**
 * Completes deletion leases interrupted between the artifact rename and the
 * metadata transaction. Metadata is authoritative and this pass must run
 * before garbage collection or orphan reconciliation.
 */
export function recoverInterruptedArtifactOperations(
  repo: ProjectRepository,
  storageDir: string
): InterruptedArtifactRecoveryReport {
  const trashRoot = join(storageDir, '.recovery', 'trash');
  const conflictRoot = join(storageDir, '.recovery', 'conflicts');
  const report: InterruptedArtifactRecoveryReport = {
    restored: 0,
    committed: 0,
    conflicts: countDirectories(conflictRoot),
  };
  const snapshot = repo.load();

  for (const entry of listDirectories(trashRoot)) {
    const operationDir = join(trashRoot, entry.name);
    let manifest: RecoveryManifest;
    try {
      manifest = parseRecoveryManifest(
        readFileSync(join(operationDir, 'manifest.json'), 'utf8'),
        storageDir,
        entry.name
      );
    } catch {
      quarantineConflict(operationDir, conflictRoot, entry.name);
      report.conflicts += 1;
      continue;
    }

    const project = snapshot.projects.find(
      (candidate) => candidate.id === manifest.target.projectId
    );
    const metadataReferencesTarget =
      manifest.kind === 'project'
        ? project !== undefined
        : project?.versions.some(
            (version) => version.id === manifest.target.versionId
          ) === true;
    const originalPath = join(storageDir, manifest.originalPath);
    const recoveryPath = join(storageDir, manifest.recoveryPath);

    if (!metadataReferencesTarget) {
      if (!manifest.committed || !existsSync(join(operationDir, 'COMMITTED'))) {
        const committedAt = new Date().toISOString();
        writeRecoveryManifest(operationDir, {
          ...manifest,
          committed: true,
          committedAt,
        });
        writeFileSync(join(operationDir, 'COMMITTED'), committedAt, 'utf8');
        report.committed += 1;
      }
      continue;
    }

    const originalExists = existsSync(originalPath);
    const recoveryExists = existsSync(recoveryPath);
    if (originalExists && recoveryExists) {
      quarantineConflict(operationDir, conflictRoot, entry.name);
      report.conflicts += 1;
      continue;
    }
    if (originalExists) {
      // Rollback already restored the source and only cleanup was interrupted.
      rmSync(operationDir, { recursive: true, force: true });
      report.restored += 1;
      continue;
    }
    if (!recoveryExists) {
      quarantineConflict(operationDir, conflictRoot, entry.name);
      report.conflicts += 1;
      continue;
    }

    mkdirSync(dirname(originalPath), { recursive: true });
    renameSync(recoveryPath, originalPath);
    rmSync(operationDir, { recursive: true, force: true });
    report.restored += 1;
  }

  return report;
}

function parseRecoveryManifest(
  source: string,
  storageDir: string,
  operationId: string
): RecoveryManifest {
  const value: unknown = JSON.parse(source);
  let manifest: RecoveryManifest;
  if (isRecord(value) && value.version === 1) {
    const legacy = parseLegacyManifest(value);
    manifest = {
      version: 2,
      operation: 'delete',
      kind: legacy.kind,
      target: {
        projectId: legacy.projectId,
        versionId: legacy.versionId,
      },
      originalPath: legacy.sourcePath,
      recoveryPath: legacy.artifactPath,
      committed: false,
      stagedAt: legacy.stagedAt,
      committedAt: null,
    };
  } else if (
    isRecord(value) &&
    value.version === 2 &&
    value.operation === 'delete' &&
    (value.kind === 'project' || value.kind === 'version') &&
    isRecord(value.target) &&
    typeof value.target.projectId === 'string' &&
    (typeof value.target.versionId === 'string' ||
      value.target.versionId === null) &&
    typeof value.originalPath === 'string' &&
    typeof value.recoveryPath === 'string' &&
    typeof value.committed === 'boolean' &&
    typeof value.stagedAt === 'string' &&
    (typeof value.committedAt === 'string' || value.committedAt === null)
  ) {
    manifest = value as unknown as RecoveryManifest;
  } else {
    throw new Error('Recovery manifest is malformed');
  }

  validateTarget(manifest);
  const expectedOriginalPath =
    manifest.target.versionId === null
      ? manifest.target.projectId
      : join(manifest.target.projectId, manifest.target.versionId);
  const expectedRecoveryPath = join(
    '.recovery',
    'trash',
    operationId,
    'artifacts',
    expectedOriginalPath
  );
  validateRelativePath(manifest.originalPath);
  validateRelativePath(manifest.recoveryPath);
  if (
    manifest.originalPath !== expectedOriginalPath ||
    manifest.recoveryPath !== expectedRecoveryPath ||
    relative(storageDir, join(storageDir, manifest.originalPath)) !==
      manifest.originalPath ||
    relative(storageDir, join(storageDir, manifest.recoveryPath)) !==
      manifest.recoveryPath
  ) {
    throw new Error('Recovery manifest paths do not match its target');
  }
  return manifest;
}

function parseLegacyManifest(
  value: Record<string, unknown>
): LegacyRecoveryManifest {
  if (
    (value.kind !== 'project' && value.kind !== 'version') ||
    typeof value.projectId !== 'string' ||
    (typeof value.versionId !== 'string' && value.versionId !== null) ||
    typeof value.sourcePath !== 'string' ||
    typeof value.artifactPath !== 'string' ||
    typeof value.stagedAt !== 'string'
  ) {
    throw new Error('Legacy recovery manifest is malformed');
  }
  return value as unknown as LegacyRecoveryManifest;
}

function validateTarget(manifest: RecoveryManifest): void {
  const { projectId, versionId } = manifest.target;
  if (
    !isSafePathComponent(projectId) ||
    (versionId !== null && !isSafePathComponent(versionId)) ||
    (manifest.kind === 'project' && versionId !== null) ||
    (manifest.kind === 'version' && versionId === null)
  ) {
    throw new Error('Recovery manifest target is invalid');
  }
}

function validateRelativePath(path: string): void {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    normalize(path) !== path ||
    path === '..' ||
    path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    path.includes('\0') ||
    (process.platform !== 'win32' && path.includes('\\'))
  ) {
    throw new Error(
      'Recovery manifest path must be a normalized relative path'
    );
  }
}

function isSafePathComponent(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0')
  );
}

function writeRecoveryManifest(
  operationDir: string,
  manifest: RecoveryManifest
): void {
  mkdirSync(operationDir, { recursive: true });
  const manifestPath = join(operationDir, 'manifest.json');
  const temporaryPath = join(operationDir, `.manifest-${createId()}.tmp`);
  writeFileSync(temporaryPath, JSON.stringify(manifest, null, 2), 'utf8');
  renameSync(temporaryPath, manifestPath);
}

function quarantineConflict(
  operationDir: string,
  conflictRoot: string,
  operationId: string
): void {
  mkdirSync(conflictRoot, { recursive: true });
  let target = join(conflictRoot, operationId);
  let suffix = 1;
  while (existsSync(target)) {
    target = join(conflictRoot, `${operationId}-${suffix}`);
    suffix += 1;
  }
  renameSync(operationDir, target);
}

function countDirectories(path: string): number {
  return listDirectories(path).length;
}

function listDirectories(path: string) {
  return existsSync(path)
    ? readdirSync(path, { withFileTypes: true }).filter((entry) =>
        entry.isDirectory()
      )
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function createNoopLease(): ArtifactRecoveryLease {
  return {
    moved: false,
    recoveryPath: null,
    commit() {},
    rollback() {},
  };
}
