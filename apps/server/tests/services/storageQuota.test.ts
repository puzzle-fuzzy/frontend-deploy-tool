import { describe, expect, test } from 'bun:test';
import type { Data, Project, Version } from '@deploykit/shared';
import {
  findStorageQuotaViolation,
  getStorageUsage,
  type StorageQuotaLimits,
} from '../../src/domain/storageQuota';

const limits: StorageQuotaLimits = {
  global: 1_000,
  perUser: 600,
  perProject: 400,
};

function version(id: string, size: number): Version {
  return {
    id,
    name: id,
    description: '',
    createdAt: '',
    size,
    fileCount: 1,
    sourceType: 'folder',
    status: 'preview',
    publishedAt: null,
    publishedBy: null,
    checksum: '',
    integrityStatus: 'unknown',
    integrityCheckedAt: null,
  };
}

function project(id: string, createdBy: string, sizes: number[]): Project {
  return {
    id,
    name: id,
    slug: id,
    description: '',
    createdAt: '',
    updatedAt: '',
    versions: sizes.map((size, index) => version(`${id}-${index}`, size)),
    activeVersionId: null,
    settings: { spaMode: false, routingType: 'hash' },
    auditPolicy: {
      enforcement: 'advisory',
      maxTotalBytes: 50 * 1024 * 1024,
      maxFileBytes: 10 * 1024 * 1024,
      maxFileCount: 1_000,
    },
    createdBy,
    members: [{ userId: createdBy, role: 'owner', invitedAt: '' }],
  };
}

function data(): Data {
  return {
    schemaVersion: 5,
    projects: [
      project('p1', 'owner-1', [100, 150]),
      project('p2', 'owner-1', [200]),
      project('p3', 'owner-2', [300]),
    ],
    users: [],
    history: [],
    artifactAudits: [],
    artifactAuditJobs: [],
  };
}

describe('storage quota', () => {
  test('calculates global, accountable-user, and project usage', () => {
    expect(getStorageUsage(data(), 'p1')).toEqual({
      global: 750,
      user: 450,
      project: 250,
      accountableUserId: 'owner-1',
    });
  });

  test('allows an upload exactly on every configured boundary', () => {
    expect(
      findStorageQuotaViolation(data(), 'p1', 150, {
        global: 900,
        perUser: 600,
        perProject: 400,
      })
    ).toBeNull();
  });

  test('reports project quota before broader quota failures', () => {
    expect(findStorageQuotaViolation(data(), 'p1', 151, limits)).toEqual({
      scope: 'project',
      used: 250,
      pending: 151,
      limit: 400,
      accountableUserId: 'owner-1',
    });
  });

  test('reports accountable-user quota without counting collaborators', () => {
    const current = data();
    current.projects[2].members.push({
      userId: 'owner-1',
      role: 'member',
      invitedAt: '',
    });

    expect(
      findStorageQuotaViolation(current, 'p1', 151, {
        ...limits,
        perProject: 1_000,
      })
    ).toEqual({
      scope: 'user',
      used: 450,
      pending: 151,
      limit: 600,
      accountableUserId: 'owner-1',
    });
  });

  test('reports global quota after narrower quotas pass', () => {
    expect(
      findStorageQuotaViolation(data(), 'p1', 251, {
        global: 1_000,
        perUser: 2_000,
        perProject: 2_000,
      })
    ).toEqual({
      scope: 'global',
      used: 750,
      pending: 251,
      limit: 1_000,
      accountableUserId: 'owner-1',
    });
  });
});
