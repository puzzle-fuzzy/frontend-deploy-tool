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
import { createArtifactRecoveryService } from '../../src/services/artifactRecovery';
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
    projects: [
      {
        id: 'project-1',
        name: 'Demo',
        slug: 'demo',
        description: '',
        createdAt: '',
        updatedAt: '',
        versions: [],
        activeVersionId: null,
        settings: { spaMode: false, routingType: 'path' },
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

  try {
    const service = createProjectService(repository, {
      artifactRecovery: createArtifactRecoveryService(storageDir),
    });
    expect(() => service.deleteProject('project-1', 'user-1')).toThrow(
      'metadata delete failed'
    );
    expect(absentDuringMutation).toBe(true);
    expect(existsSync(join(projectDir, 'index.html'))).toBe(true);
  } finally {
    rmSync(storageDir, { recursive: true, force: true });
  }
});
