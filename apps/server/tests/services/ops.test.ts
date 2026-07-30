import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteProjectRepository } from '../../src/repositories/sqliteProjectRepository';

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
  const repositoryRoot = join(import.meta.dir, '..', '..', '..', '..');
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      join(repositoryRoot, 'apps', 'server', 'src', 'cli', 'ops.ts'),
      'audit-jobs-prune',
      '--dry-run',
    ],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      DEPLOYKIT_ENV: 'test',
      DATABASE_FILE: databaseFile,
      DATA_FILE: join(tempDir, 'data.json'),
      STORAGE_DIR: join(tempDir, 'storage'),
      PUBLIC_DIR: join(tempDir, 'public'),
      ARTIFACT_AUDIT_JOB_RETENTION_HOURS: '24',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe('');
  expect(JSON.parse(result.stdout.toString())).toEqual({
    command: 'audit-jobs-prune',
    dryRun: true,
    cutoff: expect.any(String),
    report: { matched: 0, removed: 0 },
  });
});
