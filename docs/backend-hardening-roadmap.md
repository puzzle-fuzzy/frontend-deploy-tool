# DeployKit 后端完善路线图

## 产品目标

DeployKit 是一个用户可自主管理前端产物、显式发布、手动回退，并能逐步
扩展 SEO、体积和文件质量检测的自托管服务。

当前阶段保留单个 Bun/Hono 进程、SQLite 和本地文件系统。拆分微服务、
引入 Redis 或迁移 PostgreSQL 都不会直接提升当前产品目标，反而会增加
部署、备份和故障定位成本，因此不进入本轮范围。

## 不可破坏的不变量

1. 上传不等于发布；新版本始终先进入预览状态。
2. 只有用户的显式发布或回退操作才能改变线上版本。
3. 删除线上版本后项目变为未发布，不自动选择其他版本。
4. 不可信产物和控制台/API 不得共享浏览器源。
5. 非管理员只能读取自己所属的项目；写操作还需满足项目角色。
6. 任何上传都必须在解析前、解压中和落盘前受到资源预算约束。
7. 元数据、产物目录、审计事件和会话都必须具备可恢复路径。
8. SEO、体积和文件质量检测通过产物审计接口接入，不耦合上传与发布核心。

## 实施顺序

### 阶段 1：信任边界和发布安全

状态：已于 2026-07-30 完成并通过全仓验证、生产 fail-closed 与双域烟雾测试。

- 控制台/API 与部署产物双域隔离。
- 当配置管理源时，非安全方法的管理 API 还按请求发起源防护：`Origin` 必须
  精确匹配管理 origin；任何携带 session Cookie（包括同时携带 bearer）的
  缺失 `Origin` 写请求，以及
  `Sec-Fetch-Site: same-site|cross-site` 的写请求均在解析请求体和业务变更前
  返回 `403 CSRF_VALIDATION_FAILED`。没有浏览器 origin/fetch 元数据的 bearer
  客户端保持兼容。CORS 不能单独覆盖此风险，因为它不阻止同站兄弟源发送请求。
- Web 使用 HttpOnly 会话 Cookie，不在 localStorage 保存访问令牌。
- 项目读取范围和写入权限集中到统一授权策略。
- 请求体、并发数、ZIP 文件数、路径、解压体积和压缩比限制。
- 发布前检查产物存在性、根页面和校验和。
- 发布/回退携带预期线上版本，冲突时拒绝覆盖。
- 删除线上版本时明确下线，不自动替补。

完成门槛：对应 API/服务测试全部通过，`bun run verify` 通过，生产模式在
未配置双域时拒绝启动。

### 阶段 2：可撤销身份与关系型 SQLite

状态：已于 2026-07-30 完成。旧单行数据库具备迁移前一致性备份，核心元数据
使用关系表，审计/发布台账追加写入，浏览器与桌面会话可列出、撤销并跨重启保留。

- 引入持久化 session/device-session，令牌使用 `jti` 并支持注销、过期和撤销。
- 将单行 JSON payload 迁移为 users、projects、members、versions、
  releases、audit_events、sessions 表。
- 迁移器在事务中完成旧数据导入，并保留可重复执行和回滚前备份。
- 审计事件改为游标分页的长期数据，不再使用全局 200 条截断。

完成门槛：旧数据库迁移测试、崩溃恢复测试、会话撤销测试和分页契约测试
全部通过。

### 阶段 3：存储可靠性和运维

状态：两阶段删除、事务容量、保守 GC、持久化完整性、恢复命令、文件事务与
当前验证基线已于 2026-07-30 完成；备份已选择 enforced-offline 协作契约，历史
语义正确性和 production 精确 round-trip 仍是下一阶段。

- 项目/版本删除先进入回收区，再提交元数据，失败可恢复。
- 真实 runtime 分别对规范化 SQLite 与存储路径持有 SQLite sidecar 内核事务锁；
  任一资源共享都会 fail closed，进程死亡自动释放。启动恢复先于 GC/orphan
  对账，引用仍在则恢复、引用已删则完成提交。
- version 4 manifest 持久化完整目标 version ID 集合；存在任何有效 checksum
  时，其 key 集合必须完整且逐项匹配，部分 checksum 不能回退 identity，零个
  有效 checksum 时才允许 identity 兜底。非法/旧 v3 歧义 manifest、
  storage-root 下任一祖先 symlink 或原路径冲突都会进入持久隔离并让 readiness
  返回非 200；统一守卫覆盖 staging/recovery/trash/conflicts/orphans 控制根，
  冲突轮次暂停 GC、orphan 隔离和元数据修复。
