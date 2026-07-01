---
name: DeployKit
description: 前端产物部署管理系统 — 企业团队版本管理工具
colors:
  primary: "oklch(0.42 0.15 260)"
  primary-hover: "oklch(0.42 0.15 260 / 0.8)"
  background: "oklch(0.985 0.002 247)"
  foreground: "oklch(0.145 0.02 260)"
  card: "oklch(1 0 0)"
  card-foreground: "oklch(0.145 0.02 260)"
  secondary: "oklch(0.96 0.01 260)"
  secondary-foreground: "oklch(0.25 0.02 260)"
  muted: "oklch(0.96 0.01 260)"
  muted-foreground: "oklch(0.55 0.02 260)"
  destructive: "oklch(0.577 0.245 27.325)"
  border: "oklch(0.92 0.005 260)"
  input: "oklch(0.92 0.005 260)"
  ring: "oklch(0.42 0.15 260)"
  # Dark mode
  dark-background: "oklch(0.13 0.005 260)"
  dark-foreground: "oklch(0.93 0.005 260)"
  dark-card: "oklch(0.17 0.005 260)"
  dark-card-foreground: "oklch(0.93 0.005 260)"
  dark-primary: "oklch(0.65 0.18 260)"
  dark-primary-foreground: "oklch(0.13 0.005 260)"
  dark-secondary: "oklch(0.22 0.01 260)"
  dark-secondary-foreground: "oklch(0.9 0.005 260)"
  dark-muted: "oklch(0.22 0.01 260)"
  dark-muted-foreground: "oklch(0.6 0.01 260)"
  dark-border: "oklch(0.28 0.01 260)"
  dark-input: "oklch(0.28 0.01 260)"
  dark-ring: "oklch(0.65 0.18 260)"
typography:
  display:
    fontFamily: "JetBrainsMapleMono, system-ui, sans-serif"
    fontSize: "clamp(1.5rem, 4vw, 2.25rem)"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "normal"
  heading:
    fontFamily: "JetBrainsMapleMono, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "normal"
  body:
    fontFamily: "JetBrainsMapleMono, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  small:
    fontFamily: "JetBrainsMapleMono, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  mono:
    fontFamily: "JetBrainsMapleMono, ui-monospace, SFMono-Regular, 'SF Mono', monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
rounded:
  sm: "3px"
  md: "5px"
  lg: "6px"
  xl: "8px"
  2xl: "11px"
  3xl: "13px"
  4xl: "16px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.lg}"
    padding: "8px 10px"
    typography: "{typography.body}"
    fontWeight: 500
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "8px 10px"
    border: "1px solid {colors.border}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "8px 10px"
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.destructive}"
    rounded: "{rounded.lg}"
    padding: "8px 10px"
    opacity: 0.1
  input-field:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
    border: "1px solid {colors.input}"
  card-surface:
    backgroundColor: "{colors.card}"
    textColor: "{colors.card-foreground}"
    rounded: "{rounded.xl}"
    padding: "16px"
    border: "1px solid {colors.border}"
---

## Overview

DeployKit 的设计语言是**精工匠心**的企业工具美学。视觉系统建立在 OKLCH 颜色空间之上，使用紫色主轴（hue 260）传递专业可靠感，同时通过克制的信息密度和清晰的状态反馈保持现代高效。深色/浅色主题对称设计，圆角和间距保持一致的 4px 基准网格。界面无装饰性元素，所有视觉决策服务于功能清晰度和操作即时性。

## Colors

**主色调：紫色轴（hue 260）**

- **Primary** (`oklch(0.42 0.15 260)`)：品牌色，用于主要操作按钮、激活状态、图标强调。深色模式下提升到 `oklch(0.65 0.18 260)` 以保持对比度。
- **Destructive** (`oklch(0.577 0.245 27.325)`)：暖红 orange-red 色相，用于删除操作、错误状态。注意不是纯红色，避免视觉过于刺眼。

