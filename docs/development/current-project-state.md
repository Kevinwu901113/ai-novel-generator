# Current Project State — Idea-to-Novel 基线

> 本文档是仓库唯一项目状态文档：以合并后的 `main` 为事实来源，描述当前代码真实能力、
> 用户旅程、可复用资产、未合并参考资产、当前目标状态、决策与初始化 Ready Queue。
> 状态文档版本：1（2026-08-03）。本文件由初始化 Agent 独占，后续状态更新必须同步更新本文档。

---

## 0. Snapshot Metadata

| 项                 | 值                                                                                                                                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态文档版本       | 1                                                                                                                                                                                                                                                         |
| 初始化日期         | 2026-08-03                                                                                                                                                                                                                                                |
| 基线 main 完整 SHA | `e3e067f95ea601e081729aad07700aa7ead21d3a`                                                                                                                                                                                                                |
| 基线来源           | PR #28 标准 merge commit（parents `55c09572…` + `ed20524e…`）后 fetch 的 `origin/main`                                                                                                                                                                    |
| 代码核验范围       | apps/desktop（main/preload/renderer）、apps/worker、apps/writing-experiment-runner、packages（domain/application/database/contracts/model-gateway/task-engine/secret-store/writing-evaluation/plotpilot-adapter 及 stub 包）、数据库 migration、CI 工作流 |
| CI/本地验证状态    | 见 §10（`pnpm check`、`git diff --check`、CI 相同 macOS package smoke）                                                                                                                                                                                   |

## 1. Product Objective

产品方向（已合并，`PRODUCT_DIRECTION.md` / `docs/product/idea-to-novel-v1.md`）：

```text
模糊想法
→ 必要澄清
→ 必要调研
→ 故事蓝图
→ 小说生成
→ 稿件修改
→ 导出
```

一句话：以尽可能低的表达成本，把用户的模糊想法转化为经过必要调研、符合其形式要求的小说；
编辑器是稿件阶段的主要界面，但不是产品 1.0 唯一入口。

## 2. What Main Actually Provides

状态只表示 main 上代码实际存在与否，不表示产品验收通过。依据：真实代码、测试与 migration，不从文档/PR 标题推测。

### AVAILABLE

