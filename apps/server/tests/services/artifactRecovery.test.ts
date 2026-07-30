import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArtifactRecoveryService } from '../../src/services/artifactRecovery';

test('staged version deletion can be rolled back to its original path', () => {
  const storageDir = mkdtempSync(join(tmpdir(), 'deploykit-recovery-'));
  const source = join(storageDir, 'project-1', 'version-1');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'index.html'), 'ready');

  try {
    const lease = createArtifactRecoveryService(
      storageDir
    ).stageVersionDeletion('project-1', 'version-1');
    expect(lease.moved).toBe(true);
    expect(existsSync(source)).toBe(false);
    expect(lease.recoveryPath && existsSync(lease.recoveryPath)).toBe(true);

    lease.rollback();
    expect(existsSync(join(source, 'index.html'))).toBe(true);
    expect(lease.recoveryPath && existsSync(lease.recoveryPath)).toBe(false);
  } finally {
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test('committed deletion remains recoverable with a committed marker', () => {
  const storageDir = mkdtempSync(join(tmpdir(), 'deploykit-recovery-'));
  const source = join(storageDir, 'project-1');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'index.html'), 'ready');

  try {
    const lease =
      createArtifactRecoveryService(storageDir).stageProjectDeletion(
        'project-1'
      );
    lease.commit();

    expect(existsSync(source)).toBe(false);
    expect(lease.recoveryPath).toBeTruthy();
    expect(existsSync(join(lease.recoveryPath ?? '', 'COMMITTED'))).toBe(true);
    expect(
      JSON.parse(
        readFileSync(join(lease.recoveryPath ?? '', 'manifest.json'), 'utf8')
      )
    ).toMatchObject({
      version: 4,
      operation: 'delete',
      kind: 'project',
      target: { projectId: 'project-1', versionId: null },
      originalPath: 'project-1',
      committed: true,
      targetVersionIds: [],
      artifactIdentity: {
        device: expect.any(Number),
        inode: expect.any(Number),
        birthtimeMs: expect.any(Number),
        ctimeMs: expect.any(Number),
      },
      expectedVersionChecksums: {},
    });
    expect(
      existsSync(
        join(lease.recoveryPath ?? '', 'artifacts', 'project-1', 'index.html')
      )
    ).toBe(true);
  } finally {
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test('missing artifacts produce a safe no-op lease', () => {
  const storageDir = mkdtempSync(join(tmpdir(), 'deploykit-recovery-'));
  try {
    const lease = createArtifactRecoveryService(
      storageDir
    ).stageVersionDeletion('project-1', 'missing');
    expect(lease.moved).toBe(false);
    expect(lease.recoveryPath).toBeNull();
    lease.commit();
    lease.rollback();
  } finally {
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test('rollback refuses to overwrite a path recreated after staging', () => {
  const storageDir = mkdtempSync(join(tmpdir(), 'deploykit-recovery-'));
  const source = join(storageDir, 'project-1', 'version-1');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'index.html'), 'original');

  try {
    const lease = createArtifactRecoveryService(
      storageDir
    ).stageVersionDeletion('project-1', 'version-1');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'index.html'), 'replacement');

    expect(() => lease.rollback()).toThrow(
      'Cannot restore artifacts because the original path exists'
    );
    expect(existsSync(source)).toBe(true);
    expect(lease.recoveryPath && existsSync(lease.recoveryPath)).toBe(true);
  } finally {
    rmSync(storageDir, { recursive: true, force: true });
  }
});
