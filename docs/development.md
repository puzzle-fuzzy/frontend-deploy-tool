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
| `bun run dev:server` | 仅后端（API + 部署，`localhost:4010`）。`public/` 为空时无管理面板 |
| `bun run dev:web` | 前端开发服务器（Vite，`localhost:5018`），`/api` 代理到 `localhost:4010` |
| `bun run dev` | 同时启动后端与 Web 开发服务器 |
| `bun run build` | 构建所有包并将 `apps/web/dist` 打包到 `apps/server/public` |
| `bun run package` | 仅执行打包脚本（`scripts/package-web.ts`） |
| `bun run test` | 运行所有包的测试 |
| `bun run typecheck` | 全工作区 `tsc`（含前端测试） |
| `bun run lint` | ESLint（前端） |
| `bun run check` / `check:fix` | Biome 检查 / 自动修复 |
| `bun run format` / `format:check` | Biome 格式化 / 检查 |
| `bun run verify` | CI 同款：Biome、类型检查、测试、生产构建 |

### 三种本地开发形态

1. **仅后端**：`bun run dev:server`。用于调试 API / 部署路由；管理面板不渲染（`public/` 为空时 `/` 返回 404 SPA fallback）。
2. **前端开发（全栈）**：开两个终端——`bun run dev:server` 与 `bun run dev:web`。在 `localhost:5018` 操作，Vite 把 `/api` 代理到后端，享受 HMR。
3. **生产形态**：`bun run build && bun run dev:server`。后端从 `apps/server/public` 托管已构建的管理面板，与线上行为一致。

生产运行前必须设置：

```bash
DEPLOYKIT_ENV=production
SESSION_SECRET=<至少 32 个随机字符>
ADMIN_PASSWORD=<首次管理员密码>
REGISTRATION_ENABLED=false
MANAGEMENT_BASE_URL=https://console.example.com
DEPLOY_BASE_URL=https://deploy.example.net
```

生产环境需用反向代理把两个域名转发到同一个 Bun 端口并保留原始 `Host`。
配置解析采用 fail-fast：无效端口、请求/解压/并发上传限制、布尔值或双域 URL
会直接阻止启动，不会悄悄改用默认值。启动后可检查
`/health/live`（进程）与 `/health/ready`（元数据仓库和恢复冲突）。

后端真实运行入口会按路径排序获取
`<DATABASE_FILE>.runtime-lock.sqlite` 与
`<STORAGE_DIR>.runtime-lock.sqlite` 两个 SQLite `BEGIN EXCLUSIVE` 事务锁。
数据库或存储任一资源已有活跃 owner，第二个进程都会在对账和监听端口前以
`RUNTIME_OWNERSHIP_HELD` 退出；若进程死亡，SQLite 连接关闭会由内核立即释放
两把锁。sidecar 内的 PID/token 只是诊断数据，不参与正确性判断。这是本机
进程锁，不支持多主机同时读写同一份 SQLite/本地存储。

## 测试

### 后端（apps/server）

```bash
bun run test          # 根目录（或 cd apps/server && bun test）
```

- `tests/api/` — `hono/testing` 契约测试（`app.test.ts`、`contracts.test.ts`）：覆盖项目/设置/版本/部署/历史游标端点、安全头、健康探针、请求编号与上传失败清理。
- `tests/services/` — 领域/服务/工具单元测试：slug、历史游标、版本不变量、`safePath`、JSON/SQLite 原子 mutation 与回滚、`deployResolver`、`artifactService`、存储启动对账与配置门禁。

应用组装与 `Bun.serve` 分离（`createApp(config)`），测试无需开端口，也不会
获取 runtime ownership。需要验证真实启动互斥/恢复时使用
`createDeployKitRuntime(config)` 或子进程入口。

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
   - **ZIP**：选择 `.zip`（服务端安全解压 + 扁平化）。
   - **文件夹**：选择构建产物目录（`webkitdirectory`，保留相对路径）。
   - 服务端先写入 `.voasx/storage/.staging/`，全部校验通过后再原子移动到正式版本目录。
   - 上传后保持预览态；必须显式发布后才成为正式版本。
4. 预览（未配置双域的本地兼容模式）：
   - 正式版本：`http://localhost:4010/deploy/{slug}/`
   - 指定版本：`http://localhost:4010/deploy/{slug}/{versionId}/`
   配置双域时，把 `localhost:4010` 替换为 `DEPLOY_BASE_URL`。
5. 路径路由应用请先在项目设置开启 SPA 模式，详见 [vite-deployment.md](vite-deployment.md)。

服务启动时会先恢复 `.recovery/trash/` 中断删除，再以 SQLite 元数据为真源
执行 GC/orphan 对账。元数据仍引用目标则恢复原路径，已不引用则补
`COMMITTED`。恢复会从 storage root 开始统一拒绝 source 祖先以及
`.staging`、`.recovery`、`trash`、`conflicts`、`orphans` 控制路径中的任何
symlink，且不会访问外部目标。原路径已存在但 recovery 缺失时，version 3
manifest 只要带持久化 checksum 就必须重新计算并全部匹配；仅在没有 checksum
时才使用目录身份兜底。严格路径、身份或 checksum 校验失败会隔离到
`.recovery/conflicts/`，此时 `/health/ready` 保持 `503`，必须先人工处理。
存在恢复冲突的启动轮次会暂停全部破坏性对账：GC、orphan 隔离和元数据修复
都不会执行。
随后才清理过期 staging，将孤儿正式产物移动到 `.recovery/orphans/`；缺少入口
文件的已记录版本会进入 `failed`，缺失的线上版本安全下线且不自动选择替代版本。

`bun run ops -- restore <backup> --force` 仅把 `--force` 当作破坏性操作确认。
restore 仍需获取同一 runtime ownership；后端正在运行时必须先优雅停止，
不能用 `--force` 绕过。

## CI 证据

GitHub Actions 与本地共用 `bun run verify`。每次执行会保留 14 天：

- `deploykit-verify-{commit}`：完整 `verify.log`，失败时也上传；
- `deploykit-web-{commit}`：验证成功后的 `apps/web/dist` 与
  `apps/server/public`，可用于核对实际交付内容。

## 添加依赖

- **跨包共享版本**：在根 `package.json` 的 `catalog` 登记，包内用 `"catalog:"` 引用。
- **包私有依赖**：`cd apps/<pkg> && bun add <dep>`。

## Git 约定

- 提交信息使用 Conventional Commits（`feat:` / `fix:` / `refactor:` / `test:` / `docs:` / `chore:`）。
- `apps/server/public/`、`apps/web/dist/`、`deploykit.sqlite*`、`data.json*`、`.voasx/` 均被 gitignore，不要提交构建产物或本地数据。
