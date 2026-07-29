import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Data, Project, Version } from '@deploykit/shared';
import type { AppConfig } from '../../src/config';
import { ApiError, ErrorCode } from '../../src/errors';
import type { ProjectRepository } from '../../src/repositories/projectRepository';
import { checksumDirectory } from '../../src/services/artifactService';
import { createVersionService } from '../../src/services/versionService';

function version(id: string): Version {
  return {
    id,
    name: id,
    description: '',
    createdAt: '',
    size: 0,
    fileCount: 0,
    sourceType: 'unknown',
    status: 'preview',
    publishedAt: null,
    publishedBy: null,
    checksum: '',
    integrityStatus: 'unknown',
    integrityCheckedAt: null,
  };
}

function project(): Project {
  return {
    id: 'p1',
    name: 'Demo',
    slug: 'demo',
    description: '',
    createdAt: '',
    updatedAt: '',
    versions: [version('v1'), version('v2')],
    activeVersionId: 'v1',
    settings: { spaMode: false, routingType: 'hash' },
    auditPolicy: {
      enforcement: 'advisory',
      maxTotalBytes: 50 * 1024 * 1024,
      maxFileBytes: 10 * 1024 * 1024,
      maxFileCount: 1_000,
    },
    createdBy: 'user-1',
    members: [{ userId: 'user-1', role: 'owner', invitedAt: '' }],
  };
}

function config(storageDir: string): AppConfig {
  return {
    dataFile: '',
    storageDir,
    publicDir: '',
    adminEmail: 'admin@deploykit.local',
    adminPassword: '',
    secureCookies: false,
    registrationEnabled: true,
  };
}

function writeArtifact(
  storageDir: string,
  versionValue: Version,
  content = '<html>ready</html>'
): void {
  const versionDir = join(storageDir, 'p1', versionValue.id);
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(join(versionDir, 'index.html'), content);
  versionValue.checksum = checksumDirectory(versionDir);
}

