import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Data, Project, Version } from '@deploykit/shared';
import type { AppConfig } from '../../src/config';
import type { ProjectRepository } from '../../src/repositories/projectRepository';
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
  };
}

describe('createVersionService', () => {
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
    };
    let saved = false;
    const repo: ProjectRepository = {
      load: () => data,
      save: () => {
        saved = true;
      },
    };

    try {
      createVersionService(repo, config(storageDir)).publishVersion(
        'p1',
        'v1',
        'user-2'
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
    };
    const repo: ProjectRepository = {
      load: () => data,
      save: () => {},
    };

    try {
      createVersionService(repo, config(storageDir)).deleteVersion(
        'p1',
        'v1',
        'user-1'
      );

      expect(existsSync(deletedDir)).toBe(false);
      expect(existsSync(remainingDir)).toBe(true);
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });
});
