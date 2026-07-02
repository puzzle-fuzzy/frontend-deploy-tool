# DeployKit Dashboard

`@deploykit/web` — 前端产物部署系统的管理界面。React 19 + Vite 8 + shadcn/ui 构建的单页应用。

## 架构

```
浏览器 (localhost:5173)          Bun 服务器 (localhost:3000)
   |                                  |
   |── /api/* ── Vite proxy ─────────>│── API 处理
   |                                  |
   |── 页面路由 (hash) ──────────────>│ （纯客户端，不经过服务器）
   |   #/projects/{id}                |
```

1. 开发时 Vite 代理 `/api` 到后端 `localhost:3000`
2. 生产构建输出到 `apps/web/dist/`；根目录 `bun run build` 会将其打包到 `apps/server/public/`，由后端同源托管
3. 页面路由使用 URL hash（`#/projects/{id}`），纯客户端状态
4. API 客户端使用 `hono/client`，类型由后端 `ApiApp` 推导

## 功能特性

- **项目管理** — 按角色创建/删除项目，slug 自动格式化
- **版本上传** — ZIP 选择 / 文件夹上传（`webkitdirectory`）/ 拖拽上传，带进度
- **版本管理** — 发布/回滚/删除版本、预览指定版本、复制部署链接
- **SPA 配置** — 为部署的项目配置 SPA fallback（hash/path 模式）
- **明暗主题** — 亮色/暗色切换
- **中英文** — 自动检测浏览器语言

## 技术栈

- **框架**：React 19 + React Compiler
- **构建**：Vite 8 + TypeScript
- **UI**：shadcn/ui (Radix) + Tailwind CSS v4
- **图标**：lucide-react
- **国际化**：i18next + react-i18next
- **API**：`hono/client`（类型化，`src/shared/api.ts`）；上传使用 `XMLHttpRequest` 以追踪进度
- **字体**：JetBrains Maple Mono

## 快速开始

```bash
# 在仓库根目录
bun install
bun run dev:web
```

开发服务器运行在 `http://localhost:5173`，`/api` 自动代理到 `localhost:3000`。需同时运行后端：另开终端 `bun run dev:server`。

## 构建

```bash
# 在仓库根目录
bun run build
```

构建产物输出到 `apps/web/dist/`，根目录打包脚本会同步到 `apps/server/public/`。

## 项目结构

```
src/
├── main.tsx                          # 应用入口
├── App.tsx                           # Provider（Tooltip / Toast）+ DeployPage
├── index.css                         # Tailwind v4 + 明暗主题变量
├── config.ts                         # publicBaseURL（部署链接基础 URL）
├── pages/
│   └── DeployPage.tsx                # 页面外壳：组合各功能模块
├── features/                         # 功能模块
│   ├── auth/
│   ├── projects/
│   │   ├── useProjects.ts            # 项目状态 + hash 路由 + 操作
│   │   ├── ProjectList.tsx           # 左栏：项目列表
│   │   └── CreateProjectDialog.tsx
│   ├── versions/
│   │   ├── VersionList.tsx           # 版本列表 + 发布/回滚/删除/预览
│   │   └── UploadVersionDialog.tsx   # 上传（ZIP / 文件夹，带进度）
│   ├── settings/ProjectSettingsDialog.tsx
│   ├── deploy/DeployUrl.tsx          # 部署链接 + 复制 + 打开
│   ├── theme/ (useTheme.ts, ThemeToggle.tsx)
│   └── i18n/LanguageToggle.tsx
├── shared/
│   ├── api.ts                        # hono/client 类型化客户端（上传用 XHR）
│   ├── format.ts                     # 日期格式化
│   ├── types.ts                      # 类型再导出（来自 @deploykit/shared）
│   ├── utils.ts                      # cn()
│   └── ui/                           # shadcn/ui 组件 + Toast
├── i18n/ (index.ts, locales/{zh,en}.json)
```

## API 客户端

[shared/api.ts](src/shared/api.ts) 通过 `hono/client` 暴露类型化方法（`login`、`getMe`、`listProjects`、`createProject`、`updateProject`、`updateSettings`、`publishVersion`、`rollbackVersion`、`deleteVersion`、`deleteProject`）；响应类型由后端路由推导。`uploadVersion` 保留 `XMLHttpRequest` 实现，用于 `upload.onprogress` 进度事件。所有调用同源（`hc('')`），错误时抛出服务端响应体。

## 脚本

| 命令 | 说明 |
|------|------|
| `bun run dev` | 启动开发服务器（Vite） |
| `bun run build` | 构建生产版本（输出到 `dist/`） |
| `bun run preview` | 预览构建产物 |
| `bun run lint` | ESLint |
| `bun run test` | Vitest |
| `bun run typecheck` | `tsc -b` |

## 测试

```bash
bun test                    # 在 apps/web（Vitest + React Testing Library）
```

单元测试见 [tests/unit](tests/unit)：`useProjects`（加载/发布/删除 + 刷新）、`ProjectList`、`VersionList`、`ProjectSettingsDialog`、`UploadVersionDialog`。

## License

MIT
