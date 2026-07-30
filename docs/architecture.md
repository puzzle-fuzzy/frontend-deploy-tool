# 架构文档

DeployKit 是一个单进程的静态前端产物部署平台：一个 Bun + Hono 进程同时
提供管理 API、管理面板（React SPA）和已部署站点的静态托管。生产环境通过
两个不同的浏览器源划分信任边界：可信管理源只提供 UI/API，不可信部署源只
提供上传产物。元数据存储在内嵌 SQLite，部署产物保存在本地文件系统。

## 系统总览

```
                 ┌─────────────────────────── apps/server (Bun + Hono) ───────────────────────────┐
  管理源 ───────► │  /api/*      → session routes/{projects,versions,apiTokens,...} → services     │
                 │  /api/ci/*   → API Token middleware → ciVersions → versionService               │
                 │  /*          → 管理面板（apps/server/public，由打包脚本同步自 apps/web/dist）    │
  部署源 ───────► │  /deploy/*   → routes/deploy → deployResolver + artifactService                 │
                 │                                                                             │
                 │  deploykit.sqlite（WAL + durable audit queue）                                  │
                 │  .voasx/storage/{projectId}/{versionId}/（产物） → 受限审计子进程                 │
                 └─────────────────────────────────────────────────────────────────────────────┘
                                        ▲ 类型 (ApiApp, Project, Version, ...)
                                        │
                 ┌──────────── packages/shared（跨包领域类型）────────────┐
                 └──────────────────────────────────────────────────────┘
                                        ▲
                ┌──────── apps/web（React SPA，hono/client）─────────────┐
                │  features/* + shared/api.ts (hc<ApiApp>)                │
                 └────────────────────────────────────────────────────────┘
```

管理 API、管理面板和静态托管仍共用一个主进程、一个端口；审计扫描只在任务
执行期间创建无状态受限子进程。开发环境未配置双域时保留同源兼容模式；
生产环境必须由反向代理将两个域名转发到该端口并保留原始 `Host`。双域是安全
边界而不是服务拆分，因此不会增加数据库或应用进程数量。

## 后端模块边界（apps/server/src）

无环依赖方向：`config → errors → domain → utils → repositories → services → routes → app → index`。

| 层 | 职责 | 关键文件 |
|----|------|----------|
| `config.ts` | 环境变量解析与生产启动门禁（secret/password/双域/数值严格校验） | `config.ts` |
| `errors.ts` | 服务端 `ApiError`；稳定错误码定义在 `@deploykit/shared/errors.ts` | `errors.ts` |
| `domain/` | 纯领域规则，无 I/O | `project.ts`（slug/设置/审计策略）、`version.ts`（显式发布状态）、`artifactAudit.ts`（发布门禁）、`history.ts`（追加事件与不透明游标）、`session.ts`（会话身份类型）、`apiToken.ts`（自动化凭据记录） |
| `utils/` | 基础工具 | `id.ts`（nanoid）、`mime.ts`、`safePath.ts`（`safeJoin` 路径遍历防护） |
| `repositories/` | 持久化 | `projectRepository.ts`（原子 `mutate` / CI upload commit 契约）、`sqliteProjectRepository.ts`（默认 SQLite 文档仓储，WAL + `IMMEDIATE` 事务）、`apiTokenRepository.ts`（SQLite/内存 Token 与安全事件）、`jsonProjectRepository.ts`（仅隔离测试）；旧 `data.json` 由 SQLite 初始化器导入 |
| `services/` | 用例 | `projectService`、`apiTokenService`（项目 Token 生命周期与鉴权）、`versionService`（交互式/CI 上传、发布、回滚、删除）、`artifactService`（解压/扁平化/大小/缓存服务）、`artifactAuditEngine`/`artifactAuditService`（静态审计与同步兼容）、`artifactAuditJobService`（持久化队列/租约/重试/原子完成）、`artifactAuditExecutor`/`artifactAuditWorker`（隔离子进程与单任务调度）、`artifactRecovery`（两阶段删除与中断恢复）、`runtimeOwnership`（本机单实例所有权）、`artifactIntegrityService`（显式完整性检查）、`storageReconciler`/`storageGarbageCollector`（对账与保留策略）、`backupService`（备份验证恢复）、`metrics`（低基数进程指标）、`deployResolver`（纯函数解析 `/deploy/*`）；`contracts.ts` 存放 **Bun 无关**的服务接口 |
| `workers/` | 隔离进程入口 | `artifactAuditProcess.ts` 只接受一份严格 JSON 输入并输出一份经过 schema 校验的结果；不承载 HTTP、会话或数据库连接 |
| `routes/` | HTTP 适配 | session 管理面的 `projects` / `versions` / `apiTokens` / `artifactAudits` / `history`，经 `middleware/apiToken.ts` 鉴权的独立 `ciVersions`，以及依赖 artifactService 的 `deploy` |
| `app.ts` | 组合根 | `createApp(config)` 返回不争用所有权的测试应用；先挂载 `/api/ci/*` 的 Token 路由与终止 404，再挂载 session 管理 API；`createDeployKitRuntime(config)` 先获取运行时所有权，再组合相同 Hono app 与 durable audit Worker |
| `api.ts` | 类型化导出 | `createApiApp` + `export type ApiApp = ReturnType<typeof createApiApp>`（Bun/Node 无关，供前端） |
| `index.ts` / `runtime.ts` | 运行入口 | `Bun.serve` + Worker 启动；SIGTERM/SIGINT 同时停止 HTTP 接收和任务领取，等待 drain 后 SQLite checkpoint |

