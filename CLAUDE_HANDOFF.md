# CLAUDE_HANDOFF

> Claude 接手本项目时首先阅读的**唯一入口文件**。详细文档一律通过链接引用，不在本文件复制内容。

## 1. 交接快照

| 项                       | 值                                                         |
| ------------------------ | ---------------------------------------------------------- |
| repository               | `Kevinwu901113/ai-novel-generator`                         |
| main                     | `2f93ccd18f6165b44a2e4089fd2567ec58a9afcb`                 |
| PR                       | **#39** Durable Node Execution & Settlement Bridge（RW-1） |
| branch                   | `feat/rw1-node-execution-settlement`                       |
| 当前实现 head            | `c5def0dad0f7bfc442110fca99d6cb8de45d5c72`                 |
| PR 状态                  | **Draft / OPEN / 未合并**                                  |
| CI run `30888262527`     | completed / **success**（head `c5def0d`）                  |
| Quality gates            | success                                                    |
| macOS package smoke test | success                                                    |
| GE-3                     | 未启动                                                     |
| main                     | 未包含 RW-1                                                |

## 2. 项目目标

产品闭环：

```
模糊想法
→ Idea Intake
→ CreationSpec
→ Web Research / ResearchBundle
→ StoryBlueprint
→ Chapter Plan / Draft / Critics / Rewrite / Candidate Gate
→ Manuscript Commit
→ 编辑、下一章、导出
```

流程权威为两张 Graph（`packages/domain/src/idea-to-novel-graph.ts`）：**IdeaToNovelProjectGraphV1**（16 节点）与 **ChapterGenerationGraphV1**（13 节点）。方向权威见 `PRODUCT_DIRECTION.md` 与 `docs/product/idea-to-novel-v1.md`；路线与状态见 `docs/development/graph-engineering-roadmap.md` / `current-project-state.md`。

## 3. Graph Engineering 路线真实进度

| GE       | 状态                      | 事实                                                     |
| -------- | ------------------------- | -------------------------------------------------------- |
| GE-0     | **COMPLETE**              | 权威文档收束                                             |
| GE-1     | **COMPLETE**              | Durable Graph Kernel on main                             |
| GE-2     | **PARTIAL**               | Graph conformance test harness，无 production runner     |
| GE-3     | **REWORK / NOT COMPLETE** | backend assets 有，runtime wiring / UI / E2E 无          |
| GE-4     | **REWORK / NOT COMPLETE** | research backend 有，真实 provider / Graph / UI / E2E 无 |
| GE-5     | **REWORK / NOT COMPLETE** | blueprint backend 有，真实 Graph E2E 无                  |
| GE-6     | **REWORK / NOT COMPLETE** | CHAPTER_DRAFT base 有，完整章节 Graph 未接               |
| **RW-1** | **ON DRAFT PR #39**       | 已实现 R5-R2，CI 绿，**尚未独立最终验收 / 合并**         |
| GE-7     | **NOT STARTED / BLOCKED** | 待 GE-3～GE-6 真实链路完成                               |
| GE-8     | **NOT STARTED**           |                                                          |
| GE-9     | **NOT STARTED**           |                                                          |

**后续顺序只能是**：

```
独立验收并处理 PR #39
→ merge RW-1
→ post-merge acceptance
→ GE-3
→ GE-4
→ GE-5
→ GE-6 至 CANDIDATE_GATE
→ GE-7
→ GE-8
→ GE-9
```

## 4. PR #39（RW-1）做了什么

以代码事实概述：

- **migration v12**：`node_executions`、`node_execution_results`、`node_artifact_provenance`；
- `activation_no` / `attempt_no`（attempt 只在 activation 内）；unique `(run,node,activation,attempt)`；
- **partial in-flight uniqueness**（`(run,node)` WHERE in-flight）、`task_id` 非空唯一；
- **sync lease**（`claimed_by` + `lease_expires_at`，5 分钟）；
- `ExecutorRegistry` + **SyncNodeExecutor / TaskBackedNodeExecutor** 拆分（sync/pure，identity 之后调用）；
- execution / task **原子 claim**（`claimExecution`，initial + infra retry 共用同一 `BEGIN IMMEDIATE` 路径）；
- `taskId → execution` 反查（`getByTaskId`）；
- **canonical node input contracts**（`GraphNodeInputContract` 声明于节点元数据）+ canonical serializer（domain `canonicalJson`）+ `input_snapshot_json`；
- **execution-bound durable result**（result 与 invocation/task success 同一事务 + `saveOrVerifySame`）；
- **artifact provenance / 可寻址**（settlement 持久化 provenance；generation artifact 按真实 `artifact_id` + `getByArtifactId` 可寻址）；
- **atomic settlement 与 atomic failure**（`settleNodeExecution` / `failExecutionAndNodeInTransaction`，单一事务 + CAS + command log）；
- **task finalization compensation**（RUNNING invocation/task → FAILED）；
- **Worker startup readiness、recovery 与 PENDING task reschedule**（async `initialize` 等待 `recoverGraphRuns` 后才 READY；`scheduleGraphTask` → `executeChapterDraft` 幂等）；
- **Renderer 无法伪造非人工节点完成**（settlement 校验 provenance + envelope 三元组 + 失败仅显式 infra 码可重试）。