- 数据库 journal/WAL/SHM、storage、两个 sidecar 及各自
  journal/WAL/SHM 的规范化布局不得相等或互为祖先；Darwin 对缺失尾部做
  Unicode NFD + upper/lower case-fold，Windows 保守 case-fold。database/storage leaf
  symlink、错误主资源类型、已有数据库 hard link，以及 symlink/非普通/多
  hard-link 或 dev/inode alias 的数据库/sidecar auxiliary 都会在任何 sidecar、
  backup 或 restore mutation 前拒绝；sidecar 固定验证
  `journal_mode=DELETE`。备份 payload 不含 SQLite auxiliary；失败 restore
  使用显式 presence 与逐资源 published/source-removed 状态还原原本存在的
  DB/storage/auxiliary，缺失状态不会被备份内容污染；跨卷 copy 先进入全新
  sibling temp 再原子发布，部分副本不会成为 rollback 权威。补偿、stage 清理和
  ownership release 全部 best effort，初始错误保持权威并附带结构化 secondary
  failure。restore control layout 在 ownership acquisition 前与全部 runtime
  resources 校验；完整 rollback operation 作为敏感审计数据保留并由运维清理。
  活跃 ownership 存在时拒绝 restore，`--force` 不能绕过。
- v5/v6 备份在一次性副本中复用生产 migration 到 v7 与 production relational
  hydrator，current v7 直接执行 project/report/job domain validation；JSON
  syntax/domain corruption、drifted migration target 和清理失败均 fail closed。
  restore 在 ownership 内重新捕获并验证精确 staged payload，拒绝数据库与 stage
  journal/WAL/SHM；身份、内容或 rename commit 状态无法证明的 operation 保留为
  quarantined recovery evidence，不删除可能的唯一 rollback 副本。
- 增加全局、用户、项目容量配额及并发上传配额。
- 为 staging、recovery、孤儿目录增加带保留期的垃圾回收。
- 增加校验和巡检和明确的损坏状态。
- 提供可验证的 SQLite 快照与存储树备份、恢复、校验命令和恢复演练文档。

已验证基线：在注入文件操作失败时无静默数据丢失；备份恢复后 SQLite 内项目、
版本、当前发布和审计事件可读取，存储树通过清单计数、版本入口和 checksum
校验。

验证证据：`bun run verify` 通过（server 232、client 40、desktop 23）；
隔离 SQLite/WAL 演练恢复后项目、版本、线上指针、审计和 session 均一致，
`integrity_check=ok`、外键违规为 0；GC dry-run 不修改数据，真实 GC 仅移除
过期 staging 和已提交 trash，保留未提交 trash。2026-07-30 后续回归新增真实
子进程在 active-version/project artifact rename 后 `SIGKILL`，同库重启保持
产物、active pointer 与历史不变；双启动 fail closed。后续 review 加固验证
同库/异存储、异库/同存储互斥、SIGKILL 自动释放、hard-link/存储重叠拒绝，
以及 v1/v2/v3/v4 与 symlink/身份/checksum 恢复分支。

下一阶段门槛：`releases`、`audit_events` 必须逐条通过语义验证；production schema
必须通过精确 round-trip 状态断言。enforced-offline 的单机协作选择已完成：backup
必须与 server、restore、GC 共享 ownership，要求 runtime 父目录和备份目标的最近
既有祖先均可信并排除未受管写入者；备份临时根会复核身份，但目标父目录尚无
`openat` 身份绑定。它不表示热备份、跨资源原子瞬间、分布式协调、断电持久性或无副作用。

- [x] 选择并实施 enforced-offline 备份契约：先停止写入者和服务，再进行 backup，
  成功后重启，随后可选只读 verify；`RUNTIME_OWNERSHIP_HELD` 无 force bypass。
- [ ] 逐条验证 `releases`、`audit_events`，并增加 production schema 精确
  round-trip 状态断言；当前 verifier 已覆盖 SQLite 完整性、外键、表级计数与
  部分 domain hydration，但未验证每一条历史发布和审计行。

### 阶段 4：可观测性、交付和静态服务

状态：已于 2026-07-30 完成。受保护指标、结构化请求日志、有界优雅停机、
回退安全的缓存语义，以及 dependency audit / secret scan / CodeQL 门禁均已
进入统一验证和 CI。

- 所有响应携带请求 ID；访问日志为结构化 JSON。
- 增加请求延迟、上传、发布、失败、磁盘和数据库指标。
- 服务支持 SIGTERM/SIGINT 优雅退出、SQLite checkpoint 与 runtime ownership
  release；只有 HTTP 和 worker cleanup 全部确认完成才显式释放，超时、
  drain/force-stop 失败或未完成会保留 ownership 到进程退出。
