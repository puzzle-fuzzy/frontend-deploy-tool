# DeployKit 桌面客户端设计

- 日期: 2026-07-02
- 状态: 已确认,待编写实现计划
- 范围: 新增 `apps/desktop`(Electron)桌面客户端 + 新增 `packages/client` 共享客户端包

## 1. 背景与目标

现有 DeployKit 的前端管理台(`apps/web`)与后端(`apps/server`)都部署在服务器上,登录系统已完整就绪:`POST /api/auth/login`(邮箱+密码)签发 HMAC 签名的 session cookie(`deploykit_session`,HttpOnly,`SameSite=Lax`,7 天有效),`GET /api/me` 返回当前用户,角色分为 `admin`/`developer`/`viewer`。

本设计新增一个**本地安装的桌面客户端**,它是一个连接到**用户指定的远程 DeployKit 服务器**的瘦客户端:登录后提供与网页版完全一致的部署管理能力,并叠加原生增强。

### 目标

- **服务器零改动**:所有差异化都发生在桌面端与共享包,后端契约保持不变。
- **最大复用**:web 现有的 React 组件、hooks、类型、i18n、主题经传输解耦后被 web 与 desktop 同时复用。
- **完整原生体验**:镜像 web 功能 + 原生目录上传、拖拽、系统通知、托盘,以及可插拔的自动更新 / 开机自启 / 全局快捷键。
- **安全**:登录凭据与 session token 不进入渲染进程。

### 非目标(YAGNI,本期不做)

- 改动后端:不新增 CORS、不改 `SameSite`、不加 OAuth/SSO 端点。两种登录均通过 Electron session 复用现有 cookie 机制实现。
- 多服务器 profile(本期只连单个用户指定服务器)。
- 离线模式 / 本地缓存业务数据(业务数据始终在服务器)。
- 自建更新托管服务(自动更新设计为可插拔,基建未就绪则关闭)。

## 2. 关键决策(澄清结论)

| 维度 | 决策 |
|---|---|
| 整体架构 | 原生客户端,**复用 web 组件**(非内嵌远程网页,非独立重写) |
| 登录方式 | **两种都做**:账号密码 + 网页登录(内嵌窗口);服务器零改动 |
| 连接服务器 | 首次引导**用户输入服务器地址**,本地持久化 |
| 原生增强 | **完整原生体验**(分 P0/P1/P2 交付) |
| 技术路线 | **A:主进程 API 代理 + 共享包**;所有 HTTP 走主进程 `net` + 独立 session |

## 3. 架构与模块边界

### 3.1 工作区变更

- `apps/desktop` **并入根 Bun workspace**,包名 `@deploykit/desktop`;删除其独立的 `bun.lock`;依赖统一走 catalog。
- 新增 **`packages/client`**(`@deploykit/client`)承载传输无关的客户端共享代码,被 web 与 desktop 同时消费。

### 3.2 `packages/client`(复用核心)

当前 web 的 `shared/api.ts` 是"单例 + 直接 fetch",组件直接 `import { api }`。为复用,需先解耦传输:

- 定义 **`ApiClient` 接口**:与现有 `api.ts` wrapper 同形 —— `getMe` / `login(email,password)` / `logout` / `listProjects` / `createProject` / `updateProject` / `deleteProject` / `updateSettings` / `uploadVersion` / `publishVersion` / `rollbackVersion` / `deleteVersion`。
- 提供 **`<ApiClientProvider>`** React context;组件/hooks(`useAuth`、`useProjects`、`DeployPage` 等)从 context 取 client,不再 import 单例。
- 把 web 现有 `features/` + `shared/ui/` + `pages/` + `i18n/` + `theme/` **机械迁移**进 `packages/client`。
- 共享纯逻辑:`checkOk` / `extractMessage`(错误解析)、`SafeUser` 等类型、格式化工具。
- **web 瘦身为壳**:`main.tsx` + `config` + `fetchApiClient`(基于 `hono/client` 的实现)→ `<ApiClientProvider client={fetchApiClient}><App/></ApiClientProvider>`。
- **desktop 也是壳**:提供 `ipcApiClient`(IPC 实现)复用同一套 `<App>`。