### 错误传递

稳定错误码与错误信封定义在 `packages/shared/src/errors.ts`。服务层抛出
`ApiError(code, message, status)`；`app.onError` 将其转为
`{ "error": { "code", "message" } }`，其他异常降级为
`INTERNAL_ERROR` 500。Web 将其解析为带 `status/code/requestId` 的
`ApiClientError`；Electron main 先解析为 `ServerError`，再通过显式
`IpcResult` 传给 renderer 重建 `ApiClientError`，避免 Electron 丢失自定义字段。
旧服务端只有英文 message 时仍保留兼容回退，但本地化优先使用稳定 code。

每个响应都携带 `X-Request-Id`；有效的上游请求编号会原样回传，客户端错误对象会保留它用于故障定位。

### 原子写边界

所有修改 `Data` 的业务用例必须使用
`ProjectRepository.mutate(operation)`，不得在服务中自行 `load()` 后再
`save()`。SQLite 实现在读取前获得 `BEGIN IMMEDIATE` 写事务，保证 slug、
邮箱唯一性、成员角色、发布状态和历史事件基于同一个最新快照提交；回调抛错时
整个变更回滚。文件解压等耗时 I/O 位于事务外，最终元数据提交失败时清理新产物。

CI 上传使用更窄的 `commitVersionUpload` 原子边界。SQLite 在同一个
`BEGIN IMMEDIATE` 中清理过期记录、重新读取 Token 的项目/撤销/过期/scope
状态、判定 `(projectId, tokenId, idempotencyKey)` 的重放或冲突，并提交
version、history 和幂等记录。因此“请求鉴权后 Token 被撤销”与并发重试都不能
越过提交点。JSON adapter 只用于隔离测试，幂等状态仅在单进程内存中维护，也
不提供这组跨进程原子保证；旧 `data.json` 的迁移由 SQLite 初始化器完成。真实
runtime 要求 `databaseFile` 并使用 SQLite，不能把 JSON adapter 当成生产存储。

### 上传资源与路径安全

- 请求：交互式和 CI 路由复用同一套 Hono `bodyLimit` 与上传 gate，在
  `formData()` 前限制完整 multipart 大小，并分别限制全局、调用主体和项目
  并发数。
- ZIP：`fflate.Unzip` 从临时 ZIP 分块读取，不再把压缩包和所有解压结果同时
  放入内存；在条目发现时检查数量、路径长度、声明解压体积和压缩比，在每个
  输出块检查实际累计体积。
- 文件夹：全部路径、数量和总大小预检通过后才开始写入。
- 路径：`safeJoin` 拒绝绝对路径、`..`、空字节、Windows 盘符逃逸；任一失败
  清理本次生成的产物。
- 部署：`deployResolver` 经 `safeJoin` 将请求解析到版本目录内，越界返回 `403`。
- 缓存：active URL 是可移动别名，使用 ETag/revalidate；只有携带真实
  `versionId` 的 URL 才能使用一年 immutable。ETag 包含版本文件身份和 stat
  信息，回退到其他目录时不会复用旧 validator。