**中性色：极低 chroma 的灰色轴**

- **Background/Clear** (`oklch(0.985 0.002 247)` / `oklch(0.13 0.005 260)`)：接近纯白的浅色背景和深灰色的深色背景，chroma < 0.01 保持中性。
- **Foreground/Ink** (`oklch(0.145 0.02 260)` / `oklch(0.93 0.005 260)`)：正文文字颜色，保证与背景的对比度 ≥ 4.5:1。
- **Muted** (`oklch(0.96 0.01 260)` / `oklch(0.22 0.01 260)`)：次要背景色（hover 状态、禁用区域、分隔区域）。
- **Muted-Foreground** (`oklch(0.55 0.02 260)` / `oklch(0.6 0.01 260)`)：次要文字（描述文本、标签、元信息）。

**边框与输入**

- **Border/Input** (`oklch(0.92 0.005 260)` / `oklch(0.28 0.01 260)`)：分隔线、输入框边框、卡片轮廓。浅色模式下较浅以避免视觉重量过重。
- **Ring** (`oklch(0.42 0.15 260)` / `oklch(0.65 0.18 260)`)：焦点环颜色，与 primary 同色系，确保焦点状态清晰可见。

**颜色使用规则**

- 主操作按钮、链接、激活状态使用 primary
- 删除、取消、错误提示使用 destructive
- hover 状态使用 muted 色系
- 禁用状态使用 opacity 0.5（不变更颜色）
- 新增/成功状态暂无专门绿色，复用 primary 或深色模式的 text-green-500（待扩展）

## Typography

**字体栈：JetBrainsMapleMono（主） + system-ui（回退）**

项目使用自定义等宽字体 JetBrainsMapleMono 作为主要字体，传达工具属性和工程精度。system-ui 作为回退确保跨平台可读性。代码片段、slug、版本号使用 JetBrainsMapleMono 的 mono 变体或系统等宽字体。

**字号层级**

- **Display**（未使用）：如需英雄标题，使用 `clamp(1.5rem, 4vw, 2.25rem)`，font-weight 600
- **Heading** (`1.125rem / 18px`)：区域标题（如项目名、版本列表标题），font-weight 600
- **Body** (`0.875rem / 14px`)：默认正文，表单标签、列表项、按钮文本，font-weight 400
- **Small** (`0.75rem / 12px`)：元信息（时间戳、文件大小、slug），辅助说明
- **Mono** (`0.75rem / 12px`)：等宽字体场景，代码片段、技术标识符

**行高与字间距**

- 标题行高 1.3-1.4，保持紧凑但不拥挤
- 正文行高 1.5，确保可读性
- 所有字号 letter-spacing: normal，避免人为调整导致可读性下降

**排版规则**

- 按钮文本使用 font-medium (500)，body 默认 400
- 列表项 truncate 超长文本，确保界面紧凑
- 元信息（时间、大小）使用 small + muted-foreground 组合

## Elevation

**圆角：基于 6px 的倍数系统**

- 基准 `--radius: 0.375rem` (6px)
- 小元素（按钮、输入框）：`{rounded.md}` 5px / `{rounded.lg}` 6px
- 卡片、容器：`{rounded.xl}` 8px / `{rounded.2xl}` 11px
- 对话框、弹窗：`{rounded.3xl}` 13px
- 按钮组内的按钮：`rounded-[min(var(--radius-md),10px)]` 确保小屏幕不过圆

**阴影：极简或无**

当前设计不使用 box-shadow。层次通过：
- 边框 (`border-border`)
- 背景色差异 (`bg-card` vs `bg-background`)
- 间距和留白

如果需要 elevation（如下拉菜单、tooltip），使用：
- 一层 elevation：`shadow-sm` (subtle)
- 两层 elevation（对话框、toast）：`shadow-md`
- 不使用 `shadow-lg` 或更大的扩散阴影

