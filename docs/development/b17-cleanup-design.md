# B17 — UI 重设计收口（2026-08-17）

> UI 重设计四批次之四（B14 基建 / B15 基础件与壳层 / B16 各 Region / **B17 收口**），
> 总纲 `decision-log.md` D12。上游：B16 结束时全站已迁 Tailwind + shadcn，
> App.css 剩 371 行。本批清零迁移期的过渡机制、补移动端最小集、销账文档。

## 1. 范围

### 1a. preflight 启用与 App.css 退役

- 补 `@import 'tailwindcss/preflight.css' layer(base)`（D-B14-1 预留的收口步骤），
  删除 App.css 自写全局 reset 及 B15 为缺 preflight 打的临时补丁子集。
- App.css 余段处置：正文阅读排版层（D-B16-2）与确属必要的公共段迁入
  `@layer components`（或组件内聚）；`--color-*` 旧变量桥接删除，消费点改用新
  token；未引用变量（`--color-dev-badge*` 等）删除。目标：**App.css 文件删除**，
  残余并入 `styles/`；做不到则回报理由。
- 无 CSS 消费的历史类名（`project-canvas-inner` 等）从 DOM 清理。
- App.css 剩余 `@media (prefers-color-scheme: dark)` 手写块清零（token 化收编）。
- **风险**：preflight 启用是全局行为变化，逐屏（首页/访谈/调研/蓝图/章节/任务
  中心/设置/TokenGate）明暗两态截图对比，差异逐条确认为改善或无害才算过。

### 1b. 移动端最小集（桌面为主定位下的实质缺陷修复）

- `100vh` → `100dvh`（iOS Safari 地址栏收放裁底问题）。
- `env(safe-area-inset-*)`：rail、抽屉、toast 不压刘海/Home indicator。
- 关键触控目标 ≥44px：journey 阶段按钮、抽屉关闭钮、任务列表行等高频控件
  （桌面视觉密度不变，用 padding/hit-area 方式扩）。
- 补 768px 断点最小集：首页与工作区在窄视口不破版、Sheet 全宽；不做底部导航
  等形态改造（D12 拍板桌面为主）。

### 1c. 文档与债务销账

- `tech-debt.md`：TD-035 改写（最小集已修，全面移动审计明确 out of scope 或
  另立小额条目）；迁移中新发现的债（如有）登记。
- `current-project-state.md` 状态推进；`system-overview.md` 如仍描述旧样式体系
  则同步。
- 顺手项（可选，超 30 分钟即放弃并回报）：让 `vitest.setup.ts` 与 apps/web 测试
  文件被 tsconfig 覆盖，消除编辑器 tsserver 红线噪音（CI 本就全绿，纯开发体验）。

## 2. 决策

### D-B17-1 preflight 差异的判定标准

启用后逐屏对比，允许的差异只有两类：①与迁移前手写 reset 语义等价；②明确改善
（如表单控件继承字体）。出现第三类（视觉回退）必须在 App.css 残段或组件层补齐，
不允许「差不多就行」。

### D-B17-2 触控目标扩大不改桌面视觉

用 `min-h-11`（44px）+ 负 margin / 伪元素 hit-area 等方式扩触控面，桌面鼠标
密度与现视觉不变；不引入 `pointer: coarse` 分叉（维护成本大于收益，桌面为主）。

## 3. 工作流与验收

- 顺序：1a（一到两个 commit）→ 1b（一个 commit）→ 1c（一个 commit）。
- 每 commit `pnpm check` 全绿（基线：160 文件 3256 用例）。
- 1a 后全屏截图对比归档进回执；1b 后用窄视口（390×844）过首页+四阶段+抽屉。
- 最终验收（负责人）：桌面全流程 + 手机「顺手看稿」real 设备走查；通过后 D12
  四批全部完成，合并/推送由负责人定。

## 4. 已知限制

- 手机完整创作流程形态（底部导航、bottom-sheet、软键盘适配）明确不做（D12）。
- 手动暗色开关不做（跟随系统，D12）。
