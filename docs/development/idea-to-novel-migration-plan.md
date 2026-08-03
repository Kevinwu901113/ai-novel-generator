# Idea-to-Novel 1.0 迁移计划（实际代码资产审计）

> **文档性质**：本文档是**实际代码、测试与 PR #25 diff 的只读资产审计**，产出目标是
> 产品 1.0（Idea-to-Novel）的迁移计划。本审计**未修改任何产品代码**、**未修改产品方向权威文档**、
> **未修改 PR #25**、**未进行任何模型调用**。
>
> **文件所有权**：本文档由审计 Agent（Agent B）独占。Agent A 并行负责
> `PRODUCT_DIRECTION.md`、`docs/product/idea-to-novel-v1.md`、
> `docs/development/generation-quality-roadmap.md`、`README.md`。
> 两组文件零交集；本文档等待 Agent A 方向文档完成后进行交叉校验。

## 0. 审计元信息

| 项          | 值                                                           |
| ----------- | ------------------------------------------------------------ |
| 审计日期    | 2026-08-03                                                   |
| 审计 base   | `964f4644b57b106773b6760f61253c3f3aac2755`（`origin/main`）  |
| PR #25      | `feat: minimal manuscript editor`，Draft / OPEN / **未合并** |
| PR #25 head | `5d80ff20e59bd67e4c0b028b63f88e1531261926`                   |
| PR #25 base | `814f1ba4266578e5d21a30e4cf560500e2cb0189`                   |
| PR #25 规模 | 27 个文件，+6586 / -22                                       |
| 代码变更    | 0（本审计只读）                                              |
| 模型调用    | 0                                                            |

## 1. 产品 1.0 目标与主链

产品 1.0 定义：

> 快速收集用户想法，进行必要程度的联网调研，然后按照用户要求的形式生成小说。

目标主链：

```text
Idea Intake
→ CreationSpec
→ Research Decision
→ Web Research
→ ResearchBundle
→ StoryBlueprint
→ Novel Generation
→ Manuscript Review / Export
```

产品 1.0 **不以**复杂保护、契约审批或空白编辑器为中心。

最低安全线（在任何迁移中都不得破坏）：

1. **用户输入不丢失**（autosave / 持久化先于破坏性操作）；
2. **生成结果不静默覆盖用户手写正文**（CAS / 版本化 / 显式写入）；
3. **重启可恢复最近工作**（任务先落库再调用模型、启动恢复扫描）。

## 2. 审计范围与方法

### 2.1 方法

- 全部为**只读**分析：`git log / git show / git diff / git grep`、`gh pr diff`、
  Read / Grep / Glob。
- 9 路并行只读审计 agent：Grill-me、Creation Contract、Manuscript（MV1-A on main）、
  PR #25 diff、Task Engine、Model Gateway、Web Research、PlotPilot Adapter、Evaluation Harness。
- 判定以**实际代码为准**：不存在的能力一律标记 `NOT_IMPLEMENTED`，不从设计文档或外部工具推断。
- 不阅读 GQ2 私有映射与真实稿件内容（仓库内不存在，均为 gitignored 本地产物）。

### 2.2 审计红线

- 不实现任何功能；不创建 migration；不修改 PR #25；不关闭 PR #25。
- 不更新产品方向文档（属于 Agent A）。
- 不启动 Scene Planner；不进行真实联网调研；不进行付费模型调用；不访问 Keychain。
- 不把测试数量当成产品价值。

## 3. 模块审计结论

> 各子节由并行只读审计产出，证据见附录 A。

### 3.1 Grill-me

Grill-me 是**已完整实现的、分层的 Q&A 需求澄清子系统**（domain / application / contracts /
database / task-engine / worker / main IPC / preload / React renderer 全链路），且是当前桌面
app 的**主工作区**：项目创建后 Renderer 直接落在 `GrillWorkbench`
（`apps/desktop/src/renderer/App.tsx:310-316`）。核心是生产级、测试覆盖极重。

**能力判定（映射 Idea Intake / 自然追问 / 回答收集 / 问题跳过 / 创作要求提取）**：

| 能力                                                | 状态          | 说明                                                                                                                                                                             |
| --------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idea 输入捕获（收集用户初始想法）                   | `PARTIAL`     | `projects.initial_idea` 已落库，但**没有**把 `initialIdea` 自动播种进 grill session goal——用户必须在 `GrillSessionList.tsx:66-88` 重打一遍                                       |
| 会话生命周期（start/pause/resume/complete/abandon） | `IMPLEMENTED` | 对简单 1.0 Intake 过重：`PAUSED` 状态 + 每次 mutation 的 `expectedVersion` CAS 增加工程面                                                                                        |
| AI 追问规划（问题计划生成）                         | `IMPLEMENTED` | 去重任务请求 + 后台执行（`task-engine/src/grill-question-plan.ts:163`）+ 严格解析 + 引用/环校验；**1.0 自然追问的最高价值复用**                                                  |
| 提问标记（mark asked）                              | `PARTIAL`     | **死链路**：channel/主进程/preload/hook/UI 都在，但 worker dispatch **没有** `grill.markQuestionAsked` case（`index.ts:1417-1447`）→ 运行时 `VALIDATION_ERROR`；"提问"按钮是坏的 |
| 回答 / 跳过 / 取代（answer/skip/supersede）         | `IMPLEMENTED` | revisioning + supersedeCurrent，路由完整                                                                                                                                         |
| 回答历史                                            | `IMPLEMENTED` | 版本化 `grill_answers` + 单 current 部分唯一索引；1.0 可塌缩为单 current answer                                                                                                  |
| 提案流（create/review）                             | `IMPLEMENTED` | `grill_inference_proposals`；是"创作要求提取"的载体（accepted proposal 喂给 creation-contract context），但 review 门禁对 1.0 过重                                               |
| 问题计划提案接受                                    | `IMPLEMENTED` | `acceptGrillQuestionPlanProposal` 重新校验并按拓扑序插入正式问题                                                                                                                 |
| current-answers 快照                                | `IMPLEMENTED` | `getCurrentAnswers` → `listCurrentBySession`                                                                                                                                     |
| 校验语义                                            | `IMPLEMENTED` | 严格模型输出解析、引用完整性、Kahn 环检测、contracts 运行时校验                                                                                                                  |

**应废弃的工程化 UI / 状态语义（1.0）**：

- `PAUSED/ABANDONED` 生命周期与每次 mutation 的 expectedVersion CAS —— 保留 schema，1.0 只用
  `DRAFT→ACTIVE→COMPLETED` 最小切片。
- 版本化回答历史（`supersededAt` + 部分唯一索引）—— 1.0 可塌缩为单 current answer。
- 推断提案 review 门禁（`createGrillProposal/reviewGrillProposal`）。
- DEV-only `GrillDiagnostics.tsx` → `REMOVE_FROM_DEFAULT_UX`。
- 2s 轮询 + single-flight 的 `useGrillQuestionPlan.ts` 控制器 —— 若 1.0 保留异步规划流才需要。
- 死链路 `grill.markQuestionAsked` 需要修复（补 dispatch case）或删除通道。

**两个已确认缺陷**：`GRILL_MARK_QUESTION_ASKED` IPC 死链路；`initialIdea` 未自动播种进 session goal。

**R1 复用路线（不新建重复数据模型）**：

- **直接复用现有表与模型**：`grill_sessions` / `grill_questions` / `grill_answers` 表，
  Grill 的 domain / application / repository 全部复用，**不新建** Idea / Session / Answer 领域模型，
  **不新建** Idea Intake 数据表，**不物理重命名** grill 表。
- **修复与补齐**：修复 `grill.markQuestionAsked` 死链（补 worker dispatch case 或删通道）；
  将 `projects.initial_idea` 自动播种进 intake session goal。
- **前台重构**：将工作台重构为自然对话式 Idea Intake；隐藏 PAUSED/ABANDONED、proposal review、
  diagnostics 等非 1.0 流程。
- **命名策略**：内部代码可暂时保留 `grill` 命名，用户侧使用 Idea Intake；**不要为了命名纯洁度
  迁移稳定数据**。
- **迁移策略**：R1 默认不创建 migration。只有发现具体且不可复用的新持久化字段时，才提交独立的
  设计裁决（不随本计划 PR 实现）。

### 3.2 Creation Contract

Creation Contract 是**已合并、重度测试**的契约编写管线：17-section `CreationContractSections`
schema（严格校验 + canonical 序列化）、版本化权威快照（`CreationContractVersion` + current
pointer + SHA-256 快照 hash + 逐字段 provenance）、proposal accept/reject 审查流、user update 流、
lock/unlock 流、共享快照校验器、与 Grill 耦合的 AI 草案任务引擎 + 后台 runner。全链路端到端已接通。

**关键事实**：Renderer 从不调用 `updateByUser` / `lockField` / `unlockField` / `listVersions` /
`getProposal`（grep 确认无非测试调用者）；`acceptProposal` 始终以 `operations: []` 调用。即
**user-update 与 lock/unlock 在实践上是纯后端、无 UI**；lock 在 UI 上根本无法创建。

**简化到 `CreationSpec / 创作要求`**：

