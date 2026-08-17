# B15 — 基础组件与壳层迁移（2026-08-17）

> UI 重设计四批次之二（B14 基建 / **B15 基础件与壳层** / B16 各 Region / B17 收口），
> 总纲 `decision-log.md` D12。上游：B14（Tailwind v4 token + shadcn 地基就绪）。
> 本批出现**第一批可见变化**：强调色统一切靛蓝紫、rail 图标换 lucide、抽屉换
> Sheet、错误提示统一走 toast。四阶段主流程行为不变。

## 1. 范围

### 1a. shadcn 基础件引入

- `shadcn add`：`button`、`input`、`textarea`、`label`、`select`、`dialog`、
  `sheet`、`card`、`skeleton`、`sonner`（toast）、`separator`。只加壳层与首页
  实际用到的；Region 专用件（如 tabs）到 B16 按需加。
- 自建两个轻组件（`src/components/`）：
  - `EmptyState`：图标（lucide）+ 主文案 + 可选引导按钮；文案沿用现有中文措辞。
  - `Spinner`：替换全站 `⟳` 字符旋转；尊重 `prefers-reduced-motion`（静态降级），
    保留 `role="status"` 语义。本批仅在壳层/首页范围内替换，Region 内部 B16 换。
- shadcn 生成件落 `src/components/ui/`，允许就地改样式（shadcn 的设计初衷），
  但改动必须只用 B14 的 `@theme` token，不引入新硬编码色。

### 1b. 强调色收敛（第一个全局可见变化）

- `--color-primary`/`--color-primary-hover` 从蓝 `#2563eb` 系翻转为靛蓝紫
  `#514cc9` 家族（B14 桥接时刻意搁置的两个变量）——存量 `.btn-primary`、焦点环、
  链接色随之全局变色，一次到位。
- logo 渐变、`--color-accent-*` 已在同一家族，无需改。

### 1c. 壳层迁移（App.tsx / shell/ / home/ / auth/）

- **AppRail**：图标从手写 `AppIcon.tsx`（9 个 path）换 lucide-react；aria-label /
  aria-current 语义逐个保留。`AppIcon.tsx` 在最后一个引用消失时删除。
- **AppDrawer → Sheet**：右侧抽屉改 shadcn Sheet（Radix Dialog），手写的
  Escape/Tab 循环/焦点归还整段删除（Radix 接管）；`aria-hidden` backdrop button
  的存疑语义随之消失。tasks / settings 两种内容不变。
- **app-header**：面包屑 + 阶段 pill + 按钮迁 Tailwind 类；`header-button` 等
  ad-hoc 类换 Button variant。
- **HomePage**：hero、创建卡、最近项目网格迁 Tailwind + Card；宋体大标题、
  「今天想写什么？」文案与信息层级不变。
- **TokenGate**：录入卡迁 Card + Input + Button。
- 壳层迁完后删除 App.css 中对应段落（rail / drawer / header / home / token-gate），
  不允许「新旧两套都能命中」的过渡态留过本批。

### 1d. 错误提示统一

- 引入 sonner `<Toaster/>`（挂 App 根），主题色接 token。
- 顶部全局错误红条（`App.tsx` 的 `global-error`）改 toast（destructive 样式）；
  `role="alert"` 语义由 sonner 的 aria 机制承接，`accessibility.test.tsx` 中对应
  断言随批更新。
- **三处 `catch {}` 静默吞错**（`App.tsx` 项目列表 / 模型列表 / provider 状态加载）
  改为 toast 报错 + 原有「不阻塞」行为保留（加载失败不挡主流程）。
- Region 内联错误块（`.intake-error` 等 30 处 `role="alert"`）本批**不动**，B16 处理。

## 2. 决策

### D-B15-1 存量测试的改动边界（细化 D-B14-3）

本批允许改动的测试断言仅限：①壳层 DOM 结构/类名断言；②global-error → toast 的
呈现方式断言。**不允许**删除或弱化任何 role / aria-* / 键盘可达性断言——Radix 接管
后这些断言应当仍然成立（选择器可改，语义不可丢）。`accessibility.test.tsx` 改动需
在 commit message 中逐条列出理由。

### D-B15-2 Spinner/EmptyState 自建而非找库

体量 <50 行；shadcn 无对应原语；语义（`role="status"`、reduced-motion 降级）是
现有无障碍资产，自建可完整继承。

### D-B15-3 toast 选 sonner

shadcn 官方推荐位（原 toast 组件已 deprecated 指向 sonner）；内建 aria-live、
去重、reduced-motion。位置右下（桌面为主），持续 5s，错误不自动消失。

## 3. 工作流与验收

- 顺序：1a → 1b（一个 commit）；1c → 1d（一个 commit，壳层与错误提示耦合在
  App.tsx，拆开会出现两套错误呈现并存的中间态）。
- 每个 commit `pnpm check` 全绿。
- 视觉验收（负责人）：主按钮/焦点环变靛蓝紫、rail 新图标、抽屉新动画、toast 出现；
  四阶段主流程（建项目→访谈→调研→蓝图→章节→导出）行为无回归。dev 端口避开被占的
  5173（`pnpm dev -- --port 5175`）。
- 断电保护：每个 commit 都是可独立回滚的完整状态。

## 4. 已知限制

- Region 内部（访谈/调研/蓝图/章节/任务中心）仍是旧样式——本批结束时壳新瓤旧是
  预期状态，B16 收齐。
- 强调色切换后，Region 内旧蓝色元素（如有硬编码 `#2563eb` 的散点）会与新 primary
  轻微不一致，属已知过渡态，B16 逐屏消除。
- 暗色模式：壳层新组件走 token 自动获得暗色；存量 38 块中被删段落对应的块一并
  清掉，其余留到各自批次。
