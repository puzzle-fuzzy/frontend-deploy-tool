# DeployKit Server

前端产物部署服务，基于 Hono + Bun 构建。负责托管上传的前端构建产物并通过 URL 分发，整个后端集中在单个文件中。

## 架构

```
HTTP 请求
   |
   +-- /api/* ──────────> API 路由（项目/版本 CRUD）
   |                         |-- data.json 读写
   |                         |-- .voasx/storage/ 文件操作
   |
   +-- /deploy/:slug/* ─> 部署路由
   |                         |-- 解析 slug → 项目 → 活跃版本
   |                         |-- 从 .voasx/storage/ 提供静态文件
   |                         |-- SPA fallback (可选)
   |
   +-- /* ──────────────> 管理面板 (public/index.html)
```

## 功能特性

- **项目 CRUD** — 创建、删除项目，slug 校验（3-64 位小写字母数字+连字符）
- **版本上传** — 支持 ZIP 文件和文件夹两种上传方式，自动解压和扁平化
- **一键激活** — 激活版本后立即可通过 `/deploy/{slug}/` 访问，项目同时只保留一个正式版本
- **指定版本预览** — 通过 `/deploy/{slug}/{versionId}/` 访问任意版本
- **SPA fallback** — 可配置 hash/path 两种路由模式，path 模式自动 fallback 到 index.html
- **操作历史** — 自动记录所有创建、删除、激活操作（上限 200 条）
- **路径安全** — 部署路由包含路径遍历检查，确保文件访问不超出版本目录
- **MIME 类型** — 内置完整 MIME 类型映射，覆盖常见静态资源格式

## 快速开始

```bash
bun install
bun run dev
```

服务默认运行在 `http://localhost:3000`。

如需配合前端开发，先构建前端面板：

```bash
cd ../web && bun run build
```

构建产物会自动输出到 `server/public/`。

## 技术栈

- **运行时**: Bun
- **框架**: Hono
- **存储**: `data.json`（元数据）+ 文件系统（部署产物）
- **ZIP 解压**: `tar` 命令（Bun.spawn）

## 项目结构

```
server/
├── main.ts              # 完整后端（类型定义 + API 路由 + 部署服务 + 启动入口）
├── data.json            # 项目元数据、版本信息、操作历史
├── public/              # 管理界面（由 ../web/ 构建输出）
└── .voasx/
    └── storage/         # 上传的版本文件
        └── {projectId}/
            └── {versionId}/
```

> 整个后端集中在 `main.ts` 一个文件中，包含所有类型定义、工具函数、API 路由、部署文件服务和启动逻辑。

## API

所有接口前缀为 `/api`，无认证。错误响应格式：`{ "error": "message" }`。

| 方法 | 路由 | 说明 | 请求体 |
|------|------|------|--------|
| GET | `/api/projects` | 项目列表 | — |
| POST | `/api/projects` | 创建项目 | `{ name, slug, description }` |
| DELETE | `/api/projects/:id` | 删除项目及其文件 | — |
| PATCH | `/api/projects/:id` | 更新 SPA 设置 | `{ spaMode, routingType }` |
| GET | `/api/projects/:id/versions` | 获取项目及版本列表 | — |
| POST | `/api/projects/:id/versions` | 上传版本 | `FormData` (file 或 folderFiles[]) |
| PUT | `/api/projects/:id/versions/:vid/activate` | 激活版本 | — |
| DELETE | `/api/projects/:id/versions/:vid` | 删除版本及文件 | — |
| GET | `/api/history?limit=50` | 操作历史 | — |

## 部署路由

- `/deploy/:slug/` — 当前激活版本
- `/deploy/:slug/:vid/` — 指定版本预览

### SPA Fallback

当项目启用 SPA 模式时，请求的文件不存在会自动返回 `index.html`，支持前端路由框架（React Router、Vue Router 等）。

### Slug 校验规则

- 格式：`/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/`
- 长度：3-64 个字符
- 字符：小写字母、数字、连字符，不以连字符开头或结尾
- 唯一性：slug 不可重复

## 上传处理

**ZIP 上传：**
1. 写入临时文件 `{versionId}.zip`
2. 通过 `tar -xf` 解压
3. 删除临时文件
4. 扁平化处理：如果解压后有嵌套目录包含 `index.html`，自动上移一层
5. 清理 `__MACOSX` 元数据目录

**文件夹上传：**
1. 保留 `webkitRelativePath` 相对路径写入文件
2. 执行同样的扁平化处理

**自动激活：** 项目的第一个版本自动设为正式版本。

## 配置

默认配置硬编码在 `main.ts` 中：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| PORT | `3000` | 服务监听端口 |
| DATA_FILE | `server/data.json` | 元数据文件路径 |
| STORAGE_DIR | `server/.voasx/storage/` | 部署产物存储目录 |
| PUBLIC_DIR | `server/public/` | 管理面板静态文件目录 |

## License

MIT
