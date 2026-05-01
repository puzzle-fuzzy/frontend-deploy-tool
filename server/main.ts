/**
 * Dist Deploy - 前端产物部署服务 (Hono)
 *
 * 路由:
 *   /api/projects                             GET    获取项目列表
 *   /api/projects                             POST   创建项目
 *   /api/projects/:id                         DELETE 删除项目
 *   /api/projects/:id                         PATCH  更新项目设置
 *   /api/projects/:id/versions                GET    获取项目版本
 *   /api/projects/:id/versions                POST   上传新版本 (.zip / 文件夹)
 *   /api/projects/:id/versions/:vid/activate  PUT    设为正式
 *   /api/projects/:id/versions/:vid           DELETE 删除版本
 *   /api/history                              GET    获取操作历史
 *   /deploy/:slug/*                           部署产物 (正式版本)
 *   /deploy/:slug/:vid/*                      部署产物 (指定版本)
 *   /*                                        静态文件 (public/)
 */

import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync, renameSync } from "node:fs";
import { join, resolve, extname } from "node:path";

// ─── 类型 ──────────────────────────────────────────────

interface Settings {
  spaMode: boolean;
  routingType: "hash" | "path";
}

interface Version {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  active: boolean;
}

interface Project {
  id: string;
  name: string;
  slug: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  versions: Version[];
  settings: Settings;
}

interface HistoryEvent {
  id: string;
  action: "project.create" | "project.delete" | "version.upload" | "version.activate" | "version.delete";
  projectId: string;
  projectName: string;
  versionId: string;
  versionName: string;
  timestamp: string;
}

interface Data {
  projects: Project[];
  history: HistoryEvent[];
}

const DEFAULT_SETTINGS: Settings = { spaMode: false, routingType: "path" };

// ─── 常量 ──────────────────────────────────────────────

const PORT = 3000;
const DATA_FILE = join(import.meta.dir, "data.json");
const STORAGE_DIR = join(import.meta.dir, ".voasx", "storage");
const PUBLIC_DIR = join(import.meta.dir, "public");
mkdirSync(STORAGE_DIR, { recursive: true });

// ─── 工具函数 ──────────────────────────────────────────

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

function loadData(): Data {
  if (!existsSync(DATA_FILE)) return { projects: [], history: [] };
  try {
    const raw = JSON.parse(readFileSync(DATA_FILE, "utf-8"));
    // 向下兼容：旧数据缺少 settings/history 时补默认值
    for (const p of raw.projects ?? []) {
      if (!p.settings) p.settings = { ...DEFAULT_SETTINGS };
    }
    return { projects: raw.projects ?? [], history: raw.history ?? [] };
  } catch {
    return { projects: [], history: [] };
  }
}

function saveData(data: Data) {
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
}

function recordEvent(data: Data, action: HistoryEvent["action"], project: { id: string; name: string }, version?: { id: string; name: string }) {
  data.history.unshift({
    id: generateId(),
    action,
    projectId: project.id,
    projectName: project.name,
    versionId: version?.id ?? "",
    versionName: version?.name ?? "",
    timestamp: new Date().toISOString(),
  });
  // 最多保留 200 条
  if (data.history.length > 200) data.history.length = 200;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".map": "application/json",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".wasm": "application/wasm",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
};

