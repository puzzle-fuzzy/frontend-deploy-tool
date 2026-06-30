import type { Version } from '@deploykit/shared';

export function activateVersion(
  versions: Version[],
  versionId: string
): Version[] | null {
  if (!versions.some((version) => version.id === versionId)) return null;

  return versions.map((version) => ({
    ...version,
    active: version.id === versionId,
  }));
}

export function chooseReplacementActiveVersionId(
  versions: Version[],
  deletedVersionId: string
): string | null {
  const deletedVersion = versions.find(
    (version) => version.id === deletedVersionId
  );
  if (!deletedVersion)
    return versions.find((version) => version.active)?.id ?? null;
  if (!deletedVersion.active)
    return versions.find((version) => version.active)?.id ?? null;

  const remainingVersions = versions.filter(
    (version) => version.id !== deletedVersionId
  );
  return remainingVersions.at(-1)?.id ?? null;
}
