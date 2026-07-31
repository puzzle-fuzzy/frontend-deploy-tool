import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createSqliteProjectRepository } from '../../src/repositories/sqliteProjectRepository';
import {
  acquireRuntimeOwnership,
  RUNTIME_OWNERSHIP_HELD,
} from '../../src/services/runtimeOwnership';

let tempDir: string;
const repositoryRoot = join(import.meta.dir, '..', '..', '..', '..');

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'deploykit-ops-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test('runs terminal audit-job prune in dry-run mode', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  createSqliteProjectRepository({ databaseFile }).load();
  const result = spawnOps(databaseFile, 'audit-jobs-prune', '--dry-run');

  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe('');
  expect(JSON.parse(result.stdout.toString())).toEqual({
    command: 'audit-jobs-prune',
    dryRun: true,
    cutoff: expect.any(String),
    report: { matched: 0, removed: 0 },
  });

  const ownership = acquireRuntimeOwnership(
    databaseFile,
    join(tempDir, 'storage')
  );
  ownership.release();
});

test('inspect and audit-job prune hold runtime ownership for the command lifecycle', () => {
  for (const command of ['inspect', 'audit-jobs-prune'] as const) {
    const caseDir = join(tempDir, command);
    const databaseFile = join(caseDir, 'deploykit.sqlite');
    createSqliteProjectRepository({ databaseFile }).load();
    const ownership = acquireRuntimeOwnership(
      databaseFile,
      join(caseDir, 'storage')
    );
    try {
      const result = spawnOps(
        databaseFile,
        command,
        ...(command === 'audit-jobs-prune' ? ['--dry-run'] : [])
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(RUNTIME_OWNERSHIP_HELD);
    } finally {
      ownership.release();
    }
  }
});

function createOpsFixture(name: string): {
  databaseFile: string;
  storageDir: string;
} {
  const caseDir = join(tempDir, name);
  const databaseFile = join(caseDir, 'deploykit.sqlite');
  const storageDir = join(caseDir, 'storage');
  createSqliteProjectRepository({ databaseFile }).load();
  return { databaseFile, storageDir };
}

function backupTemporarySiblings(destination: string): string[] {
  const parent = dirname(destination);
  if (!existsSync(parent)) return [];
  const prefix = `${basename(destination)}.tmp-`;
  return readdirSync(parent).filter((name) => name.startsWith(prefix));
}

function expectOwnershipContention(result: ReturnType<typeof spawnOps>): void {
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout.toString()).toBe('');
  expect(result.stderr.toString()).toContain(RUNTIME_OWNERSHIP_HELD);
  expect(result.stderr.toString()).toContain(
    'Stop the DeployKit server and other operational commands before retrying'
  );
}

function expectBackupJson(
  result: ReturnType<typeof spawnOps>,
  expectedDestination?: string
): Record<string, unknown> {
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe('');
  const body = JSON.parse(result.stdout.toString()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual([
    'command',
    'destination',
    'manifest',
  ]);
  expect(body.command).toBe('backup');
  if (expectedDestination) expect(body.destination).toBe(expectedDestination);
  expect(body.manifest).toEqual(expect.any(Object));
  return body;
}

test('backup rejects held runtime ownership without writing its destination', () => {
  const { databaseFile, storageDir } = createOpsFixture('held-backup');
  const destination = join(tempDir, 'held-backup-output');
  const ownership = acquireRuntimeOwnership(databaseFile, storageDir);
  try {
    expectOwnershipContention(spawnOps(databaseFile, 'backup', destination));
    expect(existsSync(destination)).toBe(false);
    expect(backupTemporarySiblings(destination)).toEqual([]);
  } finally {
    ownership.release();
  }
});

for (const arguments_ of [['gc', '--dry-run'], ['gc']] as const) {
  test(`${arguments_.join(' ')} rejects held runtime ownership`, () => {
    const { databaseFile, storageDir } = createOpsFixture(arguments_.join('-'));
    const ownership = acquireRuntimeOwnership(databaseFile, storageDir);
    try {
      expectOwnershipContention(spawnOps(databaseFile, ...arguments_));
    } finally {
      ownership.release();
    }
  });
}

test('backup rejects flags and extra positional arguments before output', () => {
  const { databaseFile } = createOpsFixture('backup-grammar');
  const destination = join(tempDir, 'backup-grammar-output');
  for (const [arguments_, wouldBeDestination] of [
    [['backup', '--force'], join(dirname(databaseFile), '--force')],
    [['backup', destination, '--force'], destination],
    [['backup', destination, 'extra'], destination],
  ] as const) {
    const result = spawnOps(databaseFile, ...arguments_);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString()).toContain(
      'backup accepts zero or one destination path and no flags'
    );
    expect(existsSync(wouldBeDestination)).toBe(false);
    expect(backupTemporarySiblings(wouldBeDestination)).toEqual([]);
  }
});

test('backup accepts zero positional arguments before ownership validation', () => {
  const { databaseFile, storageDir } = createOpsFixture('default-backup');
  const ownership = acquireRuntimeOwnership(databaseFile, storageDir);
  try {
    expectOwnershipContention(spawnOps(databaseFile, 'backup'));
  } finally {
    ownership.release();
  }
});

test('backup accepts one positional destination and releases ownership', () => {
  const { databaseFile, storageDir } = createOpsFixture('explicit-backup');
  const destination = join(tempDir, 'explicit-backup-output');
  expectBackupJson(spawnOps(databaseFile, 'backup', destination), destination);
  expect(existsSync(destination)).toBe(true);
  const ownership = acquireRuntimeOwnership(databaseFile, storageDir);
  ownership.release();
});

function spawnOps(databaseFile: string, ...args: string[]) {
  return Bun.spawnSync({
    cmd: [
      process.execPath,
      join(repositoryRoot, 'apps', 'server', 'src', 'cli', 'ops.ts'),
      ...args,
    ],
    cwd: dirname(databaseFile),
    env: {
      ...process.env,
      DEPLOYKIT_ENV: 'test',
      DATABASE_FILE: databaseFile,
      DATA_FILE: join(dirname(databaseFile), 'data.json'),
      STORAGE_DIR: join(dirname(databaseFile), 'storage'),
      PUBLIC_DIR: join(dirname(databaseFile), 'public'),
      ARTIFACT_AUDIT_JOB_RETENTION_HOURS: '24',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}
