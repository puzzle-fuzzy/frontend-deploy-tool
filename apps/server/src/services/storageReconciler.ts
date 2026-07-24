import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { appendHistoryEvent } from '../domain/history';
import type { ProjectRepository } from '../repositories/projectRepository';

export interface StorageReconciliationReport {
  removedStagingEntries: number;
  quarantinedOrphanVersions: number;
  markedFailedVersions: number;
  deactivatedProjects: number;
}

const EMPTY_REPORT: StorageReconciliationReport = {
  removedStagingEntries: 0,
  quarantinedOrphanVersions: 0,
  markedFailedVersions: 0,
  deactivatedProjects: 0,
};

/**
 * Reconciles DeployKit-owned artifact storage against metadata before serving
 * requests. The metadata document remains authoritative:
 *
 * - incomplete staging work and legacy root ZIP temporaries are deleted;
 * - artifact directories not referenced by metadata are quarantined;
 * - referenced versions without a root index.html are marked failed;
 * - a missing active artifact deactivates the project without auto-promoting.
 */
export function reconcileStorage(
  repo: ProjectRepository,
  storageDir: string
): StorageReconciliationReport {
  mkdirSync(storageDir, { recursive: true });
  const report = { ...EMPTY_REPORT };
  const stagingRoot = join(storageDir, '.staging');
  const orphanRecoveryRoot = join(storageDir, '.recovery', 'orphans');

  if (existsSync(stagingRoot)) {
    report.removedStagingEntries = readdirSync(stagingRoot).length;
    rmSync(stagingRoot, { recursive: true, force: true });
  }

  const snapshot = repo.load();
  const projectsById = new Map(
    snapshot.projects.map((project) => [project.id, project])
  );

  for (const entry of readdirSync(storageDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const entryPath = join(storageDir, entry.name);

    if (entry.isFile() && entry.name.endsWith('.zip')) {
      rmSync(entryPath, { force: true });
      report.removedStagingEntries += 1;
      continue;
    }
    if (!entry.isDirectory()) continue;

    const project = projectsById.get(entry.name);
    if (!project) {
      report.quarantinedOrphanVersions += countChildDirectories(entryPath);
      quarantinePath(entryPath, join(orphanRecoveryRoot, entry.name));
      continue;
    }

    const versionIds = new Set(project.versions.map((version) => version.id));
    for (const versionEntry of readdirSync(entryPath, {
      withFileTypes: true,
    })) {
      if (versionEntry.isDirectory() && !versionIds.has(versionEntry.name)) {
        quarantinePath(
          join(entryPath, versionEntry.name),
          join(orphanRecoveryRoot, project.id, versionEntry.name)
        );
        report.quarantinedOrphanVersions += 1;
      }
    }
  }

  const requiresMetadataRepair = snapshot.projects.some((project) =>
    project.versions.some(
      (version) =>
        !existsSync(join(storageDir, project.id, version.id, 'index.html')) &&
        (version.status !== 'failed' || project.activeVersionId === version.id)
    )
  );
  if (!requiresMetadataRepair) return report;

  repo.mutate((data) => {
    const now = new Date().toISOString();
    for (const project of data.projects) {
      for (const version of project.versions) {
        const hasEntryPoint = existsSync(
          join(storageDir, project.id, version.id, 'index.html')
        );
        if (hasEntryPoint) continue;

        const wasActive = project.activeVersionId === version.id;
        if (wasActive) {
          project.activeVersionId = null;
          project.updatedAt = now;
          report.deactivatedProjects += 1;
        }
        if (version.status === 'failed') continue;

        version.status = 'failed';
        project.updatedAt = now;
        appendHistoryEvent(
          data,
          'version.reconcile',
          project,
          'system',
          version,
          {
            reason: 'artifact_missing',
            wasActive,
          }
        );
        report.markedFailedVersions += 1;
      }
    }
  });

  return report;
}

function countChildDirectories(path: string): number {
  return readdirSync(path, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory()
  ).length;
}

function quarantinePath(source: string, preferredTarget: string): void {
  mkdirSync(dirname(preferredTarget), { recursive: true });
  let target = preferredTarget;
  let suffix = 1;
  while (existsSync(target)) {
    target = `${preferredTarget}-${suffix}`;
    suffix += 1;
  }
  renameSync(source, target);
}