| 资产                                                                                                           | 决定                     | 说明                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 17-section sections schema + 校验 + canonical 序列化 + 快照 hash（`packages/domain/src/creation-contract.ts`） | `REUSE_WITH_REFACTOR`    | **仅作为 CreationSpecSnapshot 基础**；Draft 阶段不要求完整校验；记录待补充/裁决的 1.0 字段（作品形式 / 语言偏好 / 生成方式）；本 PR 不实现 schema v2           |
| 版本化权威快照 + current pointer + append-only                                                                 | `KEEP_AS_IS`             | 直接复用；manuscript FK 已消费（`project-database.ts:594`）                                                                                                    |
| 快照校验器（`creation-contract-snapshot-validation.ts`）                                                       | `KEEP_AS_IS`             | 唯一严格校验门                                                                                                                                                 |
| user update 后端（`updateCreationContractByUser`）                                                             | `KEEP_AS_IS`             | 1.0 CreationSpec 直接编辑后端的现成实现；**需新建 spec 编辑器 UI 调用它**                                                                                      |
| 提案 accept/reject 后端（`creation-contract-mutations.ts`）                                                    | `BACKEND_ONLY`           | 1.0 中 accept 变成"采用此草稿"动作；隐藏审查 UI                                                                                                                |
| lock/unlock（user-mutations + `lock_events` 表 + `validateProposalAgainstLocks`）                              | `DEFER`                  | UI 无法创建锁，实践中死路；1.0 默认 UX 移除                                                                                                                    |
| AI 草案任务（`creation-contract-draft.ts`）                                                                    | `REUSE_WITH_REFACTOR`    | 解耦"必须 COMPLETED grill session"（`creation-contract-request.ts:125`）与 grill 形状的 prompt context；保留 dedupe/claim/stale-before-after/严格解析/原子提交 |
| `ContractDraftPanel.tsx`                                                                                       | `REMOVE_FROM_DEFAULT_UX` | 替换为 CreationSpec 编辑器/视图                                                                                                                                |
| `ContractSectionsView.tsx`、`contract-labels.ts`                                                               | `KEEP_AS_IS`             | 只读展示，直接复用                                                                                                                                             |
| `useContractDraft.ts`                                                                                          | `REUSE_WITH_REFACTOR`    | 剥离 accept/reject review 路径；保留草案请求 + 任务轮询 + current 刷新；加 updateByUser 编辑路径                                                               |
| contracts IPC/API（10 通道 + 校验器）                                                                          | `KEEP_AS_IS`             | 保留 `getCurrent/listProposals/requestDraft/acceptProposal/rejectProposal/updateByUser`；`listVersions/getProposal/lockField/unlockField` 可后台保留或裁剪     |

**CreationSpecDraft 与 CreationSpecSnapshot 的区分**：

| 概念                   | 约束                                                      | 生命周期                                 | 用途                                             |
| ---------------------- | --------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------ |
| `CreationSpecDraft`    | **允许部分字段**；不要求完整 protagonist、POV、tense 等   | **随对话持续更新**（Idea Intake 过程内） | Idea Intake 过程                                 |
| `CreationSpecSnapshot` | **完整严格校验**；版本化（append-only + current pointer） | 一次成型、不可变                         | **Research、Blueprint 和 Generation 的权威输入** |

- 现有 `CreationContractSections` 只作为 **Snapshot 基础**（严格校验 / canonical / 版本化全部保留）。
- 现有 schema 需要**补充或裁决**的 1.0 字段（记录在案，**本 PR 不实现 schema v2**）：
  - **作品形式**（novel / 短篇 / 剧本等）；
  - **语言偏好**；
  - **生成方式**（逐章 / 整稿 / 风格化等）。
- Draft→Snapshot 的晋升即现有 accept/apply 语义（`BACKEND_ONLY`，隐藏审查 UI）。

**明确复用分类**：

- **直接复用**：版本化快照、快照校验、canonical hashing、`ContractSectionsView`、`contract-labels`、user-update 后端、数据库 repository/transaction。
- **REUSE_WITH_REFACTOR**：`CreationContractSections` 作为 Snapshot 基础；Draft 阶段允许部分字段；补充/裁决 1.0 字段（作品形式 / 语言偏好 / 生成方式）。
- **仅复用 schema 思想**：provenance 机制（重、每次读都重校验，仅 `<details>` 后展示）→ 1.0 简化为字段来源标注。
- **后台保留但前台隐藏**：accept/reject 后端（`BACKEND_ONLY`）、listVersions/getProposal。
- **产品 1.0 不再使用**：lock/unlock 整个表面（`DEFER`）、提案审查 UI（`REMOVE_FROM_DEFAULT_UX`）。
- **后续再评估**：`contractSnapshotHash` 嵌入 `lockedFieldPaths`（`domain :340`）+ DB CHECK `schema_version=1`（`project-database.ts:381`）—— 弃锁是 schema v2 变更。

### 3.3 Manuscript（MV1-A，已合并到 main）

Manuscript MV1-A 基础已在 main（经 PR #24 于 `814f1ba` 合并，后 PR #26 docs 叠加到 `964f4644`），
跨 4 个 package 实现了完整的 manuscript / chapter / chapter-version 栈。

| 层          | 内容                                                                                                                                                                                                | 证据                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Domain      | branded ID、闭合枚举、title/content 校验、纯稀疏排序函数（append/prepend/insert-before/两阶段 rebalance）带 overflow 处理                                                                           | `packages/domain/src/manuscript.ts`       |
| Application | 7 个读 + 8 个写用例，全部单 `BEGIN IMMEDIATE` 事务、CAS 保护 current-pointer/status/title、provenance 强制（AI 来源必须带 taskId/invocationId/creationContractVersionId）                           | `packages/application/src/manuscript*.ts` |
| Database    | STRICT 表 + 复合 PK/FK；每 project 至多一个 active manuscript 的部分唯一索引；每 manuscript 的 position 唯一索引；provenance CHECK；AI 任务幂等部分唯一索引；`chapter_versions` append-only trigger | `project-database.ts` migration v7        |
| Contracts   | **main 已导出**全部 manuscript DTO（`ManuscriptPublicData`/`ChapterPublicData`/`ChapterVersionPublicData` 等）、15 个输入接口、15 个严格校验器、6 个 ErrorCode                                      | `packages/contracts/src/index.ts:2177+`   |
| Transport   | **main 上完全没有**——无 `MANUSCRIPT_*` IPC 通道、无 `ManuscriptAPI`、无 preload、无 worker dispatch                                                                                                 | 见 3.4 / 5                                |

**能力清单**：Manuscript 聚合、Chapter、ChapterVersion append-only 版本（content_hash、source_type
provenance `USER/AI_GENERATION/AI_REWRITE/IMPORT/RESTORE`、parent_version_id 血缘、created_by_task_id /
invocation_id 关联、creation_contract_version_id 关联）、current_version_id 指针、position 不变量、
active-manuscript-unique、restart 恢复相关不变量。

**结论**：MV1-A 是**纯后端/测试级基础**，`apps/desktop`、`apps/worker` 均未引用 manuscript ——
零 UI / IPC / worker 接线。AI 章节生成任务类型、settle、崩溃重放恢复是 MV1-C 未来项，未实现。

**复用决定**：Manuscript 后端全部 `KEEP_AS_IS`（1.0 Novel Generation 与 Manuscript Review 的直接地基）；
transport + UI 来自 PR #25（见 3.4 / 5）。

### 3.4 PR #25（Manuscript Renderer MV1-B，未合并）

PR #25 `feat: minimal manuscript editor`（Draft / OPEN / 未合并）在 MV1-A 基础之上实现了
**完整 IPC + Renderer 垂直切片**。跨 5 层：

1. **contracts**：新增 14 个 `MANUSCRIPT_*` IPC 通道 + `ManuscriptAPI`（挂在 `DesktopAPI`）。
   输入/输出校验器、DTO、6 个 ErrorCode **在 main 的 MV1-A 已存在**，本 PR 不重复。
2. **preload**：`window.desktop.manuscript.*` 14 方法，allowlist 通道、无泛化 `invoke`、
   无 Node/fs/sqlite 泄漏。注意：preload 自带本地 `const IPC_CHANNELS`（第 7 行，**未从
   `@ai-novel/contracts` 导入**）——通道字符串在 contracts / preload / preload 测试三处重复。
3. **main**：抽取了第一个可 DI 的 `registerManuscriptIpcHandlers`（校验 → forwardToWorker →
   输出校验 → safe error），幂等清理；`main/index.ts` 仅 +8 行接线。
4. **worker**：`dispatchManuscriptCommand` 14 命令，ID/now/sourceType 注入、project 作用域、
   真实 SQLite v7。**结构性照抄** `contract-handlers.ts`。
5. **renderer**：三栏 `ManuscriptWorkbench`（ChapterList / EditorPanel / VersionHistory），
   由 882 行 `useManuscriptWorkbench` 驱动；App.tsx 加 tab 壳。

**安全机制（dirty / CAS / buffer）**：

- **dirty**：快照式 —— `lastSnapshot` 对比 `editorTitle/editorContent` + `manuscriptTitleInput`
  对比 `manuscript.title`，`isDirty = dirty || titleDirty`。
- **CAS**：每次 mutation 携带 `expectedCurrentVersionId`（标题用 `expectedUpdatedAt`）；
  `MANUSCRIPT_VERSION_CONFLICT` → 保留本地 buffer、刷新 server current、3 态 refreshStatus，
  只在 ready 态允许"再保存/放弃本地"；**不自动重试、不静默回退到旧 current**。
- **buffer 安全**：`userEditedRef` + `editorRevisionRef` 防止异步 load/save/promote 覆盖用户输入；
  `opGen/opSeq/selectedChapterIdRef` ownership 检查保证过期异步结果只刷新章节列表、绝不写入别的章节编辑器；
  `isChapterBufferLocked` 在 save/promote/load 时冻结输入；全局 `isMutationInFlight` 单飞行锁。
- **restart 持久化**：**已保存**数据经真实 SQLite v7 持久（`manuscript-handlers.test.ts`
  'restart 持久化' 重新打开同一 ProjectDatabase 验证完整）；**未保存**的 renderer buffer **不持久**
  —— 无 autosave / localStorage / indexedDB，`manuscript-leave-guard.ts` 明确文档化非持久化，
  `beforeunload` 仅警告。

**已知重复（与 main 已有代码）**：`manuscript-handlers.ts` 结构照抄 `contract-handlers.ts`；
`registerManuscriptIpcHandlers` 抽取了 main 内联 contract handler 的同一形状（未统一重构）；
preload API 组镜像 contract 组。

**测试覆盖**：worker 9（真实 SQLite）、main-ipc 7、preload 5、leave-guard 4、contracts-ipc 7、
workbench 65（renderer 集成，跑在 `test-manuscript-mock` 上）、app 1。**无真实 Electron/SQLite 端到端**。

**Gaps**：无真实 E2E；未保存正文不持久；IPC 通道字符串三处重复无运行时单源；`MANUSCRIPT_POSITION_OVERFLOW`
无 renderer 专有处理；标题 CAS 冲突刷新复用 `getOrCreateManuscript` 语义。

### 3.5 Task Engine

Task Engine 是**真实的、DB 支撑的执行框架**，具有"每次任务单次调用"的强模式。任务在调用模型
**之前**先持久化到 project.sqlite（非 app.sqlite）、原子 claim（`PENDING→RUNNING` +
`attempt_count++` 单条 UPDATE）、每次 attempt 一次模型调用、task+invocation+artifact 在单个
CAS 校验事务中提交（contract draft 用 `BEGIN IMMEDIATE`）。

