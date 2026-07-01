import { describe, expect, test } from 'bun:test';
import type { Project, Version } from '@deploykit/shared';
import { DEFAULT_PROJECT_SETTINGS } from '../../src/domain/project';
import {
  chooseReplacementActiveVersionId,
  findProjectVersion,
} from '../../src/domain/version';

const versions: Version[] = [
  {
    id: 'version-a',
    name: 'a',
    description: '',
    createdAt: '2026-06-30T00:00:00.000Z',
    size: 0,
    fileCount: 0,
    sourceType: 'unknown',
    status: 'production',
    publishedAt: null,
    publishedBy: null,
    checksum: '',
  },
  {
    id: 'version-b',
    name: 'b',
    description: '',
    createdAt: '2026-06-30T00:01:00.000Z',
    size: 0,
    fileCount: 0,
    sourceType: 'unknown',
    status: 'preview',
    publishedAt: null,
    publishedBy: null,
    checksum: '',
  },
];

function makeProject(ownedVersions: Version[] = versions): Project {
  return {
    id: 'proj-1',
    name: 'Demo',
    slug: 'demo',
    description: '',
    createdAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-06-30T00:00:00.000Z',
    versions: ownedVersions,
    activeVersionId: ownedVersions[0]?.id ?? null,
    settings: { ...DEFAULT_PROJECT_SETTINGS },
  };
}

describe('chooseReplacementActiveVersionId', () => {
  test('promotes the newest remaining version when the active version is deleted', () => {
    expect(
      chooseReplacementActiveVersionId(versions, 'version-a', 'version-a')
    ).toBe('version-b');
  });

  test('keeps the current active version when deleting an inactive version', () => {
    expect(
      chooseReplacementActiveVersionId(versions, 'version-b', 'version-a')
    ).toBe('version-a');
  });

  test('returns null when the active version was the only version', () => {
    expect(
      chooseReplacementActiveVersionId([versions[0]], 'version-a', 'version-a')
    ).toBeNull();
  });

  test('returns the active id unchanged when there is no active version', () => {
    expect(
      chooseReplacementActiveVersionId(versions, 'version-b', null)
    ).toBeNull();
  });
});

describe('findProjectVersion (version-belongs-to-one-project invariant)', () => {
  const project = makeProject();

  test('locates a version that belongs to the project', () => {
    expect(findProjectVersion(project, 'version-a')).toEqual(versions[0]);
    expect(findProjectVersion(project, 'version-b')).toEqual(versions[1]);
  });

  test('returns undefined for a version that does not belong to the project', () => {
    expect(findProjectVersion(project, 'version-x')).toBeUndefined();
    expect(findProjectVersion(makeProject([]), 'version-a')).toBeUndefined();
  });
});
