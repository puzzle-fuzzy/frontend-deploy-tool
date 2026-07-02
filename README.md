# DeployKit

前端产物部署管理系统 — 上传、版本管理、一键部署静态网站。仅需 Bun 运行时，无需外部数据库。

## 架构

```
浏览器 ──── http://localhost:3000 ────> Bun 服务器 (Hono)
   |                                      |
   |── 管理面板 (/) ────────────────────>|── 托管 React SPA (apps/server/public/)
   |                                      |
   |── API (/api/*) ─────────────────────>|── data.json 读写
   |                                      |── .voasx/storage/ 文件操作
   |                                      |
   |── 部署访问 (/deploy/:slug/) ───────>|── 从 .voasx/storage/ 提供静态文件
                                          |── SPA fallback (可选)
```

1. Bun 运行 Hono 服务，`data.json` 存储元数据，`.voasx/storage/` 存储部署产物
2. 前端管理面板（React SPA）构建后输出到 `apps/web/dist/`，由根目录打包脚本同步到 `apps/server/public/`，再由同一服务托管
3. 用户通过管理面板上传 ZIP 或文件夹，服务端自动解压、扁平化并记录版本
4. 部署访问通过 `/deploy/{slug}/` 路径提供静态文件，支持 SPA fallback

## 功能特性

- **项目管理** — 创建/删除项目，每个项目有独立 slug 用于访问
- **版本管理** — 支持 ZIP 上传或文件夹拖拽，自动记录版本历史
- **一键部署** — 激活版本后立即可访问，支持正式/预览版本
- **SPA 支持** — 支持 Hash/Path 两种路由模式，Path 模式自动 fallback 到 index.html
- **操作历史** — 记录所有创建、删除、激活操作（上限 200 条）
- **明暗主题** — 支持亮色/暗色主题切换
- **中英文** — 内置中文和英文界面，自动检测浏览器语言
- **零外部依赖** — 仅需 Bun 运行时，无数据库（JSON + 文件系统存储）

## 快速开始