**当前任务类型**：`MODEL_INVOCATION_TEST`、`GRILL_QUESTION_PLAN`、`CREATION_CONTRACT_DRAFT`
（`PROVIDER_CONNECTION_TEST` 在枚举中，但是同步 RPC，从不落为持久化任务）。前两者经共享
`runner-kernel.ts` 异步运行 + 启动恢复 PENDING 任务；`MODEL_INVOCATION_TEST` 在 RPC handler 内
内联执行、阻塞响应。

| 能力                      | 状态              | 说明                                                                                                                                                                            |
| ------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| claim/attempt 原子递增    | `IMPLEMENTED`     | 单条 UPDATE `WHERE status='PENDING'` + `changes===1`                                                                                                                            |
| CAS 状态转换              | `IMPLEMENTED`     | `completeRunning/failRunning/failPending/markStale/resetToPending` 全部 `WHERE status=?` + `changes===1`；`requireCas` 抛 `TASK_STATE_CONFLICT`；有 SQLite fault-injection 测试 |
| 重试（attempt_count）     | `PARTIAL`         | 计数器在，但**无自动重试**（`creation-contract-draft.ts:679` '不自动 retry'）；`resetToPending` 端口/SQL 存在但**零生产调用点**                                                 |
| 取消（AbortSignal）       | `NOT_IMPLEMENTED` | `CANCELLED` 只是枚举 + `cancelled_at` 列；**无 `markCancelled` 方法、无 cancel SQL、无 cancel RPC/IPC 命令、无 AbortSignal 穿线**                                               |
| 进度上报                  | `NOT_IMPLEMENTED` | 无 progress 字段；Renderer 每 2s 轮询（`useTaskCenter.ts:17`），无 push 通道                                                                                                    |
| 重启恢复                  | `PARTIAL`         | 任务先落库再调用；启动时 `reconcileTasks` **失败所有 RUNNING**（`TASK_INTERRUPTED`），只重新调度 2 类的 PENDING；被中断的 RUNNING **不恢复**、invocation 不重试                 |
| 依赖任务 / DAG            | `NOT_IMPLEMENTED` | 无 parentTaskId/dependsOnTaskId 列；dedupe 只防重复不排序                                                                                                                       |
| 结构化产物（task.result） | `IMPLEMENTED`     | `result_json` 有 `json_valid` CHECK；每个引擎写安全摘要；Renderer 按类型白名单校验                                                                                              |
| 来源关联                  | `PARTIAL`         | `ModelInvocationData` 记录 provider/model/taskId/attempt/promptHash/providerRequestId/usage；artifact 链接 taskId+invocationId；**无通用 artifact 依赖图**                      |
| 流式事件                  | `NOT_IMPLEMENTED` | gateway 单次 JSON POST；无 SSE；worker→renderer 无 push                                                                                                                         |
| 超时                      | `PARTIAL`         | 固定超时（gateway 120s、RPC 30s）；**无按任务可配置 deadline、无 task 级 watchdog**                                                                                             |

**对 1.0 长任务的适配结论**：Idea extraction / Research planning / Search+fetch / Story blueprint /
Chapter generation / Review+rewrite 六类长任务当前引擎**都能承载**"任务先落库 + CAS + 单事务产物"
的骨架，但**缺失**：取消、进度、恢复（RUNNING 重放）、自动重试、依赖 DAG、跨多步调用的流水线
结构、流式事件、按任务超时。单调用任务模型无法原生表达"规划后生成"等多步长任务。

**平台升级前置条件（不设硬前置）**：以下能力**不是 R1–R3 的硬前置**，标为 `DEFER` / R6 或 1.x：

- Token 级流式、多 provider、按调用选择模型、成本展示；
- 任务 DAG、RUNNING 自动重放、通用自动重试。

路线：

- **R1**：现有非流式 Model Gateway + 严格解析 + 轮询可满足首版。
- **R2**：Research 需要 search/fetch 端口、**粗粒度任务状态**、失败与超时。
- **R3**：Blueprint 先使用**文本 JSON + strict validator**。
- **R4**：长章节生成**前**增加**取消**和**阶段进度**。

### 3.6 Model Gateway

`packages/model-gateway` 是**最小的 Anthropic-compatible 单 provider HTTP 客户端**
（Node 24 内置 fetch）。两个函数：

- `testConnection`：20s 超时，`max_tokens=32` 探针；
- `invokeModel`：120s 超时，默认 `max_tokens=4096`。

POST `${baseUrl}/v1/messages`，`api-key` 头，解析**单一非流式 JSON 响应**，抽取 `text` 类型
content block，返回 `usage`（input/output/cache read/cache write/total）、`latencyMs`、
`finishReason`、`providerRequestId`。错误映射为稳定 `ErrorCode` + 固定中文文案，**不泄漏
apiKey/prompt/上游 body**。全部行为有 mock-fetch vitest 覆盖。

| 能力                               | 状态              | 证据 / 说明                                                                                                                                                              |
| ---------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 流式（SSE/onChunk）                | `NOT_IMPLEMENTED` | `invokeModel` 等待 `response.json()`（`index.ts:370`）；无 `getReader/ReadableStream`；worker 只返回完成态 `TaskPublicData`                                              |
| 结构化输出（tool use / JSON mode） | `NOT_IMPLEMENTED` | 无 `tools`/`json_schema`/`response_format`；契约/blueprint 走 prompt + 文本解析（`creation-contract-draft.ts:640-650`）                                                  |
| 多 provider                        | `PARTIAL`         | `ProviderType` 仅 `'anthropic-compatible'`（`contracts:141`）；`FIXED_PROVIDER_ID='mimo-token-plan-cn'` 硬编码（`task-engine:59`）；注册表单条目（`providers.ts:21-29`） |
| 按调用选择模型                     | `PARTIAL`         | `ModelInvocationInput.model` 存在，但任务引擎一律用 `profile.model`（`task-engine:174` 等）——app 流程无 per-call 覆盖路径                                                |
| 超时                               | `IMPLEMENTED`     | 硬编码 AbortController 超时（20s/120s）；`AbortError→PROVIDER_TIMEOUT`；**不可按调用配置、无外部取消、无重试**                                                           |
| usage 记账                         | `IMPLEMENTED`     | 完整 token/latency/finishReason/providerRequestId 落库并聚合到 `TaskStatsPublicData`；**无成本/计费**                                                                    |
| 任务调用方式                       | `IMPLEMENTED`     | 引擎通过注入的 `invokeModel` 端口调用；`apps/worker/src/index.ts` 在组合根注入 fetch+clock                                                                               |

**Idea-to-Novel 1.0 需要但缺失（按路线分级）**：

- **R1 即可满足**：现有**非流式** Model Gateway + 严格解析 + **轮询**——不需要 Token 级流式。
- **R3 路径**：Blueprint 先使用**文本 JSON + strict validator**（沿用现有 prompt + 严格解析模式）。
- **DEFER / R6 或 1.x（非 R1–R3 硬前置）**：Token 级流式、多 provider、按调用选择模型、成本展示、
  可配置超时与 UI 取消。

复用建议：`REUSE_WITH_REFACTOR`（保留错误码映射、usage 抽取、超时/abort、安全不变量；流式与
结构化输出按路线延后）；`FIXED_PROVIDER_PROFILE` → `SUPERSEDE`（多 provider 注册表种子，**R6/1.x**）；
任务引擎 `executeModelInvocationTest` → `REUSE_WITH_RENAME`（作为 1.0 任务优先原子调用的参考模式）。

### 3.7 Web Research

**结论：Web Research 在代码层面完全未实现。** 全部能力（除超时/失败处理为 PARTIAL 参考模式外）
均 `NOT_IMPLEMENTED`。不得从 PlotPilot 或外部服务推断已有能力。

| 能力                         | 状态              | 证据                                                                                                                                                               |
| ---------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| search provider              | `NOT_IMPLEMENTED` | 全仓 grep `tavily/serper/bing/duckduckgo/crawl` 零命中；唯一 fetch 只指向模型 API 与 PlotPilot sidecar                                                             |
| web fetching                 | `NOT_IMPLEMENTED` | 无通用页面抓取；fetch 仅存在于 `packages/model-gateway/src/index.ts:184,330` 与 `packages/plotpilot-adapter/src/index.ts:444`                                      |
| HTML 正文提取                | `NOT_IMPLEMENTED` | 无 readability / HTML-to-text                                                                                                                                      |
| 来源元数据（URL/title/date） | `NOT_IMPLEMENTED` | 无 source-record 类型                                                                                                                                              |
| 引用 / citations             | `NOT_IMPLEMENTED` | 无引用模型（Grill 的 `reference` 是依赖图校验，非网页引用）                                                                                                        |
| ResearchBundle               | `NOT_IMPLEMENTED` | 无结构化 bundle 类型；`research-engine` 为 8 行 stub                                                                                                               |
| 搜索缓存                     | `NOT_IMPLEMENTED` | 仅有模型 prompt-cache token 记账（`cacheReadTokens` 等），非搜索缓存                                                                                               |
| 失败与超时处理               | `PARTIAL`         | 无 research 专用处理，但 `model-gateway`（可注入 fetch+clock、abort、错误码映射）与 `plotpilot-adapter`（超时/中止/错误码/无 body 泄漏）是**可直接复制的参考模式** |
| 域名 / URL 安全边界          | `NOT_IMPLEMENTED` | 无 allowlist/denylist/sanitizer；相邻边界（provider baseUrl 固定、PlotPilot loopback-only）都不是 web 调研边界                                                     |

相关资产：

- `packages/research-engine/src/index.ts`：8 行 stub，仅导出 `RESEARCH_ENGINE_PACKAGE_LOADED`。
- `packages/context-engine`、`packages/review-engine`、`packages/import-export`：同款 stub。
- `packages/domain/src/index.ts:41`：`'research'` 只是 `ProjectStatus` 生命周期值（资料研究中），
  不是 web 调研功能；`TaskType` 闭合枚举**无 research 任务类型**。
- `packages/contracts/src/index.ts:212-358`：无 `RESEARCH_*` 通道、无 research API 方法。
- `apps/worker/src/index.ts`：`globalThis.fetch` 仅注入 model-gateway / plotpilot。

**最小端口建议（只给最小输入输出，不写实现）**：

- `WebSearchPort`：输入 `{ query, maxResults }`；输出 `SearchResult[]`（`{ url, title, snippet, publishedAt? }`）。
  失败语义需覆盖超时与降级。