- 活跃别名使用 revalidate/ETag，显式版本 URL 才允许 immutable。
- CI 增加依赖漏洞、CodeQL、secret scan、恶意 ZIP 和崩溃恢复测试。

完成门槛：统一 `verify` 和 CI 成功；终止服务时不接受新写入且在超时内
完成在途操作。

验证证据：全仓 `bun run verify` 通过（server 245、client 40、desktop 23）；
高危/严重依赖审计为 0，secret scanner 通过；active URL 的 ETag 在手动回退后
变化，固定版本 URL 支持 immutable 与条件请求；关机单元测试覆盖正常 drain、
超时 force-close、失败退出和真实 SQLite checkpoint。

### 阶段 5：产物审计

状态：已于 2026-07-30 完成后端第二轮并通过本地与远端交付门禁。当前详细报告按版本持久化，
运行摘要进入长期历史；异步任务具备 SQLite 持久化、租约恢复、有限重试、
子进程隔离、轮询和取消。项目 owner 可在默认仅提示与显式阻断之间切换。
管理面板中的可视化报告入口留待下一轮前端迭代，不影响 API、发布门禁或恢复能力。

- 定义 `ArtifactInspector` 输入、输出、超时和资源预算。
- 首版生成文件清单、总大小、最大文件、扩展名分布和体积预算结果。
- SEO 首版检查 index.html 的 title、description、canonical、robots、
  viewport、Open Graph 和结构化数据基本格式。
- 审计结果按 version 持久化；策略可配置为仅提示或阻止发布。
- 新客户端通过 additive `audit-jobs` API 创建/复用、轮询和取消任务；旧同步
  端点保持兼容。
- 任务按 checksum、引擎和策略快照去重，领取使用有期限租约和心跳；执行器失败
  按指数退避重试，过期租约则立即重新进入领取资格，最大尝试次数受配置约束。
- 审计任务状态机由独立 SQLite 仓库按行更新；每次轮询同时恢复过期租约并至多
  领取一项，空队列不产生业务写入。全局/请求者/项目 admission limit 在同一
  `BEGIN IMMEDIATE` 中校验，集合 API 使用 HMAC-SHA256 认证、绑定 scope 与状态的
  稳定 keyset 游标。
- 终态任务传输记录按配置保留，并由
  `bun run ops -- audit-jobs-prune [--dry-run]` 分批清理；报告、历史和发布台账
  长期保留。
- 扫描运行在超时和输出受限的 Bun 子进程中；取消、租约丢失、策略变化或产物
  变化都会阻止迟到结果写入。
- Worker 停机与 HTTP drain 并行启动，二者结束后才 checkpoint SQLite。

完成门槛：审计器失败不会损坏上传；任务能跨重启恢复且并发 Worker 不能重复
完成；用户能看到可解释的检查结果；阻止发布必须由项目策略显式开启。

历史验证证据：全仓 `bun run verify` 通过（server 292、client 40、desktop 23，
secret scanner 2）；精确覆盖关系型 v3 -> v4 与文档 v7 -> v8 的迁移前备份。
生产双域真实进程完成“注册 → 上传/审计 v1 → blocking 发布 → 上传 v2 →
SIGTERM → 同库重启恢复任务 → 发布 v2 → 手动回退 v1”。该次验证最终 SQLite
schema v4；`integrity_check=ok`、外键违规 0、成功任务 2、报告 2、发布台账 3；管理源产物和
部署源 API 均返回 404，任务指标活动数归零且不包含任何项目/版本/任务 ID。

2026-07-31 生产不变量收口证据：关系型 schema 升至 v5；审计任务状态机改为
独立行级事务仓库，游标使用用途隔离的 HMAC-SHA256，completion 的
job/report/history 在最终 lease 更新失败时整体回滚，health 来自单 SQL 快照。
最终 `bun run verify` 通过（server 427 / 1730 assertions、client 40、
desktop 23、Biome 277 files、Vite 2252 modules），CI 等价的 high/critical
dependency audit 为 0。真实 production 双域进程完成 blocking 审计、三项任务、
两次发布、一次回退、三次优雅停机、签名游标跨重启与备份恢复；最终
`integrity_check=ok`、外键违规 0、成功任务 3、当前报告 2、发布台账严格为 3。
真实 SIGKILL 删除恢复、双 Bun 进程单一领取和活租约接管均有独立聚焦证据。

2026-08-01 真实 production process 回归进一步证明：worker disabled 时 advisory
只创建一个精确 job；仅切换 enforcement 到 blocking 不取消、不新增也不重扫，
worker-enabled 重启完成同一 engine-v2 job，第二次重启后 job/current report/
assessment 仍持久。current warning 可显式发布；missing、stale、failed 三类发布
拒绝都保持 active pointer、preview status、artifact bytes 与 job/report counts
不变。取消、assessment、扫描和策略更新均不发布或删除 preview；engine-v1 报告
仍可读取但以 `engine_changed` 判 stale。同步 failed report 表示扫描成功产生了
阻断发现，不等同于 job execution failure。

