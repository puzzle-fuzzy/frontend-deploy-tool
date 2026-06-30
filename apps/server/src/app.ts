import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  Data,
  HistoryEvent,
  Project,
  Settings,
  Version,
} from '@deploykit/shared';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { DEFAULT_PROJECT_SETTINGS, isValidProjectSlug } from './domain/project';
import {
  activateVersion,
  chooseReplacementActiveVersionId,
} from './domain/version';
import { createId } from './utils/id';
import { getMimeType } from './utils/mime';
import { safeJoin } from './utils/safePath';

export interface AppConfig {
  dataFile: string;
  storageDir: string;
  publicDir: string;
  publicBaseURL?: string;
  // Upload limits
  maxZipSize?: number;
  maxExtractedSize?: number;
  maxFileCount?: number;
  maxPathLength?: number;
}

function loadData(dataFile: string): Data {
  if (!existsSync(dataFile)) return { projects: [], history: [] };
  try {
    const raw = JSON.parse(readFileSync(dataFile, 'utf-8'));
    for (const project of raw.projects ?? []) {
      if (!project.settings) project.settings = { ...DEFAULT_PROJECT_SETTINGS };
    }
    return { projects: raw.projects ?? [], history: raw.history ?? [] };
  } catch {
    return { projects: [], history: [] };
  }
}

function saveData(dataFile: string, data: Data) {
  mkdirSync(dirname(dataFile), { recursive: true });
  writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf-8');
}