- `WebFetchPort`：输入 `{ url, timeoutMs? }`；输出 `FetchedDocument`（`{ url, title, html, extractedText, fetchedAt }`）。
  复用 model-gateway 的 injectable-fetch + abort + 错误码模式。
- `ResearchRepository`：输入 source/bundle 记录；输出持久化的 `ResearchBundle`（含来源元数据与正文文本，
  供 blueprint 引用）。
- `ResearchOrchestrator`：输入 `{ researchDecision }`；输出 `ResearchBundle`。
  由任务类型承载（扩展 `TaskType` 闭合并集），走现有 worker dispatch + 启动恢复路径。

**V1 最低安全边界（不延后到 R6）**：

- 仅允许 `http/https` 协议；
- 拒绝 `localhost`、loopback、private、link-local 目标（含 DNS 解析后校验）；
- 重定向后**重新校验** URL（不信任首跳）；
- 限制响应字节数与 content-type；
- 连接 / 读取超时；
- 拒绝 URL credentials；
- 来源保留 canonical URL、title、fetchedAt；
- **默认保存提取文本 / 事实笔记，不永久保存原始 HTML**。

以上边界是 **Web Research V1 验收门禁的一部分**（见 §7 P4），并随 `WebSearchPort` /
`WebFetchPort` 端口契约一起测试。

缺口的宿主：`packages/research-engine`（替换 stub）、`packages/domain`（扩展 TaskType）、
`packages/contracts`（research 通道）、`packages/database`（新 migration）、`packages/secret-store`（search API key 槽位）。

### 3.8 PlotPilot Adapter

`packages/plotpilot-adapter` 是**完整、well-tested、但完全隔离**的包：本地 Python PlotPilot
sidecar 的 HTTP 客户端 + 可中止的安全 SSE 解析器（`parseSseStream`）+ 6 状态 sidecar 生命周期管理。

**关键事实：未接入任何 app。** 无任何包依赖 `@ai-novel/plotpilot-adapter`；apps/ 下 grep `plotpilot`
零命中；无 Worker RPC、无 IPC、无 preload、无 UI（`docs/architecture/module-boundaries.md:254-258`
明确记录"尚未实例化或接入 Main/Worker，仅有 package foundation"）。

| 能力                                                                                                           | 状态                                               | 1.0 判定                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 章节生成（GenerateChapterInput / hostedWrite / scene director / evolution gates / invocation policies / 模板） | `IMPLEMENTED`（adapter 内，`index.ts:342-380`）    | `NOT_NEEDED_1_0` / `FUTURE_R6`：1.0 生成由内置 task-engine + model-gateway 承担；PlotPilot 仅是可选的未来 NarrativeEngine 适配器（PRODUCT_DIRECTION.md:997）                   |
| SSE 流式事件 + 取消（`parseSseStream`、caller-vs-timeout first-wins、reader cancel/release）                   | `IMPLEMENTED`（`index.ts:199-307`，29 项取消测试） | `COULD_SERVE_RESEARCH_OR_GENERATION`：仓库内唯一健壮的 abort-safe、byte-limited SSE 实现；但当前耦合 PlotPilot JSON 事件形态与 sidecar HTTP 流，1.0 复用需先抽一层通用流式抽象 |
| sidecar 生命周期（python spawn / 状态机 / health poll / 优雅停止）                                             | `IMPLEMENTED`（`lifecycle.ts`，34 项测试）         | `NOT_NEEDED_1_0` / `FUTURE_R6`：1.0 无 Python sidecar；**不得成为 1.0 关键路径**                                                                                               |
| 取消语义（AbortSignal）                                                                                        | `IMPLEMENTED`                                      | 参考模式 `MUST_NOT_BE_CRITICAL_PATH` 缺失风险：任何 1.0 流式生成必须可取消；此实现是应携带的模式                                                                               |

**判定汇总**：

- **1.0 不需要**：sidecar 章节生成、hostedWrite、evolution gates、sidecar 生命周期。
- **可作为未来 R6 能力**：PlotPilot 绑定整体（PRODUCT_DIRECTION.md:548 保留适配边界）。
- **不得成为关键路径**：sidecar 启动/健康不能是 1.0 生成/调研的前置条件。
- **可能被用于 Research 或 Generation、但当前不应强绑定**：通用 SSE/流式 + 取消模式
  —— 解耦后可在 1.0 research/generation 事件流中复用；PlotPilot JSON 事件形态不进入 1.0 链路。

缺口：无环境配置（PLOTPILOT_ROOT/PYTHON/PORT）、无 Worker RPC、无 CreationSpec 快照消费路径。

### 3.9 Evaluation Harness

Evaluation Harness 由两部分构成：

- `@ai-novel/writing-evaluation`：**刻意离线、确定性、中文优先**的评测/回归包（`evaluateSuite`、
  客观指标、ai-smell 词表、6 类显式约束、seed 稳定的盲评 + 私有映射、8 维人工评分聚合、
  expected-relations fixture 回归）。**只依赖 `@ai-novel/domain`**，禁止网络/SQLite/model-gateway
  （`boundary.test.ts:61,79-99`）。
- `@ai-novel/writing-experiment-runner`：**LIVE 门控**的真实生成实验 runner
  （`WRITING_EXPERIMENT_LIVE=1` + 单一 allowlist provider `mimo-token-plan-cn`），提供
  `baseline-one-shot-v1` 策略（temp 0.7 / maxTokens 8192 / concurrency 1 / retries 0），
  产物目录原子发布，**绝不记录 secret/prompt/全文/私有映射**。

| 目标维度                  | 状态              | 说明                                                                                                                                                 |
| ------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idea Intake 质量          | `NOT_IMPLEMENTED` | 无 intake 数据模型/指标；suite case 内嵌的 `CreationContractSections`（premise/genre/tone/themes/audience）只被渲染进 prompt                         |
| Research 事实与来源完整性 | `NOT_IMPLEMENTED` | `sceneBrief.requiredFacts/forbiddenFacts`（`schema.ts:39-40`）只进 prompt，**从不自动检查**；无 fact-presence/source-attribution 评测                |
| Story Blueprint 质量      | `NOT_IMPLEMENTED` | 无 blueprint 模块；只能经 manual-criterion + 人工盲评                                                                                                |
| 章节生成质量              | `IMPLEMENTED`     | 这正是它被构建的用途：scene 级正文客观指标 + ai-smell + 约束 + 盲评 + 8 维人工评分                                                                   |
| baseline vs new pipeline  | `PARTIAL`         | 结构上支持（多 candidate suite、cross-candidate relations、盲评 A/B），但 runner 每个 case/策略只产 1 个 candidate，无策略比较器、run 命令不聚合评分 |

**结论**：

- `packages/writing-evaluation` 整体 `KEEP_AS_IS` —— 任何 1.0 流水线变更的**基线测量层**，
  保持离线与依赖隔离。
- `blind.ts` / `rating.ts` / `generator-port.ts` / `fixtures.ts` 均 `KEEP_AS_IS`（维度无关，
  blueprint/intake 未来可经 manual-criterion 复用）。
- `baseline-one-shot-v1.ts` `KEEP_AS_IS` —— 冻结基线，新 pipeline 生成时新增 sibling v2 策略。
- runner / generator adapter `BACKEND_ONLY` —— 非产品运行时依赖。
- **新增评测需求**：Idea Intake、Research 事实/来源、Blueprint 需要**新的 schema + 指标**；
  1.0 可在 `schema.ts` 上为 `requiredFacts/forbiddenFacts` 加自动 fact-presence 检查
  （`REUSE_WITH_REFACTOR`）。

> 边界声明：评测包的测试通过只证明评测工具工作，**不证明生成质量提高**；不把测试数量当成产品价值。

## 4. 迁移矩阵

> 列：Asset / Path · Current Role · Evidence · Reuse Decision · Target 1.0 Role ·
> Required Change · Phase · Owner · Dependencies · Risk。
>
> Reuse Decision 只允许：`KEEP_AS_IS` / `REUSE_WITH_RENAME` / `REUSE_WITH_REFACTOR` /
> `BACKEND_ONLY` / `DEFER` / `REMOVE_FROM_DEFAULT_UX` / `SUPERSEDE`。

> Phase：C1 = Cycle 1（Idea Intake），C2 = Cycle 2（Web Research + Blueprint），
> C3 = Cycle 3（Generation + Manuscript UI）。Owner：A = Agent A（产品方向 + Renderer/壳），
> B = Agent B（Domain/Application/Database/Worker/Transport）。

### 4.1 Idea Intake（复用自 Grill-me，R1 不新建数据模型）

> **R1 基线**：直接复用 `grill_sessions` / `grill_questions` / `grill_answers` 与 Grill
> domain/application/repository；内部保留 `grill` 命名，用户侧使用 Idea Intake；**默认不创建 migration**。
> 只有发现具体且不可复用的新持久化字段，才提交独立设计裁决。

