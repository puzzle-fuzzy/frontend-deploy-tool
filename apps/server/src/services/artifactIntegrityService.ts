import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { IntegrityStatus } from '@deploykit/shared';
import { appendHistoryEvent } from '../domain/history';
import { findProjectVersion } from '../domain/version';
import { ApiError, ErrorCode } from '../errors';
import type { ProjectRepository } from '../repositories/projectRepository';
import { checksumDirectory } from './artifactService';

export interface ArtifactIntegrityReport {
  projectId: string;
  versionId: string;
  status: Exclude<IntegrityStatus, 'unknown'>;
  checkedAt: string;
  expectedChecksum: string;
  actualChecksum: string | null;
  entrypointPresent: boolean;
}

export interface ArtifactIntegrityService {
  inspectVersion(
    projectId: string,
    versionId: string,
    actorId: string
  ): ArtifactIntegrityReport;
}

/**
 * Explicitly hashes one stored artifact tree outside the metadata transaction,
 * then applies the result only if the expected checksum is still current.
 */
export function createArtifactIntegrityService(
  repo: ProjectRepository,
  storageDir: string
): ArtifactIntegrityService {
  return {
    inspectVersion(projectId, versionId, actorId) {
      const snapshot = repo.load();
      const project = snapshot.projects.find(
        (candidate) => candidate.id === projectId
      );
      if (!project)
        throw new ApiError(
          ErrorCode.PROJECT_NOT_FOUND,
          'Project not found',
          404
        );
      const version = findProjectVersion(project, versionId);
      if (!version)
        throw new ApiError(
          ErrorCode.VERSION_NOT_FOUND,
          'Version not found',
          404
        );

      const expectedChecksum = version.checksum;
      const artifactDir = join(storageDir, projectId, versionId);
      const entrypointPresent = existsSync(join(artifactDir, 'index.html'));
      const actualChecksum = entrypointPresent
        ? checksumDirectory(artifactDir)
        : null;
      const status: ArtifactIntegrityReport['status'] = !entrypointPresent
        ? 'missing'
        : expectedChecksum === '' || expectedChecksum === actualChecksum
          ? 'verified'
          : 'corrupted';
      const checkedAt = new Date().toISOString();

      repo.mutate((data) => {
        const currentProject = data.projects.find(
          (candidate) => candidate.id === projectId
        );
        if (!currentProject)
          throw new ApiError(
            ErrorCode.PROJECT_NOT_FOUND,
            'Project not found',
            404
          );
        const currentVersion = findProjectVersion(currentProject, versionId);
        if (!currentVersion)
          throw new ApiError(
            ErrorCode.VERSION_NOT_FOUND,
            'Version not found',
            404
          );
        if (currentVersion.checksum !== expectedChecksum) {
          throw new ApiError(
            ErrorCode.RELEASE_CONFLICT,
            'Version metadata changed during integrity inspection',
            409
          );
        }

        const wasActive = currentProject.activeVersionId === versionId;
        currentVersion.integrityStatus = status;
        currentVersion.integrityCheckedAt = checkedAt;
        if (status === 'verified') {
          if (currentVersion.checksum === '' && actualChecksum) {
            currentVersion.checksum = actualChecksum;
          }
          if (currentVersion.status === 'failed') {
            currentVersion.status = 'preview';
          }
        } else {
          currentVersion.status = 'failed';
          if (wasActive) currentProject.activeVersionId = null;
        }
        currentProject.updatedAt = checkedAt;
        appendHistoryEvent(
          data,
          'version.reconcile',
          currentProject,
          actorId,
          currentVersion,
          {
            reason: `integrity_${status}`,
            expectedChecksum,
            actualChecksum,
            entrypointPresent,
            wasActive,
          }
        );
      });

      return {
        projectId,
        versionId,
        status,
        checkedAt,
        expectedChecksum,
        actualChecksum,
        entrypointPresent,
      };
    },
  };
}
