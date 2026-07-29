import { join } from 'node:path';
import type { Project } from '@deploykit/shared';
import { safeJoin } from '../utils/safePath';

export type DeployTarget =
  | { kind: 'no-active' }
  | { kind: 'forbidden' }
  | {
      kind: 'resolved';
      absolutePath: string;
      /** Path to `index.html` to try when the primary file is missing (SPA mode). */
      fallbackIndexPath: string | null;
      /** Active aliases can move; explicit version paths are immutable. */
      cacheScope: 'active' | 'version';
    };

/**
 * Resolves a `/deploy/<slug>/<path>` request (already split into `parts`) to a
 * safe artifact path. Picks an explicit `parts[1]` version id when it matches a
 * real version, otherwise the active version. Returns `no-active` when no
 * version can be chosen and `forbidden` on path traversal. File-existence checks
 * are left to the caller; `fallbackIndexPath` is set only in SPA mode.
 */
export function resolveDeployTarget(
  storageDir: string,
  project: Project,
  parts: string[]
): DeployTarget {
  let versionId: string;
  let filePath: string;
  let cacheScope: 'active' | 'version';

  if (parts.length >= 2 && project.versions.some((v) => v.id === parts[1])) {
    versionId = parts[1];
    filePath = parts.slice(2).join('/');
    cacheScope = 'version';
  } else {
    const active = project.versions.find(
      (v) => v.id === project.activeVersionId
    );
    if (!active) return { kind: 'no-active' };
    versionId = active.id;
    filePath = parts.slice(1).join('/');
    cacheScope = 'active';
  }

  if (!filePath || filePath.endsWith('/')) filePath += 'index.html';

  const versionRoot = join(storageDir, project.id, versionId);
  const absolutePath = safeJoin(versionRoot, filePath);
  if (!absolutePath) return { kind: 'forbidden' };

  const fallbackIndexPath = project.settings.spaMode
    ? join(versionRoot, 'index.html')
    : null;

  return { kind: 'resolved', absolutePath, fallbackIndexPath, cacheScope };
}