function getMimeType(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream";
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  const proc = Bun.spawn({ cmd: ["tar", "-xf", zipPath, "-C", destDir], cwd: import.meta.dir, stderr: "pipe" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error("Zip extraction failed");
}

function flattenOutput(dir: string): void {
  const macosx = join(dir, "__MACOSX");
  if (existsSync(macosx)) { try { rmSync(macosx, { recursive: true }); } catch {} }
  if (existsSync(join(dir, "index.html"))) { console.log("[flatten] already at root"); return; }
  for (const entry of readdirSync(dir)) {
    const sub = join(dir, entry);
    if (statSync(sub).isDirectory() && existsSync(join(sub, "index.html"))) {
      const children = readdirSync(sub);
      for (const child of children) renameSync(join(sub, child), join(dir, child));
      try { rmSync(sub, { recursive: true }); } catch {}
      console.log(`[flatten] moved ${children.length} items from ${entry}/`);
      return;
    }
  }
  console.log("[flatten] no index.html found");
}

function storageFile(absolutePath: string): Response | null {
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) return null;
  return new Response(Bun.file(absolutePath), { headers: { "Content-Type": getMimeType(absolutePath) } });
}

// ─── Hono App ──────────────────────────────────────────

const app = new Hono();

// ─── API: Projects ─────────────────────────────────────

app.get("/api/projects", (c) => {
  return c.json(loadData().projects);
});

app.post("/api/projects", async (c) => {
  const body = await c.req.json();
  const name = (body.name as string || "").trim();
  const slug = (body.slug as string || "").trim().toLowerCase();
  const description = (body.description as string || "").trim();

  if (!name) return c.json({ error: "项目名称不能为空" }, 400);
  if (!slug) return c.json({ error: "项目标识不能为空" }, 400);
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(slug))
    return c.json({ error: "项目标识仅支持小写字母、数字和中划线，长度 3-64" }, 400);

  const data = loadData();
  if (data.projects.some((p) => p.slug === slug))
    return c.json({ error: "项目标识已存在" }, 400);

  const project: Project = {
    id: generateId(), name, slug, description,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    versions: [],
    settings: { ...DEFAULT_SETTINGS },
  };
  data.projects.push(project);
  recordEvent(data, "project.create", project);
  saveData(data);
  console.log(`[projects] 创建项目: ${name} (${slug})`);
  return c.json(project, 201);
});

app.delete("/api/projects/:id", (c) => {
  const id = c.req.param("id");
  const data = loadData();
  const idx = data.projects.findIndex((p) => p.id === id);
  if (idx === -1) return c.json({ error: "项目不存在" }, 404);

  const removed = data.projects.splice(idx, 1)[0];
  recordEvent(data, "project.delete", removed);
  saveData(data);
  const dir = join(STORAGE_DIR, id);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  console.log(`[projects] 删除项目: ${removed.name}`);
  return c.json({ ok: true });
});

app.patch("/api/projects/:id", async (c) => {
  const id = c.req.param("id");
  const data = loadData();
  const project = data.projects.find((p) => p.id === id);
  if (!project) return c.json({ error: "项目不存在" }, 404);

  const body = await c.req.json();
  if (body.spaMode !== undefined) project.settings.spaMode = !!body.spaMode;
  if (body.routingType === "hash" || body.routingType === "path") project.settings.routingType = body.routingType;

  project.updatedAt = new Date().toISOString();
  saveData(data);
  console.log(`[projects] 更新设置: ${project.name}`, project.settings);
  return c.json(project);
});

// ─── API: Versions ─────────────────────────────────────

app.get("/api/projects/:id/versions", (c) => {
  const project = loadData().projects.find((p) => p.id === c.req.param("id"));
  if (!project) return c.json({ error: "项目不存在" }, 404);
  return c.json(project);
});

app.post("/api/projects/:id/versions", async (c) => {
  const id = c.req.param("id");
  const data = loadData();
  const project = data.projects.find((p) => p.id === id);
  if (!project) return c.json({ error: "项目不存在" }, 404);

  const formData = await c.req.formData();
  const versionDesc = (formData.get("versionDesc") as string || "").trim();
  const file = formData.get("file") as File | null;
  const folderFiles = formData.getAll("folderFiles") as File[];

  const versionId = generateId();
  const versionName = versionId.substring(0, 7);
  const versionDir = join(STORAGE_DIR, id, versionId);
  mkdirSync(versionDir, { recursive: true });

  try {
    if (file && file.size > 0 && file.name.endsWith(".zip")) {
      const zipPath = join(STORAGE_DIR, `${versionId}.zip`);
      await Bun.write(zipPath, file);
      await extractZip(zipPath, versionDir);
      rmSync(zipPath, { force: true });
      flattenOutput(versionDir);
      console.log(`[versions] 上传 zip: ${project.name} / ${versionName}`);
    } else if (folderFiles.length > 0) {
      for (const f of folderFiles) {
        const relativePath = (f as any).webkitRelativePath || f.name;
        const filePath = join(versionDir, relativePath);
        mkdirSync(join(filePath, ".."), { recursive: true });
        await Bun.write(filePath, f);
      }
      flattenOutput(versionDir);
      console.log(`[versions] 上传文件夹: ${project.name} / ${versionName}`);
    } else if (file && file.size > 0) {
      return c.json({ error: "请上传 .zip 格式的文件" }, 400);
    } else {
      return c.json({ error: "请上传文件" }, 400);
    }
  } catch (err) {
    if (existsSync(versionDir)) rmSync(versionDir, { recursive: true });
    console.error(`[versions] 上传失败: ${(err as Error).message}`);
    return c.json({ error: "文件处理失败: " + (err as Error).message }, 500);
  }

  const version: Version = {
    id: versionId, name: versionName, description: versionDesc,
    createdAt: new Date().toISOString(),
    active: project.versions.length === 0,
  };
  project.versions.push(version);
  project.updatedAt = new Date().toISOString();
  recordEvent(data, "version.upload", project, version);
  saveData(data);
  return c.json(version, 201);
});

