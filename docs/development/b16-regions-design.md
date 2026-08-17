# B16 — 各 Region 逐屏迁移（2026-08-17）

> UI 重设计四批次之三（B14 基建 / B15 基础件与壳层 / **B16 各 Region** / B17 收口），
> 总纲 `decision-log.md` D12。上游：B15（基础件、toast、强调色已就位；壳新瓤旧是
> 当前状态）。本批把四阶段工作区与任务中心全部迁到 Tailwind + shadcn，结束时
> App.css 只剩零星公共段，交 B17 收口。

## 1. 范围

分两个子批（各自一到多个 commit，均须 `pnpm check` 全绿）：

### 1a. 工作区骨架与前半流程

- `journey/JourneyNav.tsx`：阶段导航迁移；`aria-current="step"` / `aria-pressed`
  语义保留；视觉与 B15 壳层对齐。
- `App.tsx` 的 project-workspace / project-canvas 框架段。
- `regions/`：ProjectListRegion（含首页项目卡空态，接 `EmptyState`）、
  CreateProjectRegion、ProjectStatusRegion、ProviderRegion（裸 `<select>` 换
  shadcn Select）。
- 设置抽屉内容段（B15 偏差 2 遗留的 `drawer-section` / `system-overview` 系）。
- `intake/`：IntakeRegion（访谈流）、CreationSpecPanel。
- 新建 `src/components/InlineError.tsx`：Region 内联错误统一呈现
  （`role="alert"` 保留，样式走 `--destructive` token）；本子批范围内替换。

### 1b. 后半流程与任务中心

- `research/`：ResearchRegion、ResearchBundleView（空态接 EmptyState）、
  SearchKeyPanel、ResearchEscalationPanel。
- `blueprint/`：BlueprintRegion、BlueprintView、Gate/Escalation/ProjectReady 面板。
- `chapter/`：ChapterRegion（裸 `<button>` 补 Button）、CandidateView、
  Gate/Escalation 面板、ManuscriptPanel（正文阅读区排版单独对待，见 D-B16-2）。
- `task-center/`：TaskCenter、TaskList（裸 `<select>` 换 Select、listbox 键盘导航
  语义保留）、TaskDetail、TaskStats；「暂无任务」等贫瘠空态接 EmptyState。

### 通用（两个子批都执行）

- `⟳` 字符转圈全部换 `Spinner`（B15 已建）。
- 散落的硬编码蓝 `#2563eb` 系清零（强调色统一收尾）。
- 每迁完一屏，删 App.css 对应段落及配套暗色块，不留双套命中。
- 迁移中发现的死选择器（无组件引用）顺手删除。

## 2. 决策

### D-B16-1 空态允许补引导，文案走既有纪律

现状空态两极：好的有引导（「先把上面的第一个想法写下来。」），差的一行灰字
（「暂无任务」）。本批统一接 `EmptyState`，**允许**为贫瘠空态补一句引导文案或
引导按钮，约束：口语调性、不出现工程概念、每条新增文案在 commit message 列出。
存量好文案一字不动。

### D-B16-2 ManuscriptPanel 正文区保留专用排版层

小说正文阅读区（字号、行高、段距、限宽 760-820px、衬线选项）是产品核心体验，
不套 shadcn 卡片风格；迁移为独立的 `@layer components` 段（或组件内聚样式），
排版参数原值平移，只把颜色/间距接到 token。

### D-B16-3 测试改动边界（沿用 D-B15-1）

`accessibility.test.tsx` 大量断言 Region 级 DOM——允许改选择器/类名断言，
role / aria-* / 键盘导航（尤其 TaskList listbox）语义断言不许删弱；改动在
commit message 逐条列理由。用例数只增不减。

## 3. 工作流与验收

- 1a → 1b 串行（两者都动 App.css，并行必冲突）。
- 每 commit `pnpm check` 全绿；子批结束时起 dev server 截图核对明暗两态。
- 视觉验收（负责人）：四阶段全流程 + 任务中心走一遍——本批结束时全站视觉统一，
  不应再看到旧蓝色或新旧样式拼贴。
- App.css 预期从 ~3250 行降到 <300 行（公共 reset、正文排版等零星段）。

## 4. 已知限制

- 移动端断点仍未系统补齐（B17）；本批删除旧 920/1080px 覆写时，桌面 ≥920px
  视觉不受影响即可。
- 暗色模式在迁移过的屏由 token 自动生效；App.css 残段的暗色块随段删除，B17 清零。
