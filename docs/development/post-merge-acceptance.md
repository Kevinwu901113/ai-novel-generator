# Post-Merge Architecture Acceptance — GE-0..GE-6

> Status: 待 Principal Architect 决策（只读审查，未改代码）
> 日期：2026-08-04
> 事实来源：main `f70941e`（PR #33/#34/#35/#36/#37/#38 + GE-2 直接提交 `4b26c60`）
> 判定标准：**graph-engineering-roadmap 各 GE 的原始退出条件**，不以 PR 标题 / 测试数量 / "后端完成" 替代阶段完成。

---

## 0. 结论摘要

| GE   | 判定                | 一句话                                                                                                                      |
| ---- | ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| GE-0 | ✅ COMPLETE         | 文档收束达成；但推进位置表本身需修正（下详）。                                                                              |
| GE-1 | ✅ COMPLETE（内核） | Durable Runtime Kernel 真实、原子、可恢复；但 recovery 把在途 active 节点**永久 failed**（fail-closed，无 executor 恢复）。 |
| GE-2 | ⚠️ PARTIAL          | 骨架测试达成（fake）；**无运行时 runner / 无产品 UI**；`4b26c60` 直接推 main 绕过 PR 审查（代码未绕过 Domain transition）。 |
| GE-3 | 🔶 REWORK           | 仅 helper 命令（intake.*）；**IDEA_CAPTURE/SPEC_EXTRACT/ASK_QUESTION/COLLECT_ANSWER 未接运行时**；无 UI；无 E2E。           |
| GE-4 | 🔶 REWORK           | 仅 research-engine + research.execute；RESEARCH 四节点未接运行时；fake provider；无 UI。                                    |
| GE-5 | 🔶 REWORK           | 仅 StoryBlueprint + blueprint.*；**BLUEPRINT_GENERATE/USER_GATE 未接运行时**；accept 与 Graph gate **非原子一致**；无 E2E。 |
| GE-6 | 🔶 REWORK           | 仅 CHAPTER_DRAFT 任务引擎；**PLAN/DRAFT/三 Critic/JOIN/REWRITE/GATE 均无真实 executor、无 task settlement 接线**；无 E2E。  |

**统一结论**：GE-1 内核为真（RUNTIME_WIRING 层真实）；GE-0 为真；GE-2 骨架为真但无运行时驱动。GE-3/4/5/6 交付的是**独立 backend helper 命令**，Graph 节点**全部仍由测试专用 skeleton fake 驱动**（`runFakeUntilHumanOrTerminal` 只被测试引用，worker 非测试代码零引用）。**没有任何真实 executor 把模型/搜索/蓝图任务结果经 GraphRunService 推进 Graph**。artifact ref 为占位 ID（`art-${nodeId}`），不指向真实持久化对象。

---

## 1. 跨切面核查（代码证据）

### 1.1 GE-1 事务 / CAS / 幂等日志 / answer receipt 是否同一 BEGIN IMMEDIATE？

**是（真实）。**

- `packages/database/src/graph-run-transaction.ts`：`runInTransaction` 执行 `BEGIN IMMEDIATE` → operation → `COMMIT`，异常 `ROLLBACK`，嵌套检测。
- `packages/application/src/graph-run.ts` `applyHumanDecision`：`deps.tx.runInTransaction((repos) => { … intakeAnswer.insertAnswer … applyHumanDecisionTransition … saveWithCas … commandLog.insert … })` —— answer 写入、Domain transition、CAS 保存、幂等日志在同一事务。
- `advanceNode/failNode/requestHumanDecision/applyArtifactChange` 均同一模式。
- 幂等：`commandLog.get(id)` 指纹比对（同 key 同指纹 → deduped；同 key 异指纹 → IDEMPOTENCY_CONFLICT）。
- 测试证据：`packages/database/src/graph-run-database.test.ts`（receipt 原子性：CAS 失败则 answer 回滚）；`graph-run-service.test.ts`（幂等去重/冲突）。

