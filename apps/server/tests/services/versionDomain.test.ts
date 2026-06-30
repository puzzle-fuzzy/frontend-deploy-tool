import { describe, expect, test } from 'bun:test';
import type { Version } from '@deploykit/shared';
import { chooseReplacementActiveVersionId } from '../../src/domain/version';

const versions: Version[] = [
  {
    id: 'version-a',
    name: 'a',
    description: '',
    createdAt: '2026-06-30T00:00:00.000Z',
  },
  {
    id: 'version-b',
    name: 'b',
    description: '',
    createdAt: '2026-06-30T00:01:00.000Z',
  },
];

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
