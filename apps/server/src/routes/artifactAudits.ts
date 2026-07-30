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
}) {
  const { artifactAuditJobService, artifactAuditService, projectService } =
    deps;

  return new Hono<AppEnv>()
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
        return c.json(
          artifactAuditJobService.enqueue(projectId, versionId, actorId),
          202
        );
      }
    )
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
