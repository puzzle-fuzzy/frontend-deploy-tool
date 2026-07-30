import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Data } from '@deploykit/shared';
import { createApp, createDeployKitRuntime } from '../../src/app';
import type { AppConfig } from '../../src/config';
import { CURRENT_SCHEMA_VERSION } from '../../src/domain/schema';
import { createSqliteProjectRepository } from '../../src/repositories/sqliteProjectRepository';
import { createArtifactRecoveryService } from '../../src/services/artifactRecovery';
import { acquireRuntimeOwnership } from '../../src/services/runtimeOwnership';

const workerPath = join(
  import.meta.dir,
  '..',
  'fixtures',
  'storageCrashWorker.ts'
);
const childProcesses: Array<ReturnType<typeof Bun.spawn>> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const child of childProcesses.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
  }
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('storage crash recovery', () => {
  for (const mode of ['delete-version', 'delete-project'] as const) {
    test(`restores an active artifact after process death during ${mode}`, async () => {
      const fixture = createFixture();
      const renamedFile = join(fixture.tempDir, 'renamed');
      const child = spawnWorker(fixture, mode, renamedFile);

      const exitCode = await child.exited;
      expect(exitCode).not.toBe(0);
      expect(await waitForFile(renamedFile)).toBe(true);
      expect(
        existsSync(
          join(fixture.storageDir, 'project-1', 'version-1', 'index.html')
        )
      ).toBe(false);

      const firstRestart = createDeployKitRuntime(fixture.config);
      try {
        const response = await firstRestart.app.request('/deploy/demo/');
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('<html>production</html>');
        expect(fixture.repository.load().projects[0]?.activeVersionId).toBe(
          'version-1'
        );
        expect(fixture.repository.load().history).toHaveLength(0);
      } finally {
        firstRestart.runtimeOwnership.release();
      }

      const secondRestart = createDeployKitRuntime(fixture.config);
      try {
        expect(fixture.repository.load().history).toHaveLength(0);
        expect((await secondRestart.app.request('/deploy/demo/')).status).toBe(
          200
        );
      } finally {
        secondRestart.runtimeOwnership.release();
      }
    });
  }

  test('a second live runtime for the same database and storage fails closed', async () => {
    const fixture = createFixture();
    const firstReady = join(fixture.tempDir, 'first-ready');
    const first = spawnWorker(fixture, 'hold', firstReady);
    expect(await waitForFile(firstReady)).toBe(true);

    const secondReady = join(fixture.tempDir, 'second-ready');
    const second = spawnWorker(fixture, 'hold', secondReady);
    const exitCode = await Promise.race([
      second.exited,
      Bun.sleep(2_000).then(() => null),
    ]);
    if (exitCode === null) second.kill('SIGKILL');
    const stderr = await new Response(second.stderr).text();

    expect(exitCode).not.toBeNull();
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('RUNTIME_OWNERSHIP_HELD');
    expect(existsSync(secondReady)).toBe(false);
    expect(first.exitCode).toBeNull();
  });

  test('readiness remains unavailable while a recovery conflict is quarantined', async () => {
    const fixture = createFixture();
    const artifactDir = join(fixture.storageDir, 'project-1', 'version-1');
    createArtifactRecoveryService(fixture.storageDir).stageVersionDeletion(
      'project-1',
      'version-1'
    );
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, 'index.html'), 'replacement', 'utf8');

    const app = createApp(fixture.config);
    const readiness = await app.request('/health/ready');

    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toEqual({
      status: 'error',
      reason: 'artifact_recovery_conflicts',
      conflicts: 1,
    });
    expect((await app.request('/deploy/demo/')).status).toBe(200);
  });

  test('runtime ownership is released when application composition fails', () => {
    const fixture = createFixture();
    expect(() =>
      createDeployKitRuntime({
        ...fixture.config,
        artifactAuditTimeoutMs: 90_000,
        artifactAuditLeaseMs: 90_000,
      })
    ).toThrow(
      'ARTIFACT_AUDIT_LEASE_MS must be greater than ARTIFACT_AUDIT_TIMEOUT_MS'
    );

    const ownership = acquireRuntimeOwnership(
      fixture.databaseFile,
      fixture.storageDir
    );
    ownership.release();
  });
});

function createFixture() {
  const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-crash-recovery-'));
  tempDirs.push(tempDir);
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const dataFile = join(tempDir, 'data.json');
  const storageDir = join(tempDir, 'storage');
  const publicDir = join(tempDir, 'public');
  const artifactDir = join(storageDir, 'project-1', 'version-1');
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    join(artifactDir, 'index.html'),
    '<html>production</html>',
    'utf8'
  );

  const repository = createSqliteProjectRepository({
    databaseFile,
    legacyDataFile: dataFile,
  });
  const data: Data = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    users: [],
    history: [],
    artifactAudits: [],
    artifactAuditJobs: [],
    projects: [
      {
        id: 'project-1',
        name: 'Demo',
        slug: 'demo',
        description: '',
        createdAt: '2026-07-30T00:00:00.000Z',
        updatedAt: '2026-07-30T00:00:00.000Z',
        versions: [
          {
            id: 'version-1',
            name: 'Production',
            description: '',
            createdAt: '2026-07-30T00:00:00.000Z',
            size: 23,
            fileCount: 1,
            sourceType: 'folder',
            status: 'production',
            publishedAt: '2026-07-30T00:00:00.000Z',
            publishedBy: 'user-1',
            checksum: 'fixture-checksum',
            integrityStatus: 'verified',
            integrityCheckedAt: '2026-07-30T00:00:00.000Z',
          },
        ],
        activeVersionId: 'version-1',
        settings: { spaMode: false, routingType: 'path' },
        auditPolicy: {
          enforcement: 'advisory',
          maxTotalBytes: 50 * 1024 * 1024,
          maxFileBytes: 10 * 1024 * 1024,
          maxFileCount: 1_000,
        },
        createdBy: 'user-1',
        members: [],
      },
    ],
  };
  repository.save(data);
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
  return {
    tempDir,
    databaseFile,
    dataFile,
    storageDir,
    publicDir,
    repository,
    config,
  };
}

function spawnWorker(
  fixture: ReturnType<typeof createFixture>,
  mode: 'hold' | 'delete-version' | 'delete-project',
  readyFile: string
) {
  const child = Bun.spawn([process.execPath, workerPath], {
    cwd: join(import.meta.dir, '..', '..', '..', '..'),
    env: {
      ...process.env,
      CRASH_WORKER_MODE: mode,
      DATABASE_FILE: fixture.databaseFile,
      DATA_FILE: fixture.dataFile,
      STORAGE_DIR: fixture.storageDir,
      PUBLIC_DIR: fixture.publicDir,
      READY_FILE: readyFile,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  childProcesses.push(child);
  return child;
}

async function waitForFile(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return true;
    await Bun.sleep(20);
  }
  return false;
}
