import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { Project } from '@deploykit/shared';
import { resolveDeployTarget } from '../../src/services/deployResolver';

const storageDir = join('/storage');
const projectId = 'proj-1';
const versionA = 'version-a'; // active
const versionB = 'version-b';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: projectId,
    name: 'P',
    slug: 'p',
    description: '',
    createdAt: '',
    updatedAt: '',
    versions: [
      { id: versionA, name: 'a', description: '', createdAt: '' },
      { id: versionB, name: 'b', description: '', createdAt: '' },
    ],
    activeVersionId: versionA,
    settings: { spaMode: false, routingType: 'path' },
    ...overrides,
  };
}

describe('resolveDeployTarget', () => {
  test('prefers an explicit version id in the path over the active version', () => {
    const target = resolveDeployTarget(storageDir, makeProject(), [
      'p',
      versionB,
      'index.html',
    ]);
    expect(target).toEqual({
      kind: 'resolved',
      absolutePath: join(storageDir, projectId, versionB, 'index.html'),
      fallbackIndexPath: null,
    });
  });

  test('falls back to the active version when no explicit id is given', () => {
    const target = resolveDeployTarget(storageDir, makeProject(), [
      'p',
      'index.html',
    ]);
    expect(target).toEqual({
      kind: 'resolved',
      absolutePath: join(storageDir, projectId, versionA, 'index.html'),
      fallbackIndexPath: null,
    });
  });

  test('appends index.html when the file path is empty', () => {
    const target = resolveDeployTarget(storageDir, makeProject(), ['p']);
    expect(target).toEqual({
      kind: 'resolved',
      absolutePath: join(storageDir, projectId, versionA, 'index.html'),
      fallbackIndexPath: null,
    });
  });

  test('returns forbidden for a path traversal attempt', () => {
    const target = resolveDeployTarget(storageDir, makeProject(), [
      'p',
      versionA,
      '..',
      '..',
      'secret',
    ]);
    expect(target).toEqual({ kind: 'forbidden' });
  });

  test('returns no-active when no explicit id is given and no version is active', () => {
    const project = makeProject({
      versions: [{ id: versionA, name: 'a', description: '', createdAt: '' }],
      activeVersionId: null,
    });
    const target = resolveDeployTarget(storageDir, project, [
      'p',
      'index.html',
    ]);
    expect(target).toEqual({ kind: 'no-active' });
  });

  test('sets a fallback index path in SPA mode', () => {
    const project = makeProject({
      settings: { spaMode: true, routingType: 'path' },
    });
    const target = resolveDeployTarget(storageDir, project, ['p', 'about']);
    expect(target).toEqual({
      kind: 'resolved',
      absolutePath: join(storageDir, projectId, versionA, 'about'),
      fallbackIndexPath: join(storageDir, projectId, versionA, 'index.html'),
    });
  });

  test('leaves the fallback path null when SPA mode is off', () => {
    const target = resolveDeployTarget(storageDir, makeProject(), [
      'p',
      'about',
    ]);
    expect(target).toEqual({
      kind: 'resolved',
      absolutePath: join(storageDir, projectId, versionA, 'about'),
      fallbackIndexPath: null,
    });
  });
});
