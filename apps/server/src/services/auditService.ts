import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AuditProfile,
  type AuditReport,
  auditProfileSchema,
} from '@deploykit/shared';
import { DEFAULT_AUDIT_PROFILE, scoreAudit } from '../domain/audit';
import { ApiError, ErrorCode } from '../errors';
import type { ProjectRepository } from '../repositories/projectRepository';
import { auditHtml } from './htmlAuditService';

export interface AuditService {
  runVersionAudit(
    projectId: string,
    versionId: string,
    profile?: AuditProfile
  ): AuditReport;
}

export function createAuditService(
  repo: ProjectRepository,
  storageDir: string
): AuditService {
  return {
    runVersionAudit(projectId, versionId, profile) {
      const data = repo.load();
      const project = data.projects.find((item) => item.id === projectId);
      if (!project) {
        throw new ApiError(
          ErrorCode.PROJECT_NOT_FOUND,
          'Project not found',
          404
        );
      }

      const version = project.versions.find((item) => item.id === versionId);
      if (!version) {
        throw new ApiError(
          ErrorCode.VERSION_NOT_FOUND,
          'Version not found',
          404
        );
      }

      const auditProfile = profile ?? DEFAULT_AUDIT_PROFILE;
      const parsedProfile = auditProfileSchema.safeParse(auditProfile);
      if (!parsedProfile.success) {
        throw new ApiError(
          ErrorCode.AUDIT_PROFILE_INVALID,
          'Audit profile is invalid',
          400
        );
      }

      const artifactRoot = join(storageDir, projectId, versionId);
      if (!isDirectory(artifactRoot)) {
        throw new ApiError(
          ErrorCode.AUDIT_ARTIFACT_NOT_FOUND,
          'Audit artifact not found',
          404
        );
      }

      const indexPath = join(artifactRoot, 'index.html');
      if (!isFile(indexPath)) {
        throw new ApiError(
          ErrorCode.AUDIT_ENTRY_NOT_FOUND,
          'Audit entry index.html not found',
          404
        );
      }

      let html: string;
      try {
        html = readFileSync(indexPath, 'utf8');
      } catch {
        throw new ApiError(
          ErrorCode.AUDIT_UNREADABLE_HTML,
          'Unable to read audit entry HTML',
          500
        );
      }

      const checks = auditHtml({
        html,
        artifactRoot,
        profile: parsedProfile.data,
      });
      const { score, status } = scoreAudit(checks);

      return {
        projectId,
        versionId,
        profile: parsedProfile.data,
        status,
        score,
        checks,
        createdAt: new Date().toISOString(),
      };
    },
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
