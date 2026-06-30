# DeployKit Dashboard

前端产物部署系统的管理界面，基于 React 19 + Vite 8 + shadcn/ui 构建的单页应用。

## 架构

```
浏览器 (localhost:5173)          Bun 服务器 (localhost:3000)
   |                                  |
   |── /api/* ── Vite proxy ─────────>│── API 处理
   |                                  |
   |── 页面路由 (hash) ──────────────>│ (纯客户端，不经过服务器)
   |   #/projects/{id}                |
```

1. 开发时 Vite 代理 `/api` 请求到后端 `localhost:3000`
2. 生产构建输出到 `../server/public/`，由后端统一托管，无 CORS 问题
3. 页面路由使用 URL hash（`#/projects/{id}`），纯客户端状态

## 功能特性

- **项目管理** — 创建、删除项目，slug 自动格式化（小写字母数字+连字符）
- **版本上传** — 支持 ZIP 文件选择和文件夹上传（`webkitdirectory`），支持拖拽上传
- **上传进度** — 使用 XMLHttpRequest 追踪上传百分比
- **版本管理** — 激活/删除版本，预览指定版本，复制部署链接
- **SPA 配置** — 为部署的项目配置 SPA fallback（hash/path 模式）
- **明暗主题** — 亮色/暗色主题切换，oklch 色彩系统
- **中英文** — 内置中文和英文界面，自动检测浏览器语言
- **操作历史** — 查看所有项目操作记录

## 技术栈

- **框架**: React 19 + React Compiler（自动 memoization）
- **构建工具**: Vite 8
- **语言**: TypeScript
- **UI**: shadcn/ui (Radix) + Tailwind CSS v4
- **图标**: lucide-react
- **国际化**: i18next + react-i18next
- **字体**: JetBrains Maple Mono

## 快速开始

```bash
bun install
bun run dev
```

前端开发服务器运行在 `http://localhost:5173`，API 请求自动代理到 `localhost:3000`。

> 需要先启动后端服务：`cd ../server && bun run dev`

## 构建

```bash
bun run build
```

构建产物直接输出到 `../server/public/`，供后端直接托管。

## 项目结构

```
web/
├── src/
│   ├── main.tsx                        # 应用入口
│   ├── App.tsx                         # 根组件（Provider + 页面）
│   ├── index.css                       # Tailwind v4 + 明暗主题变量
│   ├── types/index.ts                  # TypeScript 类型（Project, Version, Settings, HistoryEvent）
│   ├── pages/
│   │   ├── DeployPage.tsx              # 主页面（左右布局：项目列表 + 版本面板）
│   │   ├── CreateProjectDialog.tsx     # 创建项目对话框
│   │   ├── UploadDialog.tsx            # 上传版本对话框（ZIP / 文件夹）
│   │   └── SettingsDialog.tsx          # 项目设置（SPA 模式、路由、删除）
│   ├── lib/
│   │   ├── api.ts                      # API 客户端（fetch + XHR 上传进度）
│   │   ├── format.ts                   # 日期格式化
│   │   ├── toast.tsx                   # Toast 通知 Provider
│   │   └── utils.ts                    # cn() 工具（clsx + tailwind-merge）
│   ├── i18n/
│   │   ├── index.ts                    # i18next 初始化（语言检测）
│   │   └── locales/
│   │       ├── zh.json                 # 中文翻译
│   │       └── en.json                 # 英文翻译
│   └── components/ui/                  # shadcn/ui 组件（13 个）
├── vite.config.ts                      # Vite 配置（代理 + 构建输出）
├── components.json                     # shadcn/ui 配置
└── package.json
```

## API 客户端

`src/lib/api.ts` 提供两种通信方式：

- **fetch** — 用于所有 CRUD 操作（项目/版本增删改查、设置更新）
- **XMLHttpRequest** — 用于版本上传，支持 `upload.onprogress` 追踪上传进度

所有 API 调用使用相对路径（`BASE = ""`），开发时由 Vite 代理，生产时同源访问。

## 脚本

| 命令 | 说明 |
|------|------|
| `bun run dev` | 启动开发服务器 (Vite) |
| `bun run build` | 构建生产版本（输出到 `../server/public/`） |
| `bun run preview` | 预览构建产物 |
| `bun run lint` | 代码检查 |
| `bun test` | 运行测试 |

## License

MIT
