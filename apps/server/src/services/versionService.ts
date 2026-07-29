import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  HistoryAction,
  Version,
  VersionSourceType,
} from '@deploykit/shared';
import type { AppConfig } from '../config';
import { appendHistoryEvent } from '../domain/history';
import type { ReleaseCommand } from '../domain/version';
import { findProjectVersion, syncProductionStatus } from '../domain/version';
import { ApiError, ErrorCode } from '../errors';
import type { ProjectRepository } from '../repositories/projectRepository';
import { createId } from '../utils/id';
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

export type { UploadVersionInput, VersionService } from './contracts';

export function createVersionService(
  repo: ProjectRepository,
  config: AppConfig
): VersionService {
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
    if (
      snapshotProject.activeVersionId !== command.expectedActiveVersionId
    ) {
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
      const stagingDir = join(config.storageDir, '.staging', versionId);
      const versionDir = join(config.storageDir, projectId, versionId);
      mkdirSync(stagingDir, { recursive: true });

      let sourceType: VersionSourceType = 'unknown';
      let promotedToFinal = false;
      let version: Version | undefined;
      try {
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

          try {
            await Bun.write(zipPath, file);
            await extractZip(zipPath, stagingDir, {
              maxExtractedSize: config.maxExtractedSize,
              maxFileCount: config.maxFileCount,
              maxPathLength: config.maxPathLength,
              maxCompressionRatio: config.maxCompressionRatio,
            });
            rmSync(zipPath, { force: true });
            zipCleanupNeeded = false;

            // Check extracted size limit
            if (config.maxExtractedSize) {
              const extractedSize = getDirectorySize(stagingDir);
              if (extractedSize > config.maxExtractedSize) {
                throw new ApiError(
                  ErrorCode.EXTRACTED_TOO_LARGE,
                  `Extracted files too large. Maximum size is ${config.maxExtractedSize / (1024 * 1024)}MB.`
                );
              }
            }

            flattenOutput(stagingDir);
          } finally {
            // Ensure ZIP temp file is cleaned up in all cases
            if (zipCleanupNeeded) {
              try {
                rmSync(zipPath, { force: true });
              } catch {
                // Ignore cleanup errors
              }
            }
          }
        } else if (folderFiles.length > 0) {
          sourceType = 'folder';
          const { extractedBytes: totalSize } = await writeFolderFiles(
            stagingDir,
            folderFiles,
            {
              maxExtractedSize: config.maxExtractedSize,
              maxFileCount: config.maxFileCount,
              maxPathLength: config.maxPathLength,
            }
          );

          // Check total size limit for folder uploads
          if (config.maxExtractedSize && totalSize > config.maxExtractedSize) {
            throw new ApiError(
              ErrorCode.FILES_TOO_LARGE,
              `Files too large. Maximum size is ${config.maxExtractedSize / (1024 * 1024)}MB.`
            );
          }

          flattenOutput(stagingDir);
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
        assertIndexHtml(stagingDir);

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
        };

        mkdirSync(join(config.storageDir, projectId), { recursive: true });
        renameSync(stagingDir, versionDir);
        promotedToFinal = true;
      } catch (err) {
        removeDir(stagingDir);
        if (promotedToFinal) removeDir(versionDir);
        if (err instanceof ApiError) throw err;
        throw new ApiError(
          ErrorCode.FILE_PROCESSING_FAILED,
          `File processing failed: ${err instanceof Error ? err.message : String(err)}`,
          500
        );
      }

      if (!version) {
        removeDir(versionDir);
        throw new ApiError(
          ErrorCode.FILE_PROCESSING_FAILED,
          'File processing failed before version metadata was created',
          500
        );
      }
      // Upload ≠ go-live (principle §6.1): every version starts preview-only.
      // Production is reached only by an explicit publish (activateVersion).
      try {
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
        removeDir(versionDir);
        throw error;
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
        if (wasActive) project.activeVersionId = null;
        const updatedAt = new Date().toISOString();
        project.versions = syncProductionStatus(
          project.versions,
          project.activeVersionId
        );
        project.updatedAt = updatedAt;
        appendHistoryEvent(data, 'version.delete', project, actorId, removed, {
          wasActive,
          previousActiveVersionId,
          activeVersionId: project.activeVersionId,
        });
      });
      removeDir(join(config.storageDir, projectId, versionId));
    },
  };
}
