import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createSqliteProjectRepository } from '../../src/repositories/sqliteProjectRepository';
import {
  acquireRuntimeOwnership,
  RUNTIME_OWNERSHIP_HELD,
} from '../../src/services/runtimeOwnership';

let tempDir: string;

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

function spawnOps(databaseFile: string, ...args: string[]) {
  const repositoryRoot = join(import.meta.dir, '..', '..', '..', '..');
  return Bun.spawnSync({
    cmd: [
      process.execPath,
      join(repositoryRoot, 'apps', 'server', 'src', 'cli', 'ops.ts'),
      ...args,
    ],
    cwd: repositoryRoot,
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
