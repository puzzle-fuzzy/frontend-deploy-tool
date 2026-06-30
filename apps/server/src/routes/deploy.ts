import type { Hono } from 'hono';
import { serveArtifactFile } from '../services/artifactService';
import { resolveDeployTarget } from '../services/deployResolver';
import type { ProjectService } from '../services/projectService';

export function registerDeployRoutes(
  app: Hono,
  deps: { projectService: ProjectService; storageDir: string }
): void {
  const { projectService, storageDir } = deps;

  app.get('/deploy/*', (c) => {
    const fullPath = c.req.path.replace('/deploy/', '');
    const parts = fullPath.split('/').filter(Boolean);
    const slug = parts[0];
    if (!slug) return c.notFound();

    const project = projectService.findBySlug(slug);
    if (!project) return c.notFound();

    const target = resolveDeployTarget(storageDir, project, parts);
    if (target.kind === 'no-active') return c.text('No active version', 404);
    if (target.kind === 'forbidden') return c.text('Forbidden', 403);

    const res = serveArtifactFile(target.absolutePath);
    if (!res && target.fallbackIndexPath) {
      const indexRes = serveArtifactFile(target.fallbackIndexPath);
      if (indexRes) return indexRes;
    }
    return res ?? c.notFound();
  });
}