### 1.2 recovery 是否把"可恢复任务"永久标记 failed？

**是（fail-closed 设计，需决策）。**

- `graph-run.ts:680 recoverInFlightRuns`：对每个非终态 run 的 `active` 节点执行 `failNode` → `applyNodeFailure` → run 终态 `failed`，其余 active/waiting `cancelled`。
- 语义：`active` = 执行器已下发但未提交完成 → 重启视为中断 → 失败。**无 executor registry 可恢复重放**；模型调用已完成但未 settlement 的结果会丢失。
- 与 `reconcileTasks`（RUNNING→FAILED TASK_INTERRUPTED）一致，但**在途工作确实永久丢失**（需用户重跑整个 run）。
- **待决策**：是否应引入"执行器可重放"（GE-6 的 task settlement 需保证任务完成结果在崩溃后仍可推进 Graph，而非直接 fail）。

### 1.3 GE-2 直接提交 `4b26c60` 是否引入未审查边界绕过？

**否（代码）；是（流程违规）。**

- `git show 4b26c60 --stat`：仅 `graph-skeleton.ts` + 2 测试 + docs + index 导出。
- `graph-skeleton.ts` 只调用 `advanceNode`/`getRunProgress`（Domain transition），无 `saveWithCas`/`graphRunRepo` 直写。**未绕过 Domain transition**。
- 但直接推 main **绕过 PR 审查**（与仓库 PR 流程冲突），且把 GE-2 标记为"已完成"过早。

### 1.4 GE-3 是否把 IDEA_CAPTURE/SPEC_EXTRACT/ASK_QUESTION/COLLECT_ANSWER 接运行时？

**否。**

- `grep IDEA_CAPTURE|SPEC_EXTRACT|ASK_QUESTION|COLLECT_ANSWER apps/worker/src`（非测试）：**零命中**。
- 实际交付：`intake-handlers.ts`（`intake.createIntakeSession`/`getActiveIntakeSession`/`propagateSpecInvalidation`）——独立 helper 命令，**不驱动 Graph 节点**。
- Graph 节点仍由 `runFakeUntilHumanOrTerminal`（测试专用）用 `fakeProducerForNode` 产出 `idea`/`creationSpec` 占位 artifact。

### 1.5 GE-4 是否由 RESEARCH_DECISION/PLAN/EXECUTE/VALIDATE 节点驱动？

**否。**

- `grep RESEARCH_* apps/worker/src`（非测试）：**零命中**。
- 实际交付：`research-handlers.ts`（`research.execute`）——独立命令，直接跑 `orchestrateResearch`（fake provider），**不经 Graph 节点**。
- `determineResearchDepth` 存在但无 Graph 节点调用；`research.execute` 自行决定深度。

### 1.6 GE-5 是否由 BLUEPRINT_GENERATE/USER_GATE 推进，accept 与 artifact/version 原子一致？

**否。**

- `grep BLUEPRINT_GENERATE apps/worker/src`（非测试）：仅 `blueprint-handlers.ts:6` 注释。
- `blueprint.accept` → `blueprintRepo.markAccepted(...)`（写 `story_blueprints.accepted=1`），与 Graph `BLUEPRINT_USER_GATE` 的 `applyHumanDecision` 是**两个独立事务**，非原子：可能"repo 接受但 Graph 未到 PROJECT_READY"或反之。
- `generateBlueprint` 产出的 `StoryBlueprint` 独立持久化；Graph 的 `storyBlueprint` artifact 仍是 `art-BLUEPRINT_GENERATE` 占位 ID，**不指向该持久化对象**。

### 1.7 GE-6 是否有 PLAN/DRAFT/三 Critic/JOIN/REWRITE/GATE 的真实 executor 与 task settlement？

**否。**

