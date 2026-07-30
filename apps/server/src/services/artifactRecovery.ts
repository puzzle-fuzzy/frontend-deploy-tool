import {
  lstatSync,
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
import { checksumDirectory } from './artifactService';
import {
  assertStorageControlPathsAreSafe,
  assertStoragePathHasNoSymlinkAncestors,
} from './storagePathSafety';

export interface ArtifactRecoveryLease {
  readonly moved: boolean;
  /** Operation directory containing manifest, marker, and recoverable bytes. */
  readonly recoveryPath: string | null;
  commit(): void;
  rollback(): void;
}

export interface ArtifactRecoveryEvidence {
  /** Durable upload checksums keyed by version ID. */
  versionChecksums: Record<string, string>;
}

export interface ArtifactRecoveryService {
  stageProjectDeletion(
    projectId: string,
    evidence?: ArtifactRecoveryEvidence
  ): ArtifactRecoveryLease;
  stageVersionDeletion(
    projectId: string,
    versionId: string,
    evidence?: ArtifactRecoveryEvidence
  ): ArtifactRecoveryLease;
}

export interface InterruptedArtifactRecoveryReport {
  restored: number;
  committed: number;
  /** Total unresolved conflict entries after this recovery pass. */
  conflicts: number;
}

interface ArtifactIdentity {
  device: number;
  inode: number;
  birthtimeMs: number;
  ctimeMs: number;
}

interface RecoveryManifest {
  version: 3;
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
  artifactIdentity: ArtifactIdentity | null;
  expectedVersionChecksums: Record<string, string>;
}

interface ParsedRecoveryManifest extends Omit<RecoveryManifest, 'version'> {
  sourceVersion: 1 | 2 | 3;
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
    versionId: string | null,
    evidence: ArtifactRecoveryEvidence | undefined
  ): ArtifactRecoveryLease => {
    const sourcePath =
      versionId === null
        ? join(storageDir, projectId)
        : join(storageDir, projectId, versionId);
    assertStoragePathHasNoSymlinkAncestors(storageDir, sourcePath);
    if (!pathExists(sourcePath)) return createNoopLease();
    assertNoSymlinks(sourcePath);

    const operationId = `${Date.now()}-${createId()}`;
    const operationDir = join(storageDir, '.recovery', 'trash', operationId);
    const artifactPath =
      versionId === null
        ? join(operationDir, 'artifacts', projectId)
        : join(operationDir, 'artifacts', projectId, versionId);
    let manifest: RecoveryManifest = {
      version: 3,
      operation: 'delete',
      kind,
      target: { projectId, versionId },
      originalPath: relative(storageDir, sourcePath),
      recoveryPath: relative(storageDir, artifactPath),
      committed: false,
      stagedAt: new Date().toISOString(),
      committedAt: null,
      // A valid pre-rename manifest makes even a crash between rename and the
      // identity update recoverable. Ambiguous cleanup never trusts null.
      artifactIdentity: null,
      expectedVersionChecksums: sanitizeChecksums(evidence?.versionChecksums),
    };

    assertStoragePathHasNoSymlinkAncestors(storageDir, operationDir);
    mkdirSync(dirname(artifactPath), { recursive: true });
    assertStoragePathHasNoSymlinkAncestors(storageDir, artifactPath);
    writeRecoveryManifest(storageDir, operationDir, manifest);
    try {
      renameSync(sourcePath, artifactPath);
      manifest = {
        ...manifest,
        artifactIdentity: readArtifactIdentity(artifactPath),
      };
      writeRecoveryManifest(storageDir, operationDir, manifest);
    } catch (error) {
      if (!pathExists(sourcePath) && pathExists(artifactPath)) {
        assertStoragePathHasNoSymlinkAncestors(storageDir, artifactPath);
        assertStoragePathHasNoSymlinkAncestors(storageDir, dirname(sourcePath));
        mkdirSync(dirname(sourcePath), { recursive: true });
        assertStoragePathHasNoSymlinkAncestors(storageDir, dirname(sourcePath));
        renameSync(artifactPath, sourcePath);
      }
      removeRecoveryOperation(storageDir, operationDir);
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
        writeRecoveryManifest(storageDir, operationDir, manifest);
        writeRecoveryMarker(storageDir, operationDir, committedAt);
        state = 'committed';
      },
      rollback() {
        if (state === 'rolled-back') return;
        if (state === 'committed') {
          throw new Error('Cannot roll back a committed artifact deletion');
        }
        assertStoragePathHasNoSymlinkAncestors(storageDir, sourcePath);
        assertStoragePathHasNoSymlinkAncestors(storageDir, artifactPath);
        if (pathExists(sourcePath)) {
          throw new Error(
            'Cannot restore artifacts because the original path exists'
          );
        }
        assertNoSymlinks(artifactPath);
        assertStoragePathHasNoSymlinkAncestors(storageDir, dirname(sourcePath));
        mkdirSync(dirname(sourcePath), { recursive: true });
        assertStoragePathHasNoSymlinkAncestors(storageDir, dirname(sourcePath));
        renameSync(artifactPath, sourcePath);
        removeRecoveryOperation(storageDir, operationDir);
        state = 'rolled-back';
      },
    };
  };

  return {
    stageProjectDeletion(projectId, evidence) {
      return stage('project', projectId, null, evidence);
    },
    stageVersionDeletion(projectId, versionId, evidence) {
      return stage('version', projectId, versionId, evidence);
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
    conflicts: 0,
  };
  try {
    assertStorageControlPathsAreSafe(storageDir);
    report.conflicts = countEntries(conflictRoot);
  } catch {
    // The symlink remains a durable, visible conflict on every restart. Never
    // enumerate or create through an unsafe recovery-control ancestor.
    report.conflicts += 1;
    return report;
  }
  const snapshot = repo.load();

  for (const entry of listEntries(trashRoot)) {
    const operationDir = join(trashRoot, entry.name);
    let manifest: ParsedRecoveryManifest;
    try {
      assertStoragePathHasNoSymlinkAncestors(storageDir, dirname(operationDir));
      if (!entry.isDirectory()) {
        throw new Error('Recovery operation must be a directory');
      }
      assertNoSymlinks(operationDir);
      manifest = parseRecoveryManifest(
        readFileSync(join(operationDir, 'manifest.json'), 'utf8'),
        storageDir,
        entry.name
      );
    } catch {
      quarantineConflict(storageDir, operationDir, conflictRoot, entry.name);
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
      if (!manifest.committed || !pathExists(join(operationDir, 'COMMITTED'))) {
        try {
          const committedAt = new Date().toISOString();
          writeRecoveryManifest(storageDir, operationDir, {
            ...toVersion3Manifest(manifest),
            committed: true,
            committedAt,
          });
          writeRecoveryMarker(storageDir, operationDir, committedAt);
          report.committed += 1;
        } catch {
          quarantineConflict(
            storageDir,
            operationDir,
            conflictRoot,
            entry.name
          );
          report.conflicts += 1;
        }
      }
      continue;
    }

    try {
      assertStoragePathHasNoSymlinkAncestors(storageDir, originalPath);
      assertStoragePathHasNoSymlinkAncestors(storageDir, recoveryPath);
    } catch {
      quarantineConflict(storageDir, operationDir, conflictRoot, entry.name);
      report.conflicts += 1;
      continue;
    }
    const originalExists = pathExists(originalPath);
    const recoveryExists = pathExists(recoveryPath);
    if (originalExists && recoveryExists) {
      quarantineConflict(storageDir, operationDir, conflictRoot, entry.name);
      report.conflicts += 1;
      continue;
    }
    if (originalExists) {
      try {
        assertStoragePathHasNoSymlinkAncestors(storageDir, originalPath);
        assertNoSymlinks(originalPath);
        if (!canProveRestoredArtifact(manifest, originalPath)) {
          throw new Error('Restored artifact identity cannot be proven');
        }
      } catch {
        quarantineConflict(storageDir, operationDir, conflictRoot, entry.name);
        report.conflicts += 1;
        continue;
      }
      removeRecoveryOperation(storageDir, operationDir);
      report.restored += 1;
      continue;
    }
    if (!recoveryExists) {
      quarantineConflict(storageDir, operationDir, conflictRoot, entry.name);
      report.conflicts += 1;
      continue;
    }

    try {
      assertStoragePathHasNoSymlinkAncestors(storageDir, recoveryPath);
      assertNoSymlinks(recoveryPath);
      assertStoragePathHasNoSymlinkAncestors(storageDir, dirname(originalPath));
      mkdirSync(dirname(originalPath), { recursive: true });
      assertStoragePathHasNoSymlinkAncestors(storageDir, dirname(originalPath));
      renameSync(recoveryPath, originalPath);
      removeRecoveryOperation(storageDir, operationDir);
      report.restored += 1;
    } catch {
      quarantineConflict(storageDir, operationDir, conflictRoot, entry.name);
      report.conflicts += 1;
    }
  }

  return report;
}

