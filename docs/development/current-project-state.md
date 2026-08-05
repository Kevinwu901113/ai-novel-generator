# Current Project State — Idea-to-Novel Graph Engineering 基线

> 本文档是仓库**唯一**项目状态文档：以合并后的 `main` 为事实来源，描述当前代码真实能力、用户旅程、可复用资产、
> 权威 Graph 基线、当前推进位置与验证基线。
> 状态文档版本：2（2026-08-04）。本文档由项目负责人维护，仅在目标状态、能力矩阵或推进位置发生实质变化时更新。
> 路线与验收标准见 `docs/development/graph-engineering-roadmap.md`。

---

## 0. Snapshot Metadata

| 项              | 值                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| 状态文档版本    | 2                                                                                                                    |
| 更新日期        | 2026-08-04                                                                                                           |
| 基线 main SHA   | `54c6b314bf00c0203895e54fd4253871de672261`（PR #32 合并后，含两张权威 Graph）                                        |
| 代码核验范围    | apps/desktop、apps/worker、apps/writing-experiment-runner、packages（含新增 graph 模块）、数据库 migration v1–v7、CI |
| CI/本地验证状态 | §10（`pnpm check`、`git diff --check`、CI）                                                                          |

## 1. 权威层级

```text
L1  PRODUCT_DIRECTION.md                        产品方向（最高权威）
L2  docs/product/idea-to-novel-v1.md            产品 1.0 纵向切片规格
L3  packages/domain/src/idea-to-novel-graph.ts  流程权威：IdeaToNovelProjectGraphV1 + ChapterGenerationGraphV1
L4  docs/development/*                          graph-engineering-roadmap / 本文档 / module-boundaries / decision-log …
```

详见 `docs/development/graph-engineering-roadmap.md` §1。任何"当前状态 / 下一步 / 验收标准"在本仓库只有一个答案。

## 2. What Main Actually Provides

### AVAILABLE

| 能力                  | 实际证据路径                                                                                                                                                            | 当前作用                                                                                                                                                                                               | 下一目标状态处理                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| **权威 Graph 定义**   | `packages/domain/src/idea-to-novel-graph*.ts`（PR #32 已合并）                                                                                                          | IdeaToNovelProjectGraphV1（16 节点/36 边）+ ChapterGenerationGraphV1（13 节点/23 边）+ 纯 transition / graph-aware 校验 / 失效传播 / WorkflowStage 投影；contracts DTO；175 项测试                     | 唯一流程权威；GE-1 在其上建运行时内核                                                |
| **Graph Run Runtime** | `packages/application/src/graph-run*.ts`、`database/src/graph-run-*.ts`（migration v8）、`apps/worker/src/graph-handlers.ts`、contracts GRAPH_* 通道 + DesktopAPI.graph | GraphRunService（createRun/advanceNode/failNode/requestHumanDecision/applyHumanDecision/listRuns/recoverInFlightRuns）+ BEGIN IMMEDIATE/CAS 原子持久化 + 幂等命令 + 启动恢复 + answer receipt 原子契约 | GE-2 在其上跑双 Graph 全路径                                                         |
| Project lifecycle     | `packages/application/create-project.ts`、`open-project.ts`、`list-projects.ts`                                                                                         | 项目创建/打开/列表/启动恢复                                                                                                                                                                            | 保留；产品入口随 GE-3 改为 Idea Intake                                               |
| Grill / questioning   | `packages/domain/grill.ts`、`application/grill-session.ts`、`database/grill-repositories.ts`、`worker/grill-handlers.ts`、`renderer/grill/*`                            | 会话/问题/回答/提案全链路                                                                                                                                                                              | GE-3 适配为 Idea Intake；修复 `grill.listQuestions` / `grill.markQuestionAsked` 死链 |
| Creation Contract     | `packages/domain/creation-contract.ts`、`application/creation-contract*.ts`、DB v4–v6、`worker/contract-handlers.ts`、`renderer/contract/*`                             | 契约提案/版本/current 指针/字段锁/CAS                                                                                                                                                                  | GE-3 复用快照/版本/provenance 为 CreationSpec 基座，废弃审批门禁                     |
| Task Engine           | `packages/task-engine/`                                                                                                                                                 | 持久化长任务：MODEL_INVOCATION_TEST / GRILL_QUESTION_PLAN / CREATION_CONTRACT_DRAFT；CAS claim + 启动恢复                                                                                              | GE-2+ 作为所有 AI 执行器底座                                                         |
| Model Gateway         | `packages/model-gateway/`                                                                                                                                               | Anthropic 兼容 `invokeModel` + `testConnection`，MiMo V2.5 Pro                                                                                                                                         | 保留非流式 + 严格解析；GE-6 接入生成                                                 |
| Manuscript backend    | `packages/domain/manuscript.ts`、`application/manuscript*.ts`、DB v7、contracts manuscript 类型                                                                         | 章/章节版本/CAS/position/不可变版本                                                                                                                                                                    | GE-7 接 transport/renderer                                                           |
| Evaluation harness    | `packages/writing-evaluation/`、`apps/writing-experiment-runner/`                                                                                                       | 离线确定性评测 + LIVE 门控实验                                                                                                                                                                         | GE-9 质量基线                                                                        |
| Packaged application  | `apps/desktop`（electron-packager + smoke-test）                                                                                                                        | macOS arm64 打包 + 冒烟测试                                                                                                                                                                            | 保留                                                                                 |