- `grep CHAPTER_PLAN|DRAFT|CONTINUITY_CRITIC|STYLE_CRITIC|REQUIREMENT_CRITIC|CRITIQUE_JOIN|REWRITE|CANDIDATE_GATE apps/worker/src`（非测试）：**零命中**。
- `executeChapterDraft`（task-engine）**无任何 worker 非测试引用** —— 任务引擎存在但无 executor 调用、无任务结果→Graph 推进的 settlement 接线。
- `tasks` 表 CHECK 已加 `CHAPTER_DRAFT`（migration v11），但无任务被创建/调度。

### 1.8 是否有绕过 Domain transition 直写 Graph state？

**否（结构上）。**

- 非测试代码中 `graphRunRepo`/`saveWithCas`/`graph_runs` 直写仅存在于 `graph-run.ts`（service）与 `graph-run-repositories.ts`（repo）。
- `intake/research/blueprint` handlers 都只经 application use case；但**它们根本不改 Graph state**（因为没接节点）。
- ⚠️ 残留风险：`graph.advanceNode` RPC 接受调用方任意 `outcome`/`artifactRef`，服务只校验形状/枚举，**不校验 artifact ref 是否指向真实持久化对象** → 可伪造 artifact（当前骨架正是占位 ID）。

### 1.9 Graph artifact ref 是否指向真实持久化对象？

**否。**

- skeleton `fakeProducerForNode`：`artifactId: config[node.id]?.artifactId ?? \`art-${node.id}\`` —— 占位 ID。
- 真实持久化对象（`research_bundles`/`story_blueprints` 行）有真实 id，但**无任何接线把 Graph artifact 关联到它们**。

### 1.10 task 成功与 Graph 推进之间是否具备幂等/崩溃恢复/重复 settlement 防护？

**不适用（无 settlement 接线）。**

- GE-6 没有任务→Graph 的 settlement 桥，因此不存在该防护。
- GE-1 内核层面：`advanceNode` 有 commandLog 幂等 + CAS，单次推进可重放；但"任务完成 → 推进"的桥缺失，所以无法评价其崩溃一致性。

---

## 2. 逐 GE 判定

### GE-0 — 权威文档收束

- **原始退出条件**：仓库"当前状态 / 下一步 / 验收标准"只有一个答案；`pnpm check` 绿。
- **实际已实现**：统一 roadmap（L1–L4 权威层级）、单一状态文档、Graph 中心模块边界、决策日志、删除 7 份旧规划文档；`pnpm check` 绿。
- **尚未实现**：无（本 GE 为文档阶段）。但**推进位置表本身**把后续 GE 标记为"已完成"，违反本 GE 的"只有一个答案"精神 —— 需修正（见 §3）。
- **Graph 节点 executor**：不适用。
- **经 GraphRunService + Domain transition**：不适用。
- **真实持久化 / 重启恢复**：不适用。
- **是否只有 backend/fake/fixture**：否（文档）。
- **用户可执行产品路径**：不适用。
- **判定**：✅ **COMPLETE**（文档达成；推进表需同步修正）。
- **证据**：`docs/development/graph-engineering-roadmap.md`；PR #33；`pnpm check` 117 files / 2847 tests。

### GE-1 — Durable Graph Runtime Kernel

- **原始退出条件**：run 全量状态持久化往返、CAS 冲突、幂等、恢复、answer receipt 原子性测试绿。
- **实际已实现**：GraphRunService（9 用例）、migration v8（graph_runs + graph_run_commands）、BEGIN IMMEDIATE + CAS 原子持久化、幂等命令日志、启动恢复、answer receipt 原子契约、6 个 GRAPH_RUN_* ErrorCode、graph.* RPC。
- **尚未实现**：真实节点 executor（GE-2+）；recovery 的可恢复性（在途 active → 永久 failed，见 1.2）。
- **Graph 节点 executor**：否（内核不含 executor）。
- **经 GraphRunService + Domain transition**：✅ 是（所有 mutation 走纯 domain transition）。
- **真实持久化 / 重启恢复**：✅ 是（SQLite v8 + recoverInFlightRuns + waiting_for_human 不触碰）。
- **是否只有 backend/fake/fixture**：是（内核为 backend；无 UI 属预期）。
- **用户可执行产品路径**：否（无 UI，预期）。
- **判定**：✅ **COMPLETE（内核）** —— 但 recovery 语义需 Principal Architect 决策（1.2）。
- **证据**：`graph-run.ts`/`graph-run-transaction.ts`/`graph-run-database.test.ts`（receipt 原子性回滚、CAS、幂等）；PR #34。

