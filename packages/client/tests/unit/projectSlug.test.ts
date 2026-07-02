import { describe, expect, it } from 'vitest';
import { normalizeProjectSlugInput } from '@/features/projects/slug';

describe('normalizeProjectSlugInput', () => {
  it('lowercases and keeps only slug-safe characters', () => {
    expect(normalizeProjectSlugInput('My_App 01--测试')).toBe('myapp01--');
  });
});
