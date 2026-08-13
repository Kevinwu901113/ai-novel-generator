# B9 — GE-6 章节生成 wiring 设计（2026-08-13）

> 批次定义见 `takeover-plan-2026-08-05.md` §4 B9。本文件是 B9 的设计与决策记录。
> 上游：B7/B8（GE-5 蓝图 wiring + UI，PROJECT_READY 已可达）。
> 下游：B10（GE-6 产品 UI：发起生成 / 进度 / 候选查看 / Gate 决策）。

## 1. 范围

把 `CHAPTER_GENERATION_GRAPH_V1` 上的模型节点全部接成真实 executor，使一个
PROJECT_READY 项目能真实生成一章正文并停在 `CANDIDATE_GATE`：

| 节点                                    | executor kind | 任务类型         | 产出                              |
| --------------------------------------- | ------------- | ---------------- | --------------------------------- |
| CHAPTER_PLAN                            | task_backed   | CHAPTER_PLAN     | ChapterScenePlan（内部 artifact） |
| DRAFT                                   | task_backed   | CHAPTER_DRAFT    | 候选修订 + generationRun artifact |
| CONTINUITY / STYLE / REQUIREMENT_CRITIC | task_backed   | CHAPTER_CRITIQUE | outcome `critique_verdict`        |
| CRITIQUE_JOIN                           | sync          | —                | 由 domain 确定性聚合              |
| REWRITE                                 | task_backed   | CHAPTER_REWRITE  | 新候选修订（图契约 noOut）        |
| CHAPTER_READY / CANCELLED / BLOCKED     | sync          | —                | 终态（销 TD-029-4）               |

**有意不做**：`MANUSCRIPT_COMMIT`（写入权威稿件属 GE-7，锁定不变量第 5 条）；章节生成
产品 UI（B10）；`createChapterRun` 的产品入口（B10，通道与用例 main 已有）。

## 2. 决策

### D-B9-1 候选正文是"修订链"，当前候选 = 同 run 内最大修订号

图定义（已冻结）里 `DRAFT.output = out(null,'generationRun')`，而 `REWRITE.output = noOut`。
即：**改写不产生新 artifact**，整个 rewrite 循环内 `artifacts.generationRun` 恒指向
DRAFT 那一版。因此不能用 artifact ref 定义"当前候选正文"。

落地为 `chapter_candidates` 表（migration v17，append-only）：

- `(graph_run_id, revision_no)` 唯一，`revision_no` 自 1 递增；
- `source='DRAFT'` 的行 `artifact_id` 非空（等于 execution-bound envelope 的 artifactId，
  也是 Graph 的 generationRun artifact id）；`source='REWRITE'` 的行 `artifact_id` 必须为
  NULL —— 这条契约同时钉在 CHECK 约束与 domain 工厂 `createChapterCandidate` 里；
- 所有消费方（三个 Critic、B10 的候选界面、GE-7 的 MANUSCRIPT_COMMIT）一律按
  **run + 最大修订号** 读，不按 artifact ref 读。

`regenerate` 循环（gate reject → DRAFT）产出的是新的 DRAFT 修订，也就是新的
generationRun artifact；envelope 的 `artifactVersion` 取该修订号，保证同 run 内版本号
单调且与 resolver 校验一致。

### D-B9-2 上下文只从权威存储反查，payload 不承载身份

`prepareTask` 只写三个循环预算计数（`rewrite` / `candidateRewrite` / `regenerate`），
用于 prompt 变异提示。任务引擎拿到 taskId 后：`nodeExecutionRepo.getByTaskId` →
`execution.graphRunId` → `graph_runs` 行的 chapter binding（creationSpecVersionId /
storyBlueprintId / blueprintChapterId，`createChapterRun` 写入后不可变）→ 蓝图、目标
章节、创作要求、场景计划、候选修订、审查结论。

理由：与 RW-1 "不信任调用方手拼 context" 同则；也避免 payload 与真实绑定漂移。

### D-B9-3 三个 Critic 共用一个任务类型，角色由权威 execution.nodeId 派生

三个 Critic 的执行体完全同构（同一 prompt 骨架 + 不同审查维度），故共用任务类型
`CHAPTER_CRITIQUE`；**审查维度由 `execution.nodeId` 决定**，payload 里即便写了
`criticRole` 也不生效（有回归测试锁定）。registry 侧仍是三个独立 descriptor
（executorId 各不相同），因为 registry 按 nodeId 查找、settlement 会校验 executor identity。

### D-B9-4 CRITIQUE_JOIN 的 executor 必须返回空产出

图给 JOIN 的 `output` 是 `out('critique_verdict', null)`，但 domain 的 `completeNode`
对带 `joinAggregationPolicy` 的节点**拒绝调用方传入的 outcome**，改为
`aggregateJoinOutcome` 从三个 Critic 的已 succeeded 状态 + 产出确定性聚合
（`all_pass_or_needs_rewrite`）。所以 JOIN executor 只负责触发聚合，产出恒为 `{}`；
"顺手"产一个 verdict 会让 settlement 直接抛错。

### D-B9-5 补齐 Chapter Graph 终态 executor（销 TD-029-4）