### GE-2 — 双 Graph Walking Skeleton

- **原始退出条件**：双图全路径 + 重启恢复 / fan-out / 失败 / 取消 / blocked / human interrupt / bounded loop 绿。
- **实际已实现**：确定性 fake executors + 推进器；Project/Chapter 全路径到终态；澄清循环预算耗尽、research invalid 重试、blueprint rewrite、fan-out failure、restart 恢复（真实 SQLite）。
- **尚未实现**：运行时 runner（`runFakeUntilHumanOrTerminal` 仅测试引用，worker 非测试零引用）；产品 UI（原 GE-2 要求"UI 只显示用户当前需要理解与操作的内容"）。
- **Graph 节点 executor**：fake（测试专用）。
- **经 GraphRunService + Domain transition**：✅ 是（推进器只调 advanceNode）。
- **真实持久化 / 重启恢复**：✅ 是（真实 SQLite 测试）。
- **是否只有 backend/fake/fixture**：是（fake executor；无运行时）。
- **用户可执行产品路径**：否。
- **判定**：⚠️ **PARTIAL**（骨架测试达成；无运行时 runner / 无 UI）；`4b26c60` 直接推 main 为流程违规（代码未绕过）。
- **证据**：`graph-skeleton.ts`/`graph-skeleton.test.ts`/`graph-skeleton-persistence.test.ts`；commit `4b26c60`。

### GE-3 — 真实 Idea Intake + CreationSpec 节点

- **原始退出条件**：Intake→CreationSpec 真实路径端到端绿。
- **实际已实现**：死链修复（listQuestions/markQuestionAsked）、`createIntakeSessionFromIdea`（播种）、`propagateCreationSpecInvalidation`（Graph 失效）、`GraphRunService.applyArtifactChange`、`intake.*` worker 命令。
- **尚未实现**：**IDEA_CAPTURE/SPEC_EXTRACT/ASK_QUESTION/COLLECT_ANSWER 运行时 executor**；回答经 grill_answers → answer receipt 推进 Graph 的闭环；CreationSpec 编辑器 UI；自然对话 Idea Intake UI；用户不接触工程概念的默认入口。
- **Graph 节点 executor**：否（节点仍由 skeleton fake 驱动）。
- **经 GraphRunService + Domain transition**：仅 helper 命令改 Grill/CreationSpec 存储；Graph 节点未接线。
- **真实持久化 / 重启恢复**：Grill/contract 持久化有；Graph 节点路径无。
- **是否只有 backend/fake/fixture**：是（helper backend；节点 fake）。
- **用户可执行产品路径**：否。
- **判定**：🔶 **REWORK**（核心目标——节点接线 + UI——未达）。
- **证据**：`idea-intake.ts`/`intake-handlers.ts`；grep 节点 id 在 worker 非测试零命中。

### GE-4 — 真实 Web Research + ResearchBundle

- **原始退出条件**：三档真实调研 + 安全边界测试绿。
- **实际已实现**：research-engine 端口/安全边界/深度判断/编排；migration v9；`research.execute`（fake provider）。
- **尚未实现**：**RESEARCH_DECISION/PLAN/EXECUTE/VALIDATE 节点 executor**；真实 Search/Fetch provider（现为 fake）；Research UI；问题计划用户增删跳过的 Graph 闭环；来源排除的 Graph 语义。
- **Graph 节点 executor**：否。
- **经 GraphRunService + Domain transition**：否（`research.execute` 独立跑 orchestrator，不经 Graph）。
- **真实持久化 / 重启恢复**：research_bundles 持久化有；Graph 节点路径无。
- **是否只有 backend/fake/fixture**：是（fake provider；节点未接）。
- **用户可执行产品路径**：否。
- **判定**：🔶 **REWORK**。
- **证据**：`research-engine/*`、`research.ts`、`research-handlers.ts`；grep 节点 id 零命中。

