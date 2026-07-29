import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { parseIdParam } from '../domain/schemas';
import { ErrorCode } from '../errors';
import { requireProjectRole } from '../middleware/auth';
import type { UploadRouteLimits } from '../middleware/uploadLimits';
import type {
  AppEnv,
  ProjectService,
  VersionService,
} from '../services/contracts';

export function createVersionRoutes(deps: {
  versionService: VersionService;
  projectService: ProjectService;
  uploadRouteLimits: UploadRouteLimits;
}) {
  const { versionService, projectService, uploadRouteLimits } = deps;

  return new Hono<AppEnv>()
    .post(
      '/api/projects/:id/versions',
      bodyLimit({
        maxSize: uploadRouteLimits.maxUploadRequestSize,
        onError: (c) =>
          c.json(
            {
              error: {
                code: ErrorCode.UPLOAD_TOO_LARGE,
                message: 'Upload request exceeds the configured limit',
              },
            },
            413
          ),
      }),
      requireProjectRole('member', () => projectService),
      uploadRouteLimits.gate,
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
