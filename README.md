# DeployKit

前端产物部署管理系统 — 上传、版本管理、一键部署静态网站。仅需 Bun 运行时，无需外部数据库服务。

## 架构

```
浏览器 ──── http://localhost:4010 ────> Bun 服务器 (Hono)
   |                                      |
   |── 管理面板 (/) ────────────────────>|── 托管 React SPA (apps/server/public/)
   |                                      |
   |── API (/api/*) ─────────────────────>|── SQLite 元数据
   |                                      |── .voasx/storage/ 文件操作
   |                                      |
   |── 部署访问 (/deploy/:slug/) ───────>|── 从 .voasx/storage/ 提供静态文件
                                          |── SPA fallback (可选)
```

1. Bun 运行 Hono 服务，`deploykit.sqlite` 以 WAL 模式存储元数据，`.voasx/storage/` 存储部署产物
2. 前端管理面板（React SPA）构建后输出到 `apps/web/dist/`，由根目录打包脚本同步到 `apps/server/public/`，再由同一服务托管
3. 用户通过管理面板上传 ZIP 或文件夹，服务端自动解压、扁平化并记录版本
4. 部署访问通过 `/deploy/{slug}/` 路径提供静态文件，支持 SPA fallback

## 功能特性

- **项目管理** — 创建/删除项目，每个项目有独立 slug 用于访问
- **版本管理** — 支持 ZIP 上传或文件夹拖拽，自动记录版本历史
- **一键部署** — 激活版本后立即可访问，支持正式/预览版本
- **SPA 支持** — 支持 Hash/Path 两种路由模式，Path 模式自动 fallback 到 index.html
- **操作历史** — 关系型追加记录所有创建、删除、发布和恢复操作，使用稳定游标增量加载
- **产物完整性** — 显式检查入口文件和目录校验和，持久化检查状态；损坏的线上版本会下线但不会自动换版
- **失败恢复** — 上传 staging、同盘原子切换与启动对账；孤儿产物进入可恢复隔离区
- **明暗主题** — 支持亮色/暗色主题切换
- **中英文** — 内置中文和英文界面，自动检测浏览器语言
- **零外部服务** — 内嵌 SQLite + 文件系统存储，无需单独部署数据库

## 快速开始

