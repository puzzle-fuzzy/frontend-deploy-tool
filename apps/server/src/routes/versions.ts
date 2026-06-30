import { Hono } from 'hono';
import { parseIdParam } from '../domain/schemas';
import type { VersionService } from '../services/contracts';

export function createVersionRoutes(deps: {
  versionService: VersionService;
  /** Removes the on-disk artifacts for a deleted version. */
  removeVersionDir: (projectId: string, versionId: string) => void;
}) {
  const { versionService, removeVersionDir } = deps;

  return new Hono()
    .post('/api/projects/:id/versions', async (c) => {
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

      const result = await versionService.uploadVersion(projectId, {
        versionDesc,
        file,
        folderFiles,
      });
      return c.json(result, 201);
    })
    .put('/api/projects/:id/versions/:versionId/activate', (c) => {
      const projectId = parseIdParam(c.req.param('id'));
      const versionId = parseIdParam(c.req.param('versionId'));
      versionService.activateVersion(projectId, versionId);
      return c.json({ ok: true });
    })
    .delete('/api/projects/:id/versions/:versionId', (c) => {
      const projectId = parseIdParam(c.req.param('id'));
      const versionId = parseIdParam(c.req.param('versionId'));
      versionService.deleteVersion(projectId, versionId);
      removeVersionDir(projectId, versionId);
      return c.json({ ok: true });
    });
}
