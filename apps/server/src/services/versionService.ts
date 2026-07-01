import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  HistoryAction,
  Version,
  VersionSourceType,
} from '@deploykit/shared';
import type { AppConfig } from '../config';
import { appendHistoryEvent } from '../domain/history';
import {
  chooseReplacementActiveVersionId,
  findProjectVersion,
} from '../domain/version';
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
    action: Extract<
      HistoryAction,
      'version.publish' | 'version.activate' | 'version.rollback'
    >
  ) => {
    const data = repo.load();
    const project = data.projects.find((p) => p.id === projectId);
    if (!project)
      throw new ApiError(ErrorCode.PROJECT_NOT_FOUND, 'Project not found', 404);

    const version = findProjectVersion(project, versionId);
    if (!version)
      throw new ApiError(ErrorCode.VERSION_NOT_FOUND, 'Version not found', 404);

    const previousActiveVersionId = project.activeVersionId;
    const publishedAt = new Date().toISOString();
    for (const candidate of project.versions) {
      if (candidate.id === version.id) {
        candidate.status = 'production';
        candidate.publishedAt = publishedAt;
        candidate.publishedBy = actorId;
      } else if (candidate.status === 'production') {
        candidate.status = 'preview';
      }
    }
    project.activeVersionId = version.id;
    project.updatedAt = publishedAt;
    appendHistoryEvent(data, action, project, actorId, version, {
      previousActiveVersionId,
    });
    repo.save(data);
  };

  return {
    async uploadVersion(
      projectId,
      { versionDesc, file, folderFiles },
      actorId
    ) {
      const data = repo.load();
      const project = data.projects.find((p) => p.id === projectId);
      if (!project)
        throw new ApiError(
          ErrorCode.PROJECT_NOT_FOUND,
          'Project not found',
          404
        );

      const versionId = createId();
      const versionName = versionId.substring(0, 7);
      const versionDir = join(config.storageDir, projectId, versionId);
      mkdirSync(versionDir, { recursive: true });

      let sourceType: VersionSourceType = 'unknown';
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

          const zipPath = join(config.storageDir, `${versionId}.zip`);
          let zipCleanupNeeded = true;

          try {
            await Bun.write(zipPath, file);
            await extractZip(zipPath, versionDir);
            rmSync(zipPath, { force: true });
            zipCleanupNeeded = false;

            // Check extracted size limit
            if (config.maxExtractedSize) {
              const extractedSize = getDirectorySize(versionDir);
              if (extractedSize > config.maxExtractedSize) {
                throw new ApiError(
                  ErrorCode.EXTRACTED_TOO_LARGE,
                  `Extracted files too large. Maximum size is ${config.maxExtractedSize / (1024 * 1024)}MB.`
                );
              }
            }

            flattenOutput(versionDir);
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
          const totalSize = await writeFolderFiles(
            versionDir,
            folderFiles,
            config.maxPathLength
          );

          // Check total size limit for folder uploads
          if (config.maxExtractedSize && totalSize > config.maxExtractedSize) {
            throw new ApiError(
              ErrorCode.FILES_TOO_LARGE,
              `Files too large. Maximum size is ${config.maxExtractedSize / (1024 * 1024)}MB.`
            );
          }

          flattenOutput(versionDir);
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
        assertIndexHtml(versionDir);
      } catch (err) {
        removeDir(versionDir);
        if (err instanceof ApiError) throw err;
        throw new ApiError(
          ErrorCode.FILE_PROCESSING_FAILED,
          `File processing failed: ${err instanceof Error ? err.message : String(err)}`,
          500
        );
      }

      const version: Version = {
        id: versionId,
        name: versionName,
        description: versionDesc,
        createdAt: new Date().toISOString(),
        size: getDirectorySize(versionDir),
        fileCount: countFiles(versionDir),
        sourceType,
        status: 'preview',
        publishedAt: null,
        publishedBy: null,
        checksum: checksumDirectory(versionDir),
      };
      // Upload ≠ go-live (principle §6.1): every version starts preview-only.
      // Production is reached only by an explicit publish (activateVersion).
      project.versions.push(version);
      project.updatedAt = new Date().toISOString();
      appendHistoryEvent(data, 'version.upload', project, actorId, version, {
        sourceType: version.sourceType,
        size: version.size,
        fileCount: version.fileCount,
      });
      repo.save(data);
      return { version: { id: version.id, name: version.name } };
    },

    publishVersion(projectId, versionId, actorId) {
      promoteVersion(projectId, versionId, actorId, 'version.publish');
    },

    activateVersion(projectId, versionId, actorId) {
      promoteVersion(projectId, versionId, actorId, 'version.activate');
    },

    rollbackVersion(projectId, versionId, actorId) {
      promoteVersion(projectId, versionId, actorId, 'version.rollback');
    },

    deleteVersion(projectId, versionId, actorId) {
      const data = repo.load();
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
      const replacementActiveVersionId = chooseReplacementActiveVersionId(
        project.versions,
        versionId,
        project.activeVersionId
      );
      const removed = project.versions.splice(
        project.versions.indexOf(version),
        1
      )[0];
      project.activeVersionId = replacementActiveVersionId;
      const updatedAt = new Date().toISOString();
      for (const candidate of project.versions) {
        if (candidate.id === replacementActiveVersionId) {
          candidate.status = 'production';
          candidate.publishedAt = updatedAt;
          candidate.publishedBy = actorId;
        } else if (candidate.status === 'production') {
          candidate.status = 'preview';
        }
      }
      project.updatedAt = updatedAt;
      appendHistoryEvent(data, 'version.delete', project, actorId, removed, {
        wasActive,
        replacementActiveVersionId,
      });
      repo.save(data);
    },
  };
}