| Asset / Path                                              | Current Role                                            | Evidence                                                 | Reuse Decision           | Target 1.0 Role        | Required Change                                                                                             | Phase | Owner | Deps | Risk |
| --------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------- | ------------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------- | ----- | ----- | ---- | ---- |
| `packages/domain/src/grill.ts`                            | Grill 领域模型（session/question/answer/proposal 状态） | `grill.ts:101-127` 转移图                                | `KEEP_AS_IS`             | Idea Intake 领域模型   | 复用，不新建；PAUSED/ABANDONED 保留但 1.0 不用                                                              | C1    | B     | —    | 低   |
| `packages/domain/src/grill-question-plan.ts`              | 严格 AI 追问解析 + 环检测                               | `grill-question-plan.ts:108-312,413-494`                 | `KEEP_AS_IS`             | AI 追问规划            | 复用；保持命名                                                                                              | C1    | B     | —    | 低   |
| `packages/application/src/grill-session.ts`               | session/question/answer 用例                            | `grill-session.ts:361-447` answer 修订                   | `REUSE_WITH_REFACTOR`    | Idea Intake 用例       | 保持 grill 命名；加 create-from-initialIdea；可选删 answerHistory/proposal review（前台隐藏）               | C1    | B     | P1   | 中   |
| `packages/application/src/grill-question-plan.ts`         | 去重规划请求 + 提案接受                                 | `grill-question-plan.ts:250-403` 拓扑插入                | `KEEP_AS_IS`             | AI 追问规划用例        | 复用；保持命名                                                                                              | C1    | B     | P1   | 低   |
| `packages/database/src/grill-repositories.ts`             | 5 个 repo 实现（project 作用域）                        | `grill-repositories.ts:32-417`                           | `KEEP_AS_IS`             | Idea Intake repos      | **复用现有表，不新建、不物理重命名**；稳定数据不动；可选删 proposals + 修订化 answers 由前台隐藏            | C1    | B     | P1   | 中   |
| `packages/database/src/project-database.ts`               | 迁移架构与表 owner                                      | `project-database.ts:160-241` grill 表                   | `KEEP_AS_IS`             | intake 表宿主          | **R1 默认无新 migration**；仅发现不可复用新字段才独立裁决                                                   | C1    | B     | —    | 低   |
| `packages/task-engine/src/grill-question-plan.ts`         | AI 追问后台任务                                         | `grill-question-plan.ts:163-494`                         | `KEEP_AS_IS`             | 追问生成任务           | 复用；保持命名                                                                                              | C1    | B     | P1   | 低   |
| `apps/worker/src/grill-handlers.ts`                       | dispatch + repo 适配器                                  | `grill-handlers.ts:931-982`（缺 markQuestionAsked case） | `REUSE_WITH_REFACTOR`    | intake RPC handlers    | **修复 markQuestionAsked 死链**（补 dispatch case）；保持 grill 命令命名                                    | C1    | B     | P2   | 中   |
| `apps/desktop/src/main/index.ts`（grill 内联块）          | 内联 IPC handlers（无 grill-ipc.ts）                    | `index.ts:278-620`                                       | `DEFER`                  | intake main IPC        | R1 保持内联可用；抽取为独立模块可后续做                                                                     | C1    | B     | P2   | 中   |
| `apps/desktop/src/preload/index.ts`（grill 组）           | `window.desktop.grill` 22 方法                          | `preload/index.ts:178-287`                               | `KEEP_AS_IS`             | 用户侧 Idea Intake API | 内部保留 grill 命名，用户侧命名为 Idea Intake；前台隐藏非 1.0 方法（pause/abandon/answerHistory/proposals） | C1    | A     | P2   | 低   |
| `apps/desktop/src/renderer/grill/useGrillQuestionPlan.ts` | 2s 轮询 + single-flight 控制器                          | `useGrillQuestionPlan.ts:149-247`                        | `DEFER`                  | 1.0 追问流             | 保留异步规划流才需要                                                                                        | C1/C2 | A     | P3   | 低   |
| `apps/desktop/src/renderer/grill/GrillDiagnostics.tsx`    | DEV 诊断条                                              | `GrillDiagnostics.tsx:30`（`!import.meta.env.DEV`）      | `REMOVE_FROM_DEFAULT_UX` | 无                     | 从默认 UX 移除                                                                                              | C1    | A     | P3   | 低   |

### 4.2 CreationSpec（复用自 Creation Contract）

| Asset / Path                                                                   | Current Role                                     | Evidence                                                          | Reuse Decision           | Target 1.0 Role               | Required Change                                                                                                  | Phase | Owner | Deps | Risk |
| ------------------------------------------------------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------- | ------------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----- | ----- | ---- | ---- |
| `packages/domain/src/creation-contract.ts`                                     | 17-section schema + 校验 + canonical + 快照 hash | `creation-contract.ts:82,315`                                     | `REUSE_WITH_REFACTOR`    | CreationSpecSnapshot 领域核心 | 仅作 Snapshot 基础；Draft 允许部分字段；补充/裁决 1.0 字段（作品形式/语言偏好/生成方式）；本 PR 不实现 schema v2 | C1    | B     | —    | 中   |
| `packages/application/src/creation-contract-snapshot-validation.ts`            | 共享权威快照校验器                               | `:128`                                                            | `KEEP_AS_IS`             | 完整性校验门                  | 无                                                                                                               | C1    | B     | P1   | 低   |
| `packages/application/src/creation-contract-user-mutations.ts`（updateByUser） | 直接编辑后端                                     | `:314`（无 renderer 调用者）                                      | `KEEP_AS_IS`             | CreationSpec 直接编辑         | 新建 spec 编辑器 UI                                                                                              | C1    | B     | P1   | 低   |
| `packages/task-engine/src/creation-contract-draft.ts`                          | AI 草案任务（grill 耦合）                        | `:528`；`creation-contract-request.ts:125` 要求 COMPLETED session | `REUSE_WITH_REFACTOR`    | CreationSpec AI 草案          | 解耦 grill session 依赖与 grill 形状 prompt context                                                              | C1    | B     | P2   | 高   |
| `apps/worker/src/contract-handlers.ts`                                         | RPC handlers                                     | `:339`                                                            | `KEEP_AS_IS`             | CreationSpec RPC              | 保留 getCurrent/listProposals/requestDraft/accept/reject/updateByUser                                            | C1    | B     | P2   | 低   |
| `packages/contracts/src/index.ts`（CONTRACT 通道 + API）                       | IPC 表面                                         | `index.ts:248-257,340`                                            | `KEEP_AS_IS`             | CreationSpec IPC              | 可选裁剪未用通道                                                                                                 | C1    | B     | P2   | 低   |
| `packages/application/src/creation-contract-mutations.ts`（accept/reject）     | 提案晋升后端                                     | `:531,823`                                                        | `BACKEND_ONLY`           | "采用此草稿"动作              | 隐藏审查 UI                                                                                                      | C1    | B     | P2   | 低   |
| `packages/application/src/creation-contract-user-mutations.ts`（lock/unlock）  | 锁后端                                           | `:451,554`（UI 无法创建锁）                                       | `DEFER`                  | 无                            | 1.0 移除                                                                                                         | C1    | B     | —    | 低   |
| `packages/database/src/project-database.ts`（lock_events + 触发器）            | 锁表                                             | `:381` CHECK schema_version=1                                     | `DEFER`                  | 无                            | 保留兼容或 v2 删除                                                                                               | C1    | B     | —    | 低   |
| `apps/desktop/src/renderer/contract/ContractSectionsView.tsx`                  | 只读分区视图                                     | 纯展示组件                                                        | `KEEP_AS_IS`             | CreationSpec 只读视图         | 无                                                                                                               | C1    | A     | P3   | 低   |
| `apps/desktop/src/renderer/contract/contract-labels.ts`                        | 文案/格式助手                                    | 纯展示                                                            | `KEEP_AS_IS`             | 同上                          | 无                                                                                                               | C1    | A     | P3   | 低   |
| `apps/desktop/src/renderer/contract/useContractDraft.ts`                       | 草案工作台 hook                                  | `:471`（accept 恒空 operations）                                  | `REUSE_WITH_REFACTOR`    | CreationSpec 编辑 hook        | 剥 accept/reject review；加 updateByUser 编辑路径                                                                | C1    | A     | P3   | 中   |
| `apps/desktop/src/renderer/contract/ContractDraftPanel.tsx`                    | 提案审查面板                                     | `:307-324`                                                        | `REMOVE_FROM_DEFAULT_UX` | 替换为 spec 编辑器            | 移除 accept/reject 审查 UI                                                                                       | C1    | A     | P3   | 低   |
| `apps/desktop/src/renderer/App.tsx`                                            | Grill-first 默认壳                               | `App.tsx:310-316` 创建后落 GrillWorkbench                         | `REUSE_WITH_REFACTOR`    | Idea-to-Novel 壳              | 默认入口改为 Idea Intake                                                                                         | C1    | A     | P3   | 中   |

### 4.3 Web Research（当前全部未实现）

| Asset / Path                                        | Current Role                       | Evidence                                | Reuse Decision        | Target 1.0 Role                                | Required Change           | Phase | Owner | Deps | Risk |
| --------------------------------------------------- | ---------------------------------- | --------------------------------------- | --------------------- | ---------------------------------------------- | ------------------------- | ----- | ----- | ---- | ---- |
| `packages/research-engine/src/index.ts`             | 8 行 stub                          | `index.ts:1-8`（仅导出 PACKAGE_LOADED） | `DEFER`               | WebSearchPort/WebFetchPort/ResearchBundle 宿主 | 替换 stub 为端口 + bundle | C2    | B     | P4   | 高   |
| `packages/domain/src/index.ts`（TaskType）          | 闭合任务枚举（无 research）        | `:43-50`                                | `REUSE_WITH_REFACTOR` | 增加 `RESEARCH_RUN`                            | 扩展枚举                  | C2    | B     | P4   | 中   |
| `packages/contracts/src/index.ts`                   | 无 research 通道                   | `:212-358`                              | `REUSE_WITH_REFACTOR` | research 通道 + API + 校验器                   | 新增                      | C2    | B     | P4   | 中   |
| `packages/database/src/project-database.ts`         | 迁移架构                           | v7 现有                                 | `REUSE_WITH_REFACTOR` | ResearchBundle 表（v9）                        | 新 migration              | C2    | B     | P4   | 中   |
| `packages/secret-store`                             | Keychain secret store              | `index.test.ts:183`                     | `KEEP_AS_IS`          | search API key 槽位                            | 新增 key slot             | C2    | B     | P4   | 低   |
| `packages/model-gateway/src/index.ts`（fetch 模式） | 可注入 fetch+abort+错误码映射      | `:37-51,270`                            | `REUSE_WITH_REFACTOR` | WebFetchPort 参考模式                          | 抽取通用 fetch 助手       | C2    | B     | P5   | 低   |
| `packages/plotpilot-adapter/src/index.ts`           | sidecar 适配器（无 research 端点） | `:348,371` 仅生成端点                   | `KEEP_AS_IS`          | 参考材料；**不把调研路由进 sidecar**           | 无                        | C2    | B     | —    | 低   |

### 4.4 Task Engine / Model Gateway（长任务与生成）

