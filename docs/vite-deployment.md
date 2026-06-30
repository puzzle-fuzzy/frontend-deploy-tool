# 部署 Vite 应用指南

本文说明如何把一个 Vite 构建的前端应用部署到 DeployKit，并正确配置路由与 SPA fallback。

## URL 结构

DeployKit 为每个项目的每个版本提供一个静态目录：

- **正式版本**：`{PUBLIC_BASE_URL}/deploy/{slug}/`
- **指定版本**：`{PUBLIC_BASE_URL}/deploy/{slug}/{versionId}/`

请求路径会原样映射到版本目录下的文件（例如 `/deploy/my-app/assets/x.js` → `my-app` 当前版本目录下的 `assets/x.js`）。若请求的是目录或空路径，自动回落到该目录的 `index.html`。

## 选择路由模式

### Hash 路由（推荐，零配置）

使用 `createHashRouter`（React Router）、`createWebHashHistory`（Vue Router）或 Vite 默认的 hash 模式。所有路由信息在 `#` 之后，服务器永远只请求同一个 `index.html`。

- ✅ 无需配置 `base`。
- ✅ 无需开启 SPA fallback。
- ✅ 刷新、深链接、指定版本预览都正常工作。

```bash
# 直接上传 dist/ 即可
```

### Path 路由

使用 `createBrowserRouter` / `createWebHistory` 时，前端路由会生成 `/about`、`/users/123` 这样的"真实"路径。这在 DeployKit 下有两个问题：

1. 这些路径在版本目录里并不存在对应文件。
2. DeployKit 的部署 URL 带有前缀（`/deploy/{slug}/`），前端必须以该前缀为 `base` 构建，否则资源路径会错。

因此 path 路由需要两步：

1. **以部署前缀为 `base` 构建**：
   ```js
   // vite.config.js — 以正式版本 https://host/deploy/my-app/ 为例
   export default defineConfig({
     base: '/deploy/my-app/',
   });
   ```
   指定版本预览的前缀是 `/deploy/{slug}/{versionId}/`，与正式版本不同——所以**同一构建无法同时用于正式版本和指定版本预览**。若两者都需要 path 路由，建议改用 hash 路由。

2. **在 DeployKit 项目设置中开启 SPA 模式**（`spaMode: true`）：
   - 文件不存在时，DeployKit 会回落到该版本的 `index.html`，让前端路由接管。
   - `routingType` 字段仅用于面板展示，不影响服务端行为；服务端只看 `spaMode`。

#### path 路由的取舍

- 适合：固定 slug 的正式版本独立站点。
- 不适合：需要在"正式版本"和"指定版本预览"间复用同一构建——请改用 hash 路由。

## 构建产物如何上传

`bun run build`（或 `npm run build`）后，把 **`dist/` 整个目录**作为文件夹上传，或打包成 **ZIP** 上传：

- **ZIP**：服务端 `tar -xf` 解压；若解压后是单层嵌套目录且其中含 `index.html`，会自动上移一层。所以你可以压缩 `dist/` 本身，也可以压缩 `dist/` 里的内容。
- **文件夹**：选择 `dist/` 目录（上传组件使用 `webkitdirectory`），保留相对路径写入。

上传后，DeployKit 会：

- 校验大小 / 文件数 / 路径长度（上限见根 README 的环境变量表）。
- 拒绝路径遍历（`..`、绝对路径等）。
- 扁平化、清理 `__MACOSX`。
- 第一个版本自动激活。

## SPA fallback 行为详解

针对某个版本目录（`{versionRoot}`），DeployKit 按如下顺序处理 `/deploy/{slug}/...`：

1. 解析路径（显式 `{versionId}` 优先，否则用正式版本；无正式版本返回 `404 No active version`）。
2. 空路径或以 `/` 结尾 → 追加 `index.html`。
3. `safeJoin({versionRoot}, filePath)` 越界 → `403 Forbidden`。
4. 文件存在 → 返回文件（HTML 不缓存，带哈希的静态资源长缓存）。
5. 文件不存在：
   - `spaMode: true` → 返回 `{versionRoot}/index.html`（仍不存在则 404）。
   - `spaMode: false` → `404`。

> 因此 hash 路由永远命中步骤 4 的 `index.html`，无需 SPA 模式；path 路由的子路径依赖步骤 5 的 fallback，必须开启 SPA 模式。

## 示例：部署一个 hash 路由的 Vite 应用

```bash
# 应用侧（默认 base 即可）
npm run build

# 在 DeployKit
# 1. 创建项目 my-app
# 2. 上传 dist/（文件夹或 zip）
# 3. 访问 https://your-host/deploy/my-app/
```

## 示例：部署一个 path 路由的 Vite 应用（仅正式版本）

```js
// 应用侧 vite.config.js
export default defineConfig({ base: '/deploy/my-app/' });
```

```bash
npm run build
# 在 DeployKit 创建项目 my-app，开启 SPA 模式，上传 dist/
# 访问 https://your-host/deploy/my-app/ 以及 /deploy/my-app/about 等
```
