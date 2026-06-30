import { join } from 'node:path';
import type { Hono } from 'hono';
import { removeDir } from '../services/artifactService';
import type { VersionService } from '../services/versionService';

export function registerVersionRoutes(
  app: Hono,
  deps: { versionService: VersionService; storageDir: string }
): void {
  const { versionService, storageDir } = deps;

  app.post('/api/projects/:id/versions', async (c) => {
    const projectId = c.req.param('id');
    const formData = await c.req.formData();
    const versionDesc = ((formData.get('versionDesc') as string) || '').trim();
    const file = formData.get('file') as File | null;
    const folderFiles = formData.getAll('folderFiles') as File[];

    const result = await versionService.uploadVersion(projectId, {
      versionDesc,
      file,
      folderFiles,
    });
    return c.json(result, 201);
  });

  app.put('/api/projects/:id/versions/:versionId/activate', (c) => {
    versionService.activateVersion(c.req.param('id'), c.req.param('versionId'));
    return c.json({ ok: true });
  });

  app.delete('/api/projects/:id/versions/:versionId', (c) => {
    const projectId = c.req.param('id');
    const versionId = c.req.param('versionId');
    versionService.deleteVersion(projectId, versionId);
    removeDir(join(storageDir, projectId, versionId));
    return c.json({ ok: true });
  });
}
