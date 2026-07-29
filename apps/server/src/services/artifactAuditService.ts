import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ArtifactAuditPolicy,
  ArtifactAuditReport,
  ArtifactAuditStatus,
} from '@deploykit/shared';
import { appendHistoryEvent } from '../domain/history';
import { ApiError, ErrorCode } from '../errors';
import type { ProjectRepository } from '../repositories/projectRepository';
import { createId } from '../utils/id';
import {
  ARTIFACT_AUDIT_ENGINE_VERSION,
  type ArtifactAuditResult,
  auditArtifactDirectory,
} from './artifactAuditEngine';
import { checksumDirectory } from './artifactService';
import type { ArtifactAuditService } from './contracts';

interface ArtifactAuditServiceDependencies {
  now?: () => Date;
  audit?: (
    artifactDir: string,
    expectedChecksum: string,
    policy: ArtifactAuditPolicy
  ) => ArtifactAuditResult;
  recordOutcome?: (status: ArtifactAuditStatus) => void;
}

export function createArtifactAuditService(
  repo: ProjectRepository,
  storageDir: string,
  dependencies: ArtifactAuditServiceDependencies = {}
): ArtifactAuditService {
  const now = dependencies.now ?? (() => new Date());
  const audit = dependencies.audit ?? auditArtifactDirectory;

  return {
    runArtifactAudit(projectId, versionId, actorId) {
      const snapshot = repo.load();
      const project = snapshot.projects.find(
        (candidate) => candidate.id === projectId
      );
      if (!project) {
        throw new ApiError(
          ErrorCode.PROJECT_NOT_FOUND,
          'Project not found',
          404
        );
      }
      const version = project.versions.find(
        (candidate) => candidate.id === versionId
      );
      if (!version) {
        throw new ApiError(
          ErrorCode.VERSION_NOT_FOUND,
          'Version not found',
          404
        );
      }

      const artifactDir = join(storageDir, projectId, versionId);
      if (!existsSync(artifactDir)) {
        throw new ApiError(
          ErrorCode.AUDIT_FAILED,
          'Artifact files are missing',
          409
        );
      }
      const policy = structuredClone(project.auditPolicy);
      const result = audit(artifactDir, version.checksum, policy);
      if (checksumDirectory(artifactDir) !== result.artifactChecksum) {
        throw new ApiError(
          ErrorCode.AUDIT_FAILED,
          'Artifact changed while the audit was running; retry the audit',
          409
        );
      }

      const report: ArtifactAuditReport = {
        id: createId(),
        projectId,
        versionId,
        artifactChecksum: result.artifactChecksum,
        status: result.status,
        score: result.score,
        createdAt: now().toISOString(),
        createdBy: actorId,
        engineVersion: ARTIFACT_AUDIT_ENGINE_VERSION,
        policy,
        summary: result.summary,
        checks: result.checks,
      };

      const persisted = repo.mutate((data) => {
        const currentProject = data.projects.find(
          (candidate) => candidate.id === projectId
        );
        if (!currentProject) {
          throw new ApiError(
            ErrorCode.PROJECT_NOT_FOUND,
            'Project not found',
            404
          );
        }
        const currentVersion = currentProject.versions.find(
          (candidate) => candidate.id === versionId
        );
        if (!currentVersion) {
          throw new ApiError(
            ErrorCode.VERSION_NOT_FOUND,
            'Version not found',
            404
          );
        }
        if (
          currentVersion.checksum !== version.checksum ||
          !samePolicy(currentProject.auditPolicy, policy)
        ) {
          throw new ApiError(
            ErrorCode.AUDIT_FAILED,
            'Version metadata or audit policy changed; retry the audit',
            409
          );
        }

        data.artifactAudits = data.artifactAudits.filter(
          (candidate) => candidate.versionId !== versionId
        );
        data.artifactAudits.push(report);
        const warningCount = report.checks.filter(
          (check) => !check.passed && check.severity === 'warning'
        ).length;
        const errorCount = report.checks.filter(
          (check) => !check.passed && check.severity === 'error'
        ).length;
        appendHistoryEvent(
          data,
          'version.audit',
          currentProject,
          actorId,
          currentVersion,
          {
            reportId: report.id,
            status: report.status,
            score: report.score,
            warningCount,
            errorCount,
            totalBytes: report.summary.totalBytes,
            fileCount: report.summary.fileCount,
            artifactChecksum: report.artifactChecksum,
            engineVersion: report.engineVersion,
          }
        );
        return report;
      });
      dependencies.recordOutcome?.(persisted.status);
      return persisted;
    },

    getArtifactAudit(projectId, versionId) {
      const data = repo.load();
      const project = data.projects.find(
        (candidate) => candidate.id === projectId
      );
      if (!project) {
        throw new ApiError(
          ErrorCode.PROJECT_NOT_FOUND,
          'Project not found',
          404
        );
      }
      if (!project.versions.some((version) => version.id === versionId)) {
        throw new ApiError(
          ErrorCode.VERSION_NOT_FOUND,
          'Version not found',
          404
        );
      }
      const report = data.artifactAudits.find(
        (candidate) =>
          candidate.projectId === projectId && candidate.versionId === versionId
      );
      if (!report) {
        throw new ApiError(
          ErrorCode.AUDIT_NOT_FOUND,
          'Artifact audit not found',
          404
        );
      }
      return report;
    },
  };
}

function samePolicy(
  left: ArtifactAuditPolicy,
  right: ArtifactAuditPolicy
): boolean {
  return (
    left.enforcement === right.enforcement &&
    left.maxTotalBytes === right.maxTotalBytes &&
    left.maxFileBytes === right.maxFileBytes &&
    left.maxFileCount === right.maxFileCount
  );
}