| 能力                      | 实际证据路径                                                                                                                                                                                                                                                 | 当前作用                                                                               | 主要缺口                                                                                                                                     | 下一目标状态处理                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Project lifecycle         | `packages/application/create-project.ts`、`open-project.ts`、`list-projects.ts`；`apps/worker/src/index.ts`（reconcile/reconcileTasks）                                                                                                                      | 项目创建/打开/列表/启动恢复，app.sqlite 索引 + 项目目录 project.sqlite                 | 无产品级入口引导（默认进 Grill 工作台）                                                                                                      | 保留；产品入口改为 Idea Intake 后重排 App shell                  |
| Grill / questioning       | `packages/domain/grill.ts`、`packages/application/grill-session.ts`、`packages/database/grill-repositories.ts`、`apps/worker/src/grill-handlers.ts`、`apps/desktop/src/renderer/grill/*`                                                                     | 会话生命周期、问题/回答/提案、问题规划提案，完整后端+UI                                | `grill.markQuestionAsked` 为死链（main IPC 与 preload 暴露，worker dispatch `apps/worker/src/index.ts:1379` 无该 case）；UI 暴露大量工程状态 | 重构为 Idea Intake / 创作访谈；补 dispatch case                  |
| Creation Contract         | `packages/domain/creation-contract.ts`、`packages/application/creation-contract*.ts`、`packages/database/creation-contract-*`（migration v4–v6）、`apps/worker/src/contract-handlers.ts`、`contract-draft-runner.ts`、`apps/desktop/src/renderer/contract/*` | 契约提案/版本/current 指针/字段锁/CAS 事务，草案任务调模型，UI 支持接受/拒绝/更新/锁定 | 以审批门禁为主体验，不符合 1.0；术语暴露                                                                                                     | 内部复用为 CreationSpec 的 snapshot/version 基座，不作为审批门禁 |
| Task Engine               | `packages/task-engine/`（`MODEL_INVOCATION_TEST`/`GRILL_QUESTION_PLAN`/`CREATION_CONTRACT_DRAFT`）、tasks 表 + dedupe + 启动恢复                                                                                                                             | 长任务建模：claim/CAS/dedupe/恢复 PENDING/RUNNING                                      | 仅 3 种任务类型，无生成/调研任务                                                                                                             | 作为所有 AI 任务的底座，新增 research/generation 任务类型        |
| Model Gateway             | `packages/model-gateway/index.ts`                                                                                                                                                                                                                            | Anthropic 兼容网关，`invokeModel` + `testConnection`，MiMo V2.5 Pro                    | 单一 provider 模型形态；无 Provider 抽象                                                                                                     | 保留非流式调用 + 严格解析，暂不建多 Provider 平台                |
| Manuscript domain/backend | `packages/domain/manuscript.ts`、`packages/application/manuscript*.ts`、`packages/database/manuscript-repositories.ts`、`manuscript-transaction.ts`、migration v7、`packages/contracts/src/index.ts` manuscript 类型/校验器                                  | 章/章节版本/CAS/position/不可变版本 数据与用例，已测试                                 | 无 transport、无 renderer、无产品面                                                                                                          | 保留为权威稿件存储；transport 从 PR #25 选择性移植               |
| Evaluation harness        | `packages/writing-evaluation/`（evaluate/blind/ai-smell/metrics/…）、`apps/writing-experiment-runner/`（CLI，`WRITING_EXPERIMENT_LIVE` 门控）                                                                                                                | 真实生成评测 lab，离线/受控运行                                                        | 仅评测 CLI，不接产品                                                                                                                         | 保留；用于 STATE_A fixture 生成质量基线                          |
| Packaged application      | `apps/desktop/package.json`（electron-packager + `smoke-test`）、`.github/workflows/ci.yml`                                                                                                                                                                  | macOS arm64 打包 + 冒烟测试（CI 通过）                                                 | 无发布渠道                                                                                                                                   | 保留                                                             |

### PARTIAL

| 能力                 | 实际证据路径                                                                             | 当前作用                                                  | 主要缺口                                               | 下一目标状态处理                               |
| -------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------- |
| Idea capture         | `CreateProjectRegion.tsx`（name + initialIdea）、`create-project.ts`                     | 仅新建项目时存 initial_idea                               | 无 Idea Intake 流程，无多轮追问/抽取                   | R1 复用时把 initial_idea 播种进 intake session |
| CreationSpecDraft    | `creation-contract-request.ts` + `contract-draft-runner.ts`（`CREATION_CONTRACT_DRAFT`） | 产出的是 Creation Contract 字段草案，非 CreationSpec 对象 | 对象形态与 1.0 的 CreationSpec 不同                    | 复用草案管线，冻结 CreationSpec 契约           |
| CreationSpecSnapshot | `creation_contract_versions` + `creation-contract-snapshot-validation.ts`                | snapshot/version 机制存在，命名 contract                  | 不是 CreationSpec 形状                                 | 复用版本/provenance，重新命名                  |
| PlotPilot            | `packages/plotpilot-adapter/`（lifecycle.ts、sse-cancellation.test.ts）                  | 外部 PlotPilot sidecar adapter（spawn/SSE）               | 未接产品；按方向为可选 adapter，非本地 source of truth | 保持可选，不建强依赖                           |

### MISSING

