# 开发指南

前置：安装 [Bun](https://bun.sh) ≥ 1.3。所有命令在**仓库根目录**执行（除非另注）。

## 安装

```bash
bun install      # 安装整个 Bun 工作区（apps/* + packages/*）
```

依赖版本集中在根 `package.json` 的 `catalog`；包内用 `"catalog:"` 引用，避免版本漂移。

## 常用命令

| 命令 | 说明 |
|------|------|
| `bun run dev:server` | 仅后端（API + 部署，`localhost:3000`）。`public/` 为空时无管理面板 |
| `bun run dev:web` | 前端开发服务器（Vite，`localhost:5173`），`/api` 代理到 `localhost:3000` |
| `bun run dev` | 同 `dev:server` |
| `bun run build` | 构建所有包并将 `apps/web/dist` 打包到 `apps/server/public` |
| `bun run package` | 仅执行打包脚本（`scripts/package-web.ts`） |
| `bun run test` | 运行所有包的测试 |
| `bun run typecheck` | 全工作区 `tsc`（含前端测试） |
| `bun run lint` | ESLint（前端） |
| `bun run check` / `check:fix` | Biome 检查 / 自动修复 |
| `bun run format` / `format:check` | Biome 格式化 / 检查 |

### 三种本地开发形态

1. **仅后端**：`bun run dev:server`。用于调试 API / 部署路由；管理面板不渲染（`public/` 为空时 `/` 返回 404 SPA fallback）。
2. **前端开发（全栈）**：开两个终端——`bun run dev:server` 与 `bun run dev:web`。在 `localhost:5173` 操作，Vite 把 `/api` 代理到后端，享受 HMR。
3. **生产形态**：`bun run build && bun run dev:server`。后端从 `apps/server/public` 托管已构建的管理面板，与线上行为一致。

## 测试

### 后端（apps/server）

```bash
bun run test          # 根目录（或 cd apps/server && bun test）
```

- `tests/api/` — `hono/testing` 契约测试（`app.test.ts`、`contracts.test.ts`）：覆盖项目/设置/版本/部署/历史端点、安全头、上传失败清理。
- `tests/services/` — 领域/服务/工具单元测试：slug、版本不变量、`safePath`、原子写入、`deployResolver`、`artifactService`、`parseSettings`。

应用组装与 `Bun.serve` 分离（`createApp(config)`），测试无需开端口。

### 前端（apps/web）

```bash
bun run test          # Vitest + React Testing Library
```

- `tests/unit/` — `useProjects`（加载/激活/删除 + 刷新）、`ProjectList`、`VersionList`、`ProjectSettingsDialog`、`UploadVersionDialog`。
- `tests/setup.ts` 全局 stub `ResizeObserver` 并 mock `react-i18next`（`t: key => key`）与 `@/lib/toast-context`；每个测试按需 mock `@/lib/api`。
- 测试文件纳入 `tsconfig.app.json`，`bun run typecheck` 会一并检查。

## 本地上传 / 预览流程

1. 启动后端：`bun run dev:server`（或全栈开发模式）。
2. 打开管理面板创建项目，获得 `slug`。
3. 上传一个版本：
   - **ZIP**：选择 `.zip`（服务端 `tar -xf` 解压 + 扁平化）。
   - **文件夹**：选择构建产物目录（`webkitdirectory`，保留相对路径）。
   - 第一个版本自动激活为正式版本。
4. 预览：
   - 正式版本：`http://localhost:3000/deploy/{slug}/`
   - 指定版本：`http://localhost:3000/deploy/{slug}/{versionId}/`
5. 路径路由应用请先在项目设置开启 SPA 模式，详见 [vite-deployment.md](vite-deployment.md)。

## 添加依赖

- **跨包共享版本**：在根 `package.json` 的 `catalog` 登记，包内用 `"catalog:"` 引用。
- **包私有依赖**：`cd apps/<pkg> && bun add <dep>`。

## Git 约定

- 提交信息使用 Conventional Commits（`feat:` / `fix:` / `refactor:` / `test:` / `docs:` / `chore:`）。
- `apps/server/public/`、`apps/web/dist/`、`data.json`、`.voasx/` 均被 gitignore，不要提交构建产物或本地数据。
