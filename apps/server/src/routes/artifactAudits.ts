import { Hono } from 'hono';
import { parseIdParam } from '../domain/schemas';
import { ApiError, ErrorCode } from '../errors';
import { requireProjectRole } from '../middleware/auth';
import type {
  AppEnv,
  ArtifactAuditService,
  ProjectService,
} from '../services/contracts';

export function createArtifactAuditRoutes(deps: {
  artifactAuditService: ArtifactAuditService;
  projectService: ProjectService;
}) {
  const { artifactAuditService, projectService } = deps;

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
    );
}