### 为什么 `api.ts` 与 `contracts.ts` 必须 Bun/Node 无关

前端 `tsc`（`types: ["vite/client"]`，无 `bun-types`）会沿 `import type { ApiApp }` 追踪到后端源文件；任何 `Bun.*` 或 `node:fs` 引用都会让前端类型检查失败。因此：
- 服务接口集中在 `services/contracts.ts`（类型 + `File`，无 Bun/Node）。
- `routes/{projects,versions,history}` 不直接 import `node:fs`。项目和版本
  删除由服务层通过 `artifactRecovery` 编排，使文件两阶段移动与元数据事务
  保持在同一用例边界。
- 部署路由依赖 `artifactService`（用 `Bun.file`），故不在 `api.ts` 图中。

### 浏览器信任边界

- `MANAGEMENT_BASE_URL`：管理 UI、`/api/*`、`/health/*`。
- `DEPLOY_BASE_URL`：`/deploy/*`、`/health/*`。
- `/metrics` 仅属于管理源；生产开启时还需要独立 bearer token。
- 其他 Host、部署源上的 API、管理源上的产物路由都返回 404。
- 浏览器 API 客户端只使用 HttpOnly session Cookie，不持久化 bearer token。
- `MANAGEMENT_BASE_URL` 配置后，所有非 `GET`/`HEAD`/`OPTIONS` 的
  `/api/*` 请求都会在读取请求体前验证发起方。只要携带 `Origin`，其值必须与
  管理源的序列化 origin 完全一致；`null`、格式错误或其他源均返回
  `403 CSRF_VALIDATION_FAILED`。任何携带 `deploykit_session` Cookie 的
  写请求若缺少 `Origin` 同样拒绝，即使同时携带 bearer 头；只有 bearer-only
  客户端可省略浏览器元数据。`Sec-Fetch-Site` 为
  `same-site` 或 `cross-site` 时始终拒绝写请求，即使其他头部看似可信；没有
  浏览器 origin/fetch 元数据的 bearer 客户端继续兼容。目标 Host 隔离和 CORS
  都不能替代这层控制：同一站点的兄弟源可发送携带 SameSite Cookie 的请求，
  而 CORS 仅阻止攻击者读取响应，不会阻止服务器发生状态变更。
- 浏览器和 Electron 令牌都包含签名 `jti`，并且必须命中 SQLite 中未过期、
  未撤销的 `sessions` 行；角色始终从当前用户数据读取。登录/注册只创建一个
  browser session，响应 token 与 Cookie 相同。Electron 通过一次性授权码创建
  独立 desktop session。
- 登出会先撤销当前 session；用户可列出自己的设备、撤销指定设备或全部登出，
  不能读取或撤销他人的 session。

### Session 与 CI 自动化身份隔离

- 普通 `/api/*` 管理路由加载 browser/desktop session；项目 Token 的创建、
  列出、轮换、撤销和安全事件读取也属于管理面，只允许项目 owner 或全局 admin。
- `/api/ci/projects/:id/versions` 在 session app 之前挂载，只接受 canonical
  project API Token bearer；Cookie、browser/desktop session bearer 都不能
  认证该路由。`/api/ci` 和未注册的 `/api/ci/*` 在进入 session app 前终止为
  404，避免路由前缀落回普通管理认证。
- 项目 API Token 也不能访问项目、发布、回滚等 session 管理路由。v1 唯一
  scope 是 `preview:upload`，且始终绑定一个项目；不存在 staging 或 production
  publish scope。
- 完整 Token 只在创建/轮换响应返回一次并设置 `Cache-Control: no-store`；
  SQLite 只保存带版本的摘要与 prefix。列表、事件、日志、指标和错误不得包含
  明文。泄漏时由 owner/admin 立即零重叠轮换或撤销，再替换 CI secret。

### 授权边界

`domain/authorization.ts` 是全局角色与项目角色组合规则的唯一真源：

- `admin` 可读取和管理全部项目。
- `developer` 可创建项目；项目写操作还要求 `owner/member` 身份。
- `viewer` 只能读取自己所属的项目，即使被加入为 member 也不能写入。
- 项目列表、版本读取和历史读取在 `ProjectService` 接收 actor 并过滤，避免
  新路由忘记挂中间件而泄露数据。