| Asset / Path                                                      | Current Role                        | Evidence                      | Reuse Decision        | Target 1.0 Role               | Required Change                                                                                     | Phase | Owner | Deps  | Risk |
| ----------------------------------------------------------------- | ----------------------------------- | ----------------------------- | --------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------- | ----- | ----- | ----- | ---- |
| `packages/task-engine`                                            | 3 类持久任务 + CAS + 启动恢复       | `index.ts:94,163,528`         | `REUSE_WITH_REFACTOR` | 1.0 长任务执行                | R2 补粗粒度任务状态 + 失败/超时；R4 长章节前补取消 + 阶段进度；DAG/RUNNING 重放/自动重试 → DEFER/R6 | C2/C3 | B     | P5/P8 | 高   |
| `packages/task-engine/src/index.ts`（executeModelInvocationTest） | 任务优先原子调用参考                | `:94`                         | `REUSE_WITH_RENAME`   | 1.0 原子调用模板              | 泛化 FIXED_PROVIDER_ID + per-call model（R6/1.x）                                                   | C3    | B     | P8    | 中   |
| `packages/model-gateway/src/index.ts`                             | 单 provider 网关（无流式/无结构化） | `:370` 等待 `response.json()` | `REUSE_WITH_REFACTOR` | 1.0 生成网关                  | R1 用现有非流式 + 严格解析；R3 blueprint 文本 JSON + validator；流式/结构化输出 → R6/1.x（DEFER）   | C3    | B     | P8    | 高   |
| `packages/database/src/app-database.ts`（FIXED_PROVIDER_PROFILE） | 固定单 provider 种子                | `:480-486`                    | `SUPERSEDE`           | 多 provider 注册表种子        | R6/1.x；非 R1–R3 硬前置                                                                             | C3    | B     | P8    | 中   |
| `packages/plotpilot-adapter/src/lifecycle.ts`                     | python sidecar 生命周期             | `lifecycle.ts:290-308`        | `DEFER`               | R6；**不得成为 1.0 关键路径** | 无 1.0 工作                                                                                         | C3    | B     | —     | 低   |

### 4.5 Manuscript（MV1-A + PR #25）

| Asset / Path                                                                           | Current Role                                          | Evidence                       | Reuse Decision        | Target 1.0 Role        | Required Change               | Phase | Owner | Deps | Risk |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------ | --------------------- | ---------------------- | ----------------------------- | ----- | ----- | ---- | ---- |
| `packages/domain/src/manuscript.ts`                                                    | manuscript 领域模型                                   | migration v7 全链              | `KEEP_AS_IS`          | Manuscript 领域        | 无                            | C3    | B     | P9   | 低   |
| `packages/application/src/manuscript*.ts`                                              | 7 读 + 8 写用例（BEGIN IMMEDIATE + CAS + provenance） | `manuscript-mutations.ts`      | `KEEP_AS_IS`          | Manuscript 应用        | 无                            | C3    | B     | P9   | 低   |
| `packages/database/src/project-database.ts`（v7 表）                                   | manuscripts/chapters/chapter_versions                 | `:581`                         | `KEEP_AS_IS`          | 已在 main，无需迁移    | 无                            | C3    | B     | —    | 低   |
| `packages/contracts/src/index.ts`（manuscript DTO/校验器）                             | 已合并到 main                                         | `:2177-2792`                   | `KEEP_AS_IS`          | manuscript contracts   | 无                            | C3    | B     | P9   | 低   |
| PR25 `packages/contracts/src/index.ts`（14 通道 + ManuscriptAPI）                      | 通道注册表 + API 表面                                 | diff +37                       | `REUSE_WITH_RENAME`   | manuscript transport   | 消除通道字符串三处重复        | C3    | B     | P9   | 低   |
| PR25 main/preload/worker transport（`manuscript-ipc.ts`、`manuscript-handlers.ts` 等） | typed IPC 全链                                        | diff                           | `REUSE_WITH_REFACTOR` | manuscript transport   | 与 contract handlers 统一重构 | C3    | B     | P9   | 中   |
| PR25 `useManuscriptWorkbench.ts`                                                       | dirty/CAS/buffer 核心 hook                            | diff（882 行）                 | `KEEP_AS_IS`          | Manuscript Review hook | 无；补 POSITION_OVERFLOW 特判 | C3    | A     | P10  | 中   |
| PR25 renderer 面板（ChapterList/EditorPanel/VersionHistory/Workbench/LeaveDialog）     | 三栏 UI                                               | diff                           | `KEEP_AS_IS`          | Manuscript Review UI   | 无；由 1.0 壳装配             | C3    | A     | P10  | 低   |
| PR25 `manuscript-leave-guard.ts`                                                       | 离开守卫（dirty/busy）                                | diff（明确不持久化未保存正文） | `KEEP_AS_IS`          | 离开安全               | 与 App shell guard 集成       | C3    | A     | P10  | 中   |

### 4.6 Evaluation / 产品壳 / 其他

| Asset / Path                                                                | Current Role                  | Evidence                    | Reuse Decision           | Target 1.0 Role      | Required Change                      | Phase | Owner | Deps   | Risk |
| --------------------------------------------------------------------------- | ----------------------------- | --------------------------- | ------------------------ | -------------------- | ------------------------------------ | ----- | ----- | ------ | ---- |
| `packages/writing-evaluation`                                               | 离线确定性章节评测 + 回归     | `boundary.test.ts:61,79-99` | `KEEP_AS_IS`             | 生成质量基线测量层   | 无                                   | C2/C3 | A     | —      | 低   |
| `apps/writing-experiment-runner/src/strategies/baseline-one-shot-v1.ts`     | 冻结基线策略                  | `:13-21`                    | `KEEP_AS_IS`             | baseline-vs-new 基线 | 新 pipeline 时加 v2 sibling          | C3    | A     | P8     | 低   |
| `packages/writing-evaluation/src/schema.ts`（requiredFacts/forbiddenFacts） | 只渲染进 prompt，从不自动检查 | `schema.ts:39-40`           | `REUSE_WITH_REFACTOR`    | 事实完整性评测种子   | 加自动 fact-presence 检查            | C3    | B     | P8     | 中   |
| `apps/writing-experiment-runner/src/runner.ts`                              | LIVE 门控实验 runner          | `cli.ts:228-240`            | `BACKEND_ONLY`           | 非产品运行时         | 加多策略比较模式                     | C3    | A     | P8     | 低   |
| PR25 `App.tsx` tab 切换器 / guardLeave 包裹                                 | 产品壳视图切换 + 导航安全     | diff                        | `REMOVE_FROM_DEFAULT_UX` | 1.0 壳重新设计       | 默认入口 Idea Intake；壳装配叶子组件 | C3    | A     | P3/P10 | 中   |

## 5. PR #25 拆解结论

### 5.1 可直接移植的 Transport 资产

> 全部来自 PR #25 diff；移植时建议做"统一重构"（见缺口），而非原样照抄两套并行惯例。

| 类别               | 路径                                                                                 | 说明                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| contract           | `packages/contracts/src/index.ts`（+37）                                             | 14 个 `MANUSCRIPT_*` IPC 通道 + `ManuscriptAPI`（挂在 `DesktopAPI`）。DTO/校验器/ErrorCode 在 main 已存在，本 PR 只加通道注册表 + API 表面 |
| validator          | `packages/contracts/src/manuscript-ipc.test.ts`（+108）                              | 断言 14 通道唯一、`^ipc:manuscript-` 前缀、通道→worker 命令一一映射、API 类型完备                                                          |
| main               | `apps/desktop/src/main/manuscript-ipc.ts`（+204）                                    | 第一个可 DI 的 IPC handler 模块：输入校验 → `forwardToWorker` → 输出校验 → safe error；幂等清理                                            |
| main               | `apps/desktop/src/main/manuscript-ipc.test.ts`（+293）                               | fake ipc/forward 的 7 组用例                                                                                                               |
| main               | `apps/desktop/src/main/index.ts`（+8）                                               | 接线 `registerManuscriptIpcHandlers`                                                                                                       |
| preload            | `apps/desktop/src/preload/index.ts`（+101）                                          | `window.desktop.manuscript.*` 14 方法，allowlist 通道                                                                                      |
| preload            | `apps/desktop/src/preload/manuscript-preload.test.ts`（+124）                        | 无泛化 invoke、无 Node/fs/sqlite 泄漏                                                                                                      |
| worker             | `apps/worker/src/manuscript-handlers.ts`（+399）                                     | `dispatchManuscriptCommand` 14 命令；ID/now/sourceType 注入；project 作用域；真实 SQLite v7                                                |
| worker             | `apps/worker/src/manuscript-handlers.test.ts`（+438）                                | 9 项，含 **restart 持久化**（重开同一 ProjectDatabase 验证完整）                                                                           |
| worker             | `apps/worker/src/index.ts`（+25）                                                    | `manuscript.*` 命令组 case                                                                                                                 |
| e2e（renderer 级） | `apps/desktop/src/renderer/manuscript/manuscript-workbench.test.tsx`（+2081，65 例） | 驱动真实 hook/组件跑在 `test-manuscript-mock` 上，**非真实 Electron/SQLite 端到端**                                                        |
| e2e（renderer 级） | `apps/desktop/src/renderer/app.test.tsx`（+114）                                     | save 进行中阻止切换项目/工作区                                                                                                             |

**移植注意事项**：

- 先做统一重构：`manuscript-handlers.ts` 与 `contract-handlers.ts` 合并为单一 worker dispatch 模板；
  `registerManuscriptIpcHandlers` 与 main 内联 contract handler 统一；preload 的 IPC 通道字符串改为
  从 `@ai-novel/contracts` 单一来源导入（消除三处重复）。
- IPC 通道字符串三处重复需运行时单源，仅编译期守卫不够。
- `test-manuscript-mock.ts` 属于测试资产，随 renderer 复用。

### 5.2 可选择性复用的 Renderer 资产

| 路径                                                                       | 说明                                                          | 复用判断                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------ |
| `apps/desktop/src/renderer/manuscript/useManuscriptWorkbench.ts`（882 行） | 核心 hook：快照式 dirty、CAS、buffer 安全、单飞行锁、冲突三态 | **必选复用**；1.0 Manuscript Review 的骨架 |
| `apps/desktop/src/renderer/manuscript/ManuscriptWorkbench.tsx`             | 三栏容器 + 错误/冲突 banner + LiveRegion + leave dialog       | 复用（装配层）                             |
| `apps/desktop/src/renderer/manuscript/ChapterList.tsx`                     | 左栏：创建/排序/归档/恢复 + a11y                              | 复用                                       |
| `apps/desktop/src/renderer/manuscript/EditorPanel.tsx`                     | 中栏：标题 + 正文 + dirty 指示 + 保存新版本；**无 autosave**  | 复用；1.0 需评估是否加未保存 buffer 持久化 |
| `apps/desktop/src/renderer/manuscript/VersionHistory.tsx`                  | 右栏：版本列表 + 设为当前                                     | 复用                                       |
| `apps/desktop/src/renderer/manuscript/ManuscriptLeaveDialog.tsx`           | 离开确认（focus trap）                                        | 复用                                       |
| `apps/desktop/src/renderer/manuscript/manuscript-leave-guard.ts` + test    | 共享离开守卫（dirty/busy）；明确"不持久化未保存正文"          | 复用；与 App shell 的 guard 集成           |
| `apps/desktop/src/renderer/manuscript/manuscript-labels.ts`                | 纯展示 zh-CN 文案                                             | 复用                                       |
| `apps/desktop/src/renderer/manuscript/test-manuscript-mock.ts`             | 内存 mock 后端（建模真实 CAS/position/版本）                  | 复用（测试资产）                           |
| `apps/desktop/src/renderer/App.css`（+459）                                | 三栏布局 + 横幅 + 深色模式                                    | 选择性复用（样式）                         |
| `apps/desktop/src/renderer/safety/error-code-labels.ts`（+8）              | 新增 7 个中文错误标签                                         | 复用                                       |

