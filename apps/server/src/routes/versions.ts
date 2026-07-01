import { Hono } from 'hono';
import { parseIdParam } from '../domain/schemas';
import { assertRole } from '../middleware/auth';
import type { AppEnv, VersionService } from '../services/contracts';

export function createVersionRoutes(deps: {
  versionService: VersionService;
  /** Removes the on-disk artifacts for a deleted version. */
  removeVersionDir: (projectId: string, versionId: string) => void;
}) {
  const { versionService, removeVersionDir } = deps;

  return new Hono<AppEnv>()
    .post('/api/projects/:id/versions', async (c) => {
      assertRole(c, 'developer');
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
    })
    .put('/api/projects/:id/versions/:versionId/activate', (c) => {
      assertRole(c, 'developer');
      const projectId = parseIdParam(c.req.param('id'));
      const versionId = parseIdParam(c.req.param('versionId'));
      versionService.activateVersion(
        projectId,
        versionId,
        c.get('user')?.id ?? 'system'
      );
      return c.json({ ok: true });
    })
    .delete('/api/projects/:id/versions/:versionId', (c) => {
      assertRole(c, 'developer');
      const projectId = parseIdParam(c.req.param('id'));
      const versionId = parseIdParam(c.req.param('versionId'));
      versionService.deleteVersion(
        projectId,
        versionId,
        c.get('user')?.id ?? 'system'
      );
      removeVersionDir(projectId, versionId);
      return c.json({ ok: true });
    });
}
