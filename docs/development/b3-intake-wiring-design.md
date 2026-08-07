# B3 — GE-3 Idea Intake 节点接线设计（决策记录）

> 状态：ACTIVE（B3 实现期间的工作设计，随 PR 入库）
> 决策人：Fable（Principal Architect，项目负责人授权）
> 日期：2026-08-07
> 事实依据：feat/b3-ge3-intake-wiring @ `03e241c`（TD-019/020 已落地）之侦察地图

## 1. 五节点执行策略

| 节点              | 策略                                                                 | 说明                                                                                                                                                                                                                                                                                                                               |
| ----------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IDEA_CAPTURE      | **sync executor**                                                    | 读 `project_metadata.initial_idea`（权威源）；无活跃 intake session 则 `createIntakeSessionFromIdea` 播种；**idea artifact = grill session 行**（artifactId=sessionId, version=1）。modify_idea 回环时建新 session → 新 artifactId，规避 provenance (kind,id) 唯一闸门。recoveryPolicy=replayable。                                |
| SPEC_EXTRACT      | **task-backed executor**（新任务类型 `SPEC_EXTRACT`，migration v13） | prepareTask 纯函数只写引导 payload（不含 prompt 文本）；任务执行侧（task-engine `executeSpecExtract`）自行从 DB 装配上下文（idea/goal + 全部当前 Q&A）→ 模型一次调用产出：`decision(ask_more                                                                                                                                       | spec_complete)`+ 结构化 CreationSpec + **下一批追问问题（decision=ask_more 时）**。持久化：新`creation_contract_versions`行（created_by='ai-proposal-accepted'，provenance_json 记 task/invocation）+ 问题写`grill_questions`；envelope：artifactKind='creationSpec'、artifactId=版本 id、outcome={clarification_remaining, decision}。recoveryPolicy=settle_if_result。 |
| ASK_QUESTION      | **sync executor**                                                    | 取 session 中最早 PENDING 问题 `markQuestionAsked`；NodeOutput={}（图契约 noOut）。**模型调用已合并进 SPEC_EXTRACT**（减半调用次数，贴合"只追问必要问题"）；图上声明的 `prompt:ask-question-v1` 暂无运行时消费者（与全仓 promptId 现状一致），本 PR 记录该偏离。若无 PENDING 问题（数据异常）→ 抛错走 EXECUTOR_ERROR fail-closed。 |
| COLLECT_ANSWER    | **无 executor**（human gate）                                        | `parkHumanNodes`（settlement 后自动挂起）+ 既有 `graph.applyHumanDecision`（answer receipt 原子契约，GE-1 已建成）。                                                                                                                                                                                                               |
| INTAKE_ESCALATION | **无 executor**（human gate）                                        | 同上，escalation outcome 枚举由 domain 严格校验。                                                                                                                                                                                                                                                                                  |

## 2. 关键机制决策

- **D-B3-1 live drive**：worker 在 `graph.createProjectRun`、`graph.applyHumanDecision` 成功后同步 `await driveRun`；`scheduleGraphTask` 执行任务完成后亦触发一次 `driveRun`（结算 + 推进后续 frontier）。修复"driveRun 只在启动恢复被调用"的缺口。RPC 面不新增通道。
- **D-B3-2 resolver 底层校验补全**：`GraphRunTransactionRepositories` 增读端口：`grillSessionRepo.getById`（idea）与 `creationContractVersionRepo.getById`（creationSpec）；`productionArtifactResolver` 对两 kind 补"存在 + project 匹配"校验（creationSpec 另校验 version 序号一致）。manuscript 仍留 GE-7。
- **D-B3-3 CreationSpec 版本直建**：GE-3 不走 proposal 审批链（PRODUCT_DIRECTION §8 废弃审批门禁）；`executeSpecExtract` 在任务终态事务内直接 create 新 version + current 指针 CAS 推进。`assertSessionAllowsContractDraft`（要求 session COMPLETED）不适用于本路径，不复用 `requestCreationContractProposal`。
- **D-B3-4 prompt 存放**：沿用既有模式——`packages/task-engine/src/spec-extract.ts` 内常量 `SPEC_EXTRACT_SYSTEM_PROMPT` + `buildSpecExtractPrompt(context)` 纯函数；prompt 文本不入库（payloadJson 只存 `{projectId, sessionId}` 引导字段），与 creation-contract-draft 的"prompt 只存在于内存"原则一致。
- **D-B3-5 TaskEngineDeps.invokeModel 扩签名**：增可选 `systemPrompt`（model-gateway 本就支持），SPEC_EXTRACT 用 system/user 分离。
- **D-B3-6 IDEA_INPUT kind 归属**：node-runner 的 `isHumanGateKind` 只含 CLARIFY_ANSWER/USER_GATE，IDEA_CAPTURE 按普通节点由 executor 驱动（与 domain `isHumanInterruptKind` 的宽定义并存不冲突：后者只用于失效传播语义）。不改冻结的 Graph 定义。

## 3. 改动点清单（按依赖序）

1. migration **v13**：tasks CHECK 重建加 `SPEC_EXTRACT`（镜像 v11 模式）；`DbTaskType`/domain `TaskType` 联合同步。
2. `graph-run-types.ts` 事务仓库集合 + database 接线：grill session / creation contract version 读端口。
3. `production-artifact-resolver.ts`：idea/creationSpec 存在性校验。
4. task-engine：`spec-extract.ts`（prompt + 严格解析 + `executeSpecExtract`，镜像 chapter-generation 的 claim/invocation/envelope/补偿模式）。
5. worker：`intake-executors.ts`（IDEA_CAPTURE/ASK_QUESTION sync + SPEC_EXTRACT prepareTask）；`productionRegistry`/`productionRunners` 注册；`graph-task-runner` 按 taskType 分派 + 完成后 driveRun；graph-handlers 两处 live drive。
6. E2E（真实 SQLite）：模糊想法→追问→answer/skip/finish→CreationSpec→编辑失效级联；含跨"重启"（新 deps 实例）恢复与 TD-020 交互。

## 4. 硬约束备忘（来自图定义，违反即 settlement 拒绝）

- SPEC_EXTRACT 必须同时产 outcome+artifact；ASK_QUESTION 二者皆不得产；budget 条件（clarification_budget 等）由引擎推导，executor 禁止产出。
- SPEC_EXTRACT 的 inputHash 含 activationNo 与 clarification 预算 → 回环后旧结果自然 STALE。
- answer 决策必须带 AnswerReceiptId（application 层生成），renderer 永不传原文以外的凭据。
