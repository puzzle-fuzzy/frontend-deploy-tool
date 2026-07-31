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
两把锁。数据库 journal/WAL/SHM、存储、两个 sidecar 及各自
journal/WAL/SHM 会先作为一个布局校验，任何相等或祖先碰撞都以
`RUNTIME_OWNERSHIP_LAYOUT_UNSAFE` 拒绝；Darwin 对不存在的尾部先做 Unicode
NFD 规范化并用 upper-then-lower case-fold 保守忽略大小写，Windows 也保守
忽略大小写，I/O 路径不改写。
大小写敏感 APFS 上可能拒绝仅大小写或规范化形式不同的配置。database/storage
leaf symlink 不受支持；已存在数据库必须是普通文件、存储必须是目录。数据库有
多个 hard link 时，会在创建 sidecar 前以
`RUNTIME_DATABASE_HARDLINK_UNSAFE` 退出。数据库 auxiliary、既有 sidecar 及
其 SQLite auxiliary 必须是非 symlink、单链接普通文件，且所有既有 runtime
资源不得共享 dev/inode；完成全部 preflight 后 sidecar 固定为
`journal_mode=DELETE`。backup、restore 和 GC 都是 ownership 参与者；backup/restore
在打开源数据库或变更目标前复用同一 preflight；备份只安装 `VACUUM INTO` 快照，不安装 journal/WAL/SHM，失败恢复
按显式 pre-state presence 与逐资源 published/source-removed 状态从 rollback
还原，原本缺失的 DB/storage/auxiliary 仍保持缺失。跨卷 move 先复制到全新
sibling temp 并原子发布，不能把部分副本当成 rollback；补偿、stage 清理与
ownership release 都是 best effort，初始错误保持权威并携带结构化 secondary
failure。完整 published rollback operation 会保留，未发布部分副本会清理。正常
HTTP/worker drain 全部确认后才显式
release；timeout、drain/force-stop 失败或未完成时保留 ownership 到进程退出。
sidecar 内的 PID/token 只是诊断数据，不参与正确性判断。该协议仅适用于单机上的
规范 database/storage pair，且所有 runtime 资源父目录必须由可信服务账号独占写入；
未受管写入者不参与互斥，必须在运维备份前自行停止。Bun 的 path-based
SQLite/file API 不能原子合并 leaf preflight 与 no-follow open，因此所有 runtime
资源父目录必须仅由可信服务账号写入；这是本机进程锁，不支持多主机同时读写同一份
SQLite/本地存储。

## 测试

### 后端（apps/server）

```bash
bun run test          # 根目录（或 cd apps/server && bun test）
```

- `tests/api/` — `hono/testing` 契约测试：覆盖项目/设置/版本/部署/历史游标、Token 生命周期、session/CI 凭据隔离、CI 幂等重放/冲突、上传限制、安全头、健康探针、请求编号与失败清理。`ciProductionProcessSmoke.test.ts` 另起真实 production 子进程，覆盖 worker disabled/enabled 重启、精确 job 轮询、engine-v2 报告持久化、assessment 与 blocking 发布不变量，以及 v5 verify/restore/v7 startup。
- `tests/services/` — 领域/服务/工具单元测试：slug、历史游标、版本不变量、`safePath`、SQLite 原子 mutation/CI commit、仅供测试的 JSON adapter、Token 撤销/轮换、`deployResolver`、`artifactService`、存储启动对账与配置门禁。

应用组装与 `Bun.serve` 分离（`createApp(config)`），测试无需开端口，也不会
获取 runtime ownership。需要验证真实启动互斥/恢复时使用
`createDeployKitRuntime(config)` 或子进程入口。