- 用户搜索必须位于 `/api/projects/:id/users/search`，只允许该项目 owner
  或 admin 使用，避免全局账号枚举。

## API 契约

session 管理面的请求/响应类型由 `ApiApp` 路由处理器的 `c.json(...)` 与
`hono/validator` 推导，前端经 `hono/client` 自动获得类型。CI router 在组合根
独立挂载，不属于浏览器 `ApiApp` 类型。完整端点表见根
[README](../README.md#api-接口)。错误统一为
`{ "error": { "code": ErrorCode, "message": string } }`。上传端点使用
`multipart/form-data`（`file` 或 `folderFiles[]` + `versionDesc`）。

项目 owner/全局 admin 通过 session 管理
`GET/POST /api/projects/:id/api-tokens`、
`POST /api/projects/:id/api-tokens/:tokenId/rotate`、
`DELETE /api/projects/:id/api-tokens/:tokenId` 和
`GET /api/projects/:id/api-tokens/security-events`。创建/轮换响应才包含一次性
`plaintextToken`；list、revoke 和 security-events 只返回脱敏元数据。

历史接口返回 `{ items, nextCursor }`。`nextCursor` 是只包含历史事件 ID
的版本化 Base64URL 不透明令牌；下一页从该事件之后继续，因此列表头部新增事件
不会导致重复或跳项。SQLite 历史不截断，单页最多返回 200 条；不存在、格式
错误或不属于当前可见项目的游标返回 `INVALID_HISTORY_CURSOR`。

产物审计保留同步兼容接口
`POST/GET /api/projects/:id/versions/:versionId/audit`，并增加
`POST/GET/DELETE .../audit-jobs[/jobId]`。异步 POST 返回 `202 { job, reused }`
及相对 `Location`/整数 `Retry-After`；集合 GET 使用绑定项目、版本、状态筛选和
锚点任务 ID 的严格 Base64URL keyset 游标。游标 payload 使用从同一 effective
`SESSION_SECRET` 派生的用途隔离 key 做 HMAC-SHA256 签名，语义重编码、跨 scope、
状态或签名篡改都会返回 `INVALID_AUDIT_JOB_CURSOR`。单项 GET 轮询持久化状态，
DELETE 先持久化取消再中止本机子进程。活动任务按 checksum、
引擎版本与策略快照去重；执行采用租约/心跳，崩溃或过期后有限重试。项目 owner 通过
`PATCH /api/projects/:id/audit-policy` 在 `advisory` 与 `blocking` 间切换并
配置体积预算。详细报告每个版本保留一份，运行历史写入追加式 `audit_events`。
Worker 完成时在一个元数据事务内提交报告、历史和任务终态；过期租约、取消、
换策略或 checksum 变化都会拒绝迟到结果。报告绑定 checksum、引擎版本和预算；
静态检查不执行 JavaScript、不访问网络，且根 HTML 解析上限为 2MB。

CI 上传契约是
`POST /api/ci/projects/:id/versions`，multipart 字段与交互式上传相同，并额外
要求 `Authorization: Bearer <project token>` 和 `Idempotency-Key`。幂等键只
接受 1–128 个 `[A-Za-z0-9._~:-]` 字符；记录保留 24 小时。相同
Token/project/key 且规范化描述与产物 checksum/sourceType/size/fileCount 摘要
一致时返回原版本（首次 `201`，重放 `200`）；摘要不同返回
`409 IDEMPOTENCY_CONFLICT`。CI 仍走共享的解压、路径、入口、checksum、quota
和 concurrency 管线，只创建 preview 且不改变 `activeVersionId`。生产发布必须
由 session 用户在管理路由提交 `expectedActiveVersionId`，继续执行 CAS 和
blocking audit gate；当前没有 staging 环境或自动生产发布。成功 body 只有
`{ version: { id, name }, replayed }`；固定预览地址由
`DEPLOY_BASE_URL + /deploy/{slug}/{version.id}/` 构造，不存在 `previewUrl`
响应字段。

## 存储布局

```
apps/server/
├── deploykit.sqlite                       # 元数据、发布/审计、会话、API Token 与 CI 幂等
├── deploykit.sqlite.runtime-lock.sqlite   # SQLite 数据库资源的内核事务锁 sidecar
├── data.json                              # 旧版本数据，仅在 SQLite 为空时导入一次
├── public/                                # 管理面板（打包脚本同步自 apps/web/dist）
└── .voasx/
    ├── storage.runtime-lock.sqlite         # 产物存储资源的内核事务锁 sidecar
    └── storage/
        ├── .staging/                       # 上传处理中间目录（默认保留 24h）
        ├── .recovery/
        │   ├── trash/{operationId}/        # 已删除但保留期内可恢复的产物
        │   ├── conflicts/                  # 路径/清单冲突，人工处理前阻止 ready
        │   └── orphans/                    # 无元数据引用的隔离产物
        └── {projectId}/
            └── {versionId}/                # 该版本的扁平化静态文件
                └── index.html, assets/, ...
```

- `deploykit.sqlite`：启用外键、WAL、`synchronous=NORMAL` 与
  `busy_timeout`。用户、项目、成员、版本、发布、审计任务/报告、会话、项目
  API Token、安全事件和 CI 幂等记录使用独立关系表；
  聚合写用例通过同步 `mutate` + `IMMEDIATE` 事务执行行级 upsert/delete，防止
  并发覆盖。审计事件只追加不截断，游标先解析到数据库自增序列，再按可见项目
  直接查询；发布、回滚与兼容 activate 会在同一事务写入独立 `releases` 台账。
  `artifact_audit_jobs` 由独立仓库按行维护 enqueue、领取/租约恢复、心跳、
  完成、失败/重试、取消、分页、健康状态与批量清理；空轮询不重写聚合数据。
  relational schema v5 增加活动任务部分唯一索引，以及领取、分页、过期租约和
  终态保留索引；v6 增加项目 API Token、安全事件与 CI 幂等记录。每次关系型
  schema 升级前创建对应 `.pre-relational-v{n}.bak`，重复活动任务等不一致会使
  迁移 fail closed。文档 schema v7 升级到 v8 同样保留备份。
- 旧 `deploykit_state` 单行数据库会先通过 `VACUUM INTO` 创建
  `.pre-relational-v1.bak`，再在同一事务中导入关系表；旧 `data.json` 仅在空
  SQLite 首次初始化时导入，并保留 `.sqlite-migration.bak`。迁移标记保证重复
  启动不会再次覆盖关系数据。
- 删除项目/版本先把产物在同卷原子移动到 `.recovery/trash/{operationId}`；
  version 4 manifest 明确记录 delete 操作、project/version 目标、完整目标
  version ID 集合、原路径、recovery 路径、committed 状态、移动后目录的
  dev/inode/birthtime/ctime 身份，以及删除前持久化的版本 checksum。元数据
  事务失败时恢复原路径，成功时更新 manifest 并写 `COMMITTED` 标记，等待
  保留期 GC；version 1/2/3 manifest 仍可在无歧义时恢复。
  `flattenOutput` 会将单层嵌套（含 `index.html` 的子目录）上移并移除
  `__MACOSX`。
- 上传先写入同一存储卷的 `.staging/{versionId}`，完成入口、大小、数量与
  checksum 校验后，通过 `rename` 原子移动到正式版本目录，再提交 SQLite 元数据。
  `.staging`、本次 staging 和最终目录在创建、写入、解压、移动和清理前都会
  重新经过同一 storage-root 相对路径守卫；不安全时返回不含真实路径的
  `503 STORAGE_CONTROL_CONFLICT`。元数据提交失败会在路径仍安全时删除正式
  目录，补偿清理失败不会覆盖原始上传/元数据错误。
- `activeVersionId` 是唯一发布指针。发布、回滚与兼容 activate 请求必须携带
  调用方读取到的 `expectedActiveVersionId`；服务端在同一次元数据事务中校验，
  不一致返回 `409 RELEASE_CONFLICT`。切换前会验证版本生命周期、
  `index.html` 和目录 checksum。`blocking` 项目还会在快照检查与同一元数据
  事务内重复校验当前审计报告；删除线上版本只会将项目下线，不会隐式发布
  另一个版本。
- 真实运行入口会在任何目录创建、SQLite 打开、存储对账或 HTTP serving 前，
  对数据库及其 journal/WAL/SHM、存储、两个 ownership sidecar 及各自的
  journal/WAL/SHM 做一次统一布局解析。
  每个现有路径前缀先 `realpath`；Darwin 对尚不存在的尾部先做 Unicode NFD
  规范化并用 upper-then-lower 的完整 case-fold 近似保守比较，Windows 也保守
  case-fold。I/O 路径仍保留原始拼写；
  比较键可能在大小写敏感 APFS 卷上拒绝仅大小写或 Unicode 规范化形式不同的
  名称。所有主资源和 SQLite 辅助路径不得相等或互为祖先/后代，否则以
  `RUNTIME_OWNERSHIP_LAYOUT_UNSAFE` fail closed。随后按路径排序获取两个
  SQLite sidecar 的 `BEGIN EXCLUSIVE` 事务锁：
  `<DATABASE_FILE>.runtime-lock.sqlite` 与
  `<STORAGE_DIR>.runtime-lock.sqlite`。数据库或存储任一资源已被活跃进程持有，
  启动都会以 `RUNTIME_OWNERSHIP_HELD` fail closed；若第二把锁失败，第一把立即
  释放。锁的正确性只依赖打开的 SQLite 事务，连接关闭或进程死亡由内核释放；
  sidecar 内的 PID/token 仅供诊断。数据库与存储配置 leaf 都拒绝 symlink；
  已存在数据库必须是普通文件，存储必须是目录。数据库若有多个 hard link，会在
  创建任何 sidecar 前以 `RUNTIME_DATABASE_HARDLINK_UNSAFE` 拒绝。数据库的
  journal/WAL/SHM、两个 sidecar 及其全部 SQLite auxiliary 会先全部经过
  `lstat`：必须是非 symlink、单 hard-link 的普通文件；所有既有 runtime
  资源的 dev/inode 也必须互不相同。不安全 leaf 使用
  `RUNTIME_OWNERSHIP_LAYOUT_UNSAFE`，不会打开目标 SQLite，也不会创建另一条
  sidecar。sidecar 打开前会完成全部 auxiliary leaf preflight，再固定并验证
  `journal_mode=DELETE`；rollback journal 路径仍属于上述布局。正常 HTTP/worker
  drain 全部确认后才显式释放 ownership；timeout、
  drain/force-stop 失败或未完成时保留到进程退出。Bun SQLite 的按路径打开不能
  把 `lstat` 与后续 path-based open/copy 合并成原子
  `openat(O_NOFOLLOW)`，因此所有 runtime 资源父目录必须只允许可信服务账号
  写入；若要支持不可信本机目录，需要原生 no-follow/openat 锁实现。该机制只
  承诺单机进程互斥，不是多主机分布式锁；纯
  `createApp/app.request` 测试不获取它。
- 应用开始服务前先恢复未完成删除，再执行 GC 和 orphan 对账。元数据仍引用目标
  时把 recovery 产物恢复到原路径；元数据已删除目标时补齐 committed manifest
  与 `COMMITTED`。统一的 storage-root 相对路径守卫会检查 source、operation、
  `.staging`、`.recovery`、`trash`、`conflicts`、`orphans` 控制目录、
  artifacts 祖先、recovery 对象及其递归树；任一现有祖先或对象为 symlink 都
  fail closed，且不访问其外部目标。若原路径已存在而
  recovery 已缺失，只在 version 4 的证据成立时清理 manifest：只要存在一个
  有效持久 checksum，其 version ID 集合就必须与完整目标集合完全一致，并逐个
  重新计算匹配，部分 checksum 不能退回目录身份；完全没有有效 checksum 时才
  允许目录身份兜底。缺少完整目标集合的旧 version 3 歧义分支一律 fail closed。
  其他情况移动到 `.recovery/conflicts/` 并让 readiness 返回 503；本次启动存在
  任一恢复冲突时暂停 GC、orphan 隔离和元数据修复等全部破坏性对账。无冲突时
  才清理超过 staging 保留期的中断上传和旧 ZIP；
  没有元数据引用的正式产物移动到 `.recovery/orphans/`，并从隔离时刻重新计算
  恢复保留期。只有过期且带 `COMMITTED` 的 trash 会自动删除，未提交 trash
  永久留给人工检查。元数据存在但
  缺少 `index.html` 的版本标记为 `failed` 并记录 `version.reconcile`。若缺失
  版本原本在线，只会清空 `activeVersionId`，不会自动发布另一个版本。
- 全局、项目创建者和单项目容量在上传最终 `IMMEDIATE` 元数据事务内重新计算；
  超额时删除本次已落盘产物并返回 `STORAGE_QUOTA_EXCEEDED`。
- 完整性检查是显式操作，不在每次启动对全树哈希。结果持久化为
  `unknown/verified/missing/corrupted`；缺失或损坏的线上版本只会下线。
- 路径均可通过环境变量重定位（`DATABASE_FILE` / `DATA_FILE` / `STORAGE_DIR` / `PUBLIC_DIR`）。

### 备份与恢复

`bun run ops -- backup` 使用 `VACUUM INTO` 生成一致 SQLite 快照，复制完整
存储树，并以版本化 `manifest.json` 记录 schema、数据库文件名、元数据计数和
产物计数。schema v6 清单强制记录 Token、安全事件和 CI 幂等记录三项计数；
v5 备份仍可验证和恢复，并在恢复后的真实 runtime 启动时迁移到 v6。`verify`
在恢复前检查 SQLite 完整性/外键、清单计数、符号链接、版本入口和 checksum。

恢复必须在服务停止后使用 `--force`。restore 自身还会获取同一 runtime
ownership；活跃服务存在时即使传入 `--force` 也拒绝，避免用确认参数绕过互斥。
backup/restore 会在打开源数据库、创建目标或移动当前状态前复用同一布局与
leaf preflight；数据库/存储重叠、错误 leaf 类型或 aliased SQLite auxiliary
都会 fail closed。备份负载只包含经 `VACUUM INTO` 验证的数据库快照和存储树，
不会携带或安装 journal/WAL/SHM。
恢复会先复制到数据库和存储各自同卷的临时路径；验证通过后，当前数据库及其
journal/WAL/SHM 与存储移动到 `.deploykit-rollback/{operationId}`，再原子安装
新状态。rollback root、operation、stage、DB/storage target 和 auxiliary target
会在获取 ownership 或创建目录前与全部 runtime resource 做双向祖先校验；
固定 operation 或 stage 已存在也会拒绝，不能复用旧残留。备份源即使位于 live
storage 内，也会在任何 live move 前把数据库和存储 payload 完整复制到上述已
校验 stage。

move 前会记录数据库、每个 auxiliary 与存储各自是否存在，并为每个资源分别记录
rollback 是否已发布、source 是否已移除。跨卷 move 只复制到 rollback target
同目录的全新 pending sibling，再原子 rename 发布，发布后才删除 source；恢复
绝不以 target 的 `exists` 代替发布状态。source 删除失败时，即使 live source
可能只被删了一部分，完整 published rollback 仍是权威副本。补偿也先复制到
live target 同卷的全新 recovery sibling，完成后才替换 live target。

任一步骤或 finalize 失败都会独立尝试 DB、三个 auxiliary、storage、两个 stage
清理和 ownership release；一个补偿错误不会跳过后续动作。初始错误对象、message
与 code 保持权威，补偿/清理/release 失败通过 `restoreSecondaryFailures` 和
`AggregateError` cause 附加。已经发布完整资源的 rollback operation 在成功或
失败后均保留供审计/人工恢复；仅含未发布部分副本的 pending target、stage 和
operation 会尽力清理。rollback 可能包含完整数据库、产物以及原本位于 live
storage 内的备份副本，属于敏感数据：父目录必须仅由受信服务账号写入并限制
读取权限，运维在验证恢复后负责按保留策略清理。原本缺失的数据库、auxiliary
或存储仍保持缺失；这些 auxiliary 只用于失败回滚与审计，不会从备份安装。

## 前端结构（packages/client/src）

- `App.tsx` — 共享 Provider 与应用路由入口；Web 与 Electron 复用同一客户端。
- `features/` — 按领域拆分：认证、项目、版本、设置、成员与历史时间线。
- `api/` — 传输无关 `ApiClient` 契约；Web 使用 `hono/client`，Electron 通过 IPC 实现同一接口。
- 类型来自 `@deploykit/shared`，由 `src/domain.ts` / `src/errors.ts` 经
  `src/index.ts` 统一导出。

## 数据模型（packages/shared）

```ts
Settings  { spaMode: boolean; routingType: 'hash' | 'path' }
ArtifactAuditPolicy { enforcement: 'advisory' | 'blocking'; maxTotalBytes; maxFileBytes; maxFileCount }
Version   { id; name; description; createdAt; size; fileCount; sourceType; status; publishedAt; publishedBy; checksum; integrityStatus; integrityCheckedAt }
Project   { id; name; slug; description; createdAt; updatedAt; versions: Version[]; activeVersionId: string | null; settings: Settings; auditPolicy: ArtifactAuditPolicy }
ArtifactAuditReport { id; projectId; versionId; artifactChecksum; status; score; createdAt; createdBy; engineVersion; policy; summary; checks }
ArtifactAuditJob { id; projectId; versionId; requestedBy; status; priority; attempts; maxAttempts; nextRunAt; lockedBy; lockedUntil; artifactChecksum; engineVersion; policy; reportId; errorCode; errorMessage; timestamps }
HistoryEvent { id; action; projectId; projectName; versionId; versionName; timestamp; actorId; metadata? }
User      { id; name; email; passwordHash; role; createdAt; updatedAt }
Data      { schemaVersion; projects: Project[]; users: User[]; history: HistoryEvent[]; artifactAudits: ArtifactAuditReport[]; artifactAuditJobs: ArtifactAuditJob[] }
```

> 注：`project.activeVersionId` 是线上版本唯一真源；`version.status` 用于展示、
> 筛选与发布语义同步，不应重新引入 `version.active`。
>
> 项目 API Token、安全事件和 CI 幂等记录是 relational schema v6 的专用表，
> 不进入 legacy `Data` aggregate，也不会由 JSON test adapter 提供生产持久性。

## 运行模式与探针

- `development`（默认）：允许临时会话密钥与随机首个管理员密码，默认开放注册。
- `test`：与开发默认一致，但显式标识测试运行。
- `production`：`SESSION_SECRET`（至少 32 字符）、`ADMIN_PASSWORD`、
  `MANAGEMENT_BASE_URL` 和 `DEPLOY_BASE_URL` 必填，两个 URL 必须不同源，
  注册默认关闭；任何非法端口、大小、数量、布尔或 URL 配置都会中止启动。
- `GET /health/live`：`204`，仅表示 HTTP 进程存活。
- `GET /health/ready`：实际读取元数据仓库；无未解决恢复冲突时返回
  `{ "status": "ok" }`，`.recovery/conflicts/` 非空时返回 `503`。

## 可观测性与生命周期

根应用先分配/回传 `X-Request-Id`，再执行可观测中间件与信任边界，因此成功、
业务错误、内部错误和 Host 拒绝都会产生一条访问日志。日志为单行 JSON，指标
只使用方法、已注册路由模板和状态类别；不得把项目 ID、slug、用户或文件路径
作为 label。

`/metrics` 使用 Prometheus text exposition，提供 HTTP histogram/counter、
失败、上传、发布、产物审计报告状态、任务 outcome、`queued/running` gauge
及存储 gauge。指标进程内累计，重启后清零；持久化任务/报告/历史仍以 SQLite
为准。任务指标只使用固定枚举标签，不允许项目、版本、用户、路径或错误文本。
生产默认不开放 metrics，显式开放时 token 通过常量时间比较。

SIGTERM/SIGINT 首次到达后，`runtime.ts` 先调用 `server.stop(false)` 停止接收，
同时让 Worker 停止领取、取消并等待本机活动子进程；二者都完成后才对 SQLite
执行 `wal_checkpoint(TRUNCATE)`。被中止的拥有租约任务经统一失败路径重新
排队，取消或丢失租约的迟到完成会被拒绝。若 drain 失败或超过配置时限，则
调用 `server.stop(true)`；force stop 本身也有独立上限，即使其 Promise 不结束
仍尝试 checkpoint，并以非零状态退出；重复信号
  复用同一个关机 Promise。只有正常 drain 才会 checkpoint 后释放本进程
  ownership；timeout、drain/force-stop 失败或未完成会保留 kernel ownership
  到进程死亡，避免仍在运行的工作与新进程重叠。`Bun.serve`、信号注册、Worker
  启动和启动日志位于同一清理边界；启动失败会有界停止已启动资源并移除信号
  处理器，只有 HTTP/worker cleanup 都确认完成才释放 ownership，否则同样保留
  到进程死亡。
