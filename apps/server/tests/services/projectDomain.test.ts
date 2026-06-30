import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PROJECT_SETTINGS,
  isValidProjectSlug,
  parseSettings,
} from '../../src/domain/project';

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
