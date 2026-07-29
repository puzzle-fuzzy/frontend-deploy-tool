# DeployKit Server

`@deploykit/server` — 基于 Hono + Bun 的前端产物部署服务。负责托管上传的前端构建产物并通过 URL 分发，并托管管理面板。

## 架构

```
HTTP 请求
   |
   +-- /api/* ──────────> API 路由（auth / projects / versions / history）
   |                         |-- domain/ 纯规则
   |                         |-- services/ 用例
   |                         |-- repositories/ SQLite 持久化（WAL + 原子 mutate）
   |                         |-- .voasx/storage/ 文件操作
   |
   +-- /deploy/:slug/* ─> 部署路由（deployResolver + artifactService）
   |                         |-- 解析 slug → 项目 → 版本
   |                         |-- 从 .voasx/storage/ 安全地提供静态文件
   |                         |-- SPA fallback（可选）
   |
   +-- /* ──────────────> 管理面板 (public/index.html) + 安全响应头
```

应用组装见 [src/app.ts](src/app.ts) 的 `createApp(config)`；运行入口为 [src/index.ts](src/index.ts)（`Bun.serve`）。`createApp` 与启动分离，便于使用 `hono/testing` 直接测试。

## 功能特性

- **项目 CRUD** — 创建、删除项目；slug 校验（3–64 位小写字母/数字/连字符）
- **版本上传与发布** — ZIP/文件夹上传保持预览态；显式发布/手动回滚使用线上版本前置条件，并在发布前复核入口文件与 checksum
- **发布/回滚** — 上传默认进入预览态；显式 publish/rollback 后才可通过 `/deploy/{slug}/` 访问；项目同时只保留一个正式版本
- **指定版本预览** — `/deploy/{slug}/{versionId}/`
- **SPA fallback** — 每个项目可配置 hash/path 两种路由模式
- **操作历史** — SQLite 追加记录创建、更新、上传、发布、回滚、删除等操作，使用稳定游标分页
- **认证与角色** — 可撤销的浏览器 session / 桌面 bearer 认证；`admin` 全局管理，
  `developer` 结合项目 `owner/member` 授权，`viewer` 仅可读取所属项目
- **运行检查** — `/health/live`（进程存活）与 `/health/ready`（SQLite/仓库可读）
- **请求追踪** — 每个响应携带 `X-Request-Id`，也会接受并回传有效的上游请求编号
- **路径安全** — `safeJoin` 拦截路径遍历；上传有大小/数量/路径长度上限
- **类型化路由** — [src/api.ts](src/api.ts) 导出 `ApiApp`，供前端 `hono/client` 自动推导请求/响应类型

## 模块边界

```
src/
├── index.ts                  # 运行入口（Bun.serve）
├── app.ts                    # createApp：组装 API/部署路由 + 静态托管 + onError
├── api.ts                    # createApiApp + 导出 type ApiApp（Bun/Node 无关）
├── config.ts                 # 环境变量解析（AppConfig / ServerConfig）
├── errors.ts                 # ApiError（onError 转为 { error } 响应）
├── domain/                   # 纯领域规则（project / version / history）
├── middleware/               # 认证、session、角色授权
├── repositories/             # ProjectRepository + SQLite WAL/JSON 实现
├── services/                 # 用例 + 契约（contracts.ts：Bun 无关的服务接口）
│   ├── projectService.ts     # 项目用例
│   ├── versionService.ts     # 版本上传/发布/回滚/删除
│   ├── artifactService.ts    # 解压/扁平化/大小/服务文件
│   └── deployResolver.ts     # /deploy/* 路径解析（纯函数）
├── routes/                   # HTTP 路由（chained Hono sub-apps）
│   ├── projects.ts  versions.ts  history.ts   # /api（Bun 无关）
│   └── deploy.ts                                       # /deploy
└── utils/                    # id（nanoid）、mime、safePath
```

依赖方向（无环）：`config → errors → domain → utils → repositories → services → routes → app → index`。

## 快速开始

```bash
# 在仓库根目录
bun install
bun run dev:server          # 仅后端
```

服务默认运行在 `http://localhost:4010`。如需管理面板，先在仓库根目录运行 `bun run build`，打包脚本会将前端构建同步到 `apps/server/public/`。

## 配置

