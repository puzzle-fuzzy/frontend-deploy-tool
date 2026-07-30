import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
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
import { checksumDirectory } from '../../src/services/artifactService';
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
    await expectWorkerOwnershipFailure(second);
    expect(existsSync(secondReady)).toBe(false);
    expect(first.exitCode).toBeNull();
  });

  test('sharing either database or storage with a live runtime fails closed', async () => {
    const fixture = createFixture();
    const firstReady = join(fixture.tempDir, 'first-ready');
    const first = spawnWorker(fixture, 'hold', firstReady);
    expect(await waitForFile(firstReady)).toBe(true);

    const sharedDatabase = spawnWorker(
      fixture,
      'hold',
      join(fixture.tempDir, 'shared-database-ready'),
      { storageDir: join(fixture.tempDir, 'other-storage') }
    );
    await expectWorkerOwnershipFailure(sharedDatabase);

    const sharedStorage = spawnWorker(
      fixture,
      'hold',
      join(fixture.tempDir, 'shared-storage-ready'),
      {
        databaseFile: join(fixture.tempDir, 'other.sqlite'),
        dataFile: join(fixture.tempDir, 'other.json'),
      }
    );
    await expectWorkerOwnershipFailure(sharedStorage);
    expect(first.exitCode).toBeNull();
  });

  test('SIGKILL releases both kernel sidecar locks for immediate restart', async () => {
    const fixture = createFixture();
    const firstReady = join(fixture.tempDir, 'first-ready');
    const first = spawnWorker(fixture, 'hold', firstReady);
    expect(await waitForFile(firstReady)).toBe(true);

    first.kill('SIGKILL');
    expect(await first.exited).not.toBe(0);

    const replacementReady = join(fixture.tempDir, 'replacement-ready');
    const replacement = spawnWorker(fixture, 'hold', replacementReady);
    expect(await waitForFile(replacementReady)).toBe(true);
    expect(replacement.exitCode).toBeNull();
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

  test('readiness fails when same-identity restored bytes violate the durable checksum', async () => {
    const fixture = createFixture();
    const artifactDir = join(fixture.storageDir, 'project-1', 'version-1');
    const checksum = checksumDirectory(artifactDir);
    const originalInode = statSync(artifactDir).ino;
    const lease = createArtifactRecoveryService(
      fixture.storageDir
    ).stageVersionDeletion('project-1', 'version-1', {
      versionChecksums: { 'version-1': checksum },
    });
    if (!lease.recoveryPath) throw new Error('Expected a staged operation');
    const manifest = JSON.parse(
      readFileSync(join(lease.recoveryPath, 'manifest.json'), 'utf8')
    ) as { recoveryPath: string };
    renameSync(join(fixture.storageDir, manifest.recoveryPath), artifactDir);
    expect(statSync(artifactDir).ino).toBe(originalInode);
    writeFileSync(join(artifactDir, 'index.html'), 'modified in place', 'utf8');

    const app = createApp(fixture.config);
    const readiness = await app.request('/health/ready');

    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toEqual({
      status: 'error',
      reason: 'artifact_recovery_conflicts',
      conflicts: 1,
    });
    expect(existsSync(join(fixture.storageDir, '.recovery', 'conflicts'))).toBe(
      true
    );
  });

  test('readiness fails without traversing a symlinked orphan control root', async () => {
    const fixture = createFixture();
    const externalDir = join(fixture.tempDir, 'external-orphans');
    const externalArtifact = join(externalDir, 'expired', 'index.html');
    mkdirSync(join(externalDir, 'expired'), { recursive: true });
    writeFileSync(externalArtifact, 'external');
    const ancient = new Date('2000-01-01T00:00:00.000Z');
    utimesSync(join(externalDir, 'expired'), ancient, ancient);
    mkdirSync(join(fixture.storageDir, '.recovery'), { recursive: true });
    symlinkSync(externalDir, join(fixture.storageDir, '.recovery', 'orphans'));

    const app = createApp(fixture.config);
    const readiness = await app.request('/health/ready');

    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toEqual({
      status: 'error',
      reason: 'artifact_recovery_conflicts',
      conflicts: 1,
    });
    expect(readFileSync(externalArtifact, 'utf8')).toBe('external');

    const restarted = createApp(fixture.config);
    expect((await restarted.request('/health/ready')).status).toBe(503);
    expect(readFileSync(externalArtifact, 'utf8')).toBe('external');
  });

  test('readiness fails without writing through a symlinked recovery root', async () => {
    const fixture = createFixture();
    const externalRecovery = join(fixture.tempDir, 'external-recovery');
    const orphanArtifact = join(
      fixture.storageDir,
      'orphan-project',
      'orphan-version',
      'index.html'
    );
    mkdirSync(externalRecovery, { recursive: true });
    mkdirSync(join(fixture.storageDir, 'orphan-project', 'orphan-version'), {
      recursive: true,
    });
    writeFileSync(orphanArtifact, 'orphan');
    symlinkSync(externalRecovery, join(fixture.storageDir, '.recovery'));

    const app = createApp(fixture.config);
    const readiness = await app.request('/health/ready');

    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toEqual({
      status: 'error',
      reason: 'artifact_recovery_conflicts',
      conflicts: 1,
    });
    expect(readFileSync(orphanArtifact, 'utf8')).toBe('orphan');
    expect(readdirSync(externalRecovery)).toEqual([]);
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
  readyFile: string,
  overrides: Partial<
    Pick<
      ReturnType<typeof createFixture>,
      'databaseFile' | 'dataFile' | 'storageDir' | 'publicDir'
    >
  > = {}
) {
  const paths = { ...fixture, ...overrides };
  const child = Bun.spawn([process.execPath, workerPath], {
    cwd: join(import.meta.dir, '..', '..', '..', '..'),
    env: {
      ...process.env,
      CRASH_WORKER_MODE: mode,
      DATABASE_FILE: paths.databaseFile,
      DATA_FILE: paths.dataFile,
      STORAGE_DIR: paths.storageDir,
      PUBLIC_DIR: paths.publicDir,
      READY_FILE: readyFile,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  childProcesses.push(child);
  return child;
}

async function expectWorkerOwnershipFailure(
  child: ReturnType<typeof Bun.spawn>
): Promise<void> {
  const exitCode = await Promise.race([
    child.exited,
    Bun.sleep(2_000).then(() => null),
  ]);
  if (exitCode === null) child.kill('SIGKILL');
  const stderr = await new Response(
    child.stderr as ReadableStream<Uint8Array>
  ).text();
  expect(exitCode).not.toBeNull();
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain('RUNTIME_OWNERSHIP_HELD');
}

async function waitForFile(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return true;
    await Bun.sleep(20);
  }
  return false;
}
