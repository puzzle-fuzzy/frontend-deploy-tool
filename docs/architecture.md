# 架构文档

DeployKit 是一个单进程的静态前端产物部署平台：一个 Bun + Hono 进程同时提供管理 API、管理面板（React SPA）和已部署站点的静态托管。元数据存储在内嵌 SQLite，部署产物保存在本地文件系统，无需外部数据库服务。

## 系统总览

```
                 ┌─────────────────────────── apps/server (Bun + Hono) ───────────────────────────┐
  浏览器 ───────► │  /api/*      → routes/{projects,versions,history} → services → repositories   │
                 │  /deploy/*   → routes/deploy → deployResolver + artifactService                 │
                 │  /*          → 管理面板（apps/server/public，由打包脚本同步自 apps/web/dist）    │
                 │                                                                             │
                 │  deploykit.sqlite（WAL）          .voasx/storage/{projectId}/{versionId}/（产物） │
                 └─────────────────────────────────────────────────────────────────────────────┘
                                        ▲ 类型 (ApiApp, Project, Version, ...)
                                        │
                 ┌──────────── packages/shared（跨包领域类型）────────────┐
                 └──────────────────────────────────────────────────────┘
                                        ▲
                ┌──────── apps/web（React SPA，hono/client）─────────────┐
                │  features/* + shared/api.ts (hc<ApiApp>)                │
                 └────────────────────────────────────────────────────────┘
```

三个职责共用一个进程、一个端口：管理 API、管理面板静态托管、部署站点静态托管。这是"本地优先"设计的核心——无需反向代理或独立静态服务器即可工作。

## 后端模块边界（apps/server/src）

无环依赖方向：`config → errors → domain → utils → repositories → services → routes → app → index`。

| 层 | 职责 | 关键文件 |
|----|------|----------|
| `config.ts` | 环境变量解析与生产启动门禁（secret/password/URL/数值严格校验） | `config.ts` |
| `errors.ts` | 服务端 `ApiError`；稳定错误码定义在 `@deploykit/shared/errors.ts` | `errors.ts` |
| `domain/` | 纯领域规则，无 I/O | `project.ts`（slug 校验、`parseSettings`）、`version.ts`（激活、替换活跃版本）、`history.ts`（追加事件，上限 200） |
| `utils/` | 基础工具 | `id.ts`（nanoid）、`mime.ts`、`safePath.ts`（`safeJoin` 路径遍历防护） |
| `repositories/` | 持久化 | `projectRepository.ts`（原子 `mutate` 契约）、`sqliteProjectRepository.ts`（默认 SQLite 文档仓储，WAL + `IMMEDIATE` 事务）、`jsonProjectRepository.ts`（旧数据导入与隔离测试）；两种实现均复用领域迁移器 |
| `services/` | 用例 | `projectService`、`versionService`（上传/发布/回滚/删除）、`artifactService`（解压/扁平化/大小/服务文件）、`deployResolver`（纯函数解析 `/deploy/*`）；`contracts.ts` 存放 **Bun 无关**的服务接口 |
| `routes/` | HTTP 适配 | `projects` / `versions` / `history`（chained Hono sub-app，Bun 无关）、`deploy`（依赖 artifactService） |
| `app.ts` | 组合根 | `createApp(config)`：配置校验、服务装配、`/health/*`、部署路由、错误边界、安全头、静态托管与 SPA fallback |
| `api.ts` | 类型化导出 | `createApiApp` + `export type ApiApp = ReturnType<typeof createApiApp>`（Bun/Node 无关，供前端） |
| `index.ts` | 运行入口 | `Bun.serve({ fetch: createApp(config).fetch })` |

### 错误传递

稳定错误码与错误信封定义在 `packages/shared/src/errors.ts`。服务层抛出
`ApiError(code, message, status)`；`app.onError` 将其转为
`{ "error": { "code", "message" } }`，其他异常降级为
`INTERNAL_ERROR` 500。Web 将其解析为带 `status/code/requestId` 的
`ApiClientError`；Electron main 先解析为 `ServerError`，再通过显式
`IpcResult` 传给 renderer 重建 `ApiClientError`，避免 Electron 丢失自定义字段。
旧服务端只有英文 message 时仍保留兼容回退，但本地化优先使用稳定 code。

每个响应都携带 `X-Request-Id`；有效的上游请求编号会原样回传，客户端错误对象会保留它用于故障定位。

### 原子写边界

所有修改 `Data` 的业务用例必须使用
`ProjectRepository.mutate(operation)`，不得在服务中自行 `load()` 后再
`save()`。SQLite 实现在读取前获得 `BEGIN IMMEDIATE` 写事务，保证 slug、
邮箱唯一性、成员角色、发布状态和历史事件基于同一个最新快照提交；回调抛错时
整个变更回滚。文件解压等耗时 I/O 位于事务外，最终元数据提交失败时清理新产物。