## 5. 为什么 PR #39 仍是 Draft

经历多轮 architecture review（RW-1 → R5 → R5-R2）。R5-R2 声称关闭最后 10 个 blocker，fresh CI 已绿，但**尚未由下一位 Principal Architect 独立代码级复验**。

> 不得将 PR #39 写成"已验收完成"；Draft 内容不计入 main 能力（见 §11）。

## 6. 不可破坏的不变量

- Graph state 只能经 **Domain transition**（`applyNodeSuccess` / `applyNodeFailure` / `requestHumanDecision` / `applyHumanDecision` / `applyArtifactChange`）改变；
- **WorkflowStage 只是 UI projection**，永不作为权威状态；
- Task Engine / Worker / Renderer **不得直接改 Graph state**；
- Renderer **不得提交 raw outcome/artifact**；
- candidate ≠ authoritative manuscript（仅 MANUSCRIPT_COMMIT 后可写 Manuscript）；
- artifact ref 必须指向真实持久化对象并有 **provenance**；
- **business loop 与 infrastructure retry 分离**（仅显式 infra 错误码重试；attempt 只在 activation 内）；
- **blocked 是终态**，同一 run 不复活；
- **GE-7 在 GE-3～GE-6 真实链路完成前冻结**。

## 7. Claude 必读文件

按顺序阅读（更细结构见 `docs/development/` 与各包）：

1. `PRODUCT_DIRECTION.md`（方向，最高权威）
2. `docs/product/idea-to-novel-v1.md`（1.0 纵向切片规格）
3. `docs/development/graph-engineering-roadmap.md`（唯一路线）
4. `docs/development/current-project-state.md`（唯一状态）
5. `docs/development/post-merge-acceptance.md`（GE-3..GE-6 FOUNDATION/BACKEND 验收记录）
6. `packages/domain/src/idea-to-novel-graph.ts`（两张权威 Graph + `GraphNodeInputContract`）
7. Graph validator / state / transitions / invalidation / stages：
   - `packages/domain/src/idea-to-novel-graph-validator.ts`
   - `packages/domain/src/idea-to-novel-graph-transitions.ts`
   - `packages/domain/src/idea-to-novel-graph-state.ts` / `-state-validation.ts` / `-invalidation.ts` / `-stages.ts`
8. GraphRunService 与 transaction ports：
   - `packages/application/src/graph-run.ts`、`graph-run-types.ts`
   - `packages/database/src/graph-run-transaction.ts`
9. NodeRunner / NodeSettlementService：
   - `packages/application/src/node-runner.ts`、`node-settlement.ts`、`node-input.ts`、`node-execution-types.ts`
10. node execution repositories 与 migration v12：
    - `packages/database/src/node-execution-repositories.ts`、`task-repository-port-adapter.ts`
    - `packages/database/src/project-database.ts`（migration v12）
11. Worker recovery / bootstrap / task scheduler：
    - `apps/worker/src/index.ts`、`recovery-bootstrap.ts`、`graph-task-runner.ts`
12. CHAPTER_DRAFT task engine 及其测试：
    - `packages/task-engine/src/chapter-generation.ts`、`chapter-generation.test.ts`
13. **PR #39 conversation / reviews**（`gh pr view 39`、`gh pr view 39 --json reviews`，含三轮 Principal Architect review）

## 8. 代码入口与测试地图