> 这是本设计里最大的一次性重构,但它是正确架构:web 顺带传输解耦、可纯单元测试。类型全程复用 `@deploykit/server/api`(该类型图本就是 Bun-free,桌面 tsc 能过;且遵守 web 的 `erasableSyntaxOnly`,共享代码不用 enum / 参数属性 / namespace)。

### 3.3 桌面端进程结构 `apps/desktop/src/`

```
src/
├── main/                 # 主进程(Node,Electron net)
│   ├── index.ts          # app 生命周期 / 窗口 / 托盘(P1)
│   ├── ipc.ts            # 注册 ipcMain.handle,桥接 renderer↔apiClient
│   ├── serverRequest.ts  # 用 net + persist:deploykit session 发请求
│   ├── auth.ts           # 两种登录 + session/cookie 管理
│   ├── nativeUpload.ts   # 目录选择器 + fs 递归读 + 构造 multipart + 预检
│   └── (P1/P2) tray.ts / updater.ts / autostart.ts / shortcuts.ts
├── preload.ts            # contextBridge 暴露 window.deploykit(类型化)
├── shared/
│   └── bridge.ts         # DesktopBridge 接口(桌面专属 IPC 契约类型)
└── renderer/
    ├── main.tsx          # 挂载
    ├── DesktopApp.tsx    # 引导(填服务器地址)→ 登录门 → 复用 <App>
    └── ipcApiClient.ts   # 实现 ApiClient = 调 window.deploykit.*
```

### 3.4 传输与 session(关键)

- `Session.fromPartition('persist:deploykit')` 专用分区:cookie 自动管理、跨重启持久、OS 加密落盘(= "保持登录")。
- **所有服务器请求**走 `net.request({ url, session, method })` —— 自动带 cookie、处理 `Set-Cookie`,**绕开渲染进程跨站 `SameSite=Lax` 限制**。
- IPC 契约用 `@deploykit/server/api` + `@deploykit/shared` 类型双向标注,渲染↔主进程全程类型安全。
- 切换服务器地址 → 清空该分区、重置登录态。

### 3.5 开发流程

- `bun run dev:desktop`(`electron-forge start`)→ 主进程真实请求打到 `dev:server`(`http://localhost:3000`)或任意远程服务器。
- 全栈开发仍两个终端:`dev:server` + `dev:desktop`。

## 4. 认证与登录流程

### 4.1 首次引导(服务器地址)

- 未配置服务器时显示引导页:输入地址 → "校验并连接"。
- 校验:打 `GET /api/me`,**401 = 服务器可达且需要登录**(通过);网络错误 = 地址无效。
- 地址归一化(去尾斜杠)后存入 `app.getPath('userData')` 下配置(`electron-store` 或自写 JSON)。后续启动跳过引导。
- **安全**:地址非 `localhost` 且为 `http://` 时弹警告(凭据明文传输)。

### 4.2 两种登录(共享同一 `persist:deploykit` session jar)

**① 账号密码登录**
邮箱+密码表单 → 渲染进程调 `window.deploykit.login(email,password)` → IPC → 主进程 `net` 打 `POST /api/auth/login`(带 session)→ 服务器 `Set-Cookie` 自动落进 jar → 再 `GET /api/me` 拿 `SafeUser` 回传 → 进入应用。

**② 网页登录(内嵌 BrowserWindow,非系统浏览器)**
> 不开系统浏览器的原因:系统浏览器的 cookie jar 是浏览器自己的,session 带不回 Electron,除非加 deep-link 回调(= 改服务器)。内嵌窗口用**同一 `persist:deploykit` 分区**,cookie 直接落进我们的 jar,**服务器零改动**;对用户而言它就是"网页登录页",只是画在桌面窗口里。

- 点"网页登录" → 主进程开子 `BrowserWindow`(同分区、`nodeIntegration:false`)加载 `<server>/`(部署的 SPA,未登录时显示登录页)。
- 主进程监听 `session.cookies.on('changed')`,出现 `deploykit_session` → `GET /api/me` 确认 → 关闭子窗口、进入应用;带 ~1s 轮询 `/api/me` 兜底。
- 用户可手动关闭子窗口取消。