产物审计新客户端走 durable `audit-jobs`；同步 `POST /audit` 只用于兼容，仍是
preview-only、进程内且受同一静态引擎边界限制，不参与后台 worker 的单任务
lease。engine v2 使用稳定 rule ID/ruleVersion，报告 assessment 可能返回
`checksum_changed`、`engine_changed`、`rule_config_changed` 或
`context_changed`。只改 enforcement 不使 queued job/current report 过期。
六项后端预算为 total bytes、single-file bytes、file count、JavaScript、
stylesheet、font；engine v2 已检查根 HTML 中可静态判定的本地链接/图片目标。
管理 UI、rendered DOM/profile、嵌套页面爬取、服务端路由验证，以及图片内容
解码与尺寸/格式验证尚未交付。

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
   - 创建、写入、解压、移动和清理前都会复查 storage control/staging/final
     路径；不安全时返回不泄露实际路径的 `503 STORAGE_CONTROL_CONFLICT`。
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
symlink，且不会访问外部目标。原路径已存在但 recovery 缺失时，只有 version 4
manifest 可以证明歧义清理：只要有一个有效 checksum，checksum 的 version ID
集合就必须与 manifest 的完整目标集合完全相等并逐个匹配；部分 checksum 不得
使用目录身份兜底，只有零个有效 checksum 时才允许 identity 证明。旧 version 3
歧义分支一律 fail closed。严格路径、身份或 checksum 校验失败会隔离到
`.recovery/conflicts/`，此时 `/health/ready` 保持 `503`，必须先人工处理。
存在恢复冲突的启动轮次会暂停全部破坏性对账：GC、orphan 隔离和元数据修复
都不会执行。
随后才清理过期 staging，将孤儿正式产物移动到 `.recovery/orphans/`；缺少入口
文件的已记录版本会进入 `failed`，缺失的线上版本安全下线且不自动选择替代版本。

`bun run ops -- restore <backup> --force` 仅把 `--force` 当作破坏性操作确认。
restore 仍需获取同一 runtime ownership；后端正在运行时必须先优雅停止，
不能用 `--force` 绕过。restore control/stage/rollback 路径在 acquisition 前
必须与全部 runtime resources 无祖先重叠，且不会复用已有 operation/stage。
rollback operation 可能包含完整数据库、产物与 live storage 内的备份副本；
将其视为敏感数据，限制服务账号目录权限，并在验证恢复后由运维按保留策略清理。

离线备份顺序是：停止所有写入者 -> 停止服务 -> `backup` -> 重启服务 -> 可选的
只读 `verify`。这是 enforced-offline 的协作捕获，不是热备份，也不承诺跨资源原子
瞬间、分布式协调、断电持久性或无副作用；ownership sidecar 和目标文件会被写入，
锁内打开崩溃后的 WAL 数据库也可能触发 SQLite 恢复。

`verify` 对 v5/v6 关系型备份先复制到一次性根，执行生产 v7 migration，再走
生产 `loadRelationalData` 及 project/report/job schema；current v7 直接走同一
domain hydrator。源 manifest/数据库不在验证中写入，SQLite journal/WAL/SHM
不会作为备份负载接受或安装。restore 在 ownership 内重新捕获 manifest、DB、
storage 到绑定 stage，验证该精确 payload 并在 live move 前复核 fingerprint；
验证/迁移临时根在成功和失败后都应消失，清理失败视为验证失败。无法证明身份、
内容或 rename commit 状态的 rollback operation 是 quarantined evidence，必须
人工检查，不能自动覆盖 live 或当作普通临时目录删除。

## CI 预览上传

### 创建和保管项目 Token

项目 API Token 通过 session 管理 API 创建，只允许项目 owner 或全局 admin：

```text
POST   /api/projects/:id/api-tokens
GET    /api/projects/:id/api-tokens
POST   /api/projects/:id/api-tokens/:tokenId/rotate
DELETE /api/projects/:id/api-tokens/:tokenId
GET    /api/projects/:id/api-tokens/security-events
```

