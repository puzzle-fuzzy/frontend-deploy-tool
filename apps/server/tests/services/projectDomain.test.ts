import { describe, expect, test } from 'bun:test';
import type { HistoryEvent, Project } from '@deploykit/shared';
import { paginateHistory } from '../../src/domain/history';
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
    auditPolicy: {
      enforcement: 'advisory',
      maxTotalBytes: 50 * 1024 * 1024,
      maxFileBytes: 10 * 1024 * 1024,
      maxFileCount: 1_000,
    },
    createdBy: 'user-1',
    members: [],
    ...overrides,
  };
}

function makeHistoryEvent(id: string): HistoryEvent {
  return {
    id,
    action: 'project.update',
    projectId: 'p1',
    projectName: 'Demo',
    versionId: '',
    versionName: '',
    timestamp: `2026-07-24T00:00:${id.padStart(2, '0')}.000Z`,
    actorId: 'user-1',
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

describe('paginateHistory', () => {
  test('returns bounded pages and an opaque cursor only when older events exist', () => {
    const events = [
      makeHistoryEvent('3'),
      makeHistoryEvent('2'),
      makeHistoryEvent('1'),
    ];

    const first = paginateHistory(events, '2');
    expect(first?.items.map((event) => event.id)).toEqual(['3', '2']);
    expect(first?.nextCursor).toBeString();

    const second = paginateHistory(events, '2', first?.nextCursor ?? undefined);
    expect(second).toEqual({
      items: [events[2]],
      nextCursor: null,
    });
  });

  test('continues after the cursor when newer events are prepended', () => {
    const initial = [
      makeHistoryEvent('4'),
      makeHistoryEvent('3'),
      makeHistoryEvent('2'),
      makeHistoryEvent('1'),
    ];
    const first = paginateHistory(initial, '2');

    const withNewHead = [makeHistoryEvent('5'), ...initial];
    const second = paginateHistory(
      withNewHead,
      '2',
      first?.nextCursor ?? undefined
    );

    expect(second?.items.map((event) => event.id)).toEqual(['2', '1']);
    expect(second?.nextCursor).toBeNull();
  });

  test('rejects malformed, unknown, and expired cursors', () => {
    const events = [makeHistoryEvent('2'), makeHistoryEvent('1')];

    expect(paginateHistory(events, '1', 'not-a-cursor')).toBeUndefined();

    const expired = paginateHistory(
      [makeHistoryEvent('expired'), ...events],
      '1'
    )?.nextCursor;
    expect(expired).toBeString();
    expect(paginateHistory(events, '1', expired ?? undefined)).toBeUndefined();
  });
});