前置：安装 [Bun](https://bun.sh)，然后在仓库根目录执行：

```bash
bun install
```

### 开发模式

| 命令 | 说明 |
|------|------|
| `bun run dev:server` | 仅后端（API + 部署访问）。`apps/server/public/` 为空时不含管理面板 |
| `bun run dev:web` | 前端开发服务器（Vite，`localhost:5173`），`/api` 自动代理到 `localhost:3000` |
| `bun run dev` | 同 `dev:server` |

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

访问管理面板：`http://localhost:3000`

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
│   │   │   ├── repositories/      # 持久化接口 + JSON 实现（原子写入）
│   │   │   ├── services/          # 用例（project/version/artifact/deploy）
│   │   │   ├── routes/            # HTTP 路由（projects/versions/history/deploy）
│   │   │   └── utils/             # id、mime、safePath
│   │   ├── tests/                 # API 契约测试 + 服务/领域单元测试
│   │   ├── data.json              # 项目元数据（gitignore）
│   │   ├── public/                # 管理面板（由打包脚本同步，gitignore）
│   │   └── .voasx/storage/        # 部署产物（gitignore）
│   │       └── {projectId}/{versionId}/
│   ├── desktop/                   # Electron 桌面端（Vite + React，封装管理面板）
│   └── web/                       # @deploykit/web — React 管理面板
│       ├── src/
│       │   ├── main.tsx           # 应用入口
│       │   ├── App.tsx            # Provider + DeployPage
│       │   ├── pages/DeployPage.tsx   # 页面外壳
│       │   ├── features/          # 功能模块（projects/versions/settings/deploy/theme/i18n）
│       │   ├── shared/api.ts      # hono/client 类型化客户端（上传用 XHR）
│       │   ├── shared/ui/         # shadcn/ui 组件
│       │   └── i18n/              # i18next（中/英）
│       ├── dist/                  # 构建产物（gitignore）
│       └── tests/unit/            # Vitest + RTL 单元测试
├── packages/
│   └── shared/                    # @deploykit/shared — 跨包领域类型
├── docs/                          # 架构与开发文档
├── scripts/package-web.ts         # web → server 打包脚本
└── package.json                   # 工作区根
```

## 技术栈

**后端** ([apps/server](apps/server))
- Hono + Bun
- JSON 文件持久化（原子写入）+ 文件系统存储
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
| `PORT` | `3000` | 服务监听端口 |
| `DATA_FILE` | `apps/server/data.json` | 元数据文件路径 |
| `STORAGE_DIR` | `apps/server/.voasx/storage` | 部署产物存储目录 |
| `PUBLIC_DIR` | `apps/server/public` | 管理面板静态文件目录 |
| `PUBLIC_BASE_URL` | （同源） | 部署链接的公开基础 URL |
| `MAX_ZIP_SIZE` | `104857600` (100MB) | 单个 ZIP 上传上限（字节） |
| `MAX_EXTRACTED_SIZE` | `104857600` (100MB) | 解压/文件夹上传总大小上限 |
| `MAX_FILE_COUNT` | `1000` | 单次上传文件数量上限 |
| `MAX_PATH_LENGTH` | `1000` | 单个相对路径长度上限（字符） |

前端（[apps/web/.env.example](apps/web/.env.example)）：

| 变量 | 说明 |
|------|------|
| `VITE_PUBLIC_BASE_URL` | 部署链接的公开基础 URL；不设则使用前端当前源（同源） |

## API 接口

所有接口前缀为 `/api`。除登录/登出外，API 需要 session cookie；权限分为
`admin` / `developer` / `viewer`。错误响应格式：
`{ "error": { "code": "ERROR_CODE", "message": "..." } }`（错误码见
`apps/server/src/errors.ts`）。请求/响应类型由后端路由推导，前端经
`hono/client` 自动获得类型。

### 认证

| 方法 | 路径 | 说明 | 请求体 |
|------|------|------|--------|
| POST | `/api/auth/login` | 登录并设置 session cookie | `{ email, password }` |
| POST | `/api/auth/logout` | 清除 session cookie | — |
| GET | `/api/me` | 获取当前用户 | — |

### 项目

| 方法 | 路径 | 说明 | 请求体 |
|------|------|------|--------|
| GET | `/api/projects` | 获取项目列表 | — |
| POST | `/api/projects` | 创建项目（admin） | `{ name, slug, description }` |
| PATCH | `/api/projects/:id` | 更新项目信息（developer+） | `{ name?, slug?, description? }` |
| PATCH | `/api/projects/:id/settings` | 更新项目设置（developer+） | `{ spaMode, routingType }` |
| DELETE | `/api/projects/:id` | 删除项目及其文件（admin） | — |
| GET | `/api/projects/:id/versions` | 获取项目（含版本列表） | — |

### 版本

| 方法 | 路径 | 说明 | 请求体 |
|------|------|------|--------|
| POST | `/api/projects/:id/versions` | 上传新版本（developer+，预览态） | `FormData`（`file` 或 `folderFiles[]`） |
| POST | `/api/projects/:id/versions/:vid/publish` | 发布为生产版本（developer+） | — |
| POST | `/api/projects/:id/versions/:vid/rollback` | 回滚到指定版本（developer+） | — |
| PUT | `/api/projects/:id/versions/:vid/activate` | 兼容旧激活语义（developer+） | — |
| DELETE | `/api/projects/:id/versions/:vid` | 删除版本及文件（developer+） | — |

### 历史

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/history?limit=50` | 获取操作历史（上限 200） |

### 部署访问

- **正式版本**: `/deploy/{slug}/`
- **指定版本**: `/deploy/{slug}/{versionId}/`

详细指导见 [docs/vite-deployment.md](docs/vite-deployment.md)。

## 测试

```bash
bun run test          # 全部（shared / server / web）
```

- 后端：`bun test`（[apps/server/tests](apps/server/tests)）— API 契约 + 服务/领域单元测试
- 前端：Vitest + React Testing Library（[apps/web/tests/unit](apps/web/tests/unit)）

质量脚本：`bun run typecheck`、`bun run lint`、`bun run check`（Biome）、`bun run format`。

## 文档

- [docs/architecture.md](docs/architecture.md) — 系统总览、后端模块边界、API 契约、存储布局
- [docs/development.md](docs/development.md) — 工作区命令、测试、本地上传/预览流程
- [docs/vite-deployment.md](docs/vite-deployment.md) — 部署 Vite 应用的 `base`、hash/path 路由、SPA fallback

## License

MIT