| 能力                                     | 入口文件                                                                            | 关键函数/类型                                                                                                              | 主要测试                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Graph kernel                             | `packages/domain/src/idea-to-novel-graph.ts`                                        | `IdeaToNovelProjectGraphV1` / `ChapterGenerationGraphV1`、`GraphNodeDefinition`、`GraphNodeInputContract`、`canonicalJson` | `idea-to-novel-graph.test.ts`、`canonical-json.test.ts`       |
| 唯一状态变更路径                         | `packages/domain/src/idea-to-novel-graph-transitions.ts`                            | `applyNodeSuccess/Failure`、`request/applyHumanDecision`、`applyArtifactChange`                                            | `idea-to-novel-graph-transitions.test.ts`                     |
| validator + input contract 语义          | `packages/domain/src/idea-to-novel-graph-validator.ts`                              | `validateGraph`、`nodeById`、`INVALID_INPUT_CONTRACT`                                                                      | `idea-to-novel-graph-validator.test.ts`                       |
| GraphRunService + ports                  | `packages/application/src/graph-run.ts` / `graph-run-types.ts`                      | `GraphRunService`、`GraphRunTransactionRepositories`（`taskRepo` / `artifactProvenanceRepo`）                              | `packages/application/src/graph-run*.test.ts`                 |
| execution claim（initial + infra retry） | `packages/application/src/node-runner.ts`                                           | `claimExecution`、`reconcileTaskBackedRunning`、sync lease、`NodeRunnerDeps`                                               | `node-runner.test.ts`（21 tests）                             |
| canonical input snapshot                 | `packages/application/src/node-input.ts`                                            | `computeNodeInputSnapshot`、`serializeInputSnapshot`、`inputHashOf`                                                        | `node-input.test.ts`（8 tests）                               |
| atomic settlement / failure              | `packages/application/src/node-settlement.ts`                                       | `settleNodeExecution`、`failExecutionAndNodeInTransaction`、`validateEnvelope`                                             | `node-runner.test.ts` + 集成                                  |
| execution/task 类型与 ports              | `packages/application/src/node-execution-types.ts`                                  | `NodeExecutionRecord`、`SyncNodeExecutor`、`TaskBackedNodeExecutor`、`INFRA_RETRYABLE_CODES`                               | —                                                             |
| migration v12 + repos                    | `packages/database/src/project-database.ts` / `node-execution-repositories.ts`      | activation/attempt、partial unique、`create()` UNIQUE 分类、`getByTaskId`、`getByArtifactId`                               | `node-execution-integration.test.ts`（16 tests，真实 SQLite） |
| taskRepo 入事务契约                      | `packages/database/src/task-repository-port-adapter.ts`、`graph-run-transaction.ts` | `TaskRepositoryPortAdapter`、tx wiring                                                                                     | 同上集成测试                                                  |
| CHAPTER_DRAFT 任务终态                   | `packages/task-engine/src/chapter-generation.ts`                                    | `executeChapterDraft`、`compensateFinalization`、`saveOrVerifySame`                                                        | `chapter-generation.test.ts`（7 tests）+ 集成                 |
| Worker 恢复/READY/重调度                 | `apps/worker/src/index.ts` / `recovery-bootstrap.ts` / `graph-task-runner.ts`       | `recoverGraphRuns`、`runProjectRecovery`、`bootWorkerStartup`、`scheduleGraphTask`                                         | `recovery.integration.test.ts`（3 tests）                     |

## 9. Claude 接手后的第一步

**Claude first action: independently review PR #39 at its current head.**

具体顺序：

1. 核对 PR head（`c5def0d`）、base（main `2f93ccd`）、CI 状态（run `30888262527`）；
2. 阅读全部 Principal Architect reviews（RW-1 / R5 / R5-R2 三轮）；
3. 对 R5-R2 的 **transaction、artifact provenance、recovery、concurrency tests** 做独立代码审查；
4. 决定 **ACCEPT** 或 **REWORK**；
5. **不得直接开始 GE-3**；
6. 只有 merge + post-merge acceptance 后才规划 GE-3。

## 10. 验证命令（真实 clean-checkout 序列）

```bash
unset WRITING_EXPERIMENT_LIVE
find . -name dist -type d -prune -exec rm -rf {} +
pnpm install --frozen-lockfile
pnpm check
git diff --check
pnpm package
pnpm --filter @ai-novel/desktop smoke-test
```

## 11. 已知风险与未决问题

- PR #39 **尚未最终 acceptance**（Draft 未合并，main 不含 RW-1）；
- **43 个 changed files、约 6.6k additions**，必须按边界分段审查；
- GE-3～GE-6 的真实 executor / UI / E2E **尚未实现**；
- main 与 PR branch 的能力必须严格区分；
- **不要因为 CI 绿就跳过架构复验**。

## 12. 状态文档同步

`docs/development/graph-engineering-roadmap.md`、`current-project-state.md`、`post-merge-acceptance.md`
均已使用 "Draft PR / 待验收" 的准确措辞（对应标签：`ON DRAFT PR #39` / `NOT STARTED`），
未把 Draft 内容描述为 main 已具备。**仅当内容确实过期时做最小修改**；修改时必须显式使用标签
`MERGED ON MAIN` / `ON DRAFT PR #39` / `NOT STARTED`。
