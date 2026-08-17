# B14 — UI 重设计基建与死代码清理（2026-08-17）

> UI 重设计四批次之一（**B14 基建** / B15 基础件与壳层 / B16 各 Region / B17 收口），
> 总纲 `decision-log.md` D12。本批结束时**界面视觉零变化**：只删死代码、修双 shell
> 隐患、装入 Tailwind v4 + shadcn 地基并完成主题 token 映射。

## 1. 范围

### 1a. 死代码删除（一个 commit）

- **删除入口不可达的组件及其专属依赖**：旧 Grill 工作台（`GrillWorkbench.tsx`、
  `GrillSessionPanel.tsx`、`GrillSessionList.tsx`、`GrillQuestionDetail.tsx`、
  `GrillQuestionPlanPanel.tsx`、`GrillDiagnostics.tsx` 等）与创作契约面板
  （`ContractDraftPanel.tsx`、`ContractSectionsView.tsx`）及各自的测试、hooks、
  纯逻辑模块。
- **以 import graph 为准，不按目录整删**：`grill/` 下的 hooks / `status-labels` /
  `validation` 等模块可能被 Intake（访谈阶段）复用，凡仍被可达代码 import 的一律保留。
  删除清单以「从 `main.tsx` 出发不可达且仅被自身测试引用」为唯一标准，删除前逐文件核对。
- **删除对应死 CSS**：App.css 中 Grill 工作台（约 997-1773 行）、问题规划面板
  （约 2102-2563）、创作契约（约 2564-3172）三段及其配套暗色块；行号以删除时实际
  核对为准（选择器名对照组件类名）。
- **修双 shell 隐患**：`.app`（flex，旧）与 `.app-shell`（grid，新）同时命中根节点，
  靠定义顺序侥幸正确——删掉 `.app` 旧规则，根节点类名收敛为一套。
- **删 Electron 残留**：`.app-header` 的 `-webkit-app-region: drag`。

### 1b. Tailwind v4 + shadcn 基建（一个 commit）

- apps/web 新增 devDependencies：`tailwindcss`、`@tailwindcss/vite`；shadcn init 带入
  `class-variance-authority`、`clsx`、`tailwind-merge`、`lucide-react`。
- vite.config.ts 挂 `@tailwindcss/vite` 插件。
- 新增 `src/styles/tailwind.css`：**分层引入、不含 preflight**（D-B14-1），
  `@theme` 内完成设计 token 定义（D-B14-2）。`main.tsx` 在 `App.css` 之前 import。
- `shadcn init` 生成 `components.json`（style: new-york、CSS 变量模式、alias `@/`）
  与 `src/lib/utils.ts`（`cn()`）。本批**不添加任何具体组件**（那是 B15 的事），
  只保证 `npx shadcn add button` 在下一批开箱即用。

## 2. 决策

### D-B14-1 迁移期不启用 preflight

Tailwind v4 的 `@import "tailwindcss"` 自带 preflight 重置，会立刻冲击 5535 行存量
App.css 的隐式默认值假设。迁移期改为分层引入：

```css
@layer theme, base, components, utilities;
@import 'tailwindcss/theme.css' layer(theme);
@import 'tailwindcss/utilities.css' layer(utilities);
```

跳过 `preflight.css`。B17 收口、App.css 退役时再补 `@import 'tailwindcss/preflight.css'
layer(base)`。代价：迁移期 shadcn 组件的个别样式假设（如 `border-color` 默认值）需
就地补齐，B15 引组件时逐个验证。

### D-B14-2 token 体系：@theme 单点定义，映射现有视觉身份

`@theme` 中建立完整 token（现状只有 22 个颜色变量，间距/圆角/字号全硬编码）：

- **颜色**：以现有纸感配色为准——canvas `#f4f3ef`、panel `#ffffff`、rail 近黑
  `#181817`、正文 `#1f2937` 系；**primary 统一为靛蓝紫系**（logo `#514cc9` 家族，
  按 D12 拍板，蓝 `#2563eb` 不进入新 token）。shadcn 语义变量（`--background` /
  `--foreground` / `--primary` / `--muted` / `--destructive` …）全部指向这套值，
  不留 zinc 默认值。
- **暗色**：`@media (prefers-color-scheme: dark)` 内覆写一份变量即完成全局暗色
  （替代 38 个手写块的机制；存量块随 B15/B16 逐批删除）。dark variant 绑定
  media query（`@custom-variant dark`），不做 class 切换。
- **字体**：`--font-sans`（现系统栈）、`--font-serif`（宋体展示标题栈）、
  `--font-mono`（SF Mono 栈）。
- **间距/圆角/阴影**：沿用 Tailwind 默认刻度；圆角基准对齐现有 16px 卡片
  （`--radius: 1rem`）。

旧 App.css 的 `--color-*` 变量在迁移期保持可用（由新 token 反向赋值），避免存量
选择器失效；B17 删除。

### D-B14-3 测试防线不动

19 个 .tsx 测试（含 `accessibility.test.tsx`）在本批必须**零改动全绿**——死代码删除
只允许带走「仅被删除对象自身引用」的测试文件；任何存量测试需要改动说明删多了。

## 3. 工作流与验收

- 每个 commit 后 `pnpm check` 全绿（format / lint / build / typecheck / test）。
- 1a 验收：`pnpm build` 产物体积应明显下降（CSS 约 -1/3）；浏览器过一遍四阶段主流程，
  视觉与行为无差异。
- 1b 验收：build 后产物含 tailwind 层但页面视觉零变化（utilities 尚未被使用）；
  `@theme` 变量在 devtools 可见；暗色系统切换行为与迁移前一致。

## 4. 已知限制

- 本批不动任何可见样式；三套强调色并存的现状要到 B15/B16 才逐屏收敛。
- shadcn CLI 需要网络访问 registry；若 CLI 版本与 Tailwind v4 配置有出入，以手工
  维护 `components.json` 为兜底。
- 移动端事项（100dvh、safe-area、触控目标）统一放 B17，本批不做。
