import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Data, Version } from '@deploykit/shared';
import type { ProjectRepository } from '../../src/repositories/projectRepository';
import { createArtifactIntegrityService } from '../../src/services/artifactIntegrityService';
import { checksumDirectory } from '../../src/services/artifactService';

function fixture(version: Partial<Version> = {}): Data {
  return {
    schemaVersion: 6,
    projects: [
      {
        id: 'p1',
        name: 'Demo',
        slug: 'demo',
        description: '',
        createdAt: '',
        updatedAt: '',
        versions: [
          {
            id: 'v1',
            name: 'v1',
            description: '',
            createdAt: '',
            size: 1,
            fileCount: 1,
            sourceType: 'folder',
            status: 'preview',
            publishedAt: null,
            publishedBy: null,
            checksum: '',
            integrityStatus: 'unknown',
            integrityCheckedAt: null,
            ...version,
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
        members: [{ userId: 'user-1', role: 'owner', invitedAt: '' }],
      },
    ],
    users: [],
    history: [],
    artifactAudits: [],
  } as Data;
}

function repository(data: Data): ProjectRepository {
  return {
    load: () => structuredClone(data),
    save: () => {},
    mutate: (operation) => operation(data),
  };
}

function writeArtifact(storageDir: string): string {
  const artifactDir = join(storageDir, 'p1', 'v1');
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, 'index.html'), '<html>ready</html>');
  return checksumDirectory(artifactDir);
}

describe('createArtifactIntegrityService', () => {
  test('persists a verified checksum and inspection timestamp', () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'deploykit-integrity-'));
    try {
      const checksum = writeArtifact(storageDir);
      const data = fixture({ checksum });
      const report = createArtifactIntegrityService(
        repository(data),
        storageDir
      ).inspectVersion('p1', 'v1', 'user-1');

      expect(report).toMatchObject({
        status: 'verified',
        expectedChecksum: checksum,
        actualChecksum: checksum,
        entrypointPresent: true,
      });
      expect(data.projects[0].versions[0].integrityStatus).toBe('verified');
      expect(data.projects[0].versions[0].integrityCheckedAt).toBe(
        report.checkedAt
      );
      expect(data.history[0]?.metadata).toMatchObject({
        reason: 'integrity_verified',
      });
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  test('marks a missing active artifact failed and unpublishes it', () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'deploykit-integrity-'));
    try {
      const data = fixture({
        checksum: 'expected',
        status: 'production',
        integrityStatus: 'verified',
      });
      data.projects[0].activeVersionId = 'v1';
      const report = createArtifactIntegrityService(
        repository(data),
        storageDir
      ).inspectVersion('p1', 'v1', 'user-1');

      expect(report.status).toBe('missing');
      expect(report.actualChecksum).toBeNull();
      expect(data.projects[0].activeVersionId).toBeNull();
      expect(data.projects[0].versions[0]).toMatchObject({
        status: 'failed',
        integrityStatus: 'missing',
      });
      expect(data.history[0]?.metadata).toMatchObject({
        reason: 'integrity_missing',
        wasActive: true,
      });
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  test('marks a checksum mismatch corrupted without replacing production', () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'deploykit-integrity-'));
    try {
      const actualChecksum = writeArtifact(storageDir);
      const data = fixture({
        checksum: 'different-checksum',
        status: 'production',
      });
      data.projects[0].activeVersionId = 'v1';
      const report = createArtifactIntegrityService(
        repository(data),
        storageDir
      ).inspectVersion('p1', 'v1', 'system');

      expect(report).toMatchObject({
        status: 'corrupted',
        expectedChecksum: 'different-checksum',
        actualChecksum,
      });
      expect(data.projects[0].activeVersionId).toBeNull();
      expect(data.projects[0].versions[0].integrityStatus).toBe('corrupted');
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  test('backfills an empty legacy checksum after a successful inspection', () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'deploykit-integrity-'));
    try {
      const actualChecksum = writeArtifact(storageDir);
      const data = fixture({ checksum: '' });
      createArtifactIntegrityService(
        repository(data),
        storageDir
      ).inspectVersion('p1', 'v1', 'system');

      expect(data.projects[0].versions[0]).toMatchObject({
        checksum: actualChecksum,
        integrityStatus: 'verified',
      });
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });
});
