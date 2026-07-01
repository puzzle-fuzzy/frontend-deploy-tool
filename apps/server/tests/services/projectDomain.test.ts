import { describe, expect, test } from 'bun:test';
import type { Project } from '@deploykit/shared';
import {
  DEFAULT_PROJECT_SETTINGS,
  isSlugUnique,
  isValidProjectSlug,
  parseSettings,
} from '../../src/domain/project';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Demo',
    slug: 'demo',
    description: '',
    createdAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-06-30T00:00:00.000Z',
    versions: [],
    activeVersionId: null,
    settings: { ...DEFAULT_PROJECT_SETTINGS },
    ...overrides,
  };
}

describe('project domain', () => {
  test('uses path routing with SPA fallback disabled by default', () => {
    expect(DEFAULT_PROJECT_SETTINGS).toEqual({
      spaMode: false,
      routingType: 'path',
    });
  });

  test('accepts valid project slugs', () => {
    expect(isValidProjectSlug('abc')).toBe(true);
    expect(isValidProjectSlug('demo-app')).toBe(true);
    expect(isValidProjectSlug('app-123')).toBe(true);
  });

  test('rejects invalid project slugs', () => {
    expect(isValidProjectSlug('ab')).toBe(false);
    expect(isValidProjectSlug('-demo')).toBe(false);
    expect(isValidProjectSlug('demo-')).toBe(false);
    expect(isValidProjectSlug('Demo')).toBe(false);
    expect(isValidProjectSlug('demo_app')).toBe(false);
    expect(isValidProjectSlug('demo app')).toBe(false);
    expect(isValidProjectSlug('a'.repeat(65))).toBe(false);
  });

  test('parseSettings accepts a valid settings payload', () => {
    expect(parseSettings({ spaMode: true, routingType: 'hash' })).toEqual({
      spaMode: true,
      routingType: 'hash',
    });
  });

  test('parseSettings rejects payloads with missing or invalid fields', () => {
    expect(parseSettings({ routingType: 'hash' })).toBeNull();
    expect(parseSettings({ spaMode: 'yes', routingType: 'hash' })).toBeNull();
    expect(parseSettings({ spaMode: true, routingType: 'memory' })).toBeNull();
    expect(parseSettings(null)).toBeNull();
    expect(parseSettings('not-an-object')).toBeNull();
  });
});

describe('isSlugUnique (slug-uniqueness invariant)', () => {
  test('returns true when no project uses the slug', () => {
    expect(isSlugUnique([], 'demo')).toBe(true);
    expect(isSlugUnique([makeProject({ slug: 'other' })], 'demo')).toBe(true);
  });

  test('returns false when an existing project already uses the slug', () => {
    const projects = [makeProject({ slug: 'demo' })];
    expect(isSlugUnique(projects, 'demo')).toBe(false);
  });

  test('compares slugs exactly (case-sensitive, no implicit normalization)', () => {
    expect(isSlugUnique([makeProject({ slug: 'demo' })], 'Demo')).toBe(true);
    expect(isSlugUnique([makeProject({ slug: 'demo' })], 'demo-')).toBe(true);
  });
});