创建体为 `{ "name": "GitHub Actions", "expiresAt": "..." }`；`expiresAt`
可省略。轮换体可传 `expiresAt` 与 `overlapSeconds`，其中重叠期范围为
0–86400 秒，设为 `0` 会立即撤销旧 Token。创建和轮换响应中的
`plaintextToken` 只出现一次，后续 list/security-events 不会返回明文或摘要。
收到响应后应立即写入 CI secret；如果明文遗失，重新轮换，不要把它写入
`.env`、shell 脚本、Issue、构建产物或仓库。

疑似泄漏时：

1. 使用 `overlapSeconds: 0` 轮换或立即撤销旧 Token；
2. 把新 Token 写入受控 CI secret，并重新执行受影响流水线；
3. 检查流水线日志、Issue、构建产物和 Git 历史，清理副本并查看
   `security-events`；
4. 不要在排障消息中粘贴泄漏值。

### 本地 curl

以下 Bash 命令从终端无回显读取 Token，因此凭据字面量不会进入 shell history
或仓库。ZIP 根目录必须包含 `index.html`。生产环境的
`DEPLOYKIT_MANAGEMENT_URL` 应指向 `MANAGEMENT_BASE_URL`，而不是
`DEPLOY_BASE_URL`：

```bash
read -rsp 'DeployKit API token: ' DEPLOYKIT_API_TOKEN
printf '\n'
export DEPLOYKIT_API_TOKEN
export DEPLOYKIT_MANAGEMENT_URL='http://localhost:4010'
export DEPLOYKIT_DEPLOY_BASE_URL='http://localhost:4010'
export DEPLOYKIT_PROJECT_ID='replace-with-project-id'
export DEPLOYKIT_PROJECT_SLUG='replace-with-project-slug'
export DEPLOYKIT_ARTIFACT_ZIP='./dist.zip'
export DEPLOYKIT_IDEMPOTENCY_KEY='local-preview-001'

curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer ${DEPLOYKIT_API_TOKEN}" \
  -H "Idempotency-Key: ${DEPLOYKIT_IDEMPOTENCY_KEY}" \
  -F "file=@${DEPLOYKIT_ARTIFACT_ZIP};type=application/zip" \
  -F 'versionDesc=local CI preview' \
  "${DEPLOYKIT_MANAGEMENT_URL}/api/ci/projects/${DEPLOYKIT_PROJECT_ID}/versions"

unset DEPLOYKIT_API_TOKEN
```

`Idempotency-Key` 只允许 1–128 个 `[A-Za-z0-9._~:-]` 字符。服务端将同一
Token/project/key 的记录保留 24 小时；相同描述和产物摘要的重试返回同一个
版本，内容或描述不同则返回 `409 IDEMPOTENCY_CONFLICT`。同一次流水线的网络
重试必须复用原键，不能每次 curl 都生成新时间戳。首次成功响应为
`201 { version, replayed: false }`；重放为
`200 { version, replayed: true }` 并带 `Idempotency-Replayed: true`。
响应没有 `previewUrl` 字段；用已知的项目 slug 和返回的 `version.id` 按
`${DEPLOYKIT_DEPLOY_BASE_URL}/deploy/{projectSlug}/{version.id}/` 构造固定预览
地址。生产中的 `DEPLOYKIT_DEPLOY_BASE_URL` 应取服务端 `DEPLOY_BASE_URL`，
不能使用只提供管理 API 的 `MANAGEMENT_BASE_URL`。

### GitHub Actions

在仓库或 environment settings 中创建 `DEPLOYKIT_API_TOKEN` secret；URL 和
项目 ID 可使用非敏感的 Actions variables。不要把 Token 字面量写入 workflow，
也不要启用会回显展开命令的 `set -x`：