前置：安装 [Bun](https://bun.sh)，然后在仓库根目录执行：

```bash
bun install
```

### 开发模式

| 命令 | 说明 |
|------|------|
| `bun run dev:server` | 仅后端（API + 部署访问）。`apps/server/public/` 为空时不含管理面板 |
| `bun run dev:web` | 前端开发服务器（Vite，`localhost:5018`），`/api` 自动代理到 `localhost:4010` |
| `bun run dev` | 同时启动后端和 Web 开发服务器 |

全栈开发：开两个终端分别运行 `bun run dev:server` 与 `bun run dev:web`。

### 生产构建

```bash
bun run build
```

构建流程：

1. 构建所有工作区包（`@deploykit/shared`、`@deploykit/server`、`@deploykit/web`）
2. Web 构建产物输出到 `apps/web/dist/`
3. 打包脚本（`bun run package`）将 `apps/web/dist/` 同步到 `apps/server/public/`

构建完成后，运行后端即可托管管理面板（生产模式）：

```bash
bun run dev:server   # 或 bun run apps/server/src/index.ts
```

访问管理面板：`http://localhost:4010`

## 工作区结构

本项目是一个 Bun 工作区（`apps/server`、`apps/web`、`apps/desktop` + `packages/*`）。

```
deploykit/
├── apps/
│   ├── server/                    # @deploykit/server — Hono + Bun 后端
│   │   ├── src/
│   │   │   ├── index.ts           # 运行入口（Bun.serve）
│   │   │   ├── app.ts             # Hono 应用组装（createApp）
│   │   │   ├── api.ts             # /api 路由的 typed 导出（供前端 hono/client）
│   │   │   ├── config.ts          # 环境与路径配置
│   │   │   ├── errors.ts          # ApiError
│   │   │   ├── domain/            # 纯领域规则（project/version/history）
│   │   │   ├── repositories/      # 持久化接口 + SQLite / 旧 JSON 实现
│   │   │   ├── services/          # 用例（project/version/artifact/deploy）
│   │   │   ├── routes/            # HTTP 路由（projects/versions/history/deploy）
│   │   │   └── utils/             # id、mime、safePath
│   │   ├── tests/                 # API 契约测试 + 服务/领域单元测试
│   │   ├── deploykit.sqlite       # SQLite 元数据（gitignore）
│   │   ├── data.json              # 旧版元数据，仅用于首次迁移（gitignore）
│   │   ├── public/                # 管理面板（由打包脚本同步，gitignore）
│   │   └── .voasx/storage/        # 部署产物（gitignore）
│   │       └── {projectId}/{versionId}/
│   ├── desktop/                   # Electron 桌面端（Vite + React，封装管理面板）
│   └── web/                       # @deploykit/web — Vite Web 入口与构建
├── packages/
│   ├── client/                    # 共享 React 客户端、功能模块、ApiClient 与测试
│   └── shared/                    # @deploykit/shared — 跨包领域类型
├── docs/                          # 架构与开发文档
├── scripts/package-web.ts         # web → server 打包脚本
└── package.json                   # 工作区根
```

## 技术栈

**后端** ([apps/server](apps/server))
- Hono + Bun
- 内嵌 SQLite（WAL）元数据 + 文件系统产物存储
- 旧 `data.json` 在数据库为空时安全导入一次，并保留迁移备份
- 类型化路由导出（`ApiApp`）驱动前端 `hono/client`

**前端** ([apps/web](apps/web))
- React 19 + React Compiler
- Vite 8 + TypeScript
- shadcn/ui (Radix) + Tailwind CSS v4
- i18next 国际化（中/英）、lucide-react 图标
- `hono/client` 类型化 API 客户端

## 配置（环境变量）

后端配置通过环境变量覆盖（见 [apps/server/.env.example](apps/server/.env.example)，默认值定义在 `apps/server/src/config.ts`）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `4010` | 服务监听端口 |
| `DATABASE_FILE` | `apps/server/deploykit.sqlite` | SQLite 数据库路径 |
| `DATA_FILE` | `apps/server/data.json` | 旧 JSON 数据路径，仅用于首次迁移 |
| `STORAGE_DIR` | `apps/server/.voasx/storage` | 部署产物存储目录 |
| `PUBLIC_DIR` | `apps/server/public` | 管理面板静态文件目录 |
| `MANAGEMENT_BASE_URL` | 开发环境可不设 | 管理面板与 API 的可信源；生产必填 |
| `DEPLOY_BASE_URL` | 开发环境可不设 | 不可信部署产物的独立源；生产必填且必须与管理源不同 |
| `MAX_ZIP_SIZE` | `104857600` (100MB) | 单个 ZIP 上传上限（字节） |
| `MAX_EXTRACTED_SIZE` | `104857600` (100MB) | 解压/文件夹上传总大小上限 |
| `MAX_FILE_COUNT` | `1000` | 单次上传文件数量上限 |
| `MAX_PATH_LENGTH` | `1000` | 单个相对路径长度上限（字符） |
| `MAX_COMPRESSION_RATIO` | `200` | ZIP 单条目最大声明压缩比 |
| `MAX_UPLOAD_REQUEST_SIZE` | `105906176` | 完整 multipart 请求上限；默认比产物上限多 1MB |
| `MAX_CONCURRENT_UPLOADS` | `4` | 单进程同时处理的上传数 |
| `MAX_CONCURRENT_UPLOADS_PER_USER` | `2` | 单用户同时上传数 |
| `MAX_CONCURRENT_UPLOADS_PER_PROJECT` | `1` | 单项目同时上传数 |
| `MAX_STORAGE_SIZE` | `21474836480` (20GB) | 当前实例全部已保存解压产物的容量上限 |
| `MAX_STORAGE_SIZE_PER_USER` | `10737418240` (10GB) | 按项目创建者归属计算的用户容量上限 |
| `MAX_STORAGE_SIZE_PER_PROJECT` | `5368709120` (5GB) | 单项目已保存解压产物的容量上限 |
| `STAGING_RETENTION_HOURS` | `24` | 未完成上传暂存区的最短保留时间 |
| `RECOVERY_RETENTION_HOURS` | `168` | 已提交删除和孤儿隔离区的最短保留时间 |

前端（[apps/web/.env.example](apps/web/.env.example)）：

| 变量 | 说明 |
|------|------|
| `VITE_DEPLOY_BASE_URL` | 部署产物的独立公开基础 URL |
| `VITE_PUBLIC_BASE_URL` | 旧变量兼容入口；新配置应使用 `VITE_DEPLOY_BASE_URL` |

## API 接口

所有接口前缀为 `/api`。除登录、注册、登出和桌面授权码交换外，API 需要
持久化 session；浏览器使用 HttpOnly Cookie，桌面使用 bearer token。令牌中的
`jti` 必须对应 SQLite 中未过期、未撤销的会话，
浏览器不会把 bearer token 写入 localStorage。权限分为
`admin` / `developer` / `viewer`。错误响应格式：
`{ "error": { "code": "ERROR_CODE", "message": "..." } }`（错误码见
`apps/server/src/errors.ts`）。请求/响应类型由后端路由推导，前端经
`hono/client` 自动获得类型。

`admin` 可读取和管理全部项目；`developer` 可创建项目，但只能读取自己
所属的项目，并按项目内 `owner/member` 角色写入；`viewer` 只能读取自己
所属的项目。开放注册创建的是可自主管理项目的 `developer`，生产默认关闭注册。

生产部署必须把同一个 Bun 进程反向代理到两个不同的浏览器源，并保留原始
`Host`：`MANAGEMENT_BASE_URL` 只提供管理面板、API 和健康检查，
`DEPLOY_BASE_URL` 只提供 `/deploy/*` 和健康检查。这样上传产物中的脚本无法
读取管理域的 Cookie、localStorage 或 API 响应。

### 认证

| 方法 | 路径 | 说明 | 请求体 |
|------|------|------|--------|
| POST | `/api/auth/login` | 登录并设置 session cookie | `{ email, password }` |
| POST | `/api/auth/logout` | 撤销当前 session 并清除 cookie | — |
| GET | `/api/auth/sessions` | 列出当前用户的浏览器/桌面会话 | — |
| DELETE | `/api/auth/sessions/:sessionId` | 撤销自己的指定会话 | — |
| POST | `/api/auth/logout-all` | 撤销当前用户的全部会话 | — |
| GET | `/api/me` | 获取当前用户 | — |

### 项目

| 方法 | 路径 | 说明 | 请求体 |
|------|------|------|--------|
| GET | `/api/projects` | 获取项目列表 | — |
| POST | `/api/projects` | 创建项目（developer/admin） | `{ name, slug, description }` |
| PATCH | `/api/projects/:id` | 更新项目信息（项目 owner/admin） | `{ name?, slug?, description? }` |
| PATCH | `/api/projects/:id/settings` | 更新项目设置（项目 owner/admin） | `{ spaMode, routingType }` |
| DELETE | `/api/projects/:id` | 删除项目；产物先进入可恢复区（项目 owner/admin） | — |
| GET | `/api/projects/:id/versions` | 获取项目（项目成员/admin） | — |
| GET | `/api/projects/:id/users/search` | 搜索成员候选人（项目 owner/admin） | `?q=email` |

### 版本

| 方法 | 路径 | 说明 | 请求体 |
|------|------|------|--------|
| POST | `/api/projects/:id/versions` | 上传新版本（developer 项目成员/admin，预览态） | `FormData`（`file` 或 `folderFiles[]`） |
| POST | `/api/projects/:id/versions/:vid/publish` | 发布为生产版本（developer 项目成员/admin） | `{ expectedActiveVersionId: string \| null }` |
| POST | `/api/projects/:id/versions/:vid/rollback` | 手动回滚到指定版本（developer 项目成员/admin） | `{ expectedActiveVersionId: string \| null }` |
| PUT | `/api/projects/:id/versions/:vid/activate` | 兼容旧激活语义（developer 项目成员/admin） | `{ expectedActiveVersionId: string \| null }` |
| DELETE | `/api/projects/:id/versions/:vid` | 删除版本；产物先进入可恢复区，删除线上版本会下线项目，不自动选择替代版本 | — |

发布与回滚采用乐观并发控制：服务端只在
`expectedActiveVersionId` 与当前线上版本一致时执行；否则返回
`409 RELEASE_CONFLICT`，调用方应刷新项目后由用户重新确认。发布前还会检查版本
状态、根 `index.html` 与目录 checksum，避免把缺失或已被修改的产物切到线上。

### 历史

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/projects/:id/history?limit=50&cursor=...` | 获取指定项目的操作历史页（单页上限 200） |

历史响应为 `{ items: HistoryEvent[], nextCursor: string | null }`。下一页把
`nextCursor` 原样作为 `cursor` 传回；游标失效时返回
`INVALID_HISTORY_CURSOR`，应重新读取第一页。

### 部署访问

- **正式版本**: `/deploy/{slug}/`
- **指定版本**: `/deploy/{slug}/{versionId}/`

详细指导见 [docs/vite-deployment.md](docs/vite-deployment.md)。

## 测试

```bash
bun run test          # 全部（shared / server / web）
bun run verify        # Biome + 类型检查 + 测试 + 生产构建
```

- 后端：`bun test`（[apps/server/tests](apps/server/tests)）— API 契约 + 服务/领域单元测试
- 前端：Vitest + React Testing Library（[apps/web/tests/unit](apps/web/tests/unit)）

本地与 CI 共享同一个质量入口：`bun run verify`。
CI 额外保留 14 天的验证日志 `deploykit-verify-{commit}`，并在成功时保留
`deploykit-web-{commit}` Web 构建产物。

## 文档

- [docs/architecture.md](docs/architecture.md) — 系统总览、后端模块边界、API 契约、存储布局
- [docs/development.md](docs/development.md) — 工作区命令、测试、本地上传/预览流程
- [docs/vite-deployment.md](docs/vite-deployment.md) — 部署 Vite 应用的 `base`、hash/path 路由、SPA fallback

## License

MIT