### GE-5 — StoryBlueprint + PROJECT_READY

- **原始退出条件**：Project Graph 从模糊想法真实运行到 READY/BLOCKED/CANCELLED。
- **实际已实现**：StoryBlueprint 聚合 + migration v10 + `blueprint.generate/accept/listChapters`。
- **尚未实现**：**BLUEPRINT_GENERATE 节点 executor**（产出真实持久化 blueprint artifact）；BLUEPRINT_USER_GATE accept 与 blueprint repo 的**原子一致**；改写循环的节点闭环；模糊想法→PROJECT_READY 的**真实 E2E**（现为 skeleton fake）。
- **Graph 节点 executor**：否。
- **经 GraphRunService + Domain transition**：否（`blueprint.accept` 独立写 repo，Graph gate 是另一事务）。
- **真实持久化 / 重启恢复**：story_blueprints 持久化有；Graph 节点路径无。
- **是否只有 backend/fake/fixture**：是。
- **用户可执行产品路径**：否。
- **判定**：🔶 **REWORK**。
- **证据**：`blueprint.ts`/`blueprint-handlers.ts`；grep BLUEPRINT_GENERATE 仅注释。

### GE-6 — Chapter Graph 真实章节生成节点

- **原始退出条件**：真实章节生成到 CANDIDATE_GATE 全链绿。
- **实际已实现**：CHAPTER_DRAFT 任务引擎（严格解析 + 原子提交 + migration v11 tasks CHECK）。
- **尚未实现**：**CHAPTER_PLAN / DRAFT / 三 Critic / JOIN / REWRITE / CANDIDATE_GATE 的真实 executor**；task→Graph settlement 接线；Scene Plan 内部 artifact；三 Critic 并行；一次 run 单章节约束的运行时强制。
- **Graph 节点 executor**：否（`executeChapterDraft` 无 worker 引用）。
- **经 GraphRunService + Domain transition**：否（无 settlement）。
- **真实持久化 / 重启恢复**：任务持久化有；Graph 节点路径无。
- **是否只有 backend/fake/fixture**：是（任务引擎 standalone；节点 fake）。
- **用户可执行产品路径**：否。
- **判定**：🔶 **REWORK**（实为 FOUNDATION）。
- **证据**：`task-engine/src/chapter-generation.ts`；grep 节点 id 零命中。

---

## 3. 文档修正要求（已按此修改）

`graph-engineering-roadmap.md` / `current-project-state.md`：

1. **不得**把"backend 基座完成"标记为整个 GE COMPLETE。
2. 每项分别标注：**FOUNDATION / BACKEND / RUNTIME_WIRING / PRODUCT_UI / E2E**。
3. 下一步**不得写 GE-7**，直到 GE-6 原退出条件真正通过。

---

## 4. 待 Principal Architect 决策项

1. **GE-1 recovery 语义**：在途 active 节点永久 failed（fail-closed）是否接受？还是需引入执行器可重放（GE-6 settlement 保证崩溃后任务结果仍推进 Graph）？
2. **GE-2 `4b26c60` 流程违规**：直接推 main 的提交是否需补开 PR 留痕 / 是否需要后续改走 PR？
3. **`graph.advanceNode` 可伪造 artifact ref**：服务只校验形状不校验存在性；是否需在 executor 层强制 artifact 必须来自真实持久化对象？
4. **后续依赖顺序**（用户已给定）：A 补 GE-3 → B 补 GE-4 → C 补 GE-5 → D 补 GE-6（全部真实 executor 运行到 CANDIDATE_GATE）→ 之后才启动 GE-7。
5. **roadmap 下一步**：在 D 完成前不写 GE-7。
