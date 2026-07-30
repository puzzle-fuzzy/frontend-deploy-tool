import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  HistoryAction,
  Version,
  VersionSourceType,
} from '@deploykit/shared';
import type { AppConfig } from '../config';
import { assertArtifactAuditAllowsRelease } from '../domain/artifactAudit';
import { appendHistoryEvent } from '../domain/history';
import {
  DEFAULT_STORAGE_QUOTA_LIMITS,
  findStorageQuotaViolation,
} from '../domain/storageQuota';
import type { ReleaseCommand } from '../domain/version';
import { findProjectVersion, syncProductionStatus } from '../domain/version';
import { ApiError, ErrorCode } from '../errors';
import type { ProjectRepository } from '../repositories/projectRepository';
import { createId } from '../utils/id';
import {
  type ArtifactRecoveryService,
  createArtifactRecoveryService,
} from './artifactRecovery';
import {
  assertIndexHtml,
  checksumDirectory,
  countFiles,
  extractZip,
  flattenOutput,
  getDirectorySize,
  removeDir,
  writeFolderFiles,
} from './artifactService';
import type { VersionService } from './contracts';
import {
  assertStorageMutationPathsAreSafe,
  StoragePathConflictError,
} from './storagePathSafety';

export type { UploadVersionInput, VersionService } from './contracts';

