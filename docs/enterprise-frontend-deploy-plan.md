# 企业级前端部署工具｜计划文档

## 1. 项目目标

本项目计划建设一个适合中小公司内部使用的前端部署工具，帮助团队统一管理前端项目、构建产物、部署版本、预览地址、正式发布、回滚记录和操作日志。

第一阶段不追求复杂自动化，而是先完成一个可靠的发布闭环：

```text
创建项目
↓
上传 dist.zip
↓
系统校验并生成版本
↓
生成预览地址
↓
确认发布正式版
↓
出现问题一键回滚
↓
记录操作日志
```

---

## 2. 总体实施路线

项目分为四个阶段推进：

| 阶段 | 名称 | 目标 |
|---|---|---|
| Phase 1 | 基础可用版 | 完成项目、版本、上传、预览、发布、回滚闭环 |
| Phase 2 | 团队协作版 | 增加成员、权限、备注、日志、环境管理 |
| Phase 3 | 自动化发布版 | 接入 API Token、CI 上传、CLI、Webhook |
| Phase 4 | 企业增强版 | 增加自定义域名、访问控制、通知、统计、清理策略 |

---

# Phase 1：基础可用版

## 1. 阶段目标

完成最小但专业的可用版本，用来替代人工上传服务器。

核心目标：

```text
可以创建项目
可以上传前端构建产物
可以生成预览版本
可以发布正式版本
可以一键回滚
可以查看部署记录
```

---

## 2. 功能范围

### 2.1 登录与用户

第一版可以先做简单登录。

功能：

- 用户登录
- 获取当前用户信息
- 简单用户角色
- 登录态保持

角色先简化为：

```text
admin
developer
viewer
```

---

### 2.2 项目管理

功能：

- 创建项目
- 查看项目列表
- 查看项目详情
- 修改项目名称
- 修改项目 Slug
- 删除项目或归档项目

项目字段建议：

```text
id
name
slug
description
type
routeMode
createdBy
createdAt
updatedAt
```

其中 `routeMode`：

```text
static
spa
```

---

### 2.3 版本管理

功能：

- 查看项目下的版本列表
- 查看某个版本详情
- 标记当前正式版本
- 区分 Preview 和 Production
- 删除无用版本

版本字段建议：

```text
id
projectId
versionCode
status
storagePath
entryFile
fileCount
totalSize
note
createdBy
createdAt
publishedBy
publishedAt
```

状态：

```text
preview
production
archived
deleted
failed
```

---

### 2.4 上传构建产物

第一版支持上传：

```text
dist.zip
```

上传流程：

```text
前端选择 zip
↓
后端接收文件
↓
保存到临时目录
↓
解压
↓
安全校验
↓
生成版本目录
↓
写入数据库
↓
返回预览地址
```

校验项：

- 必须存在 `index.html`
- 禁止 `.env`
- 禁止 `.git`
- 禁止 `node_modules`
- 禁止 `.pem` / `.key` / `id_rsa`
- 限制最大文件数量
- 限制最大体积
- 记录文件大小和文件数量

---

### 2.5 预览访问

每个上传版本都生成预览地址。

建议地址：

```text
/deploy/{projectSlug}/preview/{deploymentId}
```

示例：

```text
https://super.yxswy.com/deploy/tsing-tao/preview/6JOWs-g
```

预览版本不会影响正式环境。

---

### 2.6 正式发布

发布逻辑：

```text
选择 Preview 版本
↓
点击发布为正式版
↓
二次确认
↓
更新 production 环境指向
↓
原正式版保留为历史版本
↓
记录操作日志
```

正式访问地址：

```text
/deploy/{projectSlug}
```

示例：

```text
https://super.yxswy.com/deploy/tsing-tao
```

---

### 2.7 一键回滚

回滚逻辑：

```text
选择历史版本
↓
点击回滚到此版本
↓
二次确认
↓
production 指向该历史版本
↓
记录回滚日志
```

要求：

- 回滚不能重新上传文件。
- 回滚只是切换 Production 指针。
- 回滚前后的版本都要保留记录。

---

### 2.8 SPA 路由回退

项目创建或设置时选择：

```text
静态站点
单页应用 SPA
```

如果是 SPA，未命中路径回退到当前版本的 `index.html`。

这是 React / Vue / Vite 项目必须支持的功能。

---

### 2.9 操作日志

第一版必须记录：

- 创建项目
- 上传版本
- 发布正式版
- 回滚版本
- 删除版本
- 修改项目设置

日志字段建议：

```text
id
projectId
actorId
action
targetType
targetId
detail
createdAt
```

---

## 3. Phase 1 页面

### 3.1 项目列表页

内容：

```text
项目名称
Slug
当前正式版本
版本数量
最近发布时间
负责人
```

操作：

```text
新建项目
搜索项目
进入项目详情
```