**复用前提**：dirty/CAS/buffer 逻辑与 `useManuscriptWorkbench` 一起作为叶子组件/叶子 hook 交付，
由 1.0 的 App shell 装配；`MANUSCRIPT_POSITION_OVERFLOW` 需补 renderer 专有处理（当前只有
`MANUSCRIPT_VERSION_CONFLICT` 被特判）。

### 5.3 不应迁移的产品壳

| 路径                                                                                                               | 为什么不应迁移                                                      |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `apps/desktop/src/renderer/App.tsx` 中央 tab 切换器（Grill-me / 稿件）                                             | 产品壳式视图切换，不是 manuscript 业务逻辑；Grill-me 仍是默认工作区 |
| `apps/desktop/src/renderer/App.tsx` 中 `guardLeave` 包裹（open-project/new-project）+ `pendingWorkbenchLeave`      | 产品壳导航安全，属于 App shell 装配层                               |
| 旧默认入口（新建项目 / project list / Grill 工作台）                                                               | 不符合 Idea-to-Novel 信息架构；1.0 默认入口应为 Idea Intake         |
| `apps/desktop/src/renderer/grill/*` 中的工程状态区域（`GrillDiagnostics`、`useGrillQuestionPlan` 2s 轮询控制器等） | 工程化状态语义，1.0 简化为自然追问流                                |
| 与本 PR 无关的 `docs/development/generation-quality-roadmap.md` / `manuscript-version-design.md` 文档改动          | 属于 Agent A 所有（roadmap）；不随代码迁移                          |

### 5.4 建议处理时机

PR #25 当前处理方式（本审计结论）：

```text
保持 Draft
不合并
不关闭
```

仅当以下条件全部满足后，才可关闭并标记 `superseded`：

1. Manuscript 相关 transport / renderer 资产已进入后续 PR 并被采纳；
2. 与 PR #25 逐文件核对，确认无遗漏资产（见 5.1 / 5.2 清单）；
3. Agent A 方向文档已交叉校验。

## 6. 双 Agent 实施图

两名 Agent 并行工作，以**契约冻结**为同步点。分工**不固定**为"A 只做 Renderer、B 包办全部
backend"——Cycle 1 按层分工，Cycle 2/3 按**纵向能力切片**分工（见 6.3 / 6.4）。
共享热点始终单一 owner（见 6.1）。

### 6.1 共享热点：单一 owner 或先后顺序

| 热点                 | 文件                                                                                                       | 策略                                                                                                   | Owner                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `packages/contracts` | `packages/contracts/src/index.ts`                                                                          | 每个 Cycle 开始时先冻结该 Cycle 的契约提交；**禁止同时修改**，一方冻结、另一方只读消费                 | 按 Cycle 指定单 owner（见 6.2–6.4） |
| 数据库迁移注册表     | `packages/database/src/project-database.ts`（`PROJECT_MIGRATIONS`）、`app-database.ts`（`APP_MIGRATIONS`） | 版本号顺序追加；**并行时禁止同时追加**，后合入方 rebase 后接续。**R1 默认不新增**（复用现有 grill 表） | 每个 Cycle 单 owner（C2 = Agent A） |
| Worker root dispatch | `apps/worker/src/index.ts`                                                                                 | 命令组 append-only；**禁止同时修改**；C2 期间 Agent B 在 Research 合并前不触碰                         | 每个 Cycle 单 owner（C2 = Agent A） |
| Main IPC 注册        | `apps/desktop/src/main/index.ts`                                                                           | 新 handler append；**禁止同时修改**；C2 期间 Agent B 在 Research 合并前不触碰                          | 每个 Cycle 单 owner（C2 = Agent A） |
| App shell            | `apps/desktop/src/renderer/App.tsx`、`main.tsx`、`App.css`                                                 | **Agent A 独占**；Agent B 的 UI 组件作为叶子组件交付，由 shell 装配                                    | Agent A                             |
| roadmap              | `docs/development/generation-quality-roadmap.md`                                                           | 权威文档，**Agent A 独占**                                                                             | Agent A                             |

### 6.2 Cycle 1：Idea Intake

- **契约冻结**：`IdeaIntake` IPC 通道名 + 输入校验器 + `IdeaIntakeAPI`（`packages/contracts/src/index.ts`）。
  R1 **默认不新建 migration**，复用现有 `grill_*` 表。
- **R1 复用路线（Agent B 负责后端）**：
  - 复用现有 `grill_sessions` / `grill_questions` / `grill_answers` 表；
  - 复用 Grill domain / application / repository（内部保留 `grill` 命名）；
  - 修复 `grill.markQuestionAsked` 死链（补 worker dispatch case）；
  - 将 `projects.initial_idea` 自动播种进 intake session goal。
- **Agent A 负责目录**：
  - `apps/desktop/src/renderer/idea-intake/`（新默认入口、**自然对话式** Idea Intake UI：
    Idea 输入、追问/回答流）
  - `apps/desktop/src/renderer/App.tsx`（默认入口切换到 Idea Intake，卸载旧默认 Grill 入口）
  - `apps/desktop/src/renderer/grill/`（前台重构：隐藏 PAUSED/ABANDONED、proposal review、
    diagnostics 等非 1.0 流程）
  - `apps/desktop/src/preload/index.ts`（renderer 侧消费的冻结 API；用户侧命名 Idea Intake）
- **Agent B 负责目录**：
  - `packages/contracts/`（先冻结 Idea Intake 契约；复用 `GRILL_*` 通道为主）
  - `packages/application/`（加 create-from-initialIdea 用例；修复死链相关）
  - `apps/worker/src/`（补 `grill.markQuestionAsked` dispatch case）
  - `apps/desktop/src/main/index.ts`（IPC handler 注册/接线）
- **合并顺序**：契约冻结 → 死链修复 + initialIdea 播种 → preload → renderer 前台重构。
- **冲突文件 owner**：`packages/contracts/src/index.ts`（B）、`apps/desktop/src/main/index.ts`（B）、
  `apps/desktop/src/preload/index.ts`（A 消费冻结 API）、`apps/desktop/src/renderer/App.tsx`（A）、
  `apps/desktop/src/renderer/grill/*`（A 前台重构）。

### 6.3 Cycle 2：Web Research 与 Story Blueprint 并行（纵向分工）

- **契约冻结**：`ResearchBundle` + `StoryBlueprint` 契约（`packages/contracts/src/index.ts`）。
- **Agent A —— Web Research 完整纵向切片**（**本 Cycle 拥有 Research 相关 contracts、
  migration registry、Worker/Main 接线**）：
  - `packages/research-engine/`（`WebSearchPort` / `WebFetchPort` / `ResearchOrchestrator`）
  - `packages/database/`（`ResearchBundle` 存储，新 migration）
  - `packages/task-engine/`（research 任务编排）
  - `packages/contracts/`（Research 通道 + API + 校验器）
  - `apps/worker/src/`、`apps/desktop/src/main/`、`apps/desktop/src/preload/`（transport）
  - `apps/desktop/src/renderer/research/`（调研决策、搜索结果、来源与引用展示，产品 UI）
- **Agent B —— Story Blueprint 纯核心**（**Research 合并前不修改 migration registry、
  Worker root、Main IPC root**）：
  - `packages/domain/`（Blueprint 聚合 + 校验）
  - `packages/application/`（Blueprint 生成服务）
  - fixture 测试；**使用冻结的 `ResearchBundle` contract**（只读消费）
- **同步顺序**：
  1. 先冻结 `ResearchBundle` 与 `StoryBlueprint` contracts；
  2. 两边并行开发；
  3. **Web Research 先合并**；
  4. Blueprint **rebase**；
  5. 接入真实 `ResearchBundle` 与 Worker transport。
- **共享热点单一 owner**（本 Cycle）：`packages/contracts`（A 冻结 research，双方只读）、
  迁移注册表（A）、Worker root dispatch（A）、Main IPC root（A）、App shell（A）、roadmap（A）。

### 6.4 Cycle 3：Generation 与 Manuscript 并行（纵向分工）

- **契约冻结**：`Generation`（章节生成 / review/rewrite 通道）+ `Manuscript`（移植自 PR #25）通道。
- **Agent A —— Manuscript transport + Review UI**（本 Cycle 拥有 manuscript 相关
  contracts / migration registry / Worker/Main 接线）：
  - 移植 PR #25 transport（contracts 通道 + Main/preload/worker）
  - 移植 PR #25 renderer（`useManuscriptWorkbench`、ChapterList、EditorPanel、VersionHistory、
    dirty/CAS/buffer 安全）
  - App shell 装配；导出入口
- **Agent B —— Chapter Generation 核心 pipeline**：
  - `packages/task-engine/`（章节生成任务）
  - `packages/application/`（prompt 组装）
  - `packages/database/`（生成产物落库，新 migration）
  - R1–R3 使用**现有非流式 Model Gateway + 严格解析 + 轮询**；取消与阶段进度在 R4 增加
    （见 §7 修正四）
- **共享热点单一 owner**：`packages/contracts`、迁移注册表、`apps/worker/src/index.ts`、
  `apps/desktop/src/main/index.ts`（各 Cycle 单 owner，见 6.1）、App shell（A）、roadmap（A）。

## 7. 推荐的代码 PR 序列

> 每个 PR 为可独立合并的小步；标 A/B 的为并行候选。每个 PR 都给出依赖与验收门禁。

