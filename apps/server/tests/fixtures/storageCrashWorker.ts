import { existsSync, writeFileSync } from 'node:fs';
import { createDeployKitRuntime } from '../../src/app';
import type { AppConfig } from '../../src/config';
import { createSqliteProjectRepository } from '../../src/repositories/sqliteProjectRepository';
import {
  type ArtifactRecoveryService,
  createArtifactRecoveryService,
} from '../../src/services/artifactRecovery';
import { createProjectService } from '../../src/services/projectService';
import { createVersionService } from '../../src/services/versionService';

const mode = requireEnv('CRASH_WORKER_MODE');
const databaseFile = requireEnv('DATABASE_FILE');
const storageDir = requireEnv('STORAGE_DIR');
const dataFile = requireEnv('DATA_FILE');
const publicDir = requireEnv('PUBLIC_DIR');
const readyFile = process.env.READY_FILE;

const config: AppConfig = {
  environment: 'test',
  databaseFile,
  dataFile,
  storageDir,
  publicDir,
  adminEmail: 'admin@test.local',
  adminPassword: 'test-password',
  sessionSecret: 'storage-crash-recovery-test-secret',
  secureCookies: false,
  registrationEnabled: false,
};

createDeployKitRuntime(config);

if (mode === 'hold') {
  if (!readyFile) throw new Error('READY_FILE is required in hold mode');
  writeFileSync(readyFile, 'ready', 'utf8');
  await new Promise(() => {});
}

if (mode !== 'delete-version' && mode !== 'delete-project') {
  throw new Error(`Unknown CRASH_WORKER_MODE: ${mode}`);
}

const repository = createSqliteProjectRepository({
  databaseFile,
  legacyDataFile: dataFile,
});
const artifactRecovery = crashAfterArtifactRename(
  createArtifactRecoveryService(storageDir),
  mode
);

if (mode === 'delete-version') {
  createVersionService(repository, config, { artifactRecovery }).deleteVersion(
    'project-1',
    'version-1',
    'user-1'
  );
} else {
  createProjectService(repository, { artifactRecovery }).deleteProject(
    'project-1',
    'user-1'
  );
}

throw new Error('Crash worker unexpectedly survived the injected SIGKILL');

function crashAfterArtifactRename(
  delegate: ArtifactRecoveryService,
  workerMode: 'delete-version' | 'delete-project'
): ArtifactRecoveryService {
  const crash = () => {
    if (readyFile) writeFileSync(readyFile, 'renamed', 'utf8');
    process.kill(process.pid, 'SIGKILL');
  };

  return {
    stageProjectDeletion(projectId) {
      const lease = delegate.stageProjectDeletion(projectId);
      if (
        workerMode === 'delete-project' &&
        lease.moved &&
        lease.recoveryPath &&
        existsSync(lease.recoveryPath)
      ) {
        crash();
      }
      return lease;
    },
    stageVersionDeletion(projectId, versionId) {
      const lease = delegate.stageVersionDeletion(projectId, versionId);
      if (
        workerMode === 'delete-version' &&
        lease.moved &&
        lease.recoveryPath &&
        existsSync(lease.recoveryPath)
      ) {
        crash();
      }
      return lease;
    },
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
