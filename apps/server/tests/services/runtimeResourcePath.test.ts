import { describe, expect, test } from 'bun:test';
import {
  findRuntimeResourceOverlap,
  type NamedRuntimeResource,
} from '../../src/utils/runtimeResourcePath';

describe('runtime resource path identity', () => {
  test('conservatively folds Darwin missing-path comparisons', () => {
    const resources: NamedRuntimeResource[] = [
      {
        name: 'database',
        path: '/srv/deploykit/storage/metadata.sqlite',
      },
      { name: 'storage', path: '/srv/deploykit/Storage' },
    ];

    expect(findRuntimeResourceOverlap(resources, 'darwin')).toEqual([
      'database',
      'storage',
    ]);
    expect(findRuntimeResourceOverlap(resources, 'linux')).toBeUndefined();
  });

  test('normalizes Darwin Unicode path aliases before comparison', () => {
    const resources: NamedRuntimeResource[] = [
      {
        name: 'database',
        path: '/srv/deploykit/cafe\u0301/metadata.sqlite',
      },
      { name: 'storage', path: '/srv/deploykit/caf\u00e9' },
    ];

    expect(findRuntimeResourceOverlap(resources, 'darwin')).toEqual([
      'database',
      'storage',
    ]);
    expect(findRuntimeResourceOverlap(resources, 'linux')).toBeUndefined();
  });

  for (const [left, right] of [
    ['SS', '\u00df'],
    ['\u03c3', '\u03c2'],
    ['\ufb00', 'ff'],
    ['\u017f', 's'],
  ]) {
    test(`uses Darwin full case-fold semantics for ${left}/${right}`, () => {
      const resources: NamedRuntimeResource[] = [
        {
          name: 'database',
          path: `/srv/deploykit/${left}/metadata.sqlite`,
        },
        { name: 'storage', path: `/srv/deploykit/${right}` },
      ];

      expect(findRuntimeResourceOverlap(resources, 'darwin')).toEqual([
        'database',
        'storage',
      ]);
      expect(findRuntimeResourceOverlap(resources, 'linux')).toBeUndefined();
    });
  }

  test('uses Windows path semantics and case-folding', () => {
    const resources: NamedRuntimeResource[] = [
      {
        name: 'database',
        path: 'C:\\DeployKit\\storage\\metadata.sqlite',
      },
      { name: 'storage', path: 'c:\\deploykit\\Storage' },
    ];

    expect(findRuntimeResourceOverlap(resources, 'win32')).toEqual([
      'database',
      'storage',
    ]);
  });

  test('rejects ancestor collisions between non-storage runtime files', () => {
    const resources: NamedRuntimeResource[] = [
      { name: 'database-lock', path: '/srv/deploykit/lock.sqlite' },
      {
        name: 'database-shm',
        path: '/srv/deploykit/lock.sqlite/metadata-shm',
      },
    ];

    expect(findRuntimeResourceOverlap(resources, 'linux')).toEqual([
      'database-lock',
      'database-shm',
    ]);
  });
});
