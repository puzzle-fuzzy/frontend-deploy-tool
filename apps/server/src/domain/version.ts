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
