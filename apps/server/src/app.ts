import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import type { Data, HistoryEvent, Project, Settings, Version } from "@deploykit/shared";
import { getMimeType } from "./utils/mime";
import { safeJoin } from "./utils/safePath";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface AppConfig {
  dataFile: string;
  storageDir: string;
  publicDir: string;
}

const DEFAULT_SETTINGS: Settings = { spaMode: false, routingType: "path" };

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

function loadData(dataFile: string): Data {
  if (!existsSync(dataFile)) return { projects: [], history: [] };
  try {
    const raw = JSON.parse(readFileSync(dataFile, "utf-8"));
    for (const project of raw.projects ?? []) {
      if (!project.settings) project.settings = { ...DEFAULT_SETTINGS };
    }
    return { projects: raw.projects ?? [], history: raw.history ?? [] };
  } catch {
    return { projects: [], history: [] };
  }
}

function saveData(dataFile: string, data: Data) {
  mkdirSync(dirname(dataFile), { recursive: true });
  writeFileSync(dataFile, JSON.stringify(data, null, 2), "utf-8");
}

function recordEvent(
  data: Data,
  action: HistoryEvent["action"],
  project: { id: string; name: string },
  version?: { id: string; name: string },
) {
  data.history.unshift({
    id: generateId(),
    action,
    projectId: project.id,
    projectName: project.name,
    versionId: version?.id ?? "",
    versionName: version?.name ?? "",
    timestamp: new Date().toISOString(),
  });
  if (data.history.length > 200) data.history.length = 200;
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  const proc = Bun.spawn({ cmd: ["tar", "-xf", zipPath, "-C", destDir], cwd: import.meta.dir, stderr: "pipe" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error("Zip extraction failed");
}

function flattenOutput(dir: string): void {
  const macosx = join(dir, "__MACOSX");
  if (existsSync(macosx)) rmSync(macosx, { recursive: true, force: true });
  if (existsSync(join(dir, "index.html"))) return;

  for (const entry of readdirSync(dir)) {
    const sub = join(dir, entry);
    if (statSync(sub).isDirectory() && existsSync(join(sub, "index.html"))) {
      for (const child of readdirSync(sub)) {
        renameSync(join(sub, child), join(dir, child));
      }
      rmSync(sub, { recursive: true, force: true });
      return;
    }
  }
}

function storageFile(absolutePath: string): Response | null {
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) return null;
  return new Response(Bun.file(absolutePath), { headers: { "Content-Type": getMimeType(absolutePath) } });
}

function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(slug);
}

function parseSettings(input: unknown): Settings | null {
  if (!input || typeof input !== "object") return null;
  const body = input as Partial<Settings>;
  if (typeof body.spaMode !== "boolean") return null;
  if (body.routingType !== "hash" && body.routingType !== "path") return null;
  return { spaMode: body.spaMode, routingType: body.routingType };
}