### PARTIAL / STUB

| 能力                          | 状态               | 说明                                                               |
| ----------------------------- | ------------------ | ------------------------------------------------------------------ |
| Idea capture                  | PARTIAL            | `projects.initial_idea` 已落库；未播种进 intake session；GE-3 处理 |
| CreationSpecDraft             | PARTIAL            | 现有 CREATION_CONTRACT_DRAFT 草案管线可复用；对象形态在 GE-3 冻结  |
| Manuscript transport/renderer | MISSING（main 无） | PR #25 参考资产；GE-7 选择性移植                                   |
| Web Research / ResearchBundle | MISSING            | `packages/research-engine` 为 stub；GE-4                           |
| StoryBlueprint                | MISSING            | GE-5                                                               |
| Chapter Generation            | MISSING            | GE-6                                                               |
| Export                        | MISSING            | `packages/import-export` 为 stub；GE-7                             |
| PlotPilot                     | PARTIAL            | 可选 adapter foundation；不进入关键路径                            |

### 已知死链（GE-3 修复）

- `grill.listQuestions`：channel/preload/main 都在，worker 顶层 dispatch 无 case → 运行时 `VALIDATION_ERROR`。
- `grill.markQuestionAsked`：同上；worker `dispatchGrillCommand` 也无 case。

## 3. Current User Journey

打包应用当前实际走到（`apps/desktop/src/renderer/App.tsx`）：

```text
启动 → 健康检查 → 项目列表 → 新建项目（名称 + 初始想法）→ 打开
→ 有项目：Grill 工作台（GrillSessionList / GrillSessionPanel / GrillQuestionPlanPanel / ContractDraftPanel）
→ 右栏：状态面板（ProviderRegion / TaskCenter / GrillDiagnostics）
```

旅程在 **Creation Contract 之后停止**：无 Idea Intake 产品流程、无 Web Research、无 StoryBlueprint、无章节生成、
无稿件编辑器、无导出。这些正是 GE-3..GE-7 的目标。

## 4. Canonical Assets（复用路线）

- **Grill** → GE-3 适配为 Idea Intake（对话式，隐藏状态机/提案/任务细节；复用 `grill_*` 表）。
- **Creation Contract** → GE-3 作为 CreationSpec（保留 snapshot/version/provenance，废弃审批门禁/字段锁主体验）。
- **Task Engine** → GE-2+ 所有 AI 执行器底座（graph 节点执行器作为持久化任务）。
- **Model Gateway** → 非流式 + 严格解析 + 轮询。
- **Manuscript backend**（MV1-A）→ GE-7 权威稿件存储；transport/renderer 移植。
- **Evaluation** → GE-9 质量基线。

## 5. Non-Main Reference Assets

- **PR #25**（`feat/manuscript-renderer-mv1b`）：保持 Draft / 不合并 / 不关闭；GE-7 从其中选择性移植 transport + renderer 资产。
- 不把 PR #25 能力记为 main 已实现。