两种方式之后,主窗口因共享 jar 自动处于已登录态。

### 4.3 登录态保持与登出

- **保持登录**:`persist:deploykit` 分区 cookie 跨重启持久、OS 加密;尊重服务器 7 天有效期。启动 → 读 cookie → `GET /api/me` → 有效直达应用,否则登录页。
- **登出**:`POST /api/auth/logout` + 清该分区 storage → 回登录页。
- **切换服务器**:设置里改地址 → 确认 → 清分区、重置 → 回引导/登录。

### 4.4 安全要点

- `contextIsolation: true` + `nodeIntegration: false` + preload `contextBridge`;尽量开 `sandbox`。
- **token 永不进渲染进程**:cookie 只存在主进程 session jar,渲染进程仅通过 IPC 拿到 `SafeUser`。
- 子窗口同分区、无 Node 能力。

### 4.5 接口归属(重要边界)

- **`ApiClient`(共享接口,web/desktop 同形)**:只含服务器 API 形状(`getMe`/`login`/`logout`/项目/版本/设置/历史)。
- **`window.deploykit.native.*`(桌面独有,不进 `ApiClient`)**:`validateServer(url)` / `configureServer(url)` / `loginViaWeb()` / `pickDirectory()` / `onNativeNotify(cb)` / `onAuthExpired(cb)` / 托盘·更新等。共享接口保持纯净,桌面特有能力单独走 preload。

## 5. 功能对齐与原生增强

### 5.1 功能对齐 web(P0,复用共享 `<App>`)

- 项目:列表 / 创建 / 编辑 / 删除 / 设置(`spaMode` 等)。
- 版本:列表 / 上传 / 发布 / 回滚 / 删除,带二次确认。
- 审计日志 / 历史:全局 + 单项目过滤。
- i18n(中/英)+ 主题切换;上传进度、空/加载/错误态全部沿用。

### 5.2 原生上传(P0 核心增强,复用后端 `folderFiles` 契约,零改服务器)

- **原生目录选择器**:`dialog.showOpenDialog({ properties:['openDirectory'] })` → 主进程 `fs` 递归读取 → `{ 相对路径, bytes }` 列表。
- **客户端预检**:按服务器 `MAX_ZIP_SIZE` / `MAX_EXTRACTED_SIZE` / `MAX_FILE_COUNT` / `MAX_PATH_LENGTH` 先拦(配置或硬编码常量),超限直接报错,避免传一半才失败。
- **构造 multipart**:每个文件用 `File`/`Blob` 包装,`Object.defineProperty` 设 `webkitRelativePath = 相对路径`(POSIX);POST `<server>/api/projects/:id/versions`,字段 `folderFiles`(多值)+ `versionDesc`。服务器侧 `writeFolderFiles` 原样处理(`f.webkitRelativePath || f.name`,归一化为 POSIX,去前导斜杠)。
- **拖拽上传**:Electron 拖进来的 `File` 带 `path` 属性(真实磁盘路径)→ 渲染进程把路径经 IPC 给主进程 → 主进程 `fs` 读 + `net` 上传。大文件不走 IPC 内容拷贝,高效。
- **上传进度**:主进程分块写 multipart body,按已写字节经 IPC 上报(替代 web 的 XHR `upload.onprogress`)。
- zip 上传保留(选单个 `.zip`)。

### 5.3 P1 原生打磨

- **系统通知**:上传完成 / 发布成功 / 回滚完成 → `Notification`;托盘在时走托盘。
- **系统托盘**:`Tray` + 菜单(显示/退出);关闭最小化到托盘(可配置);`requestSingleInstanceLock` 单实例。
- **在浏览器打开部署地址**:`shell.openExternal(<server>/deploy/{slug}/)`。

### 5.4 P2 进阶(可插拔,延后/可砍)

- **自动更新**:`autoUpdater` + forge publisher;⚠️ **依赖外部更新托管 + 代码签名**,未就绪则关闭。
- **开机自启**:`app.setLoginItemSettings`。
- **全局快捷键**:`globalShortcut` 显示/隐藏窗口。
- **多窗口**:项目/预览弹出 —— 价值低,建议最后做或砍。

