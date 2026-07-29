import type { Project, Version } from '@deploykit/shared';

/**
 * Optimistic concurrency precondition supplied by release callers. Requiring
 * the caller's observed active version prevents a stale browser/desktop tab
 * from silently overwriting a newer operator decision.
 */
export interface ReleaseCommand {
  expectedActiveVersionId: string | null;
}

/**
 * Enforces the release-state invariant: the active version is the only
 * production version; when there is no active version, all versions are preview
 * unless another lifecycle state (archived/failed) was explicitly set.
 */
export function syncProductionStatus(
  versions: Version[],
  activeVersionId: string | null
): Version[] {
  return versions.map((version) => {
    if (version.id === activeVersionId) {
      return { ...version, status: 'production' };
    }
    if (version.status === 'production') {
      return { ...version, status: 'preview' };
    }
    return version;
  });
}

/**
 * Domain invariant: a version always belongs to exactly one project. Versions
 * are nested under `project.versions` (never referenced by id alone across
 * projects), so the owning project is the only scope in which a version is
 * looked up. Returns the version or `undefined` if it does not belong to
 * `project`.
 */
export function findProjectVersion(
  project: Project,
  versionId: string
): Version | undefined {
  return project.versions.find((version) => version.id === versionId);
}