function recordEvent(
  data: Data,
  action: HistoryEvent['action'],
  project: { id: string; name: string },
  version?: { id: string; name: string }
) {
  data.history.unshift({
    id: createId(),
    action,
    projectId: project.id,
    projectName: project.name,
    versionId: version?.id ?? '',
    versionName: version?.name ?? '',
    timestamp: new Date().toISOString(),
  });
  if (data.history.length > 200) data.history.length = 200;
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  const proc = Bun.spawn({
    cmd: ['tar', '-xf', zipPath, '-C', destDir],
    cwd: import.meta.dir,
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error('Zip extraction failed');
}

function flattenOutput(dir: string): void {
  const macosx = join(dir, '__MACOSX');
  if (existsSync(macosx)) rmSync(macosx, { recursive: true, force: true });
  if (existsSync(join(dir, 'index.html'))) return;

  for (const entry of readdirSync(dir)) {
    const sub = join(dir, entry);
    if (statSync(sub).isDirectory() && existsSync(join(sub, 'index.html'))) {
      for (const child of readdirSync(sub)) {
        renameSync(join(sub, child), join(dir, child));
      }
      rmSync(sub, { recursive: true, force: true });
      return;
    }
  }
}

function getDirectorySize(dirPath: string): number {
  let totalSize = 0;

  function calculateSize(currentPath: string) {
    const stats = statSync(currentPath);
    if (stats.isDirectory()) {
      const files = readdirSync(currentPath);
      for (const file of files) {
        calculateSize(join(currentPath, file));
      }
    } else {
      totalSize += stats.size;
    }
  }

  calculateSize(dirPath);
  return totalSize;
}

function storageFile(absolutePath: string): Response | null {
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile())
    return null;

  const mimeType = getMimeType(absolutePath);
  const headers: Record<string, string> = { 'Content-Type': mimeType };

  // Cache strategy: HTML files should not be cached, other assets can be cached
  if (absolutePath.endsWith('.html')) {
    headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
  } else {
    // For hashed assets and other static files, use long cache
    headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  }

  return new Response(Bun.file(absolutePath), { headers });
}

function parseSettings(input: unknown): Settings | null {
  if (!input || typeof input !== 'object') return null;
  const body = input as Partial<Settings>;
  if (typeof body.spaMode !== 'boolean') return null;
  if (body.routingType !== 'hash' && body.routingType !== 'path') return null;
  return { spaMode: body.spaMode, routingType: body.routingType };
}

export function createApp(config: AppConfig) {
  mkdirSync(config.storageDir, { recursive: true });

  const app = new Hono();

  app.get('/api/projects', (c) => {
    return c.json(loadData(config.dataFile).projects);
  });

  app.post('/api/projects', async (c) => {
    const body = await c.req.json();
    const name = ((body.name as string) || '').trim();
    const slug = ((body.slug as string) || '').trim().toLowerCase();
    const description = ((body.description as string) || '').trim();

    if (!name) return c.json({ error: 'Project name is required' }, 400);
    if (!slug) return c.json({ error: 'Project slug is required' }, 400);
    if (!isValidProjectSlug(slug)) {
      return c.json(
        {
          error:
            'Project slug must be 3-64 lowercase letters, numbers, or hyphens',
        },
        400
      );
    }

    const data = loadData(config.dataFile);
    if (data.projects.some((p) => p.slug === slug))
      return c.json({ error: 'Project slug already exists' }, 400);

    const project: Project = {
      id: createId(),
      name,
      slug,
      description,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      versions: [],
      settings: { ...DEFAULT_PROJECT_SETTINGS },
    };
    data.projects.push(project);
    recordEvent(data, 'project.create', project);
    saveData(config.dataFile, data);
    return c.json(project, 201);
  });

  app.delete('/api/projects/:id', (c) => {
    const id = c.req.param('id');
    const data = loadData(config.dataFile);
    const idx = data.projects.findIndex((p) => p.id === id);
    if (idx === -1) return c.json({ error: 'Project not found' }, 404);

    const removed = data.projects.splice(idx, 1)[0];
    recordEvent(data, 'project.delete', removed);
    saveData(config.dataFile, data);
    rmSync(join(config.storageDir, id), { recursive: true, force: true });
    return c.json({ ok: true });
  });

  app.patch('/api/projects/:id', async (c) => {
    const body = await c.req.json();
    const settings = parseSettings(body.settings ?? body);
    if (!settings) return c.json({ error: 'Invalid settings payload' }, 400);
    return updateProjectSettings(
      config,
      c.req.param('id'),
      settings,
      (project) => c.json(project)
    );
  });

  app.patch('/api/projects/:id/settings', async (c) => {
    const settings = parseSettings(await c.req.json());
    if (!settings) return c.json({ error: 'Invalid settings payload' }, 400);
    return updateProjectSettings(
      config,
      c.req.param('id'),
      settings,
      (project) => c.json(project)
    );
  });

  app.get('/api/projects/:id/versions', (c) => {
    const project = loadData(config.dataFile).projects.find(
      (p) => p.id === c.req.param('id')
    );
    if (!project) return c.json({ error: 'Project not found' }, 404);
    return c.json(project);
  });

  app.post('/api/projects/:id/versions', async (c) => {
    const id = c.req.param('id');
    const data = loadData(config.dataFile);
    const project = data.projects.find((p) => p.id === id);
    if (!project) return c.json({ error: 'Project not found' }, 404);

    const formData = await c.req.formData();
    const versionDesc = ((formData.get('versionDesc') as string) || '').trim();
    const file = formData.get('file') as File | null;
    const folderFiles = formData.getAll('folderFiles') as File[];

    const versionId = createId();
    const versionName = versionId.substring(0, 7);
    const versionDir = join(config.storageDir, id, versionId);
    mkdirSync(versionDir, { recursive: true });

    try {
      // Check file count limit
      if (config.maxFileCount && folderFiles.length > config.maxFileCount) {
        rmSync(versionDir, { recursive: true, force: true });
        return c.json(
          {
            error: `Too many files. Maximum ${config.maxFileCount} files allowed.`,
          },
          400
        );
      }

      if (file && file.size > 0 && file.name.endsWith('.zip')) {
        // Check ZIP size limit
        if (config.maxZipSize && file.size > config.maxZipSize) {
          rmSync(versionDir, { recursive: true, force: true });
          return c.json(
            {
              error: `ZIP file too large. Maximum size is ${config.maxZipSize / (1024 * 1024)}MB.`,
            },
            400
          );
        }

        const zipPath = join(config.storageDir, `${versionId}.zip`);
        let zipCleanupNeeded = true;

        try {
          await Bun.write(zipPath, file);
          await extractZip(zipPath, versionDir);
          rmSync(zipPath, { force: true });
          zipCleanupNeeded = false;

          // Check extracted size limit
          if (config.maxExtractedSize) {
            const extractedSize = getDirectorySize(versionDir);
            if (extractedSize > config.maxExtractedSize) {
              rmSync(versionDir, { recursive: true, force: true });
              return c.json(
                {
                  error: `Extracted files too large. Maximum size is ${config.maxExtractedSize / (1024 * 1024)}MB.`,
                },
                400
              );
            }
          }

          flattenOutput(versionDir);
        } finally {
          // Ensure ZIP temp file is cleaned up in all cases
          if (zipCleanupNeeded) {
            try {
              rmSync(zipPath, { force: true });
            } catch {
              // Ignore cleanup errors
            }
          }
        }
      } else if (folderFiles.length > 0) {
        let totalSize = 0;

        for (const f of folderFiles) {
          const relativePath = (
            (f as File & { webkitRelativePath?: string }).webkitRelativePath ||
            f.name
          ).replaceAll('/', '\\');

          // Check path length limit
          if (
            config.maxPathLength &&
            relativePath.length > config.maxPathLength
          ) {
            rmSync(versionDir, { recursive: true, force: true });
            return c.json(
              {
                error: `Path too long. Maximum path length is ${config.maxPathLength} characters.`,
              },
              400
            );
          }

          const filePath = safeJoin(versionDir, relativePath);
          if (!filePath) throw new Error(`Unsafe upload path: ${relativePath}`);
          mkdirSync(dirname(filePath), { recursive: true });
          await Bun.write(filePath, f);
          totalSize += f.size;
        }

        // Check total size limit for folder uploads
        if (config.maxExtractedSize && totalSize > config.maxExtractedSize) {
          rmSync(versionDir, { recursive: true, force: true });
          return c.json(
            {
              error: `Files too large. Maximum size is ${config.maxExtractedSize / (1024 * 1024)}MB.`,
            },
            400
          );
        }

        flattenOutput(versionDir);
      } else if (file && file.size > 0) {
        rmSync(versionDir, { recursive: true, force: true });
        return c.json({ error: 'Please upload a .zip file' }, 400);
      } else {
        rmSync(versionDir, { recursive: true, force: true });
        return c.json({ error: 'Please upload files' }, 400);
      }
    } catch (err) {
      rmSync(versionDir, { recursive: true, force: true });
      return c.json(
        { error: `File processing failed: ${(err as Error).message}` },
        500
      );
    }

    const version: Version = {
      id: versionId,
      name: versionName,
      description: versionDesc,
      createdAt: new Date().toISOString(),
      active: project.versions.length === 0,
    };
    project.versions.push(version);
    project.updatedAt = new Date().toISOString();
    recordEvent(data, 'version.upload', project, version);
    saveData(config.dataFile, data);
    return c.json({ version: { id: version.id, name: version.name } }, 201);
  });

  app.put('/api/projects/:id/versions/:versionId/activate', (c) => {
    const projectId = c.req.param('id');
    const versionId = c.req.param('versionId');
    const data = loadData(config.dataFile);
    const project = data.projects.find((p) => p.id === projectId);
    if (!project) return c.json({ error: 'Project not found' }, 404);

    const version = project.versions.find((v) => v.id === versionId);
    if (!version) return c.json({ error: 'Version not found' }, 404);

    const activatedVersions = activateVersion(project.versions, versionId);
    if (!activatedVersions) return c.json({ error: 'Version not found' }, 404);

    project.versions = activatedVersions;
    project.updatedAt = new Date().toISOString();
    recordEvent(data, 'version.activate', project, version);
    saveData(config.dataFile, data);
    return c.json({ ok: true });
  });

  app.delete('/api/projects/:id/versions/:versionId', (c) => {
    const projectId = c.req.param('id');
    const versionId = c.req.param('versionId');
    const data = loadData(config.dataFile);
    const project = data.projects.find((p) => p.id === projectId);
    if (!project) return c.json({ error: 'Project not found' }, 404);
    const vIdx = project.versions.findIndex((v) => v.id === versionId);
    if (vIdx === -1) return c.json({ error: 'Version not found' }, 404);

    const replacementActiveVersionId = chooseReplacementActiveVersionId(
      project.versions,
      versionId
    );
    const removed = project.versions.splice(vIdx, 1)[0];
    project.versions = project.versions.map((version) => ({
      ...version,
      active: version.id === replacementActiveVersionId,
    }));
    project.updatedAt = new Date().toISOString();
    recordEvent(data, 'version.delete', project, removed);
    saveData(config.dataFile, data);
    rmSync(join(config.storageDir, projectId, versionId), {
      recursive: true,
      force: true,
    });
    return c.json({ ok: true });
  });

  app.get('/api/history', (c) => {
    const limit = Math.min(Number(c.req.query('limit')) || 50, 200);
    return c.json(loadData(config.dataFile).history.slice(0, limit));
  });

  app.get('/deploy/*', (c) => {
    const fullPath = c.req.path.replace('/deploy/', '');
    const parts = fullPath.split('/').filter(Boolean);
    const slug = parts[0];
    if (!slug) return c.notFound();

    const project = loadData(config.dataFile).projects.find(
      (p) => p.slug === slug
    );
    if (!project) return c.notFound();

    let versionId: string;
    let filePath: string;
    if (parts.length >= 2 && project.versions.some((v) => v.id === parts[1])) {
      versionId = parts[1];
      filePath = parts.slice(2).join('/');
    } else {
      const active = project.versions.find((v) => v.active);
      if (!active) return c.text('No active version', 404);
      versionId = active.id;
      filePath = parts.slice(1).join('/');
    }

    if (!filePath || filePath.endsWith('/')) filePath += 'index.html';
    const versionRoot = join(config.storageDir, project.id, versionId);
    const absolutePath = safeJoin(versionRoot, filePath);
    if (!absolutePath) return c.text('Forbidden', 403);

    const res = storageFile(absolutePath);
    if (!res && project.settings.spaMode) {
      const indexRes = storageFile(join(versionRoot, 'index.html'));
      if (indexRes) return indexRes;
    }
    return res ?? c.notFound();
  });

  // Add security headers for management UI static assets
  app.use('/*', async (c, next) => {
    await next();
    // Only add security headers to management UI responses, not API routes
    if (c.req.path.startsWith('/api') || c.req.path.startsWith('/deploy')) {
      return;
    }
    // Add security headers to management UI static assets
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'SAMEORIGIN');
    c.header('X-XSS-Protection', '1; mode=block');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  });

  // Serve static files with appropriate cache headers
  app.use(
    '/*',
    serveStatic({
      root: config.publicDir,
    })
  );

  app.get('*', (c) => {
    const indexHtml = join(config.publicDir, 'index.html');
    if (existsSync(indexHtml)) {
      return new Response(Bun.file(indexHtml), {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          // Security headers for management UI
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'SAMEORIGIN',
          'X-XSS-Protection': '1; mode=block',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
        },
      });
    }
    return c.notFound();
  });

  return app;
}

function updateProjectSettings(
  config: AppConfig,
  projectId: string,
  settings: Settings,
  respond: (project: Project) => Response
) {
  const data = loadData(config.dataFile);
  const project = data.projects.find((p) => p.id === projectId);
  if (!project)
    return new Response(JSON.stringify({ error: 'Project not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });

  project.settings = settings;
  project.updatedAt = new Date().toISOString();
  saveData(config.dataFile, data);
  return respond(project);
}