| #   | PR                                    | 目标                                                                                                                                         | 主要目录                                                                                       | 可并行                                                            | 依赖                                  | 验收门禁                                                                                                                                                                               | 调用类型                                      |
| --- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| P1  | Idea Intake adaptation foundation     | **复用**现有 grill 表 + Grill 领域/应用/仓库；修复 `grill.markQuestionAsked` 死链；`initialIdea` 播种进 intake session；默认不创建 migration | `packages/application`、`apps/worker/src`、`packages/domain`、`packages/database`（复用为主）  | —                                                                 | —                                     | 死链修复 + 播种单测；`pnpm check`；无新 migration（除非独立裁决）                                                                                                                      | 否                                            |
| P2  | Idea Intake process bridge            | 复用 grill 用例 + worker 命令组 + main IPC + preload 接线（用户侧命名 Idea Intake）                                                          | `packages/application`、`apps/worker/src`、`apps/desktop/src/main`、`apps/desktop/src/preload` | —                                                                 | P1                                    | IPC 往返单测；用户输入不丢失测试                                                                                                                                                       | 否                                            |
| P3  | Idea Intake product UI                | 自然对话式 Idea Intake（新默认入口 + 追问/回答流）；隐藏 PAUSED/ABANDONED/proposal review/diagnostics                                        | `apps/desktop/src/renderer/idea-intake`、`apps/desktop/src/renderer/grill`、`App.tsx`          | 可与 P2 并行（契约冻结后）                                        | P1（契约）                            | Renderer 测试；手动验收；重启恢复                                                                                                                                                      | 否                                            |
| P4  | Web Research ports and storage        | `WebSearchPort` / `WebFetchPort` / `ResearchRepository` + `ResearchBundle` 存储（新 migration）；**V1 安全边界**                             | `packages/research-engine`、`packages/database`                                                | —（P5 需等本 PR 冻结后开始）                                      | P1                                    | 端口契约测试；存储往返测试；**V1 安全边界测试**（http/https 白名单、拒绝 private/loopback/link-local、重定向后重新校验、字节数/content-type 限制、超时、拒绝 credentials）；无真实联网 | 否（仅端口定义）                              |
| P5  | Web Research orchestration            | research 任务类型 + dispatch + 编排（失败/超时/来源元数据）                                                                                  | `packages/task-engine`、`apps/worker/src`                                                      | 部分重叠（**P4 接口与存储 schema 冻结后**才可开始；非无依赖并行） | P4 接口 + 存储 schema（冻结后）       | 任务生命周期测试；来源关联；失败/超时                                                                                                                                                  | **外部 search/fetch API 调用**（非 LLM 调用） |
| P6  | Research product UI                   | 调研决策、搜索结果、来源与引用展示                                                                                                           | `apps/desktop/src/renderer/research`                                                           | —                                                                 | P4、P5                                | Renderer 测试；手动验收                                                                                                                                                                | 否                                            |
| P7  | Story Blueprint domain and generation | Blueprint 聚合 + 生成任务（消费 CreationSpecSnapshot + ResearchBundle contract）                                                             | `packages/domain`、`packages/application`                                                      | 可与 P4/P5 并行（ResearchBundle 契约冻结后）                      | P1、P2、P4（ResearchBundle contract） | blueprint 结构校验（文本 JSON + strict validator）；来源引用保留                                                                                                                       | **LLM 模型调用**（R3）                        |
| P8  | Chapter generation pipeline           | 章节生成任务 + 产物落库（新 migration）；R1–R3 用现有非流式网关 + 轮询；R4 补取消 + 阶段进度                                                 | `packages/task-engine`、`packages/application`、`packages/database`                            | 可与 P10 并行                                                     | P7                                    | 生成不覆盖手写正文（CAS）；重启恢复；长章节前补取消/进度（R4）                                                                                                                         | **LLM 模型调用**                              |
| P9  | Manuscript transport extraction       | 从 PR #25 移植 contracts / Main / Preload / Worker / E2E                                                                                     | `packages/contracts`、`apps/desktop/src/main`、`apps/desktop/src/preload`、`apps/worker/src`   | 可与 P8 并行                                                      | —（主线上 manuscript v7 已存在）      | typed IPC 测试；restart persistence 测试                                                                                                                                               | 否                                            |
| P10 | Manuscript review UI                  | 移植 PR #25 renderer（ChapterList/EditorPanel/VersionHistory/dirty/CAS/buffer）                                                              | `apps/desktop/src/renderer/manuscript`                                                         | 可与 P8 并行                                                      | P9                                    | dirty/CAS/buffer 安全测试；离开守卫；手动验收                                                                                                                                          | 否                                            |
| P11 | Export                                | 导出为可读成品（TXT/Markdown/…）                                                                                                             | `packages/import-export`、`apps/desktop/src/main`                                              | —                                                                 | P10                                   | 导出往返测试                                                                                                                                                                           | 否                                            |

> 备注：调用类型列区分**外部 search/fetch API 调用**与 **LLM 模型调用**——搜索 API 调用**不等同于**
> LLM 调用。P5 属于外部 API 调用，P7/P8 属于 LLM 调用。本审计不进行任何模型调用；验收门禁中的
> 调用相关项由后续实施阶段执行。

## 8. 验证与完成标准

- `pnpm exec prettier --write docs/development/idea-to-novel-migration-plan.md`
- `git diff --check`
- `unset WRITING_EXPERIMENT_LIVE` + `pnpm check`
  （format:check + lint + build + typecheck + test）
- 本审计交付物：本文档 + `/tmp/idea-to-novel-asset-audit-report.md` + `/tmp/idea-to-novel-asset-audit-state.md`

## 9. 红线与不做清单

- 不实现任何功能；不创建 migration；不修改 PR #25；不关闭 PR #25。
- 不更新产品方向文档（Agent A 所有）。
- 不启动 Scene Planner；不进行真实联网调研；不进行付费模型调用；不访问 Keychain。
- 不读取 GQ2 私有映射或真实稿件内容。
- 不把测试数量当成产品价值。

## 附录 A：证据清单（关键证据，全部可复核）

**Web Research（NOT_IMPLEMENTED）**

- `packages/research-engine/src/index.ts:8` —— 唯一导出 `RESEARCH_ENGINE_PACKAGE_LOADED = true`。
- `packages/context-engine` / `review-engine` / `import-export` `src/index.ts:8` —— 同款 stub。
- 全仓 grep `tavily/serper/bing/duckduckgo/crawl/readability/citation/scrape` 零命中。
- 唯一 fetch 调用：`packages/model-gateway/src/index.ts:166,184,304,330`（模型 API）、
  `packages/plotpilot-adapter/src/index.ts:444`（sidecar）。
- `packages/plotpilot-adapter/src/index.ts:348,371` —— sidecar 仅 `/generate-chapter-stream`、
  `/hosted-write-stream` 两个生成端点，无 research 端点。
- `docs/architecture/plotpilot-sidecar-integration.md:30-31` —— PlotPilot 只拥有内部小说
  retrieval/vector index，非 web 调研。
- `packages/domain/src/index.ts:41,43-50` —— `'research'` 只是 ProjectStatus 生命周期值；TaskType 无 research。
- `packages/contracts/src/index.ts:212-358` —— 无 RESEARCH_* 通道 / API 方法。

**Grill-me**

- `apps/desktop/src/renderer/App.tsx:310-316` —— 创建项目后落 GrillWorkbench。
- 死链路：`contracts/src/index.ts:235` 通道 → `main/index.ts:428-440` → preload/hook/UI，
  但 worker `index.ts:1417-1447` 与 `grill-handlers.ts:936-981` **无** `grill.markQuestionAsked` case。
- `GrillSessionList.tsx:66-88` —— initialIdea 需用户重打，未自动播种。
- `application/src/grill-session.ts:277-292` —— `addGrillQuestions` 环检测 TECH DEBT。
- `GrillDiagnostics.tsx:30` —— `!import.meta.env.DEV`。

**Creation Contract**

- `application/src/creation-contract-request.ts:125-127` —— AI 草案硬要求 COMPLETED grill session。
- `useContractDraft.ts:471` —— accept 恒 `operations: []`。
- grep 确认 `updateByUser / lockField / unlockField / listVersions / getProposal` 无 renderer 调用者。
- `domain/src/creation-contract.ts:340` —— snapshot hash 嵌入 `lockedFieldPaths`；
  `project-database.ts:381` —— CHECK `schema_version = 1`。

**Manuscript / PR #25**

- `packages/database/src/project-database.ts:581`（v7）—— manuscripts/chapters/chapter_versions STRICT 表 +
  append-only trigger + 部分唯一索引。
- `packages/contracts/src/index.ts:2177-2792` —— main 已导出 manuscript DTO/15 输入接口/15 校验器/6 ErrorCode。
- 主线上无 `MANUSCRIPT_*` IPC 通道、无 `ManuscriptAPI`、无 preload/worker 接线。
- PR25 `apps/worker/src/manuscript-handlers.test.ts` —— 'restart 持久化' 重开 ProjectDatabase 验证。
- PR25 无 autosave/localStorage/indexedDB；`manuscript-leave-guard.ts` 明确不持久化未保存正文。
- preload `index.ts:7` —— 本地 `const IPC_CHANNELS`，未从 contracts 导入（通道字符串三处重复）。

**Task Engine / Model Gateway**

- `project-database.ts:82-105` tasks 表 —— 无 progress/依赖列；`CANCELLED` 仅枚举 + `cancelled_at`。
- `TaskRepositoryPort`（`application/src/types.ts:219-238`）—— 无 `markCancelled`。
- `apps/worker/src/index.ts:1379-1516` dispatch —— 无 task cancel 命令。
- `worker index.ts:816-821` reconcileTasks —— RUNNING→FAILED `TASK_INTERRUPTED`，不恢复。
- `resetToPending`（`project-database.ts:895`）—— 零生产调用点。
- `model-gateway/index.ts:291` —— 固定 120s 超时；`:370` 等待 `response.json()`（无流式）。
- `task-engine/index.ts:59` —— `FIXED_PROVIDER_ID='mimo-token-plan-cn'` 硬编码。

**Evaluation Harness**

- `packages/writing-evaluation` `boundary.test.ts:61,79-99` —— 离线、禁网络/SQLite/model-gateway。
- `baseline-one-shot-v1.ts:13-21` —— temp 0.7 / maxTokens 8192 / concurrency 1 / retries 0。
- `schema.ts:39-40` —— `requiredFacts/forbiddenFacts` 只渲染进 prompt，从不自动检查。
- `writing-evaluation-lab.md:309-320` —— 语义维度明确人工 only。