## 6. Current Target State

**唯一目标状态**：Product 1.0 真实纵向链路（GE-8 端到端验收通过）：

```text
输入想法 → Idea Intake → CreationSpec → 必要调研 → ResearchBundle → StoryBlueprint
→ 完整章节生成 → 用户修改 → 继续生成 → TXT/Markdown 导出
```

在 GE-8 之前允许 fixture/确定性 executor，但必须使用真实的：Graph 状态机内核、核心 contracts、跨进程 API、持久化、
Manuscript、Export、重启恢复。

## 7. Locked Decisions

```text
- 不按时间估算推进；以门禁和依赖推进
- 任何 Graph 状态变化只能经 Domain transition
- WorkflowStage 永不作为权威状态
- 生成候选 ≠ 权威稿件；仅 MANUSCRIPT_COMMIT 后可写 Manuscript
- 人工 Gate 处不得自动接受或提交
- 不建立长期集成分支
- 不提前建设多 Provider、任务 DAG 或复杂 Agent 平台
- 不静默覆盖用户正文（CAS / 版本化 / 显式写入）
- 未合并 PR 不计入 main 能力
```

## 8. Current Position（推进位置）

> 2026-08-04 Post-Merge Acceptance：GE-3/4/5/6 原始退出条件未达成；已交付为 FOUNDATION / BACKEND。
> Graph 节点真实 executor、运行时接线、产品 UI、E2E 均未达。详见 `docs/development/post-merge-acceptance.md`。

```text
GE-0 权威文档收束        → ✅ COMPLETE（2026-08-04，PR #33）
GE-1 Durable Runtime     → ✅ COMPLETE（内核，2026-08-04，PR #34，migration v8）
GE-2 Walking Skeleton    → ⚠️ PARTIAL（2026-08-04，骨架测试达成；无运行时 runner / 无 UI；直接推 main）
GE-3 Idea Intake+Spec    → 🔶 REWORK（BACKEND 有：intake.* / 播种 / 失效；节点未接，无 UI，无 E2E）
GE-4 Web Research        → 🔶 REWORK（BACKEND 有：research-engine / research.execute(fake)；节点未接，无 UI）
GE-5 StoryBlueprint      → 🔶 REWORK（BACKEND 有：blueprint.*；节点未接，accept 非原子，无 E2E）
GE-6 Chapter 生成        → 🔶 REWORK（FOUNDATION 有：CHAPTER_DRAFT 任务引擎；无 executor / settlement）
RW-1 执行与 Settlement   → Draft PR（跨阶段门禁，GE-3..6 共同依赖；待 Principal Architect 验收）
GE-7 Manuscript/导出     → 待 GE-6 原退出条件通过后才启动
GE-8 端到端验收          → 待开始
GE-9 质量增强            → 待开始
```

详见 `docs/development/graph-engineering-roadmap.md` §5–§15 与 `docs/development/post-merge-acceptance.md`。

## 9. Shared Hotspots（单一 owner）

```text
packages/domain（graph 模块）   → 已合并，冻结（PR #32）
packages/application（GraphRunService） → GE-1
packages/database（migration 注册表）    → 每 GE 单 owner 追加
packages/contracts（IPC 通道）            → 每 GE 单 owner 追加
apps/worker（root dispatch）             → 每 GE 单 owner 追加
apps/desktop（main/preload/renderer）     → GE-3 起按阶段接管
```

## 10. Verification Baseline

与 CI 相同的验证，本地实际执行结果（未设置 `WRITING_EXPERIMENT_LIVE`）：

| 项                  | 命令                                                          | 结果                                                                            |
| ------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `pnpm check`        | `format:check && lint && build && typecheck && test`          | PASS（exit 0）                                                                  |
| `git diff --check`  | —                                                             | PASS                                                                            |
| macOS package smoke | `pnpm package` + `pnpm --filter @ai-novel/desktop smoke-test` | CI macos-package 门禁                                                           |
| 测试 passed/skipped | `pnpm test` 输出                                              | Test Files 109 passed / 1 skipped（110）；Tests 2805 passed / 6 skipped（2811） |

测试通过 ≠ 产品验收通过（GE-8 才是验收）。
