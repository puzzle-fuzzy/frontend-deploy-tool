import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
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

interface RecoveryManifest {
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
    const manifest: RecoveryManifest = {
      version: 1,
      kind,
      projectId,
      versionId,
      sourcePath: relative(storageDir, sourcePath),
      artifactPath: relative(storageDir, artifactPath),
      stagedAt: new Date().toISOString(),
    };

    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(
      join(operationDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    );
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
        writeFileSync(
          join(operationDir, 'COMMITTED'),
          new Date().toISOString(),
          'utf8'
        );
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

function createNoopLease(): ArtifactRecoveryLease {
  return {
    moved: false,
    recoveryPath: null,
    commit() {},
    rollback() {},
  };
}