## 6. 分期交付

| 阶段 | 内容 | 交付物 |
|---|---|---|
| **P0 MVP** | workspace 并入;`packages/client` + `ApiClient` + IPC transport;首次引导;两种登录 + session 持久化;功能对齐 web;原生目录选择器 + 拖拽上传;客户端预检 | 一个能用、和网页等价的桌面端 |
| **P1 原生打磨** | 系统托盘、系统通知、"浏览器打开部署地址"、单实例锁 | 桌面端"活起来" |
| **P2 进阶** | 自动更新(待基建)、开机自启、全局快捷键、(可选)多窗口 | 完整原生体验 |

## 7. 状态、错误处理与 IPC 契约

### 7.1 状态与本地数据

- 桌面端**不存业务数据**(全在服务器)。本地仅:服务器地址配置、登录 session(partition jar)、用户偏好(主题/语言,渲染进程 `localStorage`,复用 web 机制)。
- 渲染进程状态:复用 web 的 `useAuth`/`useProjects`,通过 `ApiClientProvider` 注入 IPC client。
- 主进程状态:当前服务器 origin、partition session、窗口/托盘引用。

### 7.2 错误处理

- 服务器错误统一 `{ error:{ code, message } }`;主进程 `net` 非 2xx → 解析 message → IPC 抛 `Error`。`checkOk` + `extractMessage` 从 web 抽进 `packages/client` 共享。
- 网络错误 → 单独类型,UI 区分"网络问题" vs "业务错误"。
- 中途 401(session 过期)→ 主进程发 `onAuthExpired` IPC 事件 → 渲染进程回登录页。

### 7.3 IPC 契约与类型

- `preload.ts` 用 `contextBridge` 暴露 `window.deploykit`;类型由 **`DesktopBridge`** 接口描述(`apps/desktop/src/shared/bridge.ts`,桌面专属)。
- `ipcApiClient` 实现 `ApiClient`:每方法映射到 `ipcRenderer.invoke('api:method', ...)`;主进程 `ipcMain.handle` 注册,委托给 `serverRequest`/`auth`/`nativeUpload`。
- 两端共享同一 `DesktopBridge`/`ApiClient` 类型,签名由 `@deploykit/server/api` 推导 → 渲染↔主全程类型安全。

## 8. 测试策略

- **`packages/client`**:Vitest + RTL,用 **mock `ApiClient`** 注入测组件/hook(传输解耦的直接回报 —— UI 可纯单测、不碰网络)。把 web 现有测试迁过来 + 补 mock 用例。
- **桌面主进程**:
  - `nativeUpload`:临时目录测递归读取 + multipart 构造 + 客户端预检(纯函数)。
  - `serverRequest`/`auth`:本地 mock Hono server 验证 cookie 落盘 / 401 / 网络错误。
  - IPC 接线:集成测渲染→主→net。
- **契约**:复用 `apps/server/tests/api`,确保桌面依赖的端点形状(`login`/`me`/`projects`/`versions` 上传/发布/回滚)不变。
- **E2E(轻量,P0 末尾)**:Playwright for Electron 跑"引导→登录→上传→发布"冒烟。
- **CI**:`packages/client` 进 `check/typecheck/test`;桌面加 `typecheck`+`lint`;`electron-forge package` 在发布 CI 可选跑。

## 9. 风险与缓解

- **最大风险** = `packages/client` 迁移动 web 现有代码。缓解:纯机械移动 + 接口注入,分小提交,web 测试先绿再继续;迁移前后行为不变。
- **`net` 大文件/上传进度** 若不稳 → P0 fallback 为"转圈 + 完成通知"(无精确进度),不阻塞 MVP。
- **自动更新基建未就绪** → 功能位关闭,P0/P1 不受影响。
- **Electron + Bun workspace 协同**:Electron Forge 的 Vite 插件强制 `preserveSymlinks:true`,与 bun 符号链接布局冲突(已在 `vite.renderer.config.mts` 处理过渲染端)。主进程构建需复核 workspace 包符号链接解析。

## 10. 待定 / 后续

无阻塞性待定项。P2 的自动更新等基建就绪后再启用,不影响 P0/P1。