---

### 3.2 项目详情页

顶部信息：

```text
项目名称
项目 Slug
项目描述
正式访问地址
当前正式版本
最近发布时间
```

操作：

```text
上传新版本
打开正式站点
复制链接
项目设置
```

Tab：

```text
部署记录
文件
日志
设置
```

---

### 3.3 上传新版本弹窗

内容：

```text
选择 dist.zip
部署备注
是否为 SPA 项目
上传进度
校验结果
生成预览链接
```

上传成功后显示：

```text
版本 ID
文件数量
总大小
预览地址
是否立即打开预览
```

---

### 3.4 部署记录列表

每条部署记录显示：

```text
版本 ID
状态
上传时间
上传人
发布时间
发布人
文件数量
文件大小
部署备注
```

操作：

```text
预览
发布为正式版
回滚到此版本
复制链接
删除
```

---

## 4. Phase 1 技术任务

### 4.1 前端任务

技术栈：

```text
React
Vite
TailwindCSS
```

页面：

- 登录页
- 项目列表页
- 项目详情页
- 上传版本弹窗
- 部署记录列表
- 项目设置页
- 操作日志页

组件：

- ProjectList
- ProjectHeader
- DeploymentList
- DeploymentItem
- UploadDialog
- ConfirmPublishDialog
- ConfirmRollbackDialog
- AuditLogList
- EmptyState
- Toast
- ProgressBar

---

### 4.2 后端任务

技术栈：

```text
Bun
Elysia
PostgreSQL
```

核心 API：

```text
POST   /api/auth/login
GET    /api/me

GET    /api/projects
POST   /api/projects
GET    /api/projects/:id
PATCH  /api/projects/:id
DELETE /api/projects/:id

GET    /api/projects/:id/deployments
POST   /api/projects/:id/deployments/upload
GET    /api/deployments/:id
POST   /api/deployments/:id/publish
POST   /api/deployments/:id/rollback
DELETE /api/deployments/:id

GET    /api/projects/:id/audit-logs
```

---

### 4.3 数据库表

建议第一版表结构：

```text
users
projects
project_members
deployments
environments
audit_logs
```

#### users

```text
id
name
email
password_hash
role
created_at
updated_at
```

#### projects

```text
id
name
slug
description
type
route_mode
created_by
created_at
updated_at
deleted_at
```

#### project_members

```text
id
project_id
user_id
role
created_at
```

#### deployments

```text
id
project_id
version_code
status
storage_path
file_count
total_size
note
created_by
created_at
published_by
published_at
deleted_at
```

#### environments

```text
id
project_id
name
current_deployment_id
created_at
updated_at
```

其中第一版至少有：

```text
production
```

#### audit_logs

```text
id
project_id
actor_id
action
target_type
target_id
detail_json
created_at
```

---

### 4.4 文件存储结构

第一版可使用本地磁盘。

建议结构：

```text
/storage
  /projects
    /{projectSlug}
      /versions
        /{deploymentId}
          index.html
          assets/
      /meta
```

不要覆盖旧版本。

每次上传生成独立目录：

```text
/storage/projects/tsing-tao/versions/6JOWs-g
/storage/projects/tsing-tao/versions/8F2ks-x
```

---

### 4.5 Nginx / 静态访问策略

正式访问：

```text
/deploy/{projectSlug}
```

预览访问：

```text
/deploy/{projectSlug}/preview/{deploymentId}
```

需要支持：

- 静态资源访问
- `index.html` 不强缓存
- assets 强缓存
- SPA fallback

缓存策略：

```text
index.html:
Cache-Control: no-cache

assets:
Cache-Control: public, max-age=31536000, immutable
```

---

## 5. Phase 1 验收标准

Phase 1 完成后，应该可以验证：

| 验收项 | 通过标准 |
|---|---|
| 创建项目 | 可以创建并在列表中看到 |
| 上传版本 | 上传 zip 后生成版本记录 |
| 产物校验 | 没有 index.html 时上传失败 |
| 危险文件拦截 | `.env`、`.git`、私钥文件被拒绝 |
| 预览访问 | 可以打开指定版本预览地址 |
| 正式发布 | 可以将 Preview 版本设为 Production |
| 回滚 | 可以将正式版本切回历史版本 |
| SPA 路由 | 深层路由刷新不 404 |
| 日志 | 关键操作都有审计记录 |
| 权限 | 非授权用户不能发布正式环境 |

---

# Phase 2：团队协作版

## 1. 阶段目标

让工具更适合多人团队使用。

新增能力：

- 成员管理
- 角色权限
- 发布备注
- 环境管理
- 部署日志详情
- 项目负责人
- 测试状态

---

## 2. 主要功能

### 2.1 成员管理

项目成员角色：

```text
owner
admin
developer
tester
viewer
```

操作：

