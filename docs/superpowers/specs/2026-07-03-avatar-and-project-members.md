# Avatar System & Project Members

- 日期: 2026-07-03
- 状态: 设计确认,待实现
- 范围: `packages/shared` `packages/client` `apps/server`

## 1. 背景与目标

DeployKit 已有用户系统（注册/登录、角色 admin/developer/viewer），但:

- 用户没有头像,界面缺乏人性化
- 项目没有成员概念,多人协作只能依靠全局角色
- 创建项目权限仅限 admin,限制使用场景

本设计引入**确定性 identicon 头像系统**和**项目级成员模型**,让多个用户可以协作管理一个项目,并在 UI 各处展示用户头像。

## 2. 头像系统

### 2.1 技术选型

`@dicebear/core` + `@dicebear/collection` (`identicon` 风格),浏览器端 SVG 渲染。

- `identicon` 风格最接近 GitHub 的几何头像效果
- 以用户 `id` 为 seed,确定性:同一用户始终同一头像
- 生成 `data:image/svg+xml` URL,无需服务端存储
- 约 8KB gzip 额外体积

### 2.2 头像工具函数

```ts
// packages/client/src/shared/avatar.ts
import { createAvatar } from '@dicebear/core';
import { identicon } from '@dicebear/collection';

export function getUserAvatarUrl(userId: string): string {
  const avatar = createAvatar(identicon, { seed: userId });
  return avatar.toDataUri(); // data:image/svg+xml;base64,...
}

export function getUserInitials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}
```

放在 `@deploykit/client` 的 `src/shared/` 中,web 和 desktop 共享。

### 2.3 UI 组件

> `packages/client/src/shared/ui/`

均遵照现有 shadcn 组件风格（`cn()` 工具函数、Tailwind theme tokens）。

**`avatar.tsx`** — 标准 shadcn Avatar:
```tsx
// Avatar, AvatarImage, AvatarFallback 三个子组件
// 复用现有 `@/shared/ui` 目录下的命名模式
```

**`avatar-group.tsx`** — 叠放头像组:
```tsx
<AvatarGroup users={users} max={5} />
// 前4个头像叠放,第5个位置显示 "+N"
// 将鼠标悬停在叠放时显示用户列表 tooltip
```

**`user-display.tsx`** — 头像 + 名称并排:
```tsx
<UserDisplay user={user} showEmail={false} avatarSize="sm" />
// 用于顶栏、项目列表、历史记录等处
```

### 2.4 展示位置

| 位置 | 组件 | 数据来源 |
|---|---|---|
| 顶栏右侧 | `<UserDisplay user={currentUser} />` | `useAuth()` |
| 项目详情头部 | `<AvatarGroup users={project.members} />` | `project.members` |
| 项目列表每行 | `<UserDisplay user={operator} />` | `versions[0]?.actorId` → 查用户 |
| 审计日志每行 | `<UserDisplay user={actor} />` | `event.actorId` → 查用户 |

## 3. 数据模型

### 3.1 共享 (`packages/shared/src/domain.ts`)

新增 `projectMemberSchema`:
```ts
export const projectMemberSchema = z.object({
  userId: z.string(),
  role: z.enum(['owner', 'member']),
  invitedAt: z.string(),
});
```

`projectSchema` 新增字段:
```ts
  createdBy: z.string(),           // 创建者 userId
  members: z.array(projectMemberSchema).default([]),
```

### 3.2 约束

- **创建项目时**:自动将创建者设为 `{ userId, role: "owner", invitedAt: now }`
- **最低 Owner 数**:项目必须至少有 1 个 owner。删除最后 owner 拒绝、转让前确保 target 已是 member
- **移除成员**:只能由 owner 移除 member;owner 不能移除最后一个 owner
- 全局 admin 绕过所有项目级权限检查

### 3.3 数据迁移 (`apps/server/src/domain/schema.ts`)

已有项目（`data.json`）无 `members` 和 `createdBy`。迁移步骤:

- 查找第一个 admin 用户,若无则创建 `system` 占位
- 将 admin 设为 owner,写入 `members: [{ userId: adminId, role: "owner", invitedAt: project.createdAt }]`
- `createdBy` 设为 adminId

## 4. API 变更

### 4.1 新增端点

| 方法 | 路径 | 请求/参数 | 响应 | 权限 |
|---|---|---|---|---|
| `GET` | `/api/users/search?q=` | `q`: 邮箱前缀(最少2字符) | `SafeUser[]` (最多10条) | 已登录 |
| `POST` | `/api/projects/:id/members` | `{ email, role }` | `{ member }` | Owner |
| `DELETE` | `/api/projects/:id/members/:userId` | – | `{ ok: true }` | Owner |
| `POST` | `/api/projects/:id/transfer` | `{ targetUserId }` | `{ project }` | Owner |

### 4.2 变更现有端点

| 端點 | 变更 |
|---|---|
| `POST /api/projects` | 移除 `assertRole(c, 'admin')`,仅保留 `requireAuth` |
| `PATCH /api/projects/:id` | 改为 Owner-only |
| `DELETE /api/projects/:id` | 改为 Owner-only |
| `PATCH /api/projects/:id/settings` | 改为 Owner-only |
| `POST .../versions` | 放開给该项目 Owner 和 Member |
| `POST .../publish` | 同上 |
| `POST .../rollback` | 同上 |
| `DELETE .../versions/:vid` | 同上 |

### 4.3 权限中间件