### 阶段 6：项目 API Token 与 CI 上传

状态：已于 2026-07-31 完成首版。项目 owner/全局 admin 可管理最小权限
Token，CI 可通过独立路由幂等上传 preview；浏览器/桌面 session、显式生产
发布、审计门禁和可恢复存储边界保持不变。

- 管理 API 支持创建、列出、轮换、撤销项目 Token 及查看安全事件。Token 只在
  创建或轮换时通过 `Cache-Control: no-store` 响应返回一次明文；SQLite 只保存
  带版本摘要、prefix、项目、scope、过期/撤销/轮换和使用元数据。
- 支持默认 90 天、最长 365 天有效期，轮换允许 0–86400 秒重叠；创建、轮换、
  撤销和限频的鉴权失败进入脱敏安全事件。泄漏响应是立即零重叠轮换或撤销、
  替换 CI secret 并检查日志/产物/仓库副本。
- 每个 Token 只绑定一个项目。v1 scope 只有 `preview:upload`；没有
  `staging:publish` 或 `production:publish`，也不会把项目成员角色隐式扩成
  自动化权限。
- `POST /api/ci/projects/:id/versions` 使用独立 API Token 中间件；browser Cookie
  和 browser/desktop session bearer 不能认证 CI，项目 Token 也不能进入普通
  管理路由，未注册的 `/api/ci/*` 在 session app 前终止为 404。
- CI 上传要求 1–128 个 `[A-Za-z0-9._~:-]` 幂等键。记录保留 24 小时；相同
  Token/project/key 与相同规范化描述、checksum/sourceType/size/fileCount 摘要
  返回原版本，不同摘要返回 `409 IDEMPOTENCY_CONFLICT`。
- SQLite 在同一 `BEGIN IMMEDIATE` 中重新校验 Token 状态、判定幂等结果，并
  提交 version/history/idempotency record。JSON adapter 仅供隔离测试及其
  fixtures，不具备生产所需的持久、跨进程原子保证；旧 `data.json` 由 SQLite
  初始化器负责导入，真实 runtime 强制使用 SQLite。
- CI 与交互上传共享 body、危险路径、ZIP 解压比、文件数、体积、存储 quota
  和全局/调用主体/项目 concurrency gate。结果始终为 preview，不改变
  `activeVersionId`。
- 当前没有 staging 环境或 Token 自动生产发布。生产仍由已登录用户在管理路由
  显式提交 `expectedActiveVersionId`，执行 release compare-and-set、完整性
  检查和 blocking audit gate。

完成门槛：生命周期、路由隔离、即时撤销/并发轮换、幂等重放/冲突/过期、
SQLite 原子提交和共享上传限制均有 API/服务测试；Biome、类型检查与聚焦测试
通过。

### 阶段 7：产物审计体验与规则深化

状态：下一阶段。阶段 5 已经交付可恢复的 SQLite artifact audit queue、租约、
重试、取消、静态扫描和发布门禁；后续 SEO/体积检测必须直接扩展这条队列与
报告契约，不再创建第二套任务系统，也不耦合 CI 上传和生产发布。

- 在管理面板展示现有 audit job 的排队/运行/终态、可解释检查项、策略快照、
  重试和取消入口。
- 在现有静态引擎上深化 SEO 规则与体积检测：engine v2 已检查根 HTML 中可静态
  判定的本地链接/图片目标，后续补充有界的嵌套页面爬取及图片内容解码、尺寸/
  格式验证。后端已有 total/single-file/file-count/JS/CSS/font 六项预算，
  下一步是管理 UI 配置与解释。继续禁止执行上传 JavaScript 或访问外网。
- 延续已交付的稳定 rule ID + `ruleVersion`、engine-v2 compatibility 和
  checksum/rule-config/context freshness 契约；管理 UI 需要解释 assessment，
  rendered-DOM/profile 审计仍独立延期。
- 保持 `advisory` 默认；只有 owner 显式启用 `blocking` 才阻止用户发布。检测
  失败不得删除 preview，也不得触发自动生产发布。

## 动态调整规则

- 每个阶段先建立失败测试，再做最小实现，再跑局部测试和全量 verify。
- 如果上一阶段暴露出数据模型或兼容性风险，先修正阶段边界，不把补丁
  堆到下一阶段。
- 每个阶段独立提交并推送 main；不把未通过验证的半成品跨阶段积累。
- 外部服务、云存储和队列只通过接口预留，不在没有明确容量证据时引入。
