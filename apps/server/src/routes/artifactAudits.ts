import { Hono } from 'hono';
import { parseIdParam } from '../domain/schemas';
import { ApiError, ErrorCode } from '../errors';
import { requireMinRole, requireProjectRole } from '../middleware/auth';
import type {
  AppEnv,
  ArtifactAuditJobApiService,
  ArtifactAuditService,
  ProjectService,
} from '../services/contracts';

export function createArtifactAuditRoutes(deps: {
  artifactAuditService: ArtifactAuditService;
  artifactAuditJobService: ArtifactAuditJobApiService;
  projectService: ProjectService;
  cancelArtifactAuditJob?: (jobId: string) => void;
  artifactAuditPollIntervalMs?: number;
}) {
  const { artifactAuditJobService, artifactAuditService, projectService } =
    deps;

  return new Hono<AppEnv>()
    .get('/api/projects/:id/versions/:versionId/audit-assessment', (c) => {
      const projectId = parseIdParam(c.req.param('id'));
      const versionId = parseIdParam(c.req.param('versionId'));
      const actor = c.get('user');
      if (!actor) {
        throw new ApiError(
          ErrorCode.UNAUTHORIZED,
          'Authentication required',
          401
        );
      }
      projectService.getProjectForActor(projectId, actor);
      return c.json(
        artifactAuditService.getArtifactAuditAssessment(projectId, versionId)
      );
    })
    .get('/api/projects/:id/versions/:versionId/audit', (c) => {
      const projectId = parseIdParam(c.req.param('id'));
      const versionId = parseIdParam(c.req.param('versionId'));
      const actor = c.get('user');
      if (!actor) {
        throw new ApiError(
          ErrorCode.UNAUTHORIZED,
          'Authentication required',
          401
        );
      }
      projectService.getProjectForActor(projectId, actor);
      return c.json(
        artifactAuditService.getArtifactAudit(projectId, versionId)
      );
    })
    .post(
      '/api/projects/:id/versions/:versionId/audit',
      requireProjectRole('member', () => projectService),
      (c) => {
        const projectId = parseIdParam(c.req.param('id'));
        const versionId = parseIdParam(c.req.param('versionId'));
        const report = artifactAuditService.runArtifactAudit(
          projectId,
          versionId,
          c.get('user')?.id ?? 'system'
        );
        return c.json(report, 201);
      }
    )
    .post(
      '/api/projects/:id/versions/:versionId/audit-jobs',
      requireMinRole('developer'),
      requireProjectRole('member', () => projectService),
      (c) => {
        const projectId = parseIdParam(c.req.param('id'));
        const versionId = parseIdParam(c.req.param('versionId'));
        const actorId = c.get('user')?.id ?? 'system';
        const result = artifactAuditJobService.enqueue(
          projectId,
          versionId,
          actorId
        );
        c.header(
          'Location',
          `/api/projects/${projectId}/versions/${versionId}/audit-jobs/${result.job.id}`
        );
        c.header(
          'Retry-After',
          String(
            Math.max(
              1,
              Math.ceil((deps.artifactAuditPollIntervalMs ?? 1_000) / 1_000)
            )
          )
        );
        return c.json(result, 202);
      }
    )
    .get('/api/projects/:id/versions/:versionId/audit-jobs', (c) => {
      const projectId = parseIdParam(c.req.param('id'));
      const versionId = parseIdParam(c.req.param('versionId'));
      const actor = c.get('user');
      if (!actor) {
        throw new ApiError(
          ErrorCode.UNAUTHORIZED,
          'Authentication required',
          401
        );
      }
      // Scope authorization precedes opaque cursor parsing to avoid exposing
      // whether a project/version or cursor anchor exists.
      projectService.getProjectForActor(projectId, actor);
      return c.json(
        artifactAuditJobService.list(projectId, versionId, {
          limit: c.req.query('limit'),
          cursor: c.req.query('cursor'),
          status: c.req.query('status'),
        })
      );
    })
    .get('/api/projects/:id/versions/:versionId/audit-jobs/:jobId', (c) => {
      const projectId = parseIdParam(c.req.param('id'));
      const versionId = parseIdParam(c.req.param('versionId'));
      const jobId = parseIdParam(c.req.param('jobId'));
      const actor = c.get('user');
      if (!actor) {
        throw new ApiError(
          ErrorCode.UNAUTHORIZED,
          'Authentication required',
          401
        );
      }
      projectService.getProjectForActor(projectId, actor);
      return c.json(artifactAuditJobService.get(projectId, versionId, jobId));
    })
    .delete(
      '/api/projects/:id/versions/:versionId/audit-jobs/:jobId',
      requireMinRole('developer'),
      requireProjectRole('member', () => projectService),
      (c) => {
        const projectId = parseIdParam(c.req.param('id'));
        const versionId = parseIdParam(c.req.param('versionId'));
        const jobId = parseIdParam(c.req.param('jobId'));
        const actorId = c.get('user')?.id ?? 'system';
        const job = artifactAuditJobService.cancel(
          projectId,
          versionId,
          jobId,
          actorId
        );
        deps.cancelArtifactAuditJob?.(jobId);
        return c.json(job);
      }
    );
}
