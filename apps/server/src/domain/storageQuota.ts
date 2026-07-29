import type { Data } from '@deploykit/shared';

export const DEFAULT_STORAGE_QUOTA_LIMITS: StorageQuotaLimits = {
  global: 20 * 1024 * 1024 * 1024,
  perUser: 10 * 1024 * 1024 * 1024,
  perProject: 5 * 1024 * 1024 * 1024,
};

export interface StorageQuotaLimits {
  global: number;
  perUser: number;
  perProject: number;
}

export interface StorageUsage {
  global: number;
  user: number;
  project: number;
  accountableUserId: string;
}

export interface StorageQuotaViolation {
  scope: 'project' | 'user' | 'global';
  used: number;
  pending: number;
  limit: number;
  accountableUserId: string;
}

/**
 * Storage is charged to the project's creator. Project ownership transfers do
 * not silently reassign historical storage; that requires a future explicit
 * billing/ownership operation.
 */
export function getStorageUsage(data: Data, projectId: string): StorageUsage {
  const project = data.projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new Error(`Unknown project ${projectId}`);

  const sizeOf = (versions: typeof project.versions) =>
    versions.reduce((total, version) => total + version.size, 0);
  const accountableUserId = project.createdBy;
  return {
    global: data.projects.reduce(
      (total, candidate) => total + sizeOf(candidate.versions),
      0
    ),
    user: data.projects
      .filter((candidate) => candidate.createdBy === accountableUserId)
      .reduce((total, candidate) => total + sizeOf(candidate.versions), 0),
    project: sizeOf(project.versions),
    accountableUserId,
  };
}

export function findStorageQuotaViolation(
  data: Data,
  projectId: string,
  pending: number,
  limits: StorageQuotaLimits
): StorageQuotaViolation | null {
  const usage = getStorageUsage(data, projectId);
  const candidates = [
    ['project', usage.project, limits.perProject],
    ['user', usage.user, limits.perUser],
    ['global', usage.global, limits.global],
  ] as const;

  for (const [scope, used, limit] of candidates) {
    if (used + pending > limit) {
      return {
        scope,
        used,
        pending,
        limit,
        accountableUserId: usage.accountableUserId,
      };
    }
  }
  return null;
}
