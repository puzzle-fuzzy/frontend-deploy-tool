import type {
  ArtifactAuditAssessment,
  ArtifactAuditReleaseAssessment,
  ArtifactAuditReport,
  ArtifactAuditStaleReason,
  Data,
  Project,
  Version,
} from '@deploykit/shared';
import { hasSameArtifactAuditRuleConfig } from '@deploykit/shared';
import { ApiError, ErrorCode } from '../errors';
import { ARTIFACT_AUDIT_ENGINE_VERSION } from './artifactAuditRules';

/** Assesses an already-loaded release snapshot without I/O or mutation. */
export function assessArtifactAudit(
  data: Data,
  project: Project,
  version: Version
): ArtifactAuditAssessment {
  const report = data.artifactAudits.find(
    (candidate) =>
      candidate.projectId === project.id && candidate.versionId === version.id
  );
  if (!report) {
    return {
      report: null,
      freshness: 'missing',
      staleReasons: [],
      currentEngineVersion: ARTIFACT_AUDIT_ENGINE_VERSION,
      release: releaseAssessment(project, null, false),
    };
  }

  const staleReasons: ArtifactAuditStaleReason[] = [];
  if (report.artifactChecksum !== version.checksum) {
    staleReasons.push('checksum_changed');
  }
  if (report.engineVersion !== ARTIFACT_AUDIT_ENGINE_VERSION) {
    staleReasons.push('engine_changed');
  }
  if (!hasSameArtifactAuditRuleConfig(report.policy, project.auditPolicy)) {
    staleReasons.push('rule_config_changed');
  }
  if (
    report.context.spaMode !== project.settings.spaMode ||
    report.context.routingType !== project.settings.routingType
  ) {
    staleReasons.push('context_changed');
  }

  const [firstStaleReason, ...remainingStaleReasons] = staleReasons;
  if (firstStaleReason) {
    return {
      report,
      freshness: 'stale',
      staleReasons: [firstStaleReason, ...remainingStaleReasons],
      currentEngineVersion: ARTIFACT_AUDIT_ENGINE_VERSION,
      release: releaseAssessment(project, report, false),
    };
  }

  return {
    report,
    freshness: 'current',
    staleReasons: [],
    currentEngineVersion: ARTIFACT_AUDIT_ENGINE_VERSION,
    release: releaseAssessment(project, report, true),
  };
}

function releaseAssessment(
  project: Project,
  report: ArtifactAuditReport | null,
  current: boolean
): ArtifactAuditReleaseAssessment {
  if (project.auditPolicy.enforcement === 'advisory') {
    return { allowed: true, reason: 'advisory' };
  }
  if (!current) {
    return { allowed: false, reason: 'audit_required' };
  }
  if (report?.status === 'failed') {
    return { allowed: false, reason: 'audit_blocked' };
  }
  return { allowed: true, reason: 'current_report' };
}

/** Enforces the opt-in project release gate against the current version report. */
export function assertArtifactAuditAllowsRelease(
  data: Data,
  project: Project,
  version: Version
): void {
  const assessment = assessArtifactAudit(data, project, version);
  if (assessment.release.allowed) return;
  if (assessment.release.reason === 'audit_required') {
    throw new ApiError(
      ErrorCode.AUDIT_REQUIRED,
      assessment.freshness === 'missing'
        ? 'Run an artifact audit before releasing this version'
        : 'The artifact audit is stale for the current release inputs',
      409
    );
  }
  throw new ApiError(
    ErrorCode.AUDIT_BLOCKED,
    'The current artifact audit contains blocking findings',
    409
  );
}
