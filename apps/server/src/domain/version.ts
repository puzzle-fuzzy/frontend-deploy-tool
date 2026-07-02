import type { Project, Version } from '@deploykit/shared';

/**
 * Returns the `activeVersionId` to use after `deletedVersionId` is removed.
 * Deleting a non-active version leaves the active id untouched; deleting the
 * active version promotes the newest remaining version. Returns `null` when the
 * active version was the only version (nothing remains).
 */
export function chooseReplacementActiveVersionId(
  versions: Version[],
  deletedVersionId: string,
  activeVersionId: string | null
): string | null {
  if (deletedVersionId !== activeVersionId) return activeVersionId;

  const remaining = versions.filter(
    (version) => version.id !== deletedVersionId
  );
  return remaining.at(-1)?.id ?? null;
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