- 邀请成员
- 修改成员角色
- 移除成员
- 查看项目成员

---

### 2.2 环境管理

从第一版的 Production 扩展为：

```text
Preview
Staging
Production
```

每个环境可指向不同版本。

---

### 2.3 发布状态

新增状态：

```text
待测试
测试通过
待发布
已发布
已回滚
```

让测试和负责人可以协同确认。

---

### 2.4 部署备注和变更说明

每次上传必须支持备注：

```text
修复首页按钮错位
上线春节活动页
更新登录页面
紧急回滚
```

---

### 2.5 部署日志详情

查看某次部署的详细流程：

```text
接收上传文件
解压完成
安全校验通过
文件数量统计完成
版本生成完成
预览地址生成完成
```

失败时显示具体原因。

---

## 3. Phase 2 验收标准

| 验收项 | 通过标准 |
|---|---|
| 成员管理 | 可以添加、移除、修改成员角色 |
| 权限细化 | 不同角色权限不同 |
| 环境管理 | Staging 和 Production 可独立指向版本 |
| 发布备注 | 部署记录可以看到备注 |
| 测试状态 | 版本可以标记测试状态 |
| 部署日志 | 失败时能看到具体原因 |

---

# Phase 3：自动化发布版

## 1. 阶段目标

从手动上传升级到自动化发布。

主要支持：

- API Token
- CI 上传
- Webhook
- CLI 工具
- Git 信息展示

---

## 2. 主要功能

### 2.1 API Token

为每个项目生成部署 Token。

用途：

```text
CI/CD 上传构建产物
命令行发布
自动化脚本调用
```

Token 权限：

```text
只允许上传 Preview
允许发布 Staging
允许发布 Production
```

---

### 2.2 CI 上传

支持 GitHub Actions / GitLab CI 上传。

示例流程：

```text
代码 push
↓
CI 执行 pnpm build
↓
压缩 dist
↓
调用部署平台 API
↓
生成预览地址
```

---

### 2.3 CLI 工具

提供内部 CLI：

```bash
deploy upload ./dist --project tsing-tao --env preview
deploy publish --project tsing-tao --version 6JOWs-g
deploy rollback --project tsing-tao --version 5Kp9a-x
```

---

### 2.4 Git 信息

部署记录展示：

```text
commit hash
commit message
branch
author
repository
CI run id
```

---

## 3. Phase 3 验收标准

| 验收项 | 通过标准 |
|---|---|
| API Token | 可以为项目生成和禁用 Token |
| CI 上传 | CI 可以上传 dist.zip 并生成预览 |
| CLI 上传 | 命令行可以上传版本 |
| Git 信息 | 部署记录显示 commit 和 branch |
| Token 权限 | Token 不能越权发布 Production |

---

# Phase 4：企业增强版

## 1. 阶段目标

补齐企业生产环境常用能力。

新增：

- 自定义域名
- HTTPS 证书
- 访问密码
- IP 白名单
- 发布通知
- Webhook
- 版本保留策略
- 访问统计
- 错误监控接入

---

## 2. 主要功能

### 2.1 自定义域名

支持项目绑定：

```text
admin.company.com
activity.company.com
www.company.com
```

需要提供：

- DNS 配置说明
- 绑定校验
- HTTPS 证书状态
- 域名启用 / 停用

---

### 2.2 访问控制

访问方式：

```text
公开访问
密码访问
登录后访问
IP 白名单
```

第一步建议先做：

```text
公开访问
密码访问
```

---

### 2.3 通知能力

发布成功、失败、回滚后通知：

```text
企业微信
飞书
钉钉
邮件
Webhook
```

通知内容：

```text
项目
环境
版本
操作人
状态
访问地址
部署备注
```

---

### 2.4 版本保留策略

自动清理旧版本。

策略：

```text
每个项目最多保留 N 个版本
保留最近 30 天版本
Production 历史版本永不自动删除
手动锁定版本不删除
```

---

### 2.5 访问统计

基础统计：

```text
访问量
独立访客
访问路径
状态码
资源请求量
```

---

## 3. Phase 4 验收标准

| 验收项 | 通过标准 |
|---|---|
| 自定义域名 | 可以绑定并访问 |
| HTTPS | 域名有可用证书 |
| 访问密码 | 未输入密码不能访问 |
| IP 白名单 | 非白名单 IP 被拒绝 |
| 通知 | 发布成功和失败能通知团队 |
| 清理策略 | 旧版本可自动清理 |
| 统计 | 可以查看基础访问数据 |

---

# 6. 建议开发顺序

建议实际开发顺序如下：

```text
1. 数据库表设计
2. 用户登录
3. 项目 CRUD
4. 项目列表和详情页
5. 上传 zip 接口
6. 解压和安全校验
7. 生成 Deployment 记录
8. 预览访问服务
9. 发布 Production
10. 回滚 Production
11. 操作日志
12. SPA fallback
13. 前端交互优化
14. 权限收口
15. Docker 部署
```

