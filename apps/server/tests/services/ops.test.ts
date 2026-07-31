import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { executeOwnedOperation } from '../../src/cli/opsLifecycle';
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

test('owned operation returns success only after ownership release', () => {
  const calls: string[] = [];
  const result = executeOwnedOperation(
    {
      migrationGuard: 'guard',
      release() {
        calls.push('release');
      },
    },
    (migrationGuard) => {
      calls.push(`operation:${migrationGuard}`);
      return { command: 'gc' };
    }
  );
  calls.push('output');

  expect(result).toEqual({ command: 'gc' });
  expect(calls).toEqual(['operation:guard', 'release', 'output']);
});

test('owned operation suppresses success when ownership release fails', () => {
  const calls: string[] = [];
  const releaseError = new Error('release failed');
  let caught: unknown;
  try {
    const result = executeOwnedOperation(
      {
        migrationGuard: 'guard',
        release() {
          calls.push('release');
          throw releaseError;
        },
      },
      () => {
        calls.push('operation');
        return { command: 'gc' };
      }
    );
    calls.push(`output:${result.command}`);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBe(releaseError);
  expect(calls).toEqual(['operation', 'release']);
});

test('owned operation preserves its primary error when release also fails', () => {
  const calls: string[] = [];
  const primaryError = new Error('operation failed');
  const releaseError = new Error('release failed');
  let caught: unknown;
  try {
    executeOwnedOperation(
      {
        migrationGuard: 'guard',
        release() {
          calls.push('release');
          throw releaseError;
        },
      },
      () => {
        calls.push('operation');
        throw primaryError;
      }
    );
  } catch (error) {
    caught = error;
  }

  expect(caught).toBe(primaryError);
  expect(calls).toEqual(['operation', 'release']);
  expect(
    (
      primaryError as Error & {
        operationalSecondaryFailures?: unknown[];
      }
    ).operationalSecondaryFailures
  ).toEqual([
    {
      step: 'release',
      resource: 'runtime-ownership',
      error: releaseError,
    },
  ]);
  expect(primaryError.cause).toBeInstanceOf(AggregateError);
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

test('runs terminal audit-job prune with zero arguments', () => {
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  createSqliteProjectRepository({ databaseFile }).load();
  const result = spawnOps(databaseFile, 'audit-jobs-prune');

  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe('');
  expect(JSON.parse(result.stdout.toString())).toEqual({
    command: 'audit-jobs-prune',
    dryRun: false,
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

test('backup rejects literal delimiters before ownership or writes', () => {
  const { databaseFile, storageDir } = createOpsFixture(
    'backup-literal-delimiter'
  );
  const destination = join(tempDir, 'backup-literal-delimiter-output');
  const ownership = acquireRuntimeOwnership(databaseFile, storageDir);
  try {
    for (const arguments_ of [
      ['backup', '--'],
      ['backup', destination, '--'],
    ] as const) {
      const result = spawnOps(databaseFile, ...arguments_);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe('');
      expect(result.stderr.toString()).toContain(
        'backup accepts zero or one destination path and no flags'
      );
      expect(result.stderr.toString()).not.toContain(RUNTIME_OWNERSHIP_HELD);
      expect(existsSync(destination)).toBe(false);
      expect(backupTemporarySiblings(destination)).toEqual([]);
    }
  } finally {
    ownership.release();
  }
});

for (const command of ['gc', 'audit-jobs-prune'] as const) {
  test(`${command} rejects invalid dry-run grammar before ownership`, () => {
    const { databaseFile, storageDir } = createOpsFixture(
      `${command}-invalid-grammar`
    );
    const ownership = acquireRuntimeOwnership(databaseFile, storageDir);
    try {
      for (const arguments_ of [
        ['--dryrun'],
        ['--force'],
        ['--dry-run', '--dry-run'],
        ['position'],
        ['--dry-run', 'position'],
      ] as const) {
        const result = spawnOps(databaseFile, command, ...arguments_);
        expect(result.exitCode).not.toBe(0);
        expect(result.stdout.toString()).toBe('');
        expect(result.stderr.toString()).toContain(
          `${command} accepts no arguments except a single optional --dry-run`
        );
        expect(result.stderr.toString()).not.toContain(RUNTIME_OWNERSHIP_HELD);
      }
    } finally {
      ownership.release();
    }
  });
}

test('gc rejects a misspelled dry-run flag without deleting stale staging', () => {
  const { databaseFile, storageDir } = createOpsFixture('gc-dryrun-typo');
  const staleEntry = join(storageDir, '.staging', 'stale-entry');
  mkdirSync(staleEntry, { recursive: true });
  const staleTime = new Date('2020-01-01T00:00:00.000Z');
  utimesSync(staleEntry, staleTime, staleTime);

  const result = spawnOps(databaseFile, 'gc', '--dryrun');

  expect(result.exitCode).not.toBe(0);
  expect(result.stdout.toString()).toBe('');
  expect(result.stderr.toString()).toContain(
    'gc accepts no arguments except a single optional --dry-run'
  );
  expect(existsSync(staleEntry)).toBe(true);
});

test('bun run ops consumes its delimiter and forwards gc dry-run', () => {
  const { databaseFile, storageDir } = createOpsFixture('bun-run-delimiter');
  const staleEntry = join(storageDir, '.staging', 'stale-entry');
  mkdirSync(staleEntry, { recursive: true });
  const staleTime = new Date('2020-01-01T00:00:00.000Z');
  utimesSync(staleEntry, staleTime, staleTime);

  const result = spawnRootOps(databaseFile, 'gc', '--dry-run');

  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe('');
  expect(JSON.parse(result.stdout.toString())).toEqual({
    command: 'gc',
    dryRun: true,
    report: {
      removedStagingEntries: 1,
      removedCommittedTrashEntries: 0,
      removedOrphanEntries: 0,
    },
  });
  expect(existsSync(staleEntry)).toBe(true);
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
    env: opsEnvironment(databaseFile),
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function spawnRootOps(databaseFile: string, ...args: string[]) {
  return Bun.spawnSync({
    cmd: [process.execPath, 'run', '--silent', 'ops', '--', ...args],
    cwd: repositoryRoot,
    env: opsEnvironment(databaseFile),
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function opsEnvironment(databaseFile: string): Record<string, string> {
  return {
    ...process.env,
    DEPLOYKIT_ENV: 'test',
    DATABASE_FILE: databaseFile,
    DATA_FILE: join(dirname(databaseFile), 'data.json'),
    STORAGE_DIR: join(dirname(databaseFile), 'storage'),
    PUBLIC_DIR: join(dirname(databaseFile), 'public'),
    ARTIFACT_AUDIT_JOB_RETENTION_HOURS: '24',
  };
}
