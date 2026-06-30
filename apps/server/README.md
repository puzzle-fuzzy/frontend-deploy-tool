# DeployKit Server

`@deploykit/server` — 基于 Hono + Bun 的前端产物部署服务。负责托管上传的前端构建产物并通过 URL 分发，并托管管理面板。

## 架构

```
HTTP 请求
   |
   +-- /api/* ──────────> API 路由（projects / versions / history）
   |                         |-- domain/ 纯规则
   |                         |-- services/ 用例
   |                         |-- repositories/ JSON 持久化（data.json，原子写入）
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
- **版本上传** — 支持 ZIP 与文件夹两种方式，自动解压、扁平化、清理 `__MACOSX`
- **一键激活** — 激活版本后立即可通过 `/deploy/{slug}/` 访问；项目同时只保留一个正式版本
- **指定版本预览** — `/deploy/{slug}/{versionId}/`
- **SPA fallback** — 每个项目可配置 hash/path 两种路由模式
- **操作历史** — 记录所有创建、删除、激活、上传操作（上限 200）
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
├── repositories/             # ProjectRepository 接口 + JSON 实现（原子写入）
├── services/                 # 用例 + 契约（contracts.ts：Bun 无关的服务接口）
│   ├── projectService.ts     # 项目用例
│   ├── versionService.ts     # 版本上传/激活/删除
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

服务默认运行在 `http://localhost:3000`。如需管理面板，先在仓库根目录运行 `bun run build`，打包脚本会将前端构建同步到 `apps/server/public/`。

## 配置

通过环境变量覆盖（见 [.env.example](.env.example)，默认值在 [src/config.ts](src/config.ts)）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 监听端口 |
| `DATA_FILE` | `apps/server/data.json` | 元数据文件 |
| `STORAGE_DIR` | `apps/server/.voasx/storage` | 部署产物目录 |
| `PUBLIC_DIR` | `apps/server/public` | 管理面板静态目录 |
| `PUBLIC_BASE_URL` | （同源） | 部署链接公开基础 URL |
| `MAX_ZIP_SIZE` / `MAX_EXTRACTED_SIZE` / `MAX_FILE_COUNT` / `MAX_PATH_LENGTH` | 100MB / 100MB / 1000 / 1000 | 上传上限 |

## 部署路由

- `/deploy/:slug/` — 当前激活版本
- `/deploy/:slug/:versionId/` — 指定版本预览

启用 SPA 模式后，请求文件不存在会返回 `index.html`，支持前端路由框架。

### Slug 校验

- 正则：`/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/`
- 长度 3–64，小写字母/数字/连字符，不以连字符开头或结尾，且全局唯一

## 上传处理

- **ZIP**：写入临时文件 → `tar -xf` 解压 → 删除临时 → 大小校验 → 扁平化（嵌套目录含 `index.html` 时上移一层）→ 清理 `__MACOSX`
- **文件夹**：保留 `webkitRelativePath` 相对路径写入，再执行扁平化
- **自动激活**：项目的第一个版本自动设为正式版本
- 任一阶段失败都会清理版本目录并返回 `500 File processing failed: ...`

## API

见根 [README](../../README.md#api-接口)。错误格式：`{ "error": "message" }`。

## 测试

```bash
bun test                    # 在 apps/server
```

覆盖：API 契约（`tests/api`）、服务/领域/工具单元测试（`tests/services`）。

## License

MIT
