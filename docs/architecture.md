# 架构文档

DeployKit 是一个单进程的静态前端产物部署平台：一个 Bun + Hono 进程同时提供管理 API、管理面板（React SPA）和已部署站点的静态托管。所有状态存储在本地文件系统（JSON 元数据 + 产物目录），无外部数据库。

## 系统总览

```
                 ┌─────────────────────────── apps/server (Bun + Hono) ───────────────────────────┐
  浏览器 ───────► │  /api/*      → routes/{projects,versions,history} → services → repositories   │
                 │  /deploy/*   → routes/deploy → deployResolver + artifactService                 │
                 │  /*          → 管理面板（apps/server/public，由打包脚本同步自 apps/web/dist）    │
                 │                                                                             │
                 │  data.json（元数据，原子写入）   .voasx/storage/{projectId}/{versionId}/（产物） │
                 └─────────────────────────────────────────────────────────────────────────────┘
                                        ▲ 类型 (ApiApp, Project, Version, ...)
                                        │
                 ┌──────────── packages/shared（跨包领域类型）────────────┐
                 └──────────────────────────────────────────────────────┘
                                        ▲
                 ┌──────── apps/web（React SPA，hono/client）─────────────┐
                 │  features/* + lib/api.ts (hc<ApiApp>)                   │
                 └────────────────────────────────────────────────────────┘
```

三个职责共用一个进程、一个端口：管理 API、管理面板静态托管、部署站点静态托管。这是"本地优先"设计的核心——无需反向代理或独立静态服务器即可工作。

## 后端模块边界（apps/server/src）

无环依赖方向：`config → errors → domain → utils → repositories → services → routes → app → index`。

| 层 | 职责 | 关键文件 |
|----|------|----------|
| `config.ts` | 环境变量解析为 `AppConfig` / `ServerConfig` | `config.ts` |
| `errors.ts` | `ApiError`（`status: 400 \| 404 \| 500`） | `errors.ts` |
| `domain/` | 纯领域规则，无 I/O | `project.ts`（slug 校验、`parseSettings`）、`version.ts`（激活、替换活跃版本）、`history.ts`（追加事件，上限 200） |
| `utils/` | 基础工具 | `id.ts`（nanoid）、`mime.ts`、`safePath.ts`（`safeJoin` 路径遍历防护） |
| `repositories/` | 持久化 | `projectRepository.ts`（接口）、`jsonProjectRepository.ts`（JSON 实现，**原子写入**：临时文件 + rename；读取时为缺失的 `settings` 补默认值，损坏文件降级为空数据） |
| `services/` | 用例 | `projectService`、`versionService`（上传/激活/删除）、`artifactService`（解压/扁平化/大小/服务文件）、`deployResolver`（纯函数解析 `/deploy/*`）；`contracts.ts` 存放 **Bun 无关**的服务接口 |
| `routes/` | HTTP 适配 | `projects` / `versions` / `history`（chained Hono sub-app，Bun 无关）、`deploy`（依赖 artifactService） |
| `app.ts` | 组合根 | `createApp(config)`：`createApiApp().route('/', deploy).onError().use('/*', 安全头).use('/*', serveStatic).get('*', SPA fallback)` |
| `api.ts` | 类型化导出 | `createApiApp` + `export type ApiApp = ReturnType<typeof createApiApp>`（Bun/Node 无关，供前端） |
| `index.ts` | 运行入口 | `Bun.serve({ fetch: createApp(config).fetch })` |

### 错误传递

服务层抛出 `ApiError(code, message, status)`（`code` 取自 `errors.ts` 的 `ErrorCode`）；`app.onError` 将其转为 `{ "error": { "code", "message" } }` 响应，其他异常降级为 `INTERNAL_ERROR` 500。路由不对服务调用包 `try/catch`（上传的清理与 500 包装在 `versionService.uploadVersion` 内）。

### 路径安全

- 上传：`safeJoin` 拒绝绝对路径、`..`、空字节、Windows 盘符逃逸；逐文件校验路径长度；上传前后校验大小与数量；任一失败清理版本目录。
- 部署：`deployResolver` 经 `safeJoin` 将请求解析到版本目录内，越界返回 `403`。

### 为什么 `api.ts` 与 `contracts.ts` 必须 Bun/Node 无关

前端 `tsc`（`types: ["vite/client"]`，无 `bun-types`）会沿 `import type { ApiApp }` 追踪到后端源文件；任何 `Bun.*` 或 `node:fs` 引用都会让前端类型检查失败。因此：
- 服务接口集中在 `services/contracts.ts`（类型 + `File`，无 Bun/Node）。
- `routes/{projects,versions,history}` 不直接 import `node:fs`——文件清理以 DI 回调（`removeProjectDir` / `removeVersionDir`）注入，实现在 `app.ts` 中。
- 部署路由依赖 `artifactService`（用 `Bun.file`），故不在 `api.ts` 图中。

## API 契约

请求/响应类型由路由处理器的 `c.json(...)` 与 `hono/validator` 推导；前端经 `hono/client` 自动获得类型，无需手写。完整端点表见根 [README](../README.md#api-接口)。错误统一为 `{ "error": { "code": ErrorCode, "message": string } }`。上传端点使用 `multipart/form-data`（`file` 或 `folderFiles[]` + `versionDesc`）。

## 存储布局

```
apps/server/
├── data.json                              # 元数据：{ projects: Project[], history: HistoryEvent[] }
├── public/                                # 管理面板（打包脚本同步自 apps/web/dist）
└── .voasx/storage/
    └── {projectId}/
        └── {versionId}/                   # 该版本的扁平化静态文件
            └── index.html, assets/, ...
```

- `data.json`：原子写入（`<file>.tmp` + `rename`）；损坏时降级为空数据，不崩溃。
- 产物目录：删除项目/版本时联动清理；`flattenOutput` 会将单层嵌套（含 `index.html` 的子目录）上移并移除 `__MACOSX`。
- 路径均可通过环境变量重定位（`DATA_FILE` / `STORAGE_DIR` / `PUBLIC_DIR`）。

## 前端结构（apps/web/src）

- `pages/DeployPage.tsx` — 薄外壳，调用 `useProjects()` 并组合各功能模块。
- `features/` — 按领域拆分：`projects`（`useProjects` 钩子、`ProjectList`、`CreateProjectDialog`）、`versions`（`VersionList`、`UploadVersionDialog`）、`settings`、`deploy`（`DeployUrl`）、`theme`、`i18n`。
- `lib/api.ts` — `hono/client` 类型化客户端；`uploadVersion` 保留 XHR 以追踪进度。
- 类型来自 `@deploykit/shared`（`src/types` 再导出）。

## 数据模型（packages/shared）

```ts
Settings  { spaMode: boolean; routingType: 'hash' | 'path' }
Version   { id; name; description; createdAt; active: boolean }
Project   { id; name; slug; description; createdAt; updatedAt; versions: Version[]; settings: Settings }
HistoryEvent { id; action; projectId; projectName; versionId; versionName; timestamp }
Data      { projects: Project[]; history: HistoryEvent[] }
```

> 注：当前版本以 `version.active` 标记活跃版本（每项目至多一个）。计划演进为 `project.activeVersionId`（见 TODO "数据模型演进"）。
