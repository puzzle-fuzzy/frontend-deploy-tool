import { Hono } from 'hono';
import { parseIdParam } from '../domain/schemas';
import { requireProjectRole } from '../middleware/auth';
import type { AppEnv, ProjectService, VersionService } from '../services/contracts';

export function createVersionRoutes(deps: {
  versionService: VersionService;
  projectService: ProjectService;
}) {
  const { versionService, projectService } = deps;

  return new Hono<AppEnv>()
    .post(
      '/api/projects/:id/versions',
      requireProjectRole('member', () => projectService),
      async (c) => {
        const projectId = parseIdParam(c.req.param('id'));
        const formData = await c.req.formData();

        const versionDescRaw = formData.get('versionDesc');
        const versionDesc = (
          typeof versionDescRaw === 'string' ? versionDescRaw : ''
        ).trim();
        const fileEntry = formData.get('file');
        const file = fileEntry instanceof File ? fileEntry : null;
        const folderFiles = formData
          .getAll('folderFiles')
          .filter((entry): entry is File => entry instanceof File);

        const result = await versionService.uploadVersion(
          projectId,
          {
            versionDesc,
            file,
            folderFiles,
          },
          c.get('user')?.id ?? 'system'
        );
        return c.json(result, 201);
      }
    )
    .put(
      '/api/projects/:id/versions/:versionId/activate',
      requireProjectRole('member', () => projectService),
      (c) => {
        const projectId = parseIdParam(c.req.param('id'));
        const versionId = parseIdParam(c.req.param('versionId'));
        versionService.activateVersion(
          projectId,
          versionId,
          c.get('user')?.id ?? 'system'
        );
        return c.json({ ok: true });
      }
    )
    .post(
      '/api/projects/:id/versions/:versionId/publish',
      requireProjectRole('member', () => projectService),
      (c) => {
        const projectId = parseIdParam(c.req.param('id'));
        const versionId = parseIdParam(c.req.param('versionId'));
        versionService.publishVersion(
          projectId,
          versionId,
          c.get('user')?.id ?? 'system'
        );
        return c.json({ ok: true });
      }
    )
    .post(
      '/api/projects/:id/versions/:versionId/rollback',
      requireProjectRole('member', () => projectService),
      (c) => {
        const projectId = parseIdParam(c.req.param('id'));
        const versionId = parseIdParam(c.req.param('versionId'));
        versionService.rollbackVersion(
          projectId,
          versionId,
          c.get('user')?.id ?? 'system'
        );
        return c.json({ ok: true });
      }
    )
    .delete(
      '/api/projects/:id/versions/:versionId',
      requireProjectRole('member', () => projectService),
      (c) => {
        const projectId = parseIdParam(c.req.param('id'));
        const versionId = parseIdParam(c.req.param('versionId'));
        versionService.deleteVersion(
          projectId,
          versionId,
          c.get('user')?.id ?? 'system'
        );
        return c.json({ ok: true });
      }
    );
}
