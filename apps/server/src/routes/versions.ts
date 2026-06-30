import { Hono } from 'hono';
import type { VersionService } from '../services/contracts';

export function createVersionRoutes(deps: {
  versionService: VersionService;
  /** Removes the on-disk artifacts for a deleted version. */
  removeVersionDir: (projectId: string, versionId: string) => void;
}) {
  const { versionService, removeVersionDir } = deps;

  return new Hono()
    .post('/api/projects/:id/versions', async (c) => {
      const projectId = c.req.param('id');
      const formData = await c.req.formData();
      const versionDesc = (
        (formData.get('versionDesc') as string) || ''
      ).trim();
      const file = formData.get('file') as File | null;
      const folderFiles = formData.getAll('folderFiles') as File[];

      const result = await versionService.uploadVersion(projectId, {
        versionDesc,
        file,
        folderFiles,
      });
      return c.json(result, 201);
    })
    .put('/api/projects/:id/versions/:versionId/activate', (c) => {
      versionService.activateVersion(
        c.req.param('id'),
        c.req.param('versionId')
      );
      return c.json({ ok: true });
    })
    .delete('/api/projects/:id/versions/:versionId', (c) => {
      const projectId = c.req.param('id');
      const versionId = c.req.param('versionId');
      versionService.deleteVersion(projectId, versionId);
      removeVersionDir(projectId, versionId);
      return c.json({ ok: true });
    });
}