```yaml
name: DeployKit preview

on:
  push:

permissions:
  contents: read

jobs:
  preview:
    runs-on: ubuntu-latest
    env:
      DEPLOYKIT_API_TOKEN: ${{ secrets.DEPLOYKIT_API_TOKEN }}
      DEPLOYKIT_MANAGEMENT_URL: ${{ vars.DEPLOYKIT_MANAGEMENT_URL }}
      DEPLOYKIT_DEPLOY_BASE_URL: ${{ vars.DEPLOYKIT_DEPLOY_BASE_URL }}
      DEPLOYKIT_PROJECT_ID: ${{ vars.DEPLOYKIT_PROJECT_ID }}
      DEPLOYKIT_IDEMPOTENCY_KEY: github-${{ github.run_id }}-${{ github.job }}
    steps:
      - uses: actions/checkout@v6
        with:
          persist-credentials: false
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun --filter @deploykit/web build
      - run: (cd apps/web/dist && zip -qr ../../../deploykit-artifact.zip .)
      - name: Upload preview
        run: |
          curl --fail-with-body --silent --show-error \
            -H "Authorization: Bearer ${DEPLOYKIT_API_TOKEN}" \
            -H "Idempotency-Key: ${DEPLOYKIT_IDEMPOTENCY_KEY}" \
            -F "file=@deploykit-artifact.zip;type=application/zip" \
            -F "versionDesc=${GITHUB_SHA}" \
            "${DEPLOYKIT_MANAGEMENT_URL}/api/ci/projects/${DEPLOYKIT_PROJECT_ID}/versions"
```

GitHub 官方建议通过 `secrets` context 把 Actions secret 注入环境，并避免在命令行
中直接传递秘密值；对包含 secret 使用方式的 workflow 变更进行审查。参见
[GitHub Actions secrets reference](https://docs.github.com/en/actions/reference/security/secrets)
和
[Using secrets in GitHub Actions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets?tool=webui)。

### GitLab CI

在 GitLab 项目的 **Settings → CI/CD → Variables** 中创建
`DEPLOYKIT_API_TOKEN`，启用 **Masked and hidden**；如果只有受保护分支/标签能
上传预览，再启用 **Protected**。不要在 `.gitlab-ci.yml` 的 `variables` 中写
Token：

```yaml
deploykit-preview:
  image: oven/bun:1
  stage: deploy
  script:
    - bun install --frozen-lockfile
    - bun --filter @deploykit/web build
    - apt-get update && apt-get install -y zip curl
    - (cd apps/web/dist && zip -qr ../../../deploykit-artifact.zip .)
    - export DEPLOYKIT_IDEMPOTENCY_KEY="gitlab-${CI_PIPELINE_ID}-${CI_JOB_NAME_SLUG}"
    - >
      curl --fail-with-body --silent --show-error
      -H "Authorization: Bearer ${DEPLOYKIT_API_TOKEN}"
      -H "Idempotency-Key: ${DEPLOYKIT_IDEMPOTENCY_KEY}"
      -F "file=@deploykit-artifact.zip;type=application/zip"
      -F "versionDesc=${CI_COMMIT_SHA}"
      "${DEPLOYKIT_MANAGEMENT_URL}/api/ci/projects/${DEPLOYKIT_PROJECT_ID}/versions"
```

`DEPLOYKIT_MANAGEMENT_URL`、`DEPLOYKIT_DEPLOY_BASE_URL` 和
`DEPLOYKIT_PROJECT_ID` 可同样通过 GitLab CI/CD variables 配置。GitLab 提醒
恶意流水线脚本仍可泄漏变量，因此合并前必须审查 `.gitlab-ci.yml` 变更；详见
[GitLab CI/CD variables](https://docs.gitlab.com/ci/variables/)。

CI 与交互式上传共享 multipart body limit、ZIP/路径/入口校验、存储 quota 和
全局/调用主体/项目 concurrency gate。CI 路由只创建 preview，不改变线上
`activeVersionId`；v1 Token scope 只有 `preview:upload`。项目当前没有 staging
环境，Token 也不能自动发布生产。生产发布必须由登录用户在管理 API 提交
`expectedActiveVersionId`，继续执行 compare-and-set 与 blocking audit gate。

## 仓库 CI 质量证据

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
