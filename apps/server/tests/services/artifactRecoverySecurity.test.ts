import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Data } from '@deploykit/shared';
import type { ProjectRepository as ServerProjectRepository } from '../../src/repositories/projectRepository';
import {
  createArtifactRecoveryService,
  recoverInterruptedArtifactOperations,
} from '../../src/services/artifactRecovery';
import { checksumDirectory } from '../../src/services/artifactService';

describe('artifact recovery manifest safety', () => {
  test('restores an unambiguous legacy v1 recovery tree', () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'deploykit-recovery-v1-'));
    const operationId = 'legacy-operation';
    const operationDir = join(storageDir, '.recovery', 'trash', operationId);
    const recoveryPath = join(operationDir, 'artifacts', 'p1', 'version-1');
    mkdirSync(recoveryPath, { recursive: true });
    writeFileSync(join(recoveryPath, 'index.html'), 'legacy');
    writeFileSync(
      join(operationDir, 'manifest.json'),
      JSON.stringify({
        version: 1,
        kind: 'version',
        projectId: 'p1',
        versionId: 'version-1',
        sourcePath: 'p1/version-1',
        artifactPath: '.recovery/trash/legacy-operation/artifacts/p1/version-1',
        stagedAt: '2026-07-30T00:00:00.000Z',
      })
    );

    try {
      expect(
        recoverInterruptedArtifactOperations(
          repositoryWithReferencedVersion(),
          storageDir
        )
      ).toEqual({ restored: 1, committed: 0, conflicts: 0 });
      expect(
        readFileSync(join(storageDir, 'p1', 'version-1', 'index.html'), 'utf8')
      ).toBe('legacy');
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  test('quarantines ambiguous v1 cleanup and inconsistent v2 commit state', () => {
    for (const variant of ['ambiguous-v1', 'malformed-v2'] as const) {
      const storageDir = mkdtempSync(
        join(tmpdir(), `deploykit-recovery-${variant}-`)
      );
      const operationDir = join(storageDir, '.recovery', 'trash', variant);
      const originalPath = join(storageDir, 'p1', 'version-1');
      mkdirSync(operationDir, { recursive: true });
      if (variant === 'ambiguous-v1') {
        mkdirSync(originalPath, { recursive: true });
        writeFileSync(join(originalPath, 'index.html'), 'unproven');
        writeFileSync(
          join(operationDir, 'manifest.json'),
          JSON.stringify({
            version: 1,
            kind: 'version',
            projectId: 'p1',
            versionId: 'version-1',
            sourcePath: 'p1/version-1',
            artifactPath: '.recovery/trash/ambiguous-v1/artifacts/p1/version-1',
            stagedAt: '2026-07-30T00:00:00.000Z',
          })
        );
      } else {
        const recoveryPath = join(operationDir, 'artifacts', 'p1', 'version-1');
        mkdirSync(recoveryPath, { recursive: true });
        writeFileSync(join(recoveryPath, 'index.html'), 'malformed');
        writeVersion2Manifest(operationDir, variant, {
          committed: true,
          committedAt: null,
        });
      }

      try {
        expect(
          recoverInterruptedArtifactOperations(
            repositoryWithReferencedVersion(),
            storageDir
          )
        ).toMatchObject({ restored: 0, conflicts: 1 });
        expect(
          existsSync(join(storageDir, '.recovery', 'conflicts', variant))
        ).toBe(true);
      } finally {
        rmSync(storageDir, { recursive: true, force: true });
      }
    }
  });

  test('rejects symlinks at the recovery object, an artifacts ancestor, and inside the tree', () => {
    for (const variant of [
      'recovery-object-link',
      'artifact-ancestor-link',
      'recursive-link',
    ] as const) {
      const storageDir = mkdtempSync(
        join(tmpdir(), `deploykit-recovery-${variant}-`)
      );
      const externalDir = mkdtempSync(
        join(tmpdir(), `deploykit-recovery-external-${variant}-`)
      );
      const operationDir = join(storageDir, '.recovery', 'trash', variant);
      const recoveryPath = join(operationDir, 'artifacts', 'p1', 'version-1');
      mkdirSync(externalDir, { recursive: true });
      writeFileSync(join(externalDir, 'index.html'), 'outside');

      if (variant === 'recovery-object-link') {
        mkdirSync(join(operationDir, 'artifacts', 'p1'), {
          recursive: true,
        });
        symlinkSync(externalDir, recoveryPath, 'dir');
      } else if (variant === 'artifact-ancestor-link') {
        mkdirSync(join(operationDir, 'artifacts'), { recursive: true });
        symlinkSync(externalDir, join(operationDir, 'artifacts', 'p1'), 'dir');
      } else {
        mkdirSync(recoveryPath, { recursive: true });
        writeFileSync(join(recoveryPath, 'index.html'), 'inside');
        symlinkSync(
          join(externalDir, 'index.html'),
          join(recoveryPath, 'outside-link')
        );
      }
      writeVersion2Manifest(operationDir, variant);

      try {
        expect(
          recoverInterruptedArtifactOperations(
            repositoryWithReferencedVersion(),
            storageDir
          )
        ).toMatchObject({ restored: 0, conflicts: 1 });
        expect(readFileSync(join(externalDir, 'index.html'), 'utf8')).toBe(
          'outside'
        );
      } finally {
        rmSync(storageDir, { recursive: true, force: true });
        rmSync(externalDir, { recursive: true, force: true });
      }
    }
  });

  test('cleans a manifest only when a restored path has identity proof', () => {
    const storageDir = mkdtempSync(
      join(tmpdir(), 'deploykit-recovery-identity-')
    );
    const originalPath = join(storageDir, 'p1', 'version-1');
    mkdirSync(originalPath, { recursive: true });
    writeFileSync(join(originalPath, 'index.html'), 'original');
    const lease = createArtifactRecoveryService(
      storageDir
    ).stageVersionDeletion('p1', 'version-1');
    const manifest = readManifest(lease.recoveryPath);
    const recoveryPath = join(storageDir, manifest.recoveryPath);
    renameSync(recoveryPath, originalPath);

    try {
      expect(
        recoverInterruptedArtifactOperations(
          repositoryWithReferencedVersion(),
          storageDir
        )
      ).toEqual({ restored: 1, committed: 0, conflicts: 0 });
      expect(existsSync(lease.recoveryPath ?? '')).toBe(false);
      expect(readFileSync(join(originalPath, 'index.html'), 'utf8')).toBe(
        'original'
      );
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  test('accepts checksum proof when restored bytes have a new identity', () => {
    const storageDir = mkdtempSync(
      join(tmpdir(), 'deploykit-recovery-checksum-')
    );
    const originalPath = join(storageDir, 'p1', 'version-1');
    mkdirSync(originalPath, { recursive: true });
    writeFileSync(join(originalPath, 'index.html'), 'same bytes');
    const checksum = checksumDirectory(originalPath);
    const lease = createArtifactRecoveryService(
      storageDir
    ).stageVersionDeletion('p1', 'version-1', {
      versionChecksums: { 'version-1': checksum },
    });
    const manifest = readManifest(lease.recoveryPath);
    rmSync(join(storageDir, manifest.recoveryPath), {
      recursive: true,
      force: true,
    });
    mkdirSync(originalPath, { recursive: true });
    writeFileSync(join(originalPath, 'index.html'), 'same bytes');

    try {
      expect(
        recoverInterruptedArtifactOperations(
          repositoryWithReferencedVersion(checksum),
          storageDir
        )
      ).toEqual({ restored: 1, committed: 0, conflicts: 0 });
      expect(existsSync(lease.recoveryPath ?? '')).toBe(false);
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  test('quarantines an original path whose identity and checksum both mismatch', () => {
    const storageDir = mkdtempSync(
      join(tmpdir(), 'deploykit-recovery-mismatch-')
    );
    const originalPath = join(storageDir, 'p1', 'version-1');
    mkdirSync(originalPath, { recursive: true });
    writeFileSync(join(originalPath, 'index.html'), 'original');
    const checksum = checksumDirectory(originalPath);
    const lease = createArtifactRecoveryService(
      storageDir
    ).stageVersionDeletion('p1', 'version-1', {
      versionChecksums: { 'version-1': checksum },
    });
    const manifest = readManifest(lease.recoveryPath);
    rmSync(join(storageDir, manifest.recoveryPath), {
      recursive: true,
      force: true,
    });
    mkdirSync(originalPath, { recursive: true });
    writeFileSync(join(originalPath, 'index.html'), 'replacement');

    try {
      expect(
        recoverInterruptedArtifactOperations(
          repositoryWithReferencedVersion(checksum),
          storageDir
        )
      ).toMatchObject({ restored: 0, conflicts: 1 });
      expect(readFileSync(join(originalPath, 'index.html'), 'utf8')).toBe(
        'replacement'
      );
      expect(existsSync(join(storageDir, '.recovery', 'conflicts'))).toBe(true);
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });
});

function writeVersion2Manifest(
  operationDir: string,
  operationId: string,
  overrides: { committed?: boolean; committedAt?: string | null } = {}
): void {
  mkdirSync(operationDir, { recursive: true });
  writeFileSync(
    join(operationDir, 'manifest.json'),
    JSON.stringify({
      version: 2,
      operation: 'delete',
      kind: 'version',
      target: { projectId: 'p1', versionId: 'version-1' },
      originalPath: 'p1/version-1',
      recoveryPath: `.recovery/trash/${operationId}/artifacts/p1/version-1`,
      committed: overrides.committed ?? false,
      stagedAt: '2026-07-30T00:00:00.000Z',
      committedAt: overrides.committedAt ?? null,
    })
  );
}

function readManifest(operationDir: string | null): { recoveryPath: string } {
  if (!operationDir) throw new Error('Expected a staged operation');
  return JSON.parse(
    readFileSync(join(operationDir, 'manifest.json'), 'utf8')
  ) as { recoveryPath: string };
}

function repositoryWithReferencedVersion(
  checksum = ''
): ServerProjectRepository {
  const data: Data = {
    schemaVersion: 5,
    projects: [
      {
        id: 'p1',
        name: 'Demo',
        slug: 'demo',
        description: '',
        createdAt: '2026-07-30T00:00:00.000Z',
        updatedAt: '2026-07-30T00:00:00.000Z',
        versions: [
          {
            id: 'version-1',
            name: 'Version 1',
            description: '',
            createdAt: '2026-07-30T00:00:00.000Z',
            size: 1,
            fileCount: 1,
            sourceType: 'folder',
            status: 'preview',
            publishedAt: null,
            publishedBy: null,
            checksum,
            integrityStatus: 'unknown',
            integrityCheckedAt: null,
          },
        ],
        activeVersionId: null,
        settings: { spaMode: false, routingType: 'path' },
        auditPolicy: {
          enforcement: 'advisory',
          maxTotalBytes: 50 * 1024 * 1024,
          maxFileBytes: 10 * 1024 * 1024,
          maxFileCount: 1_000,
        },
        createdBy: 'user-1',
        members: [
          {
            userId: 'user-1',
            role: 'owner',
            invitedAt: '2026-07-30T00:00:00.000Z',
          },
        ],
      },
    ],
    users: [],
    history: [],
    artifactAudits: [],
    artifactAuditJobs: [],
  };
  return {
    load: () => data,
    save: () => {},
    mutate: (operation) => operation(data),
  };
}