| 能力                 | 证据路径（缺失）                                                                               | 说明                       | 下一目标状态处理                              |
| -------------------- | ---------------------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------- |
| Web Research         | `packages/research-engine/src/index.ts`（仅 `RESEARCH_ENGINE_PACKAGE_LOADED` 桩）              | 无搜索/抓取/来源记录       | P4/P5（port + orchestration），含 V1 安全边界 |
| ResearchBundle       | 无 domain/表/契约                                                                              | 无调研资料包对象           | 冻结 ResearchBundle 契约，新 migration        |
| StoryBlueprint       | 无 domain/表/契约                                                                              | 无蓝图对象                 | P7 蓝图聚合 + 生成任务                        |
| Chapter Generation   | 无 generation task/表/UI                                                                       | 无章节生成                 | P8 章节生成 pipeline（CAS 不覆盖正文）        |
| Manuscript transport | `apps/worker/src/`、`apps/desktop/src/main/`、`apps/desktop/src/preload/` 均无 manuscript 引用 | 无 IPC/worker/preload 通道 | P9 从 PR #25 移植                             |
| Manuscript renderer  | `apps/desktop/src/renderer/` 无 manuscript/ 目录                                               | 无稿件编辑 UI              | P10 从 PR #25 选择性移植                      |
| Export               | `packages/import-export/src/index.ts`（仅 `IMPORT_EXPORT_PACKAGE_LOADED` 桩）                  | 无导出                     | P11 TXT/Markdown 导出                         |

### REFERENCE_ONLY

| 能力                           | 状态          | 处理       |
| ------------------------------ | ------------- | ---------- |
| Manuscript transport（PR #25） | 未合并，见 §5 | 选择性移植 |
| Manuscript renderer（PR #25）  | 未合并，见 §5 | 选择性移植 |

## 3. Current User Journey

打包应用实际能走到（`apps/desktop/src/renderer/App.tsx`）：

```text
启动 → 健康检查 + 数据服务轮询
→ 项目列表 / 提供商状态加载
→ 无当前项目：新建项目表单（名称 + 初始想法）→ 创建/打开
→ 有当前项目：进入 Grill 工作台（"Grill-me 需求澄清"）
   ├─ 左栏：GrillSessionList（创建/选择会话）
   ├─ 中栏：GrillSessionPanel（start/pause/resume/complete/abandon，
   │        add/markAsked/skip/supersede 问题）+
   │        GrillQuestionPlanPanel（请求问题规划任务 → 接受提案）+
   │        ContractDraftPanel（请求创作契约草案任务 → 接受/拒绝提案）
   ├─ 右栏：GrillQuestionDetail（回答、创建/审阅提案）
   └─ 顶部：GrillDiagnostics（开发态诊断）
→ 右栏状态面板：本地存储 / 数据服务 / 当前阶段 / 项目状态 / TaskCenter / 模型服务（ProviderRegion）
```

用户现在能完成：新建/打开项目；配置并测试模型提供商；管理 Grill 会话与问答；请求问题规划并接受；
请求创作契约草案并接受/拒绝、查看/编辑/锁定契约字段；查看任务中心。

旅程在 **Creation Contract 之后停止**。以下均不存在：Idea Intake 产品流程、Web Research、
StoryBlueprint、章节生成、稿件编辑器（Manuscript renderer）、导出。工程控制台包括
`GrillDiagnostics`、`ProviderRegion`（连接测试）、`TaskCenter`、契约提案/审批 UI——这些是工程面，不是 1.0 产品面。

## 4. Canonical Assets

main 上可复用、但需要改造后才能等同于目标产品对象的资产：

- **Grill** → Idea Intake / 创作访谈（对话式，隐藏状态机/提案/任务细节）。
- **Creation Contract** → CreationSpec（保留 snapshot/version/provenance，废弃审批门禁与字段锁主体验）。
- **Task Engine** → 所有 AI 长任务底座（research/generation 任务类型在此基础上扩展）。
- **Model Gateway** → 非流式调用 + 严格解析 + 轮询（R1–R3 使用，R4 再补取消/阶段进度）。
- **Manuscript backend**（MV1-A）→ 权威稿件存储；transport/renderer 从 PR #25 移植后接入。
- **Evaluation** → 生成质量基线；STATE_A fixture 生成后用于判断"fixture 生成"是否达标。

