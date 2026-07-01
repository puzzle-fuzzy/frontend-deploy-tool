import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Version, VersionSourceType } from '@deploykit/shared';
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
  countFiles,
  extractZip,
  flattenOutput,
  getDirectorySize,
  hasRootIndexHtml,
  removeDir,
  writeFolderFiles,
} from './artifactService';
import type { VersionService } from './contracts';

export type { UploadVersionInput, VersionService } from './contracts';

export function createVersionService(
  repo: ProjectRepository,
  config: AppConfig
): VersionService {
  return {
    async uploadVersion(projectId, { versionDesc, file, folderFiles }) {
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
            if (!hasRootIndexHtml(versionDir)) {
              throw new ApiError(
                ErrorCode.MISSING_INDEX_HTML,
                'Upload rejected: no index.html found at the root after extraction. DeployKit serves sites from index.html.',
                400
              );
            }
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
          if (!hasRootIndexHtml(versionDir)) {
            throw new ApiError(
              ErrorCode.MISSING_INDEX_HTML,
              'Upload rejected: no index.html found at the root after extraction. DeployKit serves sites from index.html.',
              400
            );
          }
        } else if (file && file.size > 0) {
          throw new ApiError(
            ErrorCode.INVALID_UPLOAD,
            'Please upload a .zip file'
          );
        } else {
          throw new ApiError(ErrorCode.INVALID_UPLOAD, 'Please upload files');
        }
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
      };
      const isFirstVersion = project.versions.length === 0;
      project.versions.push(version);
      if (isFirstVersion) project.activeVersionId = version.id;
      project.updatedAt = new Date().toISOString();
      appendHistoryEvent(data, 'version.upload', project, version, {
        sourceType: version.sourceType,
        size: version.size,
        fileCount: version.fileCount,
      });
      repo.save(data);
      return { version: { id: version.id, name: version.name } };
    },

    activateVersion(projectId, versionId) {
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

      const previousActiveVersionId = project.activeVersionId;
      project.activeVersionId = version.id;
      project.updatedAt = new Date().toISOString();
      appendHistoryEvent(data, 'version.activate', project, version, {
        previousActiveVersionId,
      });
      repo.save(data);
    },

    deleteVersion(projectId, versionId) {
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
      project.updatedAt = new Date().toISOString();
      appendHistoryEvent(data, 'version.delete', project, removed, {
        wasActive,
      });
      repo.save(data);
    },
  };
}
