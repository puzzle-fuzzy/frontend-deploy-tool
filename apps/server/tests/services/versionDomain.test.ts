import { describe, expect, test } from 'bun:test';
import type { Version } from '@deploykit/shared';
import {
  activateVersion,
  chooseReplacementActiveVersionId,
} from '../../src/domain/version';

const versions: Version[] = [
  {
    id: 'version-a',
    name: 'a',
    description: '',
    createdAt: '2026-06-30T00:00:00.000Z',
    active: true,
  },
  {
    id: 'version-b',
    name: 'b',
    description: '',
    createdAt: '2026-06-30T00:01:00.000Z',
    active: false,
  },
];

describe('version domain', () => {
  test('activates exactly one known version', () => {
    const updated = activateVersion(versions, 'version-b');

    expect(updated).toEqual([
      expect.objectContaining({ id: 'version-a', active: false }),
      expect.objectContaining({ id: 'version-b', active: true }),
    ]);
  });

  test('returns null for unknown version activation', () => {
    expect(activateVersion(versions, 'missing-version')).toBeNull();
  });

  test('chooses newest remaining version when active version is deleted', () => {
    expect(chooseReplacementActiveVersionId(versions, 'version-a')).toBe(
      'version-b'
    );
  });

  test('keeps current active version when deleting inactive version', () => {
    expect(chooseReplacementActiveVersionId(versions, 'version-b')).toBe(
      'version-a'
    );
  });

  test('returns null when no replacement version remains', () => {
    expect(
      chooseReplacementActiveVersionId([versions[0]], 'version-a')
    ).toBeNull();
  });
});