export function createApp(config: AppConfig) {
  mkdirSync(config.storageDir, { recursive: true });

  const app = new Hono();

  app.get("/api/projects", (c) => {
    return c.json(loadData(config.dataFile).projects);
  });

  app.post("/api/projects", async (c) => {
    const body = await c.req.json();
    const name = ((body.name as string) || "").trim();
    const slug = ((body.slug as string) || "").trim().toLowerCase();
    const description = ((body.description as string) || "").trim();

    if (!name) return c.json({ error: "Project name is required" }, 400);
    if (!slug) return c.json({ error: "Project slug is required" }, 400);
    if (!isValidSlug(slug)) {
      return c.json({ error: "Project slug must be 3-64 lowercase letters, numbers, or hyphens" }, 400);
    }

    const data = loadData(config.dataFile);
    if (data.projects.some((p) => p.slug === slug)) return c.json({ error: "Project slug already exists" }, 400);

    const project: Project = {
      id: generateId(),
      name,
      slug,
      description,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      versions: [],
      settings: { ...DEFAULT_SETTINGS },
    };
    data.projects.push(project);
    recordEvent(data, "project.create", project);
    saveData(config.dataFile, data);
    return c.json(project, 201);
  });

  app.delete("/api/projects/:id", (c) => {
    const id = c.req.param("id");
    const data = loadData(config.dataFile);
    const idx = data.projects.findIndex((p) => p.id === id);
    if (idx === -1) return c.json({ error: "Project not found" }, 404);

    const removed = data.projects.splice(idx, 1)[0];
    recordEvent(data, "project.delete", removed);
    saveData(config.dataFile, data);
    rmSync(join(config.storageDir, id), { recursive: true, force: true });
    return c.json({ ok: true });
  });

  app.patch("/api/projects/:id", async (c) => {
    const body = await c.req.json();
    const settings = parseSettings(body.settings ?? body);
    if (!settings) return c.json({ error: "Invalid settings payload" }, 400);
    return updateProjectSettings(config, c.req.param("id"), settings, (project) => c.json(project));
  });

  app.patch("/api/projects/:id/settings", async (c) => {
    const settings = parseSettings(await c.req.json());
    if (!settings) return c.json({ error: "Invalid settings payload" }, 400);
    return updateProjectSettings(config, c.req.param("id"), settings, (project) => c.json(project));
  });

  app.get("/api/projects/:id/versions", (c) => {
    const project = loadData(config.dataFile).projects.find((p) => p.id === c.req.param("id"));
    if (!project) return c.json({ error: "Project not found" }, 404);
    return c.json(project);
  });

  app.post("/api/projects/:id/versions", async (c) => {
    const id = c.req.param("id");
    const data = loadData(config.dataFile);
    const project = data.projects.find((p) => p.id === id);
    if (!project) return c.json({ error: "Project not found" }, 404);

    const formData = await c.req.formData();
    const versionDesc = ((formData.get("versionDesc") as string) || "").trim();
    const file = formData.get("file") as File | null;
    const folderFiles = formData.getAll("folderFiles") as File[];

    const versionId = generateId();
    const versionName = versionId.substring(0, 7);
    const versionDir = join(config.storageDir, id, versionId);
    mkdirSync(versionDir, { recursive: true });

    try {
      if (file && file.size > 0 && file.name.endsWith(".zip")) {
        const zipPath = join(config.storageDir, `${versionId}.zip`);
        await Bun.write(zipPath, file);
        await extractZip(zipPath, versionDir);
        rmSync(zipPath, { force: true });
        flattenOutput(versionDir);
      } else if (folderFiles.length > 0) {
        for (const f of folderFiles) {
          const relativePath = ((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name).replaceAll("/", "\\");
          const filePath = safeJoin(versionDir, relativePath);
          if (!filePath) throw new Error(`Unsafe upload path: ${relativePath}`);
          mkdirSync(dirname(filePath), { recursive: true });
          await Bun.write(filePath, f);
        }
        flattenOutput(versionDir);
      } else if (file && file.size > 0) {
        return c.json({ error: "Please upload a .zip file" }, 400);
      } else {
        return c.json({ error: "Please upload files" }, 400);
      }
    } catch (err) {
      rmSync(versionDir, { recursive: true, force: true });
      return c.json({ error: `File processing failed: ${(err as Error).message}` }, 500);
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
    recordEvent(data, "version.upload", project, version);
    saveData(config.dataFile, data);
    return c.json(version, 201);
  });

  app.put("/api/projects/:id/versions/:versionId/activate", (c) => {
    const projectId = c.req.param("id");
    const versionId = c.req.param("versionId");
    const data = loadData(config.dataFile);
    const project = data.projects.find((p) => p.id === projectId);
    if (!project) return c.json({ error: "Project not found" }, 404);

    const version = project.versions.find((v) => v.id === versionId);
    if (!version) return c.json({ error: "Version not found" }, 404);

    project.versions.forEach((v) => (v.active = v.id === versionId));
    project.updatedAt = new Date().toISOString();
    recordEvent(data, "version.activate", project, version);
    saveData(config.dataFile, data);
    return c.json({ ok: true });
  });

  app.delete("/api/projects/:id/versions/:versionId", (c) => {
    const projectId = c.req.param("id");
    const versionId = c.req.param("versionId");
    const data = loadData(config.dataFile);
    const project = data.projects.find((p) => p.id === projectId);
    if (!project) return c.json({ error: "Project not found" }, 404);
    const vIdx = project.versions.findIndex((v) => v.id === versionId);
    if (vIdx === -1) return c.json({ error: "Version not found" }, 404);

    const removed = project.versions.splice(vIdx, 1)[0];
    if (removed.active && project.versions.length > 0) {
      project.versions[project.versions.length - 1].active = true;
    }
    project.updatedAt = new Date().toISOString();
    recordEvent(data, "version.delete", project, removed);
    saveData(config.dataFile, data);
    rmSync(join(config.storageDir, projectId, versionId), { recursive: true, force: true });
    return c.json({ ok: true });
  });

  app.get("/api/history", (c) => {
    const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
    return c.json(loadData(config.dataFile).history.slice(0, limit));
  });

  app.get("/deploy/*", (c) => {
    const fullPath = c.req.path.replace("/deploy/", "");
    const parts = fullPath.split("/").filter(Boolean);
    const slug = parts[0];
    if (!slug) return c.notFound();

    const project = loadData(config.dataFile).projects.find((p) => p.slug === slug);
    if (!project) return c.notFound();

    let versionId: string;
    let filePath: string;
    if (parts.length >= 2 && project.versions.some((v) => v.id === parts[1])) {
      versionId = parts[1];
      filePath = parts.slice(2).join("/");
    } else {
      const active = project.versions.find((v) => v.active);
      if (!active) return c.text("No active version", 404);
      versionId = active.id;
      filePath = parts.slice(1).join("/");
    }

    if (!filePath || filePath.endsWith("/")) filePath += "index.html";
    const versionRoot = join(config.storageDir, project.id, versionId);
    const absolutePath = safeJoin(versionRoot, filePath);
    if (!absolutePath) return c.text("Forbidden", 403);

    const res = storageFile(absolutePath);
    if (!res && project.settings.spaMode) {
      const indexRes = storageFile(join(versionRoot, "index.html"));
      if (indexRes) return indexRes;
    }
    return res ?? c.notFound();
  });

  app.use("/*", serveStatic({ root: config.publicDir }));

  app.get("*", (c) => {
    const indexHtml = join(config.publicDir, "index.html");
    if (existsSync(indexHtml)) {
      return new Response(Bun.file(indexHtml), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return c.notFound();
  });

  return app;
}

function updateProjectSettings(
  config: AppConfig,
  projectId: string,
  settings: Settings,
  respond: (project: Project) => Response,
) {
  const data = loadData(config.dataFile);
  const project = data.projects.find((p) => p.id === projectId);
  if (!project) return new Response(JSON.stringify({ error: "Project not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

  project.settings = settings;
  project.updatedAt = new Date().toISOString();
  saveData(config.dataFile, data);
  return respond(project);
}