通过环境变量覆盖（见 [.env.example](.env.example)，默认值在 [src/config.ts](src/config.ts)）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DEPLOYKIT_ENV` / `NODE_ENV` | `development` | `development` / `test` / `production`；生产模式启用启动门禁 |
| `PORT` | `4010` | 监听端口；配置无效时直接拒绝启动 |
| `DATABASE_FILE` | `apps/server/deploykit.sqlite` | SQLite 元数据文件（WAL） |
| `DATA_FILE` | `apps/server/data.json` | 旧 JSON 数据；仅在 SQLite 为空时导入一次并备份 |
| `STORAGE_DIR` | `apps/server/.voasx/storage` | 部署产物目录 |
| `PUBLIC_DIR` | `apps/server/public` | 管理面板静态目录 |
| `MANAGEMENT_BASE_URL` | 开发可不设 | 管理 UI/API 可信源；生产必填，`https://` 时 Cookie 标记 Secure |
| `DEPLOY_BASE_URL` | 开发可不设 | 部署产物不可信源；生产必填且必须与管理源不同 |
| `SESSION_SECRET` | 开发环境临时生成 | 生产必填且至少 32 个字符 |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@deploykit.local` / 开发环境随机生成 | 空用户库首次启动时创建管理员；生产密码必填 |
| `REGISTRATION_ENABLED` | 开发 `true`、生产 `false` | 是否开放自助注册 |
| `MAX_ZIP_SIZE` / `MAX_EXTRACTED_SIZE` / `MAX_FILE_COUNT` / `MAX_PATH_LENGTH` | 100MB / 100MB / 1000 / 1000 | 上传上限 |
| `MAX_COMPRESSION_RATIO` / `MAX_UPLOAD_REQUEST_SIZE` | 200 / 101MB | ZIP 单条目压缩比与完整 multipart 上限 |
| `MAX_CONCURRENT_UPLOADS` / `MAX_CONCURRENT_UPLOADS_PER_USER` / `MAX_CONCURRENT_UPLOADS_PER_PROJECT` | 4 / 2 / 1 | 单进程、用户、项目上传并发预算 |

所有显式配置值都会严格校验。拼写错误（例如无效布尔值）、非法 URL 或越界数字不会被静默替换成默认值。

生产环境由反向代理把两个不同域名转发到同一服务端口并保留原始 `Host`。
管理源拒绝 `/deploy/*`，部署源拒绝 UI 和 `/api/*`。

## 部署路由

- `/deploy/:slug/` — 当前激活版本
- `/deploy/:slug/:versionId/` — 指定版本预览

启用 SPA 模式后，请求文件不存在会返回 `index.html`，支持前端路由框架。

### Slug 校验

- 正则：`/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/`
- 长度 3–64，小写字母/数字/连字符，不以连字符开头或结尾，且全局唯一

## 上传处理

- **ZIP**：multipart 请求先限长，写入临时文件后用 `fflate.Unzip` 分块解压；
  每个条目在写入前检查路径、数量、声明体积和压缩比，每个输出块检查实际累计
  体积，失败清理已生成文件。
- **文件夹**：先检查全部 `webkitRelativePath`、文件数与总大小，再保留相对
  路径写入并执行扁平化。
- **并发**：全局、单用户和单项目分别受 in-process semaphore 约束；容量不足
  返回稳定错误 `UPLOAD_BUSY` 和 429。
- **上线门禁**：上传只创建预览版本；生产版本必须通过显式 publish/rollback
- 任一阶段失败都会清理版本目录并返回 `500 File processing failed: ...`

## API

见根 [README](../../README.md#api-接口)。错误格式：`{ "error": { "code": "ERROR_CODE", "message": "..." } }`（错误码定义在 [src/errors.ts](src/errors.ts) 的 `ErrorCode`）。

公开运行端点：

- `GET /health/live` — 返回 `204`，只表示进程可处理 HTTP。
- `GET /health/ready` — 返回 `{ "status": "ok" }`，并实际读取元数据仓库。

所有响应包含 `X-Request-Id`。调用方可传入合法的 `X-Request-Id` 以串联代理、服务端日志和客户端报错。

## 测试

```bash
bun test                    # 在 apps/server
```

覆盖：API 契约（`tests/api`）、服务/领域/工具单元测试（`tests/services`）。

## License

MIT