---

# 7. 第一版里程碑

## Milestone 1：基础框架

目标：

- 前后端项目初始化
- 数据库连接完成
- 登录流程可用
- 基础布局完成

交付物：

```text
React 控制台页面
Bun + Elysia API 服务
PostgreSQL 基础表
登录接口
```

---

## Milestone 2：项目管理

目标：

- 创建项目
- 查看项目列表
- 进入项目详情
- 修改项目信息

交付物：

```text
项目列表页
项目详情页
项目 CRUD API
```

---

## Milestone 3：上传和版本

目标：

- 上传 dist.zip
- 后端解压
- 校验 index.html
- 生成版本目录
- 生成版本记录

交付物：

```text
上传弹窗
上传 API
版本列表
版本详情
```

---

## Milestone 4：预览和发布

目标：

- 版本可以预览
- 版本可以发布为正式版
- 正式地址可以访问

交付物：

```text
预览 URL
Production URL
发布接口
部署记录状态变化
```

---

## Milestone 5：回滚和日志

目标：

- 可以回滚历史版本
- 操作日志完整记录
- 删除版本时保留审计

交付物：

```text
回滚接口
审计日志页面
版本删除逻辑
```

---

## Milestone 6：上线准备

目标：

- 权限校验
- 文件安全校验
- SPA fallback
- Nginx 配置
- Docker 部署

交付物：

```text
可部署的第一版系统
基础运维文档
验收测试清单
```

---

# 8. 第一版任务清单

## 前端

```text
[ ] 登录页
[ ] 主布局
[ ] 项目列表
[ ] 新建项目弹窗
[ ] 项目详情头部
[ ] 部署记录列表
[ ] 上传版本弹窗
[ ] 上传进度展示
[ ] 发布确认弹窗
[ ] 回滚确认弹窗
[ ] 删除确认弹窗
[ ] 操作日志列表
[ ] 项目设置页
[ ] Toast / Message 反馈
[ ] Loading / Empty 状态
```

## 后端

```text
[ ] 用户登录接口
[ ] 权限中间件
[ ] 项目 CRUD
[ ] 版本列表接口
[ ] 上传 zip 接口
[ ] 解压逻辑
[ ] 文件安全校验
[ ] 版本目录生成
[ ] 预览访问映射
[ ] 发布正式版接口
[ ] 回滚接口
[ ] 删除版本接口
[ ] 操作日志写入
[ ] SPA fallback 处理
```

## 数据库

```text
[ ] users
[ ] projects
[ ] project_members
[ ] deployments
[ ] environments
[ ] audit_logs
[ ] 初始化管理员账号
[ ] 基础索引
```

## 运维

```text
[ ] Dockerfile
[ ] docker-compose.yml
[ ] Nginx 访问配置
[ ] 上传大小限制
[ ] 静态资源缓存配置
[ ] 日志目录
[ ] 存储目录挂载
[ ] 数据库备份方案
```

---

# 9. 风险点

## 9.1 上传安全风险

风险：

- 用户上传 `.env`
- 用户上传私钥
- 用户上传 `.git`
- 用户上传超大文件

处理：

- 文件黑名单
- 文件大小限制
- 解压路径防穿越
- 上传后校验
- 失败立即删除临时文件

---

## 9.2 路由访问风险

风险：

React / Vue 深层路由刷新 404。

处理：

- 项目支持 SPA 模式
- 未命中路径回退到 `index.html`

---

## 9.3 缓存风险

风险：

用户发布新版本后仍看到旧页面。

处理：

- `index.html` 不强缓存
- assets 使用 hash 强缓存
- 发布后刷新入口文件

---

## 9.4 发布覆盖风险

风险：

新版本直接覆盖旧版本，导致无法回滚。

处理：

- 每个版本独立目录
- Production 只保存当前版本指针
- 回滚只切换指针

---

## 9.5 权限风险

风险：

非负责人误发正式环境或删除版本。

处理：

- 发布、回滚、删除需要权限
- 高危操作二次确认
- 所有操作写入审计日志

---

# 10. 推荐第一版交付标准

第一版完成后，需要达到：

```text
一个中小团队可以真正拿它部署前端项目
上传不会直接影响正式环境
正式发布前可以预览
出了问题可以回滚
每次操作可以追踪到人
React / Vue 项目可以正常刷新路由
危险文件不会被部署出去
```

---

# 11. 一句话计划

先做一个可靠的内部前端部署闭环：

> 项目管理 + 版本上传 + 预览 + 发布 + 回滚 + 日志 + 权限。

等这个闭环稳定后，再逐步增加：

> 团队协作、CI 自动化、自定义域名、访问控制和通知能力。