**间距：4px 基准网格**

- `xs: 4px` — 紧凑间距（图标与文本、标签与输入框）
- `sm: 8px` — 小间距（列表项内边距、卡片内部元素）
- `md: 12px` — 中等间距（表单字段之间）
- `lg: 16px` — 标准间距（卡片内边距、区域分隔）
- `xl: 20px` — 大间距（区域组之间）
- `2xl: 24px` — 超大间距（主容器与边缘）

## Components

**Button**

- **Primary**：品牌色背景，用于主要操作（上传、激活、创建）
- **Outline**：带边框透明背景，用于次要操作（取消、关闭）
- **Ghost**：无边框透明背景，用于工具栏按钮（设置、删除图标按钮）
- **Destructive**：红色半透明背景，用于危险操作（删除项目、删除版本）
- **Size**：default (h-8)、sm (h-7)、xs (h-6)、icon-only variants
- **Hover**：primary 变为 80% opacity，其他变体填充 muted 背景色
- **Focus**：3px ring (ring/50)，确保键盘导航可见

**Input / Select / Textarea**

- 背景 `bg-background`，边框 `border-input`
- focus 时边框变为 `ring`，添加 3px ring
- 错误状态（aria-invalid）：边框和 ring 变为 `destructive` / `destructive/20`
- 占位符文本：`text-muted-foreground`

**Card / Dialog**

- 卡片使用 `bg-card` + `border-border` + `{rounded.xl}` (8px)
- 对话框使用更大圆角 `{rounded.3xl}` (13px)，背景可选 `bg-popover`
- 内容区域 padding `16px` (lg)

**List / ScrollArea**

- 列表项 hover: `hover:bg-muted/50`
- 选中项：`bg-accent text-accent-foreground`
- 分隔线：`border-b border-border` 或 `Separator` 组件

**Tooltip**

- 背景色 `bg-popover`，文字 `popover-foreground`
- 圆角 `{rounded.md}` (5px)
- 箭头指向目标元素

**Toast**

- 成功/错误状态通过图标区分（CheckCircle2 / XCircle）
- dismiss 按钮：icon-only ghost button
- 固定在屏幕右上角或右下角

## Do's and Don'ts

**Do**

- ✅ 使用 OKLCH 颜色，保持 hue 260（紫色轴）的一致性
- ✅ 深色/浅色主题对称设计，确保两个主题对比度都 ≥ 4.5:1
- ✅ 圆角基于 6px 倍数系统，避免随意数值（32px, 40px 大圆角是 SaaS 套路）
- ✅ 间距基于 4px 网格，使用 Tailwind 的预设值（2, 3, 4, 5, 6, 8）
- ✅ 按钮文本使用 font-medium (500)，保持视觉层级
- ✅ 状态反馈清晰：loading、pending、success、error 都有明确视觉指示
- ✅ 等宽字体用于技术信息（slug、版本 ID、文件大小）
- ✅ 限制宽度使用 truncate（项目名、slug），确保列表紧凑

**Don't**

- ❌ 不要使用渐变文字、渐变背景、玻璃态效果（SaaS 套路）
- ❌ 不要添加装饰性 SVG 插图或手绘风格图形（玩具感）
- ❌ 不要使用大于 `{rounded.3xl}` (13px) 的圆角，避免过度圆润
- ❌ 不要使用 `shadow-lg` 或更大的扩散阴影（企业笨重）
- ❌ 不要使用 ALL CAPS 作为 eyebrow 标签（SaaS 套路的 "ABOUT" "PROCESS"）
- ❌ 不要留白过度或信息密度过低（极简冷淡）
- ❌ 不要使用营销话术（"seamless" "empower" "supercharge"）
- ❌ 不要在卡片上叠加 border + shadow（ghost-card 模式）
- ❌ 不要使用纯黑色或纯白色（`#000` / `#fff`），始终使用 OKLCH 中性色
