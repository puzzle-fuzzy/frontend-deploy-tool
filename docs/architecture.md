# 架构文档

DeployKit 是一个单进程的静态前端产物部署平台：一个 Bun + Hono 进程同时
提供管理 API、管理面板（React SPA）和已部署站点的静态托管。生产环境通过
两个不同的浏览器源划分信任边界：可信管理源只提供 UI/API，不可信部署源只
提供上传产物。元数据存储在内嵌 SQLite，部署产物保存在本地文件系统。

## 系统总览

```
                 ┌─────────────────────────── apps/server (Bun + Hono) ───────────────────────────┐
  管理源 ───────► │  /api/*      → routes/{projects,versions,history} → services → repositories   │
                 │  /*          → 管理面板（apps/server/public，由打包脚本同步自 apps/web/dist）    │
  部署源 ───────► │  /deploy/*   → routes/deploy → deployResolver + artifactService                 │
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

三个职责仍共用一个进程、一个端口。开发环境未配置双域时保留同源兼容模式；
生产环境必须由反向代理将两个域名转发到该端口并保留原始 `Host`。双域是安全
边界而不是服务拆分，因此不会增加数据库或应用进程数量。

## 后端模块边界（apps/server/src）

无环依赖方向：`config → errors → domain → utils → repositories → services → routes → app → index`。

| 层 | 职责 | 关键文件 |
|----|------|----------|
| `config.ts` | 环境变量解析与生产启动门禁（secret/password/双域/数值严格校验） | `config.ts` |
| `errors.ts` | 服务端 `ApiError`；稳定错误码定义在 `@deploykit/shared/errors.ts` | `errors.ts` |
| `domain/` | 纯领域规则，无 I/O | `project.ts`（slug 校验、`parseSettings`）、`version.ts`（激活、替换活跃版本）、`history.ts`（追加事件，上限 200） |
| `utils/` | 基础工具 | `id.ts`（nanoid）、`mime.ts`、`safePath.ts`（`safeJoin` 路径遍历防护） |
| `repositories/` | 持久化 | `projectRepository.ts`（原子 `mutate` 契约）、`sqliteProjectRepository.ts`（默认 SQLite 文档仓储，WAL + `IMMEDIATE` 事务）、`jsonProjectRepository.ts`（旧数据导入与隔离测试）；两种实现均复用领域迁移器 |
| `services/` | 用例 | `projectService`、`versionService`（上传/发布/回滚/删除）、`artifactService`（解压/扁平化/大小/服务文件）、`storageReconciler`（启动时元数据/产物对账）、`deployResolver`（纯函数解析 `/deploy/*`）；`contracts.ts` 存放 **Bun 无关**的服务接口 |
| `routes/` | HTTP 适配 | `projects` / `versions` / `history`（chained Hono sub-app，Bun 无关）、`deploy`（依赖 artifactService） |
| `app.ts` | 组合根 | `createApp(config)`：配置校验、信任域路由、服务装配、`/health/*`、部署路由、错误边界、安全头、静态托管与 SPA fallback |
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

### 上传资源与路径安全

- 请求：Hono `bodyLimit` 在 `formData()` 前限制完整 multipart 大小；上传 gate
  分别限制全局、用户和项目并发数。
- ZIP：`fflate.Unzip` 从临时 ZIP 分块读取，不再把压缩包和所有解压结果同时
  放入内存；在条目发现时检查数量、路径长度、声明解压体积和压缩比，在每个
  输出块检查实际累计体积。
- 文件夹：全部路径、数量和总大小预检通过后才开始写入。
- 路径：`safeJoin` 拒绝绝对路径、`..`、空字节、Windows 盘符逃逸；任一失败
  清理本次生成的产物。
- 部署：`deployResolver` 经 `safeJoin` 将请求解析到版本目录内，越界返回 `403`。

### 为什么 `api.ts` 与 `contracts.ts` 必须 Bun/Node 无关

前端 `tsc`（`types: ["vite/client"]`，无 `bun-types`）会沿 `import type { ApiApp }` 追踪到后端源文件；任何 `Bun.*` 或 `node:fs` 引用都会让前端类型检查失败。因此：
- 服务接口集中在 `services/contracts.ts`（类型 + `File`，无 Bun/Node）。
- `routes/{projects,versions,history}` 不直接 import `node:fs`。项目目录清理以
  DI 回调（`removeProjectDir`）注入，实现在 `app.ts` 中；版本目录清理由
  `versionService` 负责，和版本生命周期保持在同一用例边界。
- 部署路由依赖 `artifactService`（用 `Bun.file`），故不在 `api.ts` 图中。

### 浏览器信任边界

- `MANAGEMENT_BASE_URL`：管理 UI、`/api/*`、`/health/*`。
- `DEPLOY_BASE_URL`：`/deploy/*`、`/health/*`。
- 其他 Host、部署源上的 API、管理源上的产物路由都返回 404。
- 浏览器 API 客户端只使用 HttpOnly session Cookie，不持久化 bearer token。
- Electron 仍通过一次性授权码换取进程内 bearer token；持久化可撤销设备会话
  在身份阶段接入。

### 授权边界

`domain/authorization.ts` 是全局角色与项目角色组合规则的唯一真源：

- `admin` 可读取和管理全部项目。
- `developer` 可创建项目；项目写操作还要求 `owner/member` 身份。
- `viewer` 只能读取自己所属的项目，即使被加入为 member 也不能写入。
- 项目列表、版本读取和历史读取在 `ProjectService` 接收 actor 并过滤，避免
  新路由忘记挂中间件而泄露数据。
- 用户搜索必须位于 `/api/projects/:id/users/search`，只允许该项目 owner
  或 admin 使用，避免全局账号枚举。

## API 契约

请求/响应类型由路由处理器的 `c.json(...)` 与 `hono/validator` 推导；前端经 `hono/client` 自动获得类型，无需手写。完整端点表见根 [README](../README.md#api-接口)。错误统一为 `{ "error": { "code": ErrorCode, "message": string } }`。上传端点使用 `multipart/form-data`（`file` 或 `folderFiles[]` + `versionDesc`）。

历史接口返回 `{ items, nextCursor }`。`nextCursor` 是只包含历史事件 ID
的版本化 Base64URL 不透明令牌；下一页从该事件之后继续，因此列表头部新增事件
不会导致重复或跳项。历史仍保留最近 200 条，游标对应事件离开保留窗口后返回
`INVALID_HISTORY_CURSOR`，客户端保留已显示内容并提示刷新或重试。

## 存储布局

```
apps/server/
├── deploykit.sqlite                       # 版本化状态文档：{ projects, users, history }
├── data.json                              # 旧版本数据，仅在 SQLite 为空时导入一次
├── public/                                # 管理面板（打包脚本同步自 apps/web/dist）
└── .voasx/storage/
    ├── .staging/                          # 上传处理中间目录（启动时清理）
    └── {projectId}/
        └── {versionId}/                   # 该版本的扁平化静态文件
            └── index.html, assets/, ...
```

- `deploykit.sqlite`：启用 WAL、`synchronous=NORMAL` 与 `busy_timeout`。当前采用单行版本化状态文档；写用例通过同步 `mutate` + `IMMEDIATE` 事务防止并发覆盖，适合单节点/共享本机数据库；需要多节点查询扩展时再关系化拆表。
- 旧 `data.json`：仅在 SQLite 状态行不存在时导入，导入前创建 `.sqlite-migration.bak`，原文件保持不变。
- 产物目录：删除项目/版本时联动清理；`flattenOutput` 会将单层嵌套（含 `index.html` 的子目录）上移并移除 `__MACOSX`。
- 上传先写入同一存储卷的 `.staging/{versionId}`，完成入口、大小、数量与
  checksum 校验后，通过 `rename` 原子移动到正式版本目录，再提交 SQLite 元数据。
  元数据提交失败会删除正式目录。
- 应用开始服务前执行一次对账：清理中断 staging 与旧 ZIP 临时文件；没有元数据
  引用的正式产物移动到 `.recovery/orphans/`，不做不可恢复删除。元数据存在但
  缺少 `index.html` 的版本标记为 `failed` 并记录 `version.reconcile`。若缺失
  版本原本在线，只会清空 `activeVersionId`，不会自动发布另一个版本。
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
- `production`：`SESSION_SECRET`（至少 32 字符）、`ADMIN_PASSWORD`、
  `MANAGEMENT_BASE_URL` 和 `DEPLOY_BASE_URL` 必填，两个 URL 必须不同源，
  注册默认关闭；任何非法端口、大小、数量、布尔或 URL 配置都会中止启动。
- `GET /health/live`：`204`，仅表示 HTTP 进程存活。
- `GET /health/ready`：实际读取元数据仓库，成功返回 `{ "status": "ok" }`。
