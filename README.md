# DeployKit

前端产物部署管理系统 — 上传、版本管理、一键部署静态网站。仅需 Bun 运行时，无需外部数据库。

## 架构

```
浏览器 ──── http://localhost:3000 ────> Bun 服务器 (Hono)
   |                                      |
   |── 管理面板 (/) ────────────────────>|── 托管 React SPA (server/public/)
   |                                      |
   |── API (/api/*) ─────────────────────>|── data.json 读写
   |                                      |── .voasx/storage/ 文件操作
   |                                      |
   |── 部署访问 (/deploy/:slug/) ───────>|── 从 .voasx/storage/ 提供静态文件
                                          |── SPA fallback (可选)
```

1. Bun 运行 Hono 服务，`data.json` 存储元数据，`.voasx/storage/` 存储部署产物
2. 前端管理面板（React SPA）构建后输出到 `server/public/`，由同一服务托管
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

```bash
# 启动后端（含前端托管）
cd server
bun install
bun run dev
```

访问管理面板：http://localhost:3000

### 前端开发

如需单独开发前端面板：

```bash
cd web
bun install
bun run dev
```

前端开发服务器运行在 `localhost:5173`，API 请求自动代理到 `localhost:3000`。

### 构建前端

```bash
cd web
bun run build
```

构建产物直接输出到 `../server/public/`，后端自动托管。

## 技术栈

**后端** (server/)
- Hono + Bun
- 文件系统存储（`data.json` + `.voasx/storage/`）

**前端** (web/)
- React 19 + React Compiler
- Vite 8
- TypeScript
- shadcn/ui (Radix) + Tailwind CSS v4
- i18next 国际化（中/英）
- lucide-react 图标

## 项目结构

```
frontend-deploy-tool/
├── server/                    # 后端服务
│   ├── main.ts                # 完整后端（API 路由 + 部署服务 + 静态托管）
│   ├── data.json              # 项目元数据、版本信息、操作历史
│   ├── public/                # 管理界面（由 web/ 构建输出）
│   └── .voasx/storage/        # 部署产物存储
│       └── {projectId}/
│           └── {versionId}/
└── web/                       # 前端管理面板
    ├── src/
    │   ├── pages/
    │   │   ├── DeployPage.tsx          # 主页面（项目列表 + 版本面板）
    │   │   ├── CreateProjectDialog.tsx  # 创建项目对话框
    │   │   ├── UploadDialog.tsx         # 上传版本对话框
    │   │   └── SettingsDialog.tsx       # 项目设置对话框
    │   ├── lib/
    │   │   ├── api.ts                   # API 客户端（fetch + XHR 上传进度）
    │   │   ├── toast.tsx                # Toast 通知
    │   │   └── utils.ts                 # 工具函数
    │   ├── i18n/locales/
    │   │   ├── zh.json                  # 中文翻译
    │   │   └── en.json                  # 英文翻译
    │   ├── types/index.ts               # TypeScript 类型定义
    │   └── components/ui/               # shadcn/ui 组件
    ├── vite.config.ts                   # Vite 配置（代理 + 构建输出到 server/public）
    └── components.json                  # shadcn/ui 配置
```

## API 接口

所有接口前缀为 `/api`，无认证。

### 项目

| 方法 | 路径 | 说明 | 请求体 |
|------|------|------|--------|
| GET | `/api/projects` | 获取项目列表 | — |
| POST | `/api/projects` | 创建项目 | `{ name, slug, description }` |
| DELETE | `/api/projects/:id` | 删除项目及其文件 | — |
| PATCH | `/api/projects/:id` | 更新项目设置 | `{ spaMode, routingType }` |

### 版本

| 方法 | 路径 | 说明 | 请求体 |
|------|------|------|--------|
| GET | `/api/projects/:id/versions` | 获取项目及版本列表 | — |
| POST | `/api/projects/:id/versions` | 上传新版本 | `FormData(file/zip)` |
| PUT | `/api/projects/:id/versions/:vid/activate` | 设为正式版本 | — |
| DELETE | `/api/projects/:id/versions/:vid` | 删除版本及文件 | — |

### 历史

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/history?limit=50` | 获取操作历史 |

### 部署访问

- **正式版本**: `http://localhost:3000/deploy/{slug}/`
- **指定版本**: `http://localhost:3000/deploy/{slug}/{versionId}/`

## 数据存储

| 文件/目录 | 说明 |
|-----------|------|
| `server/data.json` | 项目元数据、版本信息、操作历史 |
| `server/.voasx/storage/{projectId}/{versionId}/` | 部署产物文件 |
| `server/public/` | 管理面板（由 `web/` 构建输出） |

## 上传处理

- **ZIP 上传** — 服务端写入临时文件，通过 `tar` 解压，自动扁平化嵌套目录，清理 `__MACOSX` 元数据
- **文件夹上传** — 通过 `webkitdirectory` 属性选择，保留相对路径写入
- **自动激活** — 项目第一个上传的版本自动设为正式版本
- **上传进度** — 前端使用 XMLHttpRequest 追踪上传百分比

## 使用场景

1. **前端团队** — 快速部署测试环境，每个 PR 对应一个版本
2. **个人开发者** — 管理多个静态网站，统一入口访问
3. **设计评审** — 上传设计稿版本，团队在线预览

## 配置

默认配置硬编码在 `server/main.ts` 中：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| PORT | `3000` | 服务监听端口 |
| DATA_FILE | `server/data.json` | 元数据文件路径 |
| STORAGE_DIR | `server/.voasx/storage/` | 部署产物存储目录 |
| PUBLIC_DIR | `server/public/` | 管理面板静态文件目录 |

## License

MIT