`driveRun` 对 TERMINAL kind 无豁免——未注册 executor 时按能力缺口静默跳过，章节 run
会永远停在终态节点 active。B7 已给 Project Graph 补过同样的洞（`project-terminal-executors.ts`），
当时如实记下"Chapter Graph 同样存在"（TD-029-4）。B9 是第一个真正驱动到章节终态的
批次，随批次补齐并有 E2E（cancel → `cancelled`、continue_later → `blocked`）。

### D-B9-6 改写没有用户意见承载（章节侧同 TD-029-1）

`candidate_gate` 的决策 DTO 没有 feedback 字段（与蓝图 gate 同病）。本批次如实处理：
改写 prompt 里带 `userRequestedRewrite: true / userFeedback: null` 并说明"用户未附具体
意见"，**不伪造一条用户意见**。承载 feedback 属 B10（UI 批次），登记 TD-031-2。

### D-B9-7 正文任务抬高输出上限到 8192

网关默认 `max_tokens=4096`，一章中文正文（2500~4000 字，约 1.5 token/字）必然被截断，
截断的 JSON 必然解析失败。`TaskEngineDeps.invokeModel` 增加可选 `maxTokens`，DRAFT 与
REWRITE 传 8192。不取更高是因为 D6 要覆盖的 OpenAI 兼容端点里有硬上限 8192 的实现
（DeepSeek chat），超限会被直接 400——宁可极长章节撞一次解析失败，也不要整类 provider
不可用。

### D-B9-8 严格解析的两条业务边界

- 正文 `content` 下限 200 字符：低于此只可能是占位或截断，不是一章可用正文；
- Critic 判 `needs_rewrite` 时必须至少给一条问题：否则 REWRITE 节点拿不到可执行输入，
  等于白烧一轮 `rewrite` 预算（且用户在 B10 界面上会看到"需要改写"却没有任何理由）。

### D-B9-9 取代 GE-6 base 时期的 `executeChapterDraft`

原 `chapter-generation.ts` 的 `executeChapterDraft` 是 RW-1 时期的脚手架：prompt 由调用方
经 payload 传入、产物只进 execution envelope、不落任何章节领域表、不认识蓝图与场景计划。
B9 用 `chapter-nodes.ts` 的四个执行器整体取代它，原文件只保留仍被四个任务引擎共用的
`compensateFinalization`；对应测试覆盖迁到 `chapter-nodes.test.ts`（补偿助手本身的覆盖
保留在原测试文件）。`packages/database` 的 RW-1 集成测试用例 14 同步改用新执行器，并
真正落库 bp-1 / spec-1 上下文（新执行器在调用模型前会校验上下文）。

## 3. 持久化（migration v17）

```text
chapter_scene_plans   CHAPTER_PLAN 产出（内部 artifact，非 Graph artifact 槽位）
chapter_candidates    候选修订链（见 D-B9-1；CHECK 强制 DRAFT 有 artifact_id、REWRITE 无）
chapter_critiques     每个 Critic 对某个候选修订的结论（(run, revision, critic) 唯一）
tasks                 task_type CHECK 追加 CHAPTER_PLAN / CHAPTER_CRITIQUE / CHAPTER_REWRITE
```

只追加新版本号，未改历史 migration。

## 4. 测试证据

| 层                     | 文件                                                  | 覆盖                                                                                                                                                                                                                                                        |
| ---------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 任务引擎（17）         | `packages/task-engine/src/chapter-nodes.test.ts`      | 三类严格解析边界；四个执行器成功路径与 envelope 形状；角色由 execution.nodeId 派生；上下文缺失确定性失败且不发模型调用；最终事务失败补偿                                                                                                                    |
| executor 注册（7）     | `apps/worker/src/chapter-executors.test.ts`           | 非人工节点全覆盖的结构性守卫；MANUSCRIPT_COMMIT 有意不注册；终态节点已注册；任务类型映射；payload 无身份字段；JOIN 返回空产出                                                                                                                               |
| E2E（10，真实 SQLite） | `apps/worker/src/chapter-e2e.integration.test.ts`     | 全链到 CANDIDATE_GATE；**三 Critic 真并行**（同轮三 execution 在途）；rewrite 循环；rewrite 预算耗尽不自动接受；reject 重新起草；用户改写循环；candidateRewrite 耗尽 → escalation → cancelled / blocked；accept 后 MANUSCRIPT_COMMIT 能力缺口跳过；重启恢复 |
| 补偿助手（3）          | `packages/task-engine/src/chapter-generation.test.ts` | 半成品标记 FAILED / 终态不改写 / 补偿自身失败不外抛                                                                                                                                                                                                         |

`pnpm check` 全绿（152 test files / 3381 tests passed，7 skipped）。

## 5. 不变量自查

1. 无 `graph_runs` 直写：所有推进经 `NodeSettlementService` / `applyHumanDecision`；
2. 未改 `packages/domain/src/idea-to-novel-graph*.ts` 的节点 / 边 / 预算定义；
3. 一次 run 一章：binding 由 `createChapterRun` 写入且执行器只按它反查；
4. 人工 Gate 处不自动接受：rewrite 预算耗尽仍进 CANDIDATE_GATE（E2E 用例 3）；
5. 不写 Manuscript：MANUSCRIPT_COMMIT 无 executor（E2E 用例 8 + 注册测试）；
6. `WorkflowStage` 未被用作权威状态；
7. migration 只追加 v17。

## 6. 随行登记的技术债

见 `tech-debt.md` TD-031（B9 随行三项）与 TD-029-4 的销账记录。