### 路径安全

- 上传：`safeJoin` 拒绝绝对路径、`..`、空字节、Windows 盘符逃逸；逐文件校验路径长度；上传前后校验大小与数量；任一失败清理版本目录。
- 部署：`deployResolver` 经 `safeJoin` 将请求解析到版本目录内，越界返回 `403`。

### 为什么 `api.ts` 与 `contracts.ts` 必须 Bun/Node 无关

前端 `tsc`（`types: ["vite/client"]`，无 `bun-types`）会沿 `import type { ApiApp }` 追踪到后端源文件；任何 `Bun.*` 或 `node:fs` 引用都会让前端类型检查失败。因此：
- 服务接口集中在 `services/contracts.ts`（类型 + `File`，无 Bun/Node）。
- `routes/{projects,versions,history}` 不直接 import `node:fs`。项目目录清理以
  DI 回调（`removeProjectDir`）注入，实现在 `app.ts` 中；版本目录清理由
  `versionService` 负责，和版本生命周期保持在同一用例边界。
- 部署路由依赖 `artifactService`（用 `Bun.file`），故不在 `api.ts` 图中。

## API 契约

请求/响应类型由路由处理器的 `c.json(...)` 与 `hono/validator` 推导；前端经 `hono/client` 自动获得类型，无需手写。完整端点表见根 [README](../README.md#api-接口)。错误统一为 `{ "error": { "code": ErrorCode, "message": string } }`。上传端点使用 `multipart/form-data`（`file` 或 `folderFiles[]` + `versionDesc`）。

## 存储布局

```
apps/server/
├── deploykit.sqlite                       # 版本化状态文档：{ projects, users, history }
├── data.json                              # 旧版本数据，仅在 SQLite 为空时导入一次
├── public/                                # 管理面板（打包脚本同步自 apps/web/dist）
└── .voasx/storage/
    └── {projectId}/
        └── {versionId}/                   # 该版本的扁平化静态文件
            └── index.html, assets/, ...
```

- `deploykit.sqlite`：启用 WAL、`synchronous=NORMAL` 与 `busy_timeout`。当前采用单行版本化状态文档；写用例通过同步 `mutate` + `IMMEDIATE` 事务防止并发覆盖，适合单节点/共享本机数据库；需要多节点查询扩展时再关系化拆表。
- 旧 `data.json`：仅在 SQLite 状态行不存在时导入，导入前创建 `.sqlite-migration.bak`，原文件保持不变。
- 产物目录：删除项目/版本时联动清理；`flattenOutput` 会将单层嵌套（含 `index.html` 的子目录）上移并移除 `__MACOSX`。
- 路径均可通过环境变量重定位（`DATABASE_FILE` / `DATA_FILE` / `STORAGE_DIR` / `PUBLIC_DIR`）。

## 前端结构（packages/client/src）

- `App.tsx` — 共享 Provider 与应用路由入口；Web 与 Electron 复用同一客户端。
- `features/` — 按领域拆分：认证、项目、版本、设置、成员与历史时间线。
- `api/` — 传输无关 `ApiClient` 契约；Web 使用 `hono/client`，Electron 通过 IPC 实现同一接口。
- 类型来自 `@deploykit/shared`（`src/types` 再导出）。

## 数据模型（packages/shared）

```ts
Settings  { spaMode: boolean; routingType: 'hash' | 'path' }
Version   { id; name; description; createdAt; size; fileCount; sourceType; status; publishedAt; publishedBy; checksum }
Project   { id; name; slug; description; createdAt; updatedAt; versions: Version[]; activeVersionId: string | null; settings: Settings }
HistoryEvent { id; action; projectId; projectName; versionId; versionName; timestamp; actorId; metadata? }
User      { id; name; email; passwordHash; role; createdAt; updatedAt }
Data      { schemaVersion; projects: Project[]; users: User[]; history: HistoryEvent[] }
```

> 注：`project.activeVersionId` 是线上版本唯一真源；`version.status` 用于展示、
> 筛选与发布语义同步，不应重新引入 `version.active`。

## 运行模式与探针

- `development`（默认）：允许临时会话密钥与随机首个管理员密码，默认开放注册。
- `test`：与开发默认一致，但显式标识测试运行。
- `production`：`SESSION_SECRET`（至少 32 字符）和 `ADMIN_PASSWORD` 必填，注册默认关闭；任何非法端口、大小、数量、布尔或 URL 配置都会中止启动。
- `GET /health/live`：`204`，仅表示 HTTP 进程存活。
- `GET /health/ready`：实际读取元数据仓库，成功返回 `{ "status": "ok" }`。
