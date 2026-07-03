import { describe, expect, it } from 'vitest';
import { getUserAvatarUrl, getUserInitials } from '../../src/shared/avatar';

describe('getUserAvatarUrl', () => {
  it('returns a data URI for a given user id', () => {
    const url = getUserAvatarUrl('user-123');
    expect(url).toMatch(/^data:image\/svg\+xml;/u);
  });

  it('returns the same URL for the same seed', () => {
    const a = getUserAvatarUrl('user-123');
    const b = getUserAvatarUrl('user-123');
    expect(a).toBe(b);
  });

  it('returns different URLs for different seeds', () => {
    const a = getUserAvatarUrl('user-123');
    const b = getUserAvatarUrl('user-456');
    expect(a).not.toBe(b);
  });
});

describe('getUserInitials', () => {
  it('returns first 2 chars uppercased', () => {
    expect(getUserInitials('admin')).toBe('AD');
  });

  it('handles single-char names', () => {
    expect(getUserInitials('a')).toBe('A');
  });

  it('handles empty string', () => {
    expect(getUserInitials(''));
  });
});