function parseRecoveryManifest(
  source: string,
  storageDir: string,
  operationId: string
): ParsedRecoveryManifest {
  const value: unknown = JSON.parse(source);
  let manifest: ParsedRecoveryManifest;
  if (isRecord(value) && value.version === 1) {
    const legacy = parseLegacyManifest(value);
    manifest = {
      sourceVersion: 1,
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
      artifactIdentity: null,
      expectedVersionChecksums: {},
    };
  } else if (isVersion2Manifest(value)) {
    manifest = {
      sourceVersion: 2,
      operation: 'delete',
      kind: value.kind,
      target: {
        projectId: value.target.projectId,
        versionId: value.target.versionId,
      },
      originalPath: value.originalPath,
      recoveryPath: value.recoveryPath,
      committed: value.committed,
      stagedAt: value.stagedAt,
      committedAt: value.committedAt,
      artifactIdentity: null,
      expectedVersionChecksums: {},
    };
  } else if (isVersion3Manifest(value)) {
    manifest = {
      sourceVersion: 3,
      operation: 'delete',
      kind: value.kind,
      target: {
        projectId: value.target.projectId,
        versionId: value.target.versionId,
      },
      originalPath: value.originalPath,
      recoveryPath: value.recoveryPath,
      committed: value.committed,
      stagedAt: value.stagedAt,
      committedAt: value.committedAt,
      artifactIdentity: value.artifactIdentity,
      expectedVersionChecksums: value.expectedVersionChecksums,
    };
  } else {
    throw new Error('Recovery manifest is malformed');
  }

  validateCommittedState(manifest);
  validateTarget(manifest);
  if (!isSafePathComponent(operationId)) {
    throw new Error('Recovery operation ID is invalid');
  }
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

function isVersion2Manifest(value: unknown): value is {
  version: 2;
  operation: 'delete';
  kind: 'project' | 'version';
  target: { projectId: string; versionId: string | null };
  originalPath: string;
  recoveryPath: string;
  committed: boolean;
  stagedAt: string;
  committedAt: string | null;
} {
  return (
    isCommonManifest(value) &&
    value.version === 2 &&
    !('artifactIdentity' in value) &&
    !('expectedVersionChecksums' in value)
  );
}

function isVersion3Manifest(value: unknown): value is RecoveryManifest {
  return (
    isCommonManifest(value) &&
    value.version === 3 &&
    (value.artifactIdentity === null ||
      isArtifactIdentity(value.artifactIdentity)) &&
    isChecksumRecord(value.expectedVersionChecksums)
  );
}

function isCommonManifest(value: unknown): value is Record<string, unknown> & {
  operation: 'delete';
  kind: 'project' | 'version';
  target: { projectId: string; versionId: string | null };
  originalPath: string;
  recoveryPath: string;
  committed: boolean;
  stagedAt: string;
  committedAt: string | null;
} {
  return (
    isRecord(value) &&
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
  );
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

function validateCommittedState(manifest: ParsedRecoveryManifest): void {
  if (
    (manifest.committed && manifest.committedAt === null) ||
    (!manifest.committed && manifest.committedAt !== null)
  ) {
    throw new Error('Recovery manifest commit state is inconsistent');
  }
}

function validateTarget(manifest: ParsedRecoveryManifest): void {
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

function sanitizeChecksums(
  checksums: Record<string, string> | undefined
): Record<string, string> {
  if (!checksums) return {};
  return Object.fromEntries(
    Object.entries(checksums).filter(
      ([versionId, checksum]) =>
        isSafePathComponent(versionId) && isSha256(checksum)
    )
  );
}

function isChecksumRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([versionId, checksum]) =>
        isSafePathComponent(versionId) &&
        typeof checksum === 'string' &&
        isSha256(checksum)
    )
  );
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function isArtifactIdentity(value: unknown): value is ArtifactIdentity {
  return (
    isRecord(value) &&
    isSafeIdentityInteger(value.device) &&
    isSafeIdentityInteger(value.inode) &&
    isFiniteTimestamp(value.birthtimeMs) &&
    isFiniteTimestamp(value.ctimeMs)
  );
}

function isSafeIdentityInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function readArtifactIdentity(path: string): ArtifactIdentity {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) {
    throw new Error('Recovery artifacts must not contain symbolic links');
  }
  return {
    device: stats.dev,
    inode: stats.ino,
    birthtimeMs: stats.birthtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}

function canProveRestoredArtifact(
  manifest: ParsedRecoveryManifest,
  originalPath: string
): boolean {
  if (manifest.sourceVersion !== 3) return false;
  if (Object.keys(manifest.expectedVersionChecksums).length > 0) {
    return checksumsMatch(manifest, originalPath);
  }
  if (
    manifest.artifactIdentity &&
    identitiesMatch(
      manifest.artifactIdentity,
      readArtifactIdentity(originalPath)
    )
  ) {
    return true;
  }
  return false;
}

function identitiesMatch(
  expected: ArtifactIdentity,
  actual: ArtifactIdentity
): boolean {
  return (
    actual.device === expected.device &&
    actual.inode === expected.inode &&
    actual.birthtimeMs === expected.birthtimeMs &&
    actual.ctimeMs >= expected.ctimeMs
  );
}

function checksumsMatch(
  manifest: ParsedRecoveryManifest,
  originalPath: string
): boolean {
  const expected = manifest.expectedVersionChecksums;
  if (manifest.kind === 'version') {
    const versionId = manifest.target.versionId;
    const expectedVersions = Object.keys(expected);
    const expectedChecksum = versionId ? expected[versionId] : undefined;
    return (
      expectedVersions.length === 1 &&
      expectedChecksum !== undefined &&
      checksumDirectory(originalPath) === expectedChecksum
    );
  }

  const expectedVersions = Object.keys(expected).sort();
  if (expectedVersions.length === 0) return false;
  const actualVersions = readdirSync(originalPath, {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (
    actualVersions.length !== expectedVersions.length ||
    actualVersions.some(
      (versionId, index) => versionId !== expectedVersions[index]
    )
  ) {
    return false;
  }
  return expectedVersions.every(
    (versionId) =>
      checksumDirectory(join(originalPath, versionId)) === expected[versionId]
  );
}

function assertNoSymlinks(path: string): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) {
    throw new Error('Recovery artifacts must not contain symbolic links');
  }
  if (!stats.isDirectory()) return;
  for (const entry of readdirSync(path)) {
    assertNoSymlinks(join(path, entry));
  }
}

function writeRecoveryManifest(
  storageDir: string,
  operationDir: string,
  manifest: RecoveryManifest
): void {
  assertStoragePathHasNoSymlinkAncestors(storageDir, operationDir);
  mkdirSync(operationDir, { recursive: true });
  assertStoragePathHasNoSymlinkAncestors(storageDir, operationDir);
  const manifestPath = join(operationDir, 'manifest.json');
  const temporaryPath = join(operationDir, `.manifest-${createId()}.tmp`);
  assertStoragePathHasNoSymlinkAncestors(storageDir, manifestPath);
  assertStoragePathHasNoSymlinkAncestors(storageDir, temporaryPath);
  writeFileSync(temporaryPath, JSON.stringify(manifest, null, 2), 'utf8');
  renameSync(temporaryPath, manifestPath);
}

function writeRecoveryMarker(
  storageDir: string,
  operationDir: string,
  committedAt: string
): void {
  assertStoragePathHasNoSymlinkAncestors(storageDir, operationDir);
  const markerPath = join(operationDir, 'COMMITTED');
  assertStoragePathHasNoSymlinkAncestors(storageDir, markerPath);
  writeFileSync(markerPath, committedAt, 'utf8');
}

function removeRecoveryOperation(
  storageDir: string,
  operationDir: string
): void {
  assertStoragePathHasNoSymlinkAncestors(storageDir, operationDir);
  assertNoSymlinks(operationDir);
  rmSync(operationDir, { recursive: true, force: true });
}

function toVersion3Manifest(
  manifest: ParsedRecoveryManifest
): RecoveryManifest {
  return {
    version: 3,
    operation: manifest.operation,
    kind: manifest.kind,
    target: manifest.target,
    originalPath: manifest.originalPath,
    recoveryPath: manifest.recoveryPath,
    committed: manifest.committed,
    stagedAt: manifest.stagedAt,
    committedAt: manifest.committedAt,
    artifactIdentity: manifest.artifactIdentity,
    expectedVersionChecksums: manifest.expectedVersionChecksums,
  };
}

function quarantineConflict(
  storageDir: string,
  operationDir: string,
  conflictRoot: string,
  operationId: string
): boolean {
  try {
    assertStoragePathHasNoSymlinkAncestors(storageDir, dirname(operationDir));
    assertStoragePathHasNoSymlinkAncestors(storageDir, conflictRoot);
    mkdirSync(conflictRoot, { recursive: true });
    assertStoragePathHasNoSymlinkAncestors(storageDir, conflictRoot);
    let target = join(conflictRoot, operationId);
    let suffix = 1;
    while (pathExists(target)) {
      target = join(conflictRoot, `${operationId}-${suffix}`);
      suffix += 1;
    }
    assertStoragePathHasNoSymlinkAncestors(storageDir, dirname(target));
    renameSync(operationDir, target);
    return true;
  } catch {
    // Retaining the operation or unsafe control symlink preserves a conflict
    // for the next readiness pass without touching an external target.
    return false;
  }
}

function countEntries(path: string): number {
  return listEntries(path).length;
}

function listEntries(path: string) {
  return pathExists(path) ? readdirSync(path, { withFileTypes: true }) : [];
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (
      isRecord(error) &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
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
