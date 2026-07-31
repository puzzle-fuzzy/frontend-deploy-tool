import { expect, test } from 'bun:test';
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
import type { ProjectRepository } from '../../src/repositories/projectRepository';
import {
  type ArtifactRecoveryEvidence,
  type ArtifactRecoveryService,
  createArtifactRecoveryService,
} from '../../src/services/artifactRecovery';
import { createProjectService } from '../../src/services/projectService';

test('restores project artifacts when the metadata deletion fails', () => {
  const storageDir = mkdtempSync(join(tmpdir(), 'deploykit-project-delete-'));
  const projectDir = join(storageDir, 'project-1');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'index.html'), 'ready');
  const data: Data = {
    schemaVersion: 5,
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
            checksum: 'a'.repeat(64),
            integrityStatus: 'unknown',
            integrityCheckedAt: null,
          },
          {
            id: 'v2',
            name: 'v2',
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
          },
        ],
        activeVersionId: null,
        settings: { spaMode: false, routingType: 'path' },
        auditPolicy: {
          enforcement: 'advisory',
          maxTotalBytes: 50 * 1024 * 1024,
          maxFileBytes: 10 * 1024 * 1024,
          maxFileCount: 1_000,
          maxJavaScriptBytes: 10 * 1024 * 1024,
          maxStylesheetBytes: 2 * 1024 * 1024,
          maxFontBytes: 10 * 1024 * 1024,
        },
        createdBy: 'user-1',
        members: [],
      },
    ],
  };
  let absentDuringMutation = false;
  const repository: ProjectRepository = {
    load: () => data,
    save: () => {},
    mutate: () => {
      absentDuringMutation = !existsSync(projectDir);
      throw new Error('metadata delete failed');
    },
  };
  let capturedEvidence: ArtifactRecoveryEvidence | undefined;
  const delegate = createArtifactRecoveryService(storageDir);
  const artifactRecovery: ArtifactRecoveryService = {
    stageProjectDeletion(projectId, evidence) {
      capturedEvidence = evidence;
      return delegate.stageProjectDeletion(projectId, evidence);
    },
    stageVersionDeletion(projectId, versionId, evidence) {
      return delegate.stageVersionDeletion(projectId, versionId, evidence);
    },
  };

  try {
    const service = createProjectService(repository, {
      artifactRecovery,
    });
    expect(() => service.deleteProject('project-1', 'user-1')).toThrow(
      'metadata delete failed'
    );
    expect(absentDuringMutation).toBe(true);
    expect(existsSync(join(projectDir, 'index.html'))).toBe(true);
    expect(capturedEvidence).toEqual({
      targetVersionIds: ['v1', 'v2'],
      versionChecksums: { v1: 'a'.repeat(64), v2: '' },
    });
  } finally {
    rmSync(storageDir, { recursive: true, force: true });
  }
});