## 5. Non-Main Reference Assets

- **PR #25**（`feat/manuscript-renderer-mv1b`，head `5d80ff20e59bd67e4c0b028b63f88e1531261926`，27 文件 +6586/−22）
  - 状态：REFERENCE_ONLY
  - 处理：保持 Draft、不合并、不继续开发；仅当 manuscript transport/renderer 资产进入后续 PR 且逐文件核对无遗漏后才可标记 superseded
  - 用途：后续选择性移植 Manuscript transport（contracts 通道+`ManuscriptAPI`、main `manuscript-ipc.ts`、preload allowlist、worker `manuscript-handlers.ts`）与 renderer（`useManuscriptWorkbench.ts`、ChapterList、EditorPanel、VersionHistory、dirty/CAS/buffer 安全）
  - 不把其中能力记为 main 已实现；App shell/默认入口等产品壳不随其迁移

## 6. Current Target State

唯一目标状态：**STATE_A_EXECUTABLE_SPINE**（可执行主链）。

完成条件：

```text
输入想法
→ fixture 调研
→ fixture 蓝图
→ fixture 生成
→ 真实 Manuscript 写入
→ 编辑
→ TXT/Markdown 导出
```

允许 fixture，但必须使用真实的：产品页面、核心 contracts、跨进程 API、持久化、Manuscript、Export、重启恢复。

## 7. Locked Decisions

```text
- 不按时间估算推进；以门禁和依赖推进
- 两个 Agent 各自最多一个主要工作包
- 共享热点只有一个 Owner
- 不建立长期集成分支
- 不提前建设多 Provider、任务 DAG 或复杂 Agent 平台
- 不静默覆盖用户正文（CAS / 版本化 / 显式写入）
- 未合并 PR 不计入 main 能力
```

## 8. Initial Ready Queue

```text
READY:
  Agent B — Canonical Spine Contract Freeze
    WorkflowStage / ResearchBundle / StoryBlueprint / GenerationRun
    正式 validator
    Renderer 可消费的 DesktopAPI 形状

READY_WITH_CONSTRAINT:
  Agent A — Product Spine Preparation
    Renderer 实际结构审计
    App shell 拆分计划
    Idea / Research / Blueprint / Generation / Manuscript 页面骨架
    不得建立私有核心类型；等待 Agent B 契约冻结后正式接入

BLOCKED:
  持久化
  fixture transport
  真实 Idea Intake
  真实 Web Research
  真实 Blueprint
  真实 Generation
```

## 9. Shared Hotspots

同一时刻只能有一个 Owner；每次重新调度可变更 Owner。

```text
packages/contracts            → Agent B
database migration registry   → Agent B
Worker root dispatch          → Agent B
Main IPC registration         → Agent B
Preload API                   → Agent B
App shell                     → Agent A
Renderer product pages        → Agent A
```

## 10. Verification Baseline

与 CI 相同的验证，实际执行结果（本初始化工作树，未设置 `WRITING_EXPERIMENT_LIVE`）：

| 项                  | 命令                                                                                            | 结果                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `pnpm check`        | `format:check && lint && build && typecheck && test`                                            | PASS（exit 0）                                                                |
| `git diff --check`  | —                                                                                               | PASS（exit 0）                                                                |
| macOS package smoke | `pnpm package` + `pnpm --filter @ai-novel/desktop smoke-test`（与 `ci.yml` macos-package 相同） | PASS（见下方执行记录）                                                        |
| 测试 passed/skipped | `pnpm test` 输出                                                                                | Test Files 96 passed / 1 skipped（97）；Tests 2599 passed / 6 skipped（2605） |

macOS package smoke 执行记录（与 `ci.yml` macos-package 相同命令）：

```text
pnpm package
pnpm --filter @ai-novel/desktop smoke-test
```

测试通过 ≠ 产品验收通过。
