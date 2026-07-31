import { describe, expect, test } from 'bun:test';
import type { Project, Version } from '@deploykit/shared';
import { DEFAULT_PROJECT_SETTINGS } from '../../src/domain/project';
import {
  findProjectVersion,
  syncProductionStatus,
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
    integrityStatus: 'unknown',
    integrityCheckedAt: null,
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
    integrityStatus: 'unknown',
    integrityCheckedAt: null,
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
    members: [
      {
        userId: 'user-1',
        role: 'owner',
        invitedAt: '2026-06-30T00:00:00.000Z',
      },
    ],
  };
}

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

describe('syncProductionStatus', () => {
  test('marks only the active version as production', () => {
    const next = syncProductionStatus(versions, 'version-b');
    expect(next.map((version) => [version.id, version.status])).toEqual([
      ['version-a', 'preview'],
      ['version-b', 'production'],
    ]);
  });

  test('clears production status when there is no active version', () => {
    const next = syncProductionStatus(versions, null);
    expect(next.map((version) => [version.id, version.status])).toEqual([
      ['version-a', 'preview'],
      ['version-b', 'preview'],
    ]);
  });
});
