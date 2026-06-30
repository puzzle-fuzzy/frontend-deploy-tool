import type { Version } from '@deploykit/shared';

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