新增 `requireProjectRole(minRole)` 中间件(`apps/server/src/middleware/auth.ts`):

```ts
export function requireProjectRole(minRole: 'member' | 'owner') {
  return async (c: Context<AppEnv>, next) => {
    const user = c.get('user');
    if (!user) throw new ApiError(ErrorCode.UNAUTHORIZED, '...', 401);
    const projectId = c.req.param('id');
    const project = projectService.getProject(projectId);
    const member = project.members.find(m => m.userId === user.id);
    if (!member) throw new ApiError(ErrorCode.FORBIDDEN, 'Not a member', 403);
    if (minRole === 'owner' && member.role !== 'owner')
      throw new ApiError(ErrorCode.FORBIDDEN, 'Owner required', 403);
    await next();
  };
}
```

## 5. 前端变更

### 5.1 新增/修改组件

```
packages/client/src/
├── features/
│   ├── members/
│   │   ├── MemberList.tsx
│   │   ├── AddMemberDialog.tsx
│   │   └── TransferOwnershipDialog.tsx
│   ├── projects/
│   │   ├── useProjects.ts        ← members 字段,创建权限
│   │   └── ProjectList.tsx       ← 操作者头像
│   └── ...
├── shared/
│   └── ui/
│       ├── avatar.tsx            ← NEW
│       ├── avatar-group.tsx      ← NEW
│       └── user-display.tsx      ← NEW
└── pages/
    └── DeployPage.tsx            ← 顶栏头像,成员区
```

### 5.2 交互流程

**添加成员**:Owner 打开项目 → AddMemberDialog → 输入邮箱搜索 → 选择已注册用户 → POST → 刷新成员列表 → 新成员获得版本操作权限。

**转让所有权**:Owner → 项目设置 → TransferOwnershipDialog → 选择目标 member → 确认弹窗 → POST → 页面刷新反映新 role。

**移除成员**:MemberList 每行末尾"移除"按钮(仅 Owner 可见)→ 确认 → DELETE → 刷新。

**创建项目**:放开后顶端"新建项目"按钮对所有登录用户可见 → 填写表单 → POST → 创建者自动成为 owner → 进入项目。

### 5.3 头像 AvatarGroup 展示

项目详情头部显示 `<AvatarGroup>`:

```
┌─ ProjectDetails ─────────────────────────────┐
│  project-name          [A][B] [+3]           │
│  slug: my-project                             │
└───────────────────────────────────────────────┘
```

用户悬停 AvatarGroup 时显示 tooltip 用户列表。

### 5.4 头像 UserDisplay 展示

审计日志、版本列表等位置:

```
张三   2026-07-03 14:30   发布了 v3
```

前面的头像 + 名称通过 `<UserDisplay user={user} />` 渲染。

## 6. 服务端用户搜索

`GET /api/users/search?q=`:

```ts
// userService.searchByEmail(query: string): SafeUser[]
// 大小写不敏感前缀匹配,最多 10 条
// 不暴露 passwordHash
// 为空或 query 长度 < 2 时返回空数组
```

前端在 AddMemberDialog 中 debounce 输入,发送搜索请求,展示匹配结果。

## 7. 测试策略

### 服务端

- `tests/api/permissions.test.ts` — 新增测试用例: member 可上传/发布/回滚但不可删除项目、不可修改设置、不可移除成员;owner 有全部权限;非 member 收到 403
- `tests/services/projectDomain.test.ts` — members 约束: 创建时自动设 owner、转让逻辑、移除最后 owner 拒绝
- `tests/services/userService.test.ts` — searchByEmail

### 客户端

- `tests/unit/Avatar.test.tsx` — Avatar 组件渲染 identicon + fallback
- `tests/unit/AvatarGroup.test.tsx` — 叠放 + N
- `tests/unit/AddMemberDialog.test.tsx` — 搜索交互
- `tests/unit/TransferOwnershipDialog.test.tsx` — 确认弹窗
- 已有 `useProjects.test.ts` 补充 members 相关用例

## 8. 分期交付

| 阶段 | 内容 | 依赖 |
|---|---|---|
| **Phase 1** | 头像系统: dicebear + Avatar/AvatarGroup/UserDisplay 组件;顶栏、项目列表、历史记录展示头像 | 无 |
| **Phase 2** | 数据模型: members 字段、schema migration、项目级权限检查 | Phase 1 (UI 复用) |
| **Phase 3** | API: 成员管理端点、用户搜索、权限中间件 | Phase 2 |
| **Phase 4** | 前端: AddMemberDialog、MemberList、TransferOwnershipDialog、创建项目放开 | Phase 3 |

Phase 1 是纯前端新增,不依赖服务端变更;Phase 2-4 是服务端+前端的后端功能,彼此紧密关联可合并实现。

## 9. 风险与缓解

- **`@dicebear/core` 包体积**:约 8KB gzip,控制在可接受范围。若对 bundle 敏感可改用 `@dicebear/core` 的 tree-shaking
- **`/api/users/search` 安全问题**:仅返回 `SafeUser`(无 passwordHash),且需要登录,无敏感信息泄露
- **已有项目迁移**:新字段有默认值(members 空数组),迁移不是强制的,但建议一次性迁移

## 10. 后续

- **邀请链接受 token 管理**:本期不做(YAGNI),仅支持已注册用户的邮箱搜索添加。未来可扩展 `/api/invites` token 系统
- **多人实时协作提示**:非本期目标
- **自定义上传头像**:非本期目标,YAGNI。identicon 确定性方案满足当前需求