app.put("/api/projects/:id/versions/:versionId/activate", (c) => {
  const projectId = c.req.param("id");
  const versionId = c.req.param("versionId");
  const data = loadData();
  const project = data.projects.find((p) => p.id === projectId);
  if (!project) return c.json({ error: "项目不存在" }, 404);
  project.versions.forEach((v) => (v.active = v.id === versionId));
  project.updatedAt = new Date().toISOString();
  const v = project.versions.find((v) => v.id === versionId);
  recordEvent(data, "version.activate", project, v);
  saveData(data);
  console.log(`[versions] 设为正式: ${project.name} / ${v?.name}`);
  return c.json({ ok: true });
});

app.delete("/api/projects/:id/versions/:versionId", (c) => {
  const projectId = c.req.param("id");
  const versionId = c.req.param("versionId");
  const data = loadData();
  const project = data.projects.find((p) => p.id === projectId);
  if (!project) return c.json({ error: "项目不存在" }, 404);
  const vIdx = project.versions.findIndex((v) => v.id === versionId);
  if (vIdx === -1) return c.json({ error: "版本不存在" }, 404);
  const removed = project.versions.splice(vIdx, 1)[0];
  project.updatedAt = new Date().toISOString();
  recordEvent(data, "version.delete", project, removed);
  saveData(data);
  const dir = join(STORAGE_DIR, projectId, versionId);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  console.log(`[versions] 删除: ${project.name} / ${removed.name}`);
  return c.json({ ok: true });
});

// ─── API: History ──────────────────────────────────────

app.get("/api/history", (c) => {
  const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
  return c.json(loadData().history.slice(0, limit));
});

// ─── Deploy: 通过 slug 提供产物文件 ───────────────────

app.get("/deploy/*", async (c) => {
  const fullPath = c.req.path.replace("/deploy/", "");
  const parts = fullPath.split("/").filter(Boolean);

  const slug = parts[0];
  if (!slug) return c.notFound();

  const project = loadData().projects.find((p) => p.slug === slug);
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

  const versionRoot = join(STORAGE_DIR, project.id, versionId);
  const absolutePath = resolve(versionRoot, filePath);
  if (!absolutePath.startsWith(resolve(versionRoot))) return c.text("Forbidden", 403);

  const res = storageFile(absolutePath);

  // SPA fallback: 文件不存在时返回 index.html
  if (!res && project.settings.spaMode) {
    const indexPath = join(versionRoot, "index.html");
    const indexRes = storageFile(indexPath);
    if (indexRes) return indexRes;
  }

  return res ?? c.notFound();
});

// ─── Static: public 目录 (SPA fallback) ────────────────

app.use("/*", serveStatic({ root: "./public" }));

// SPA fallback: 非 API/deploy 路径返回 index.html
app.get("*", (c) => {
  const indexHtml = join(PUBLIC_DIR, "index.html");
  if (existsSync(indexHtml)) {
    return new Response(Bun.file(indexHtml), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  return c.notFound();
});

// ─── Start ─────────────────────────────────────────────

Bun.serve({ port: PORT, fetch: app.fetch });

console.log(`\n  🚀 Dist Deploy server is running\n\n  ➜  Local:   http://localhost:${PORT}\n  ➜  Deploy:  http://localhost:${PORT}/deploy/{slug}/\n`);