describe('createVersionService', () => {
  test('promotes a validated upload from staging into its final directory', async () => {
    const storageDir = mkdtempSync(
      join(tmpdir(), 'deploykit-version-service-')
    );
    const demoProject = project();
    demoProject.versions = [];
    demoProject.activeVersionId = null;
    const data: Data = {
      schemaVersion: 5,
      projects: [demoProject],
      users: [],
      history: [],
      artifactAudits: [],
    };
    const repo: ProjectRepository = {
      load: () => data,
      save: () => {},
      mutate: (operation) => operation(data),
    };

    try {
      const result = await createVersionService(
        repo,
        config(storageDir)
      ).uploadVersion(
        'p1',
        {
          versionDesc: 'staged build',
          file: null,
          folderFiles: [new File(['<html>ready</html>'], 'index.html')],
        },
        'user-1'
      );

      expect(
        existsSync(join(storageDir, 'p1', result.version.id, 'index.html'))
      ).toBe(true);
      expect(existsSync(join(storageDir, '.staging', result.version.id))).toBe(
        false
      );
      expect(data.projects[0].versions[0].id).toBe(result.version.id);
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  test('cleans staging and final artifacts when metadata commit fails', async () => {
    const storageDir = mkdtempSync(
      join(tmpdir(), 'deploykit-version-service-')
    );
    const demoProject = project();
    demoProject.versions = [];
    demoProject.activeVersionId = null;
    const data: Data = {
      schemaVersion: 5,
      projects: [demoProject],
      users: [],
      history: [],
      artifactAudits: [],
    };
    const repo: ProjectRepository = {
      load: () => data,
      save: () => {},
      mutate: () => {
        throw new Error('metadata commit failed');
      },
    };

    try {
      await expect(
        createVersionService(repo, config(storageDir)).uploadVersion(
          'p1',
          {
            versionDesc: 'failed commit',
            file: null,
            folderFiles: [new File(['<html>ready</html>'], 'index.html')],
          },
          'user-1'
        )
      ).rejects.toThrow('metadata commit failed');

      const stagingRoot = join(storageDir, '.staging');
      expect(existsSync(stagingRoot) ? readdirSync(stagingRoot) : []).toEqual(
        []
      );
      const projectRoot = join(storageDir, 'p1');
      expect(existsSync(projectRoot) ? readdirSync(projectRoot) : []).toEqual(
        []
      );
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  test('rejects a transactionally over-quota upload and removes its artifact', async () => {
    const storageDir = mkdtempSync(
      join(tmpdir(), 'deploykit-version-service-')
    );
    const demoProject = project();
    demoProject.versions = [];
    demoProject.activeVersionId = null;
    const data: Data = {
      schemaVersion: 5,
      projects: [demoProject],
      users: [],
      history: [],
      artifactAudits: [],
    };
    const repo: ProjectRepository = {
      load: () => data,
      save: () => {},
      mutate: (operation) => operation(data),
    };

    try {
      await expect(
        createVersionService(repo, {
          ...config(storageDir),
          maxStorageSize: 1_000,
          maxStorageSizePerUser: 1_000,
          maxStorageSizePerProject: 1,
        }).uploadVersion(
          'p1',
          {
            versionDesc: 'over quota',
            file: null,
            folderFiles: [new File(['<html>ready</html>'], 'index.html')],
          },
          'user-1'
        )
      ).rejects.toMatchObject({
        code: ErrorCode.STORAGE_QUOTA_EXCEEDED,
        status: 413,
      });

      expect(data.projects[0].versions).toEqual([]);
      expect(data.history).toEqual([]);
      const projectRoot = join(storageDir, 'p1');
      expect(existsSync(projectRoot) ? readdirSync(projectRoot) : []).toEqual(
        []
      );
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  test('does not record history when promoting the already active version', () => {
    const storageDir = mkdtempSync(
      join(tmpdir(), 'deploykit-version-service-')
    );
    const activeVersion = version('v1');
    activeVersion.status = 'production';
    activeVersion.publishedAt = '2026-07-01T00:00:00.000Z';
    activeVersion.publishedBy = 'user-1';
    const demoProject = project();
    demoProject.versions = [activeVersion, version('v2')];
    demoProject.updatedAt = '2026-07-01T00:00:00.000Z';

    const data: Data = {
      schemaVersion: 1,
      projects: [demoProject],
      users: [],
      history: [],
      artifactAudits: [],
    };
    let saved = false;
    const repo: ProjectRepository = {
      load: () => data,
      save: () => {
        saved = true;
      },
      mutate: (operation) => operation(data),
    };

    try {
      writeArtifact(storageDir, activeVersion);
      createVersionService(repo, config(storageDir)).publishVersion(
        'p1',
        'v1',
        'user-2',
        { expectedActiveVersionId: 'v1' }
      );

      expect(saved).toBe(false);
      expect(data.history).toHaveLength(0);
      expect(activeVersion.publishedAt).toBe('2026-07-01T00:00:00.000Z');
      expect(activeVersion.publishedBy).toBe('user-1');
      expect(demoProject.updatedAt).toBe('2026-07-01T00:00:00.000Z');
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  test('removes artifact files when deleting a version', () => {
    const storageDir = mkdtempSync(
      join(tmpdir(), 'deploykit-version-service-')
    );
    const deletedDir = join(storageDir, 'p1', 'v1');
    const remainingDir = join(storageDir, 'p1', 'v2');
    mkdirSync(deletedDir, { recursive: true });
    mkdirSync(remainingDir, { recursive: true });
    writeFileSync(join(deletedDir, 'index.html'), '');
    writeFileSync(join(remainingDir, 'index.html'), '');

    const data: Data = {
      schemaVersion: 1,
      projects: [project()],
      users: [],
      history: [],
      artifactAudits: [],
    };
    const repo: ProjectRepository = {
      load: () => data,
      save: () => {},
      mutate: (operation) => operation(data),
    };

    try {
      createVersionService(repo, config(storageDir)).deleteVersion(
        'p1',
        'v1',
        'user-1'
      );

      expect(existsSync(deletedDir)).toBe(false);
      expect(existsSync(remainingDir)).toBe(true);
      const trashRoot = join(storageDir, '.recovery', 'trash');
      const operation = readdirSync(trashRoot)[0];
      expect(existsSync(join(trashRoot, operation, 'COMMITTED'))).toBe(true);
      expect(data.projects[0].activeVersionId).toBeNull();
      expect(data.projects[0].versions[0]?.status).toBe('preview');
      expect(data.history[0]?.metadata).toMatchObject({
        wasActive: true,
        previousActiveVersionId: 'v1',
        activeVersionId: null,
      });
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  test('restores version artifacts when metadata deletion fails', () => {
    const storageDir = mkdtempSync(
      join(tmpdir(), 'deploykit-version-service-')
    );
    const versionDir = join(storageDir, 'p1', 'v1');
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(join(versionDir, 'index.html'), 'ready');
    const data: Data = {
      schemaVersion: 5,
      projects: [project()],
      users: [],
      history: [],
      artifactAudits: [],
    };
    let absentDuringMutation = false;
    const repo: ProjectRepository = {
      load: () => data,
      save: () => {},
      mutate: () => {
        absentDuringMutation = !existsSync(versionDir);
        throw new Error('metadata delete failed');
      },
    };

    try {
      expect(() =>
        createVersionService(repo, config(storageDir)).deleteVersion(
          'p1',
          'v1',
          'user-1'
        )
      ).toThrow('metadata delete failed');
      expect(absentDuringMutation).toBe(true);
      expect(existsSync(join(versionDir, 'index.html'))).toBe(true);
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  test('rejects a stale release precondition without changing production', () => {
    const storageDir = mkdtempSync(
      join(tmpdir(), 'deploykit-version-service-')
    );
    const demoProject = project();
    writeArtifact(storageDir, demoProject.versions[1]);
    const data: Data = {
      schemaVersion: 5,
      projects: [demoProject],
      users: [],
      history: [],
      artifactAudits: [],
    };
    const repo: ProjectRepository = {
      load: () => data,
      save: () => {},
      mutate: (operation) => operation(data),
    };

    try {
      expect(() =>
        createVersionService(repo, config(storageDir)).publishVersion(
          'p1',
          'v2',
          'user-1',
          { expectedActiveVersionId: null }
        )
      ).toThrow(
        new ApiError(
          ErrorCode.RELEASE_CONFLICT,
          'The active version changed; refresh before releasing',
          409
        )
      );
      expect(demoProject.activeVersionId).toBe('v1');
      expect(data.history).toHaveLength(0);
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  test('rejects failed and archived versions as publish targets', () => {
    for (const status of ['failed', 'archived'] as const) {
      const storageDir = mkdtempSync(
        join(tmpdir(), 'deploykit-version-service-')
      );
      const demoProject = project();
      demoProject.activeVersionId = null;
      demoProject.versions = [version('blocked')];
      demoProject.versions[0].status = status;
      writeArtifact(storageDir, demoProject.versions[0]);
      const data: Data = {
        schemaVersion: 5,
        projects: [demoProject],
        users: [],
        history: [],
        artifactAudits: [],
      };
      const repo: ProjectRepository = {
        load: () => data,
        save: () => {},
        mutate: (operation) => operation(data),
      };

      try {
        expect(() =>
          createVersionService(repo, config(storageDir)).publishVersion(
            'p1',
            'blocked',
            'user-1',
            { expectedActiveVersionId: null }
          )
        ).toThrow('Version is not publishable');
        expect(demoProject.activeVersionId).toBeNull();
      } finally {
        rmSync(storageDir, { recursive: true, force: true });
      }
    }
  });

  test('rejects missing or corrupted artifacts before publication', () => {
    for (const scenario of ['missing', 'corrupted'] as const) {
      const storageDir = mkdtempSync(
        join(tmpdir(), 'deploykit-version-service-')
      );
      const demoProject = project();
      demoProject.activeVersionId = null;
      demoProject.versions = [version('candidate')];
      if (scenario === 'corrupted') {
        writeArtifact(storageDir, demoProject.versions[0]);
        writeFileSync(
          join(storageDir, 'p1', 'candidate', 'index.html'),
          '<html>tampered</html>'
        );
      }
      const data: Data = {
        schemaVersion: 5,
        projects: [demoProject],
        users: [],
        history: [],
        artifactAudits: [],
      };
      const repo: ProjectRepository = {
        load: () => data,
        save: () => {},
        mutate: (operation) => operation(data),
      };

      try {
        expect(() =>
          createVersionService(repo, config(storageDir)).publishVersion(
            'p1',
            'candidate',
            'user-1',
            { expectedActiveVersionId: null }
          )
        ).toThrow(
          scenario === 'missing'
            ? 'Upload must contain an index.html at its root'
            : 'Artifact checksum verification failed'
        );
        expect(demoProject.activeVersionId).toBeNull();
      } finally {
        rmSync(storageDir, { recursive: true, force: true });
      }
    }
  });
});