export function createVersionService(
  repo: ProjectRepository,
  config: AppConfig,
  options: { artifactRecovery?: ArtifactRecoveryService } = {}
): VersionService {
  const artifactRecovery =
    options.artifactRecovery ??
    createArtifactRecoveryService(config.storageDir);
  const storageQuotaLimits = {
    global: config.maxStorageSize ?? DEFAULT_STORAGE_QUOTA_LIMITS.global,
    perUser:
      config.maxStorageSizePerUser ?? DEFAULT_STORAGE_QUOTA_LIMITS.perUser,
    perProject:
      config.maxStorageSizePerProject ??
      DEFAULT_STORAGE_QUOTA_LIMITS.perProject,
  };
  const promoteVersion = (
    projectId: string,
    versionId: string,
    actorId: string,
    command: ReleaseCommand,
    action: Extract<
      HistoryAction,
      'version.publish' | 'version.activate' | 'version.rollback'
    >
  ) => {
    const snapshot = repo.load();
    const snapshotProject = snapshot.projects.find(
      (project) => project.id === projectId
    );
    if (!snapshotProject)
      throw new ApiError(ErrorCode.PROJECT_NOT_FOUND, 'Project not found', 404);
    const snapshotVersion = findProjectVersion(snapshotProject, versionId);
    if (!snapshotVersion)
      throw new ApiError(ErrorCode.VERSION_NOT_FOUND, 'Version not found', 404);
    if (snapshotProject.activeVersionId !== command.expectedActiveVersionId) {
      throw new ApiError(
        ErrorCode.RELEASE_CONFLICT,
        'The active version changed; refresh before releasing',
        409
      );
    }
    if (
      snapshotVersion.status !== 'preview' &&
      snapshotVersion.status !== 'production'
    ) {
      throw new ApiError(
        ErrorCode.INVALID_REQUEST,
        'Version is not publishable'
      );
    }
    assertArtifactAuditAllowsRelease(
      snapshot,
      snapshotProject,
      snapshotVersion
    );

    const versionDir = join(config.storageDir, projectId, versionId);
    assertIndexHtml(versionDir);
    if (checksumDirectory(versionDir) !== snapshotVersion.checksum) {
      throw new ApiError(
        ErrorCode.FILE_PROCESSING_FAILED,
        'Artifact checksum verification failed',
        500
      );
    }

    repo.mutate((data) => {
      const project = data.projects.find((p) => p.id === projectId);
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

      const previousActiveVersionId = project.activeVersionId;
      if (previousActiveVersionId !== command.expectedActiveVersionId) {
        throw new ApiError(
          ErrorCode.RELEASE_CONFLICT,
          'The active version changed; refresh before releasing',
          409
        );
      }
      if (version.status !== 'preview' && version.status !== 'production') {
        throw new ApiError(
          ErrorCode.INVALID_REQUEST,
          'Version is not publishable'
        );
      }
      assertArtifactAuditAllowsRelease(data, project, version);
      if (previousActiveVersionId === version.id) return;

      const publishedAt = new Date().toISOString();
      project.activeVersionId = version.id;
      project.versions = syncProductionStatus(project.versions, version.id);
      const publishedVersion = findProjectVersion(project, version.id);
      if (publishedVersion) {
        publishedVersion.publishedAt = publishedAt;
        publishedVersion.publishedBy = actorId;
      }
      project.updatedAt = publishedAt;
      appendHistoryEvent(data, action, project, actorId, version, {
        previousActiveVersionId,
      });
    });
  };

  return {
    async uploadVersion(
      projectId,
      { versionDesc, file, folderFiles },
      actorId
    ) {
      if (!repo.load().projects.some((project) => project.id === projectId))
        throw new ApiError(
          ErrorCode.PROJECT_NOT_FOUND,
          'Project not found',
          404
        );

      const versionId = createId();
      const versionName = versionId.substring(0, 7);
      const stagingRoot = join(config.storageDir, '.staging');
      const stagingDir = join(stagingRoot, versionId);
      const versionDir = join(config.storageDir, projectId, versionId);
      const projectDir = join(config.storageDir, projectId);

      let sourceType: VersionSourceType = 'unknown';
      let promotedToFinal = false;
      let version: Version | undefined;
      try {
        assertStorageMutationPathsAreSafe(
          config.storageDir,
          stagingRoot,
          stagingDir,
          versionDir
        );
        mkdirSync(stagingDir, { recursive: true });
        assertStorageMutationPathsAreSafe(
          config.storageDir,
          stagingRoot,
          stagingDir,
          versionDir
        );

        // Check file count limit
        if (config.maxFileCount && folderFiles.length > config.maxFileCount) {
          throw new ApiError(
            ErrorCode.TOO_MANY_FILES,
            `Too many files. Maximum ${config.maxFileCount} files allowed.`
          );
        }

        if (file && file.size > 0 && file.name.endsWith('.zip')) {
          sourceType = 'zip';
          // Check ZIP size limit
          if (config.maxZipSize && file.size > config.maxZipSize) {
            throw new ApiError(
              ErrorCode.ZIP_TOO_LARGE,
              `ZIP file too large. Maximum size is ${config.maxZipSize / (1024 * 1024)}MB.`
            );
          }

          const zipPath = join(stagingDir, 'upload.zip');
          let zipCleanupNeeded = true;
          let zipFailed = false;
          let zipFailure: unknown;
          let zipCleanupFailure: unknown;

          try {
            assertStorageMutationPathsAreSafe(
              config.storageDir,
              stagingDir,
              zipPath
            );
            await Bun.write(zipPath, file);
            assertStorageMutationPathsAreSafe(
              config.storageDir,
              stagingDir,
              zipPath
            );
            await extractZip(zipPath, stagingDir, {
              maxExtractedSize: config.maxExtractedSize,
              maxFileCount: config.maxFileCount,
              maxPathLength: config.maxPathLength,
              maxCompressionRatio: config.maxCompressionRatio,
            });
            assertStorageMutationPathsAreSafe(
              config.storageDir,
              stagingDir,
              zipPath
            );
            rmSync(zipPath, { force: true });
            zipCleanupNeeded = false;

            // Check extracted size limit
            if (config.maxExtractedSize) {
              assertStorageMutationPathsAreSafe(config.storageDir, stagingDir);
              const extractedSize = getDirectorySize(stagingDir);
              if (extractedSize > config.maxExtractedSize) {
                throw new ApiError(
                  ErrorCode.EXTRACTED_TOO_LARGE,
                  `Extracted files too large. Maximum size is ${config.maxExtractedSize / (1024 * 1024)}MB.`
                );
              }
            }

            assertStorageMutationPathsAreSafe(config.storageDir, stagingDir);
            flattenOutput(stagingDir);
            assertStorageMutationPathsAreSafe(config.storageDir, stagingDir);
          } catch (error) {
            zipFailed = true;
            zipFailure = error;
          } finally {
            // Ensure ZIP temp file is cleaned up in all cases
            if (zipCleanupNeeded) {
              try {
                assertStorageMutationPathsAreSafe(
                  config.storageDir,
                  stagingDir,
                  zipPath
                );
                rmSync(zipPath, { force: true });
              } catch (cleanupError) {
                zipCleanupFailure = cleanupError;
              }
            }
          }
          if (zipFailed) throw zipFailure;
          if (zipCleanupFailure instanceof StoragePathConflictError) {
            throw zipCleanupFailure;
          }
        } else if (folderFiles.length > 0) {
          sourceType = 'folder';
          assertStorageMutationPathsAreSafe(config.storageDir, stagingDir);
          const { extractedBytes: totalSize } = await writeFolderFiles(
            stagingDir,
            folderFiles,
            {
              maxExtractedSize: config.maxExtractedSize,
              maxFileCount: config.maxFileCount,
              maxPathLength: config.maxPathLength,
            }
          );
          assertStorageMutationPathsAreSafe(config.storageDir, stagingDir);

          // Check total size limit for folder uploads
          if (config.maxExtractedSize && totalSize > config.maxExtractedSize) {
            throw new ApiError(
              ErrorCode.FILES_TOO_LARGE,
              `Files too large. Maximum size is ${config.maxExtractedSize / (1024 * 1024)}MB.`
            );
          }

          assertStorageMutationPathsAreSafe(config.storageDir, stagingDir);
          flattenOutput(stagingDir);
          assertStorageMutationPathsAreSafe(config.storageDir, stagingDir);
        } else if (file && file.size > 0) {
          throw new ApiError(
            ErrorCode.INVALID_UPLOAD,
            'Please upload a .zip file'
          );
        } else {
          throw new ApiError(ErrorCode.INVALID_UPLOAD, 'Please upload files');
        }

        // A deployable build must expose an index.html; otherwise the upload
        // would "succeed" but /deploy/:slug/ would 404.
        assertStorageMutationPathsAreSafe(config.storageDir, stagingDir);
        assertIndexHtml(stagingDir);

        assertStorageMutationPathsAreSafe(config.storageDir, stagingDir);
        version = {
          id: versionId,
          name: versionName,
          description: versionDesc,
          createdAt: new Date().toISOString(),
          size: getDirectorySize(stagingDir),
          fileCount: countFiles(stagingDir),
          sourceType,
          status: 'preview',
          publishedAt: null,
          publishedBy: null,
          checksum: checksumDirectory(stagingDir),
          integrityStatus: 'unknown',
          integrityCheckedAt: null,
        };

        assertStorageMutationPathsAreSafe(
          config.storageDir,
          stagingDir,
          projectDir,
          versionDir
        );
        mkdirSync(projectDir, { recursive: true });
        assertStorageMutationPathsAreSafe(
          config.storageDir,
          stagingDir,
          projectDir,
          versionDir
        );
        renameSync(stagingDir, versionDir);
        promotedToFinal = true;
        assertStorageMutationPathsAreSafe(config.storageDir, versionDir);
      } catch (err) {
        const failure = cleanupFailedUpload(
          config.storageDir,
          promotedToFinal ? versionDir : stagingDir,
          err
        );
        throw normalizeUploadProcessingError(failure);
      }

      if (!version) {
        const cleanupFailure = cleanupFailedUpload(
          config.storageDir,
          versionDir
        );
        if (cleanupFailure)
          throw normalizeUploadProcessingError(cleanupFailure);
        throw new ApiError(
          ErrorCode.FILE_PROCESSING_FAILED,
          'File processing failed before version metadata was created',
          500
        );
      }
      // Upload ≠ go-live (principle §6.1): every version starts preview-only.
      // Production is reached only by an explicit publish (activateVersion).
      try {
        assertStorageMutationPathsAreSafe(config.storageDir, versionDir);
        repo.mutate((data) => {
          const project = data.projects.find(
            (candidate) => candidate.id === projectId
          );
          if (!project)
            throw new ApiError(
              ErrorCode.PROJECT_NOT_FOUND,
              'Project not found',
              404
            );

          const quotaViolation = findStorageQuotaViolation(
            data,
            projectId,
            version.size,
            storageQuotaLimits
          );
          if (quotaViolation) {
            throw new ApiError(
              ErrorCode.STORAGE_QUOTA_EXCEEDED,
              `${quotaViolation.scope} storage quota exceeded`,
              413
            );
          }

          project.versions.push(version);
          project.updatedAt = new Date().toISOString();
          appendHistoryEvent(
            data,
            'version.upload',
            project,
            actorId,
            version,
            {
              sourceType: version.sourceType,
              size: version.size,
              fileCount: version.fileCount,
            }
          );
        });
      } catch (error) {
        const failure = cleanupFailedUpload(
          config.storageDir,
          versionDir,
          error
        );
        if (failure instanceof StoragePathConflictError) {
          throw normalizeUploadProcessingError(failure);
        }
        throw failure;
      }
      return { version: { id: version.id, name: version.name } };
    },

    publishVersion(projectId, versionId, actorId, command) {
      promoteVersion(projectId, versionId, actorId, command, 'version.publish');
    },

    activateVersion(projectId, versionId, actorId, command) {
      promoteVersion(
        projectId,
        versionId,
        actorId,
        command,
        'version.activate'
      );
    },

    rollbackVersion(projectId, versionId, actorId, command) {
      promoteVersion(
        projectId,
        versionId,
        actorId,
        command,
        'version.rollback'
      );
    },

    deleteVersion(projectId, versionId, actorId) {
      const snapshotVersion = repo
        .load()
        .projects.find((project) => project.id === projectId)
        ?.versions.find((version) => version.id === versionId);
      const lease = artifactRecovery.stageVersionDeletion(
        projectId,
        versionId,
        snapshotVersion
          ? {
              targetVersionIds: [snapshotVersion.id],
              versionChecksums: {
                [snapshotVersion.id]: snapshotVersion.checksum,
              },
            }
          : undefined
      );
      try {
        repo.mutate((data) => {
          const project = data.projects.find((p) => p.id === projectId);
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

          const wasActive = project.activeVersionId === versionId;
          const previousActiveVersionId = project.activeVersionId;
          const removed = project.versions.splice(
            project.versions.indexOf(version),
            1
          )[0];
          data.artifactAudits = data.artifactAudits.filter(
            (report) => report.versionId !== versionId
          );
          data.artifactAuditJobs = data.artifactAuditJobs.filter(
            (job) => job.versionId !== versionId
          );
          if (wasActive) project.activeVersionId = null;
          const updatedAt = new Date().toISOString();
          project.versions = syncProductionStatus(
            project.versions,
            project.activeVersionId
          );
          project.updatedAt = updatedAt;
          appendHistoryEvent(
            data,
            'version.delete',
            project,
            actorId,
            removed,
            {
              wasActive,
              previousActiveVersionId,
              activeVersionId: project.activeVersionId,
            }
          );
        });
        commitRecoveryLease(lease);
      } catch (error) {
        lease.rollback();
        throw error;
      }
    },
  };
}

function commitRecoveryLease(
  lease: ReturnType<ArtifactRecoveryService['stageVersionDeletion']>
): void {
  try {
    lease.commit();
  } catch (error) {
    console.error(
      '[deploykit] Metadata deletion committed but trash marker failed',
      error
    );
  }
}

function cleanupFailedUpload(
  storageDir: string,
  target: string,
  failure?: unknown
): unknown | null {
  try {
    assertStorageMutationPathsAreSafe(storageDir, target);
    removeDir(target);
    return failure ?? null;
  } catch (cleanupError) {
    // Cleanup is compensating work. Once upload or metadata processing has
    // already failed, its diagnostic remains authoritative even if a later
    // guard or filesystem removal also fails.
    return failure ?? cleanupError;
  }
}

function normalizeUploadProcessingError(error: unknown): ApiError {
  if (error instanceof StoragePathConflictError) {
    return new ApiError(
      ErrorCode.STORAGE_CONTROL_CONFLICT,
      'Artifact storage control paths are unsafe',
      503
    );
  }
  if (error instanceof ApiError) return error;
  return new ApiError(
    ErrorCode.FILE_PROCESSING_FAILED,
    `File processing failed: ${error instanceof Error ? error.message : String(error)}`,
    500
  );
}
