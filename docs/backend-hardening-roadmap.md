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

状态：已于 2026-07-30 完成。两阶段删除、事务容量、保守 GC、持久化完整性
状态和备份/验证/恢复命令均已通过全仓验证与真实命令行恢复演练。

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
- 增加全局、用户、项目容量配额及并发上传配额。
- 为 staging、recovery、孤儿目录增加带保留期的垃圾回收。
- 增加校验和巡检和明确的损坏状态。
- 提供一致性备份、恢复、校验命令和恢复演练文档。

完成门槛：在注入文件操作失败时无静默数据丢失；备份恢复后项目、版本、
当前发布和审计事件一致。

验证证据：`bun run verify` 通过（server 232、client 40、desktop 23）；
隔离 SQLite/WAL 演练恢复后项目、版本、线上指针、审计和 session 均一致，
`integrity_check=ok`、外键违规为 0；GC dry-run 不修改数据，真实 GC 仅移除
过期 staging 和已提交 trash，保留未提交 trash。2026-07-30 后续回归新增真实
子进程在 active-version/project artifact rename 后 `SIGKILL`，同库重启保持
产物、active pointer 与历史不变；双启动 fail closed。后续 review 加固验证
同库/异存储、异库/同存储互斥、SIGKILL 自动释放、hard-link/存储重叠拒绝，
以及 v1/v2/v3/v4 与 symlink/身份/checksum 恢复分支。

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
- 任务按 checksum、引擎和策略快照去重，领取使用有期限租约和心跳；崩溃或
  过期后指数退避重试，最大尝试次数受配置约束。
- 扫描运行在超时和输出受限的 Bun 子进程中；取消、租约丢失、策略变化或产物
  变化都会阻止迟到结果写入。
- Worker 停机与 HTTP drain 并行启动，二者结束后才 checkpoint SQLite。

完成门槛：审计器失败不会损坏上传；任务能跨重启恢复且并发 Worker 不能重复
完成；用户能看到可解释的检查结果；阻止发布必须由项目策略显式开启。

验证证据：全仓 `bun run verify` 通过（server 292、client 40、desktop 23，
secret scanner 2）；精确覆盖关系型 v3 -> v4 与文档 v7 -> v8 的迁移前备份。
生产双域真实进程完成“注册 → 上传/审计 v1 → blocking 发布 → 上传 v2 →
SIGTERM → 同库重启恢复任务 → 发布 v2 → 手动回退 v1”。最终 SQLite schema v4、
`integrity_check=ok`、外键违规 0、成功任务 2、报告 2、发布台账 3；管理源产物和
部署源 API 均返回 404，任务指标活动数归零且不包含任何项目/版本/任务 ID。

## 动态调整规则

- 每个阶段先建立失败测试，再做最小实现，再跑局部测试和全量 verify。
- 如果上一阶段暴露出数据模型或兼容性风险，先修正阶段边界，不把补丁
  堆到下一阶段。
- 每个阶段独立提交并推送 main；不把未通过验证的半成品跨阶段积累。
- 外部服务、云存储和队列只通过接口预留，不在没有明确容量证据时引入。
