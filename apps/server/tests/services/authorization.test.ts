import { describe, expect, test } from 'bun:test';
import type { Project, SafeUser } from '@deploykit/shared';
import {
  canCreateProject,
  canReadProject,
  hasProjectRole,
} from '../../src/domain/authorization';

function user(id: string, role: SafeUser['role']): SafeUser {
  return {
    id,
    role,
    name: id,
    email: `${id}@example.test`,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
  };
}

const project: Project = {
  id: 'project-1',
  name: 'Demo',
  slug: 'demo',
  description: '',
  createdAt: '2026-07-30T00:00:00.000Z',
  updatedAt: '2026-07-30T00:00:00.000Z',
  versions: [],
  activeVersionId: null,
  settings: { spaMode: false, routingType: 'hash' },
  auditPolicy: {
    enforcement: 'advisory',
    maxTotalBytes: 50 * 1024 * 1024,
    maxFileBytes: 10 * 1024 * 1024,
    maxFileCount: 1_000,
  },
  createdBy: 'owner',
  members: [
    {
      userId: 'owner',
      role: 'owner',
      invitedAt: '2026-07-30T00:00:00.000Z',
    },
    {
      userId: 'member',
      role: 'member',
      invitedAt: '2026-07-30T00:00:00.000Z',
    },
  ],
};

describe('project authorization policy', () => {
  test('scopes reads to admins and project members', () => {
    expect(canReadProject(user('admin', 'admin'), project)).toBe(true);
    expect(canReadProject(user('owner', 'developer'), project)).toBe(true);
    expect(canReadProject(user('member', 'viewer'), project)).toBe(true);
    expect(canReadProject(user('stranger', 'developer'), project)).toBe(false);
  });

  test('allows only developers and admins to create projects', () => {
    expect(canCreateProject(user('admin', 'admin'))).toBe(true);
    expect(canCreateProject(user('developer', 'developer'))).toBe(true);
    expect(canCreateProject(user('viewer', 'viewer'))).toBe(false);
  });

  test('requires a global write role in addition to project membership', () => {
    expect(hasProjectRole(user('admin', 'admin'), project, 'owner')).toBe(true);
    expect(hasProjectRole(user('owner', 'developer'), project, 'owner')).toBe(
      true
    );
    expect(hasProjectRole(user('member', 'developer'), project, 'member')).toBe(
      true
    );
    expect(hasProjectRole(user('member', 'developer'), project, 'owner')).toBe(
      false
    );
    expect(hasProjectRole(user('member', 'viewer'), project, 'member')).toBe(
      false
    );
  });
});
