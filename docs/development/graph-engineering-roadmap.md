# Graph Engineering Roadmap — Idea-to-Novel 统一路线

> Status: ACTIVE（本文件是仓库**唯一**路线文档）
> Effective date: 2026-08-04
> 本文件取代并收束旧规划文档：`roadmap.md`（M0–M8）、`generation-quality-roadmap.md`（R0.1–R6）、
> `idea-to-novel-migration-plan.md`（P1–P11 / Cycle 1–3）、`current-state.md`、`docs/product/PRD.md` 等，
> 这些文档已按 GE-0 决策删除（见 §9）。质量基线折入 §10。
> 任何"当前状态 / 下一步 / 验收标准"在仓库中只有一个答案：当前状态见 `current-project-state.md`，
> 下一步与验收标准见本文档的"当前推进位置"。

---

## 1. 权威层级

低层不得与高层冲突；任何流程细节以 Graph Definition 为准，而非旧流程文档。

```text
L1  PRODUCT_DIRECTION.md                        产品方向（最高权威，ACCEPTED 2026-08-03）
L2  docs/product/idea-to-novel-v1.md            产品 1.0 纵向切片规格
L3  packages/domain/src/idea-to-novel-graph.ts  流程权威：
                                                IdeaToNovelProjectGraphV1 + ChapterGenerationGraphV1
                                                （+ idea-to-novel-graph-state / -transitions /
                                                  -state-validation / -validator / -invalidation / -stages）
L4  docs/development/*                          本文档（统一路线）、current-project-state（单一状态）、
                                                module-boundaries、decision-log、quality-gates、testing-strategy …
```

- L3 是唯一流程权威：节点的输入输出、转移、人工 Gate、预算、循环、终态、失效传播全部由两张 Graph 定义。
- L4 中的任何 roadmap / state / boundary / 验收描述与 L3 冲突时，以 L3 为准。
- `WorkflowStage` 是派生 UI 投影（`idea-to-novel-graph-stages.ts`），**永不作为权威状态**；
  下一个可执行节点以 `possibleNextNodes`（`idea-to-novel-graph.ts`）为准。

## 2. 主链

```text
模糊想法
→ Idea Intake（IDEA_CAPTURE / SPEC_EXTRACT / ASK_QUESTION / COLLECT_ANSWER）
→ CreationSpec（可编辑；SPEC_EXTRACT 产出 creationSpec artifact）
→ Research Decision（RESEARCH_DECISION：无需 / 轻量 / 深度）
→ Web Research（RESEARCH_PLAN / RESEARCH_EXECUTE → researchBundle artifact）
→ StoryBlueprint（BLUEPRINT_GENERATE → storyBlueprint artifact；BLUEPRINT_USER_GATE 显式接受）
→ PROJECT_READY
→ Chapter Generation（每章一个 ChapterGenerationRun：
     CHAPTER_PLAN → DRAFT → 三 Critic 并行 → CRITIQUE_JOIN → REWRITE 循环
     → CANDIDATE_GATE → MANUSCRIPT_COMMIT → CHAPTER_READY）
→ Manuscript 工作区（查看 / 编辑 / 局部重写 / 重新生成 / 下一章）
→ TXT / Markdown 导出
```

一次 **ProjectRun** 只推进到"蓝图被用户明确接受"（PROJECT_READY）；一次 **ChapterGenerationRun** 只生成
一个章节或明确生成单元（绑定 `blueprintChapterId` 与项目级输入引用）；"继续生成下一章"由 application 层创建新的
ChapterGenerationRun。

## 3. 锁定工程不变量（全 GE 生效，不可回退）

1. 不重新引入单体 workflow；`WorkflowStage` 永不作为权威状态（仅派生 UI 投影）。
2. **任何 Graph 状态变化只能经已合并的 Domain transition**（`applyNodeSuccess` / `applyNodeFailure` /
   `requestHumanDecision` / `applyHumanDecision` / `applyArtifactChange`）。Renderer、Worker、Task Engine 均不得
   直接拼装或修改 Graph state；模型 / 任务结果不能直接推进 Graph。
3. 一次 ChapterGenerationRun 只对应一个章节/明确生成单元；Scene Plan 是内部 artifact。
4. 人工 Gate 处：用户拒绝 / 重写 / 预算耗尽时**不得自动接受或提交**。
5. 生成候选 ≠ 权威稿件；仅经 `MANUSCRIPT_COMMIT`（用户显式接受）后可写 Manuscript。
6. 不为命名 / 架构纯洁度重写已可复用的稳定资产（Grill 内部命名、Creation Contract 快照基座、Manuscript 后端、评测 harness）。
7. 每 GE 小步可合并；每次合并后主线 `pnpm check` 可运行。

## 4. GE 推进总览

| GE   | 名称                                  | 核心交付                                                                             | 涉及 Graph                                                                                     | 退出条件                                                                        |
| ---- | ------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| GE-0 | 权威文档收束                          | 本路线 + 单一状态 + 模块边界 + 决策日志；旧规划删除；两张 Graph 合入 main            | —                                                                                              | 仓库"当前状态/下一步/验收标准"只有一个答案；`pnpm check` 绿                     |
| GE-1 | Durable Graph Runtime Kernel          | GraphRunService + Repository Ports + run 持久化（v8）+ 原子 transition/CAS/幂等/恢复 | 全部节点（状态机内核）                                                                         | run 全量状态持久化往返、CAS 冲突、幂等、恢复、answer receipt 原子性测试绿       |
| GE-2 | 双 Graph Walking Skeleton             | 确定性 fake executors 跑通两图全路径 + 全部终态 + 故障注入                           | 全部节点                                                                                       | 双图全路径 + 重启恢复/fan-out/失败/取消/blocked/human interrupt/bounded loop 绿 |
| GE-3 | 真实 Idea Intake + CreationSpec       | Grill→Idea Intake 适配；answer receipt 契约；CreationSpec 编辑与失效                 | IDEA_CAPTURE / SPEC_EXTRACT / ASK_QUESTION / COLLECT_ANSWER / INTAKE_ESCALATION                | Intake→CreationSpec 真实路径端到端绿                                            |
| GE-4 | 真实 Web Research + ResearchBundle    | research-engine；none/light/deep；ResearchBundle 版本化；V1 安全边界                 | RESEARCH_DECISION / RESEARCH_PLAN / RESEARCH_EXECUTE / RESEARCH_VALIDATE / RESEARCH_ESCALATION | 三档真实调研 + 安全边界测试绿                                                   |
| GE-5 | StoryBlueprint + PROJECT_READY        | Blueprint 聚合/生成/显式接受/改写循环/升级；PROJECT_READY 入口                       | BLUEPRINT_GENERATE / BLUEPRINT_USER_GATE / BLUEPRINT_ESCALATION / PROJECT_READY                | Project Graph 从模糊想法真实运行到 READY/BLOCKED/CANCELLED                      |
| GE-6 | Chapter Graph 真实生成节点            | CHAPTER_PLAN/DRAFT/三 Critic/REWRITE 接 Task Engine + Model Gateway；Join 聚合       | CHAPTER_PLAN / DRAFT / 三 CRITIC / CRITIQUE_JOIN / REWRITE / CANDIDATE_GATE                    | 真实章节生成到 CANDIDATE_GATE 全链绿                                            |
| GE-7 | MANUSCRIPT_COMMIT + 稿件工作区 + 导出 | 稿件写入门禁；编辑器/版本/CAS/autosave/导出；重启恢复                                | MANUSCRIPT_COMMIT / CHAPTER_READY                                                              | 稿件工作区 + 导出闭环绿；无静默覆盖测试绿                                       |
| GE-8 | 产品 1.0 端到端验收                   | 全链真实路径 + 故障注入 + 恢复验证                                                   | 全部（端到端）                                                                                 | 真实路径通过才算 V1 完成                                                        |
| GE-9 | 质量与长篇增强                        | Story State Ledger、摘要、检索上下文、偏好、多候选、Critic 基准等派生层              | 派生层（不反阻塞闭环）                                                                         | 增强能力在稳定基线上可重建、可替换、有评测证据                                  |

## 5. GE-0 — 权威文档收束（当前阶段）

**前置**：两张 Graph 合入 main（PR #32 已合并，main `54c6b31`）。

**交付**：

- 本路线文档（唯一 roadmap）。
- `current-project-state.md` 重写为唯一状态文档。
- `module-boundaries.md` 重写为 Graph 中心边界。
- `decision-log.md` 追加 2026-08-04 决策并并入 `technical-decisions.md` 缺失决策。
- `data-model.md` / `system-overview.md` 精简修正。
- `README.md` / `PRODUCT_DIRECTION.md` 指向权威层级。
- 删除旧规划文档（见 §9）。

**退出条件**：仓库中"当前状态 / 下一步 / 验收标准"只有一个答案；`pnpm check` + `git diff --check` 绿。

## 6. GE-1 — Durable Graph Runtime Kernel

**前置**：GE-0（两张 Graph 已在 main）。

**涉及 Graph 节点**：全部节点（本 GE 建立状态机内核，不做节点实现）。

**输入输出 artifact**：run 完整状态（graphId/version、nodeStatuses、frontier、nodeOutcomes、artifacts、
pendingHumanDecision、attemptBudget、consumedEdges、invalidatedArtifacts、terminalStatus、createdAt）。

**持久化变化**：project.sqlite migration **v8** —— 统一 `graph_runs` 表（kind 判别）+ `graph_run_commands`
幂等日志表；`state_json` 存完整校验后的 run 状态；`expected_version` 独立列作 CAS 守卫；chapter-only 绑定列
（creationSpecVersionId / researchBundleId / storyBlueprintId / blueprintChapterId）+ CHECK + 索引。

**人工 Gate**：`requestHumanDecision` / `applyHumanDecision`（intake answer 走 answer receipt 契约：
同事务先写权威 answer 存储得 AnswerReceiptId 再推进 Graph；skip/finish 不写）。

**失败与恢复**：节点失败 → `applyNodeFailure`（fan-out 取消其余，run 终态 failed）；重启恢复 `recoverInFlightRuns`
对 active 节点执行 fail 路径（安全可重放）；`waiting_for_human` 不触碰；预算耗尽由 domain 路由到升级节点，内核跟随。

**失效传播**：`applyArtifactChange` 按 Graph `artifactDownstreamOrder` 传播。

**非目标**：无真实执行器/模型调用、无 renderer、无 research/blueprint/generation 节点、WorkflowStage 不作为状态、
无 task-engine 强耦合、无用户强制取消在途 run（领域无通用 cancelRun）。

**测试证据**：repository 往返（JSON 保真 + 跨图身份拒绝）、事务原子性（回滚/嵌套/receipt 原子性）、service
（STATE_CONFLICT / fan-out failure / 幂等 / CAS 冲突 / 跨图拒绝 / run 边界）、recovery（active→failed /
waiting 不动 / 幂等）、worker handlers + reconcile、contracts 校验器。

**退出条件**：上述测试全绿；`pnpm check` 绿。

## 7. GE-2 — 双 Graph Walking Skeleton

**前置**：GE-1。

**涉及 Graph 节点**：全部（确定性 fake executors：EXTRACT / CLARIFY_ASK / PLAN / RESEARCH / GENERATE / CRITIC /
REWRITE / DECISION；USER_GATE→pending 人工决策）。

**输入输出 artifact**：各节点 output contract 的 fake 产物（idea / creationSpec / researchBundle / storyBlueprint /
generationRun / manuscript + 各 outcome）。

**持久化变化**：复用 GE-1 v8；新增确定性执行器注册（测试内 fake）。

**人工 Gate**：COLLECT_ANSWER（intake_response）、INTAKE_ESCALATION、RESEARCH_ESCALATION、BLUEPRINT_USER_GATE、
BLUEPRINT_ESCALATION、CANDIDATE_GATE、CANDIDATE_ESCALATION —— 由测试注入决策。

**失败与恢复**：覆盖重启恢复、fan-out/fan-in、失败、取消、blocked、human interrupt、bounded loop。

**失效传播**：验证 artifact 变更级联（creationSpec→researchBundle→storyBlueprint；generationRun→manuscript）。

**非目标**：不实现真实节点逻辑、不接模型、UI 只显示用户当前需要理解与操作的内容，不暴露 Graph 控制台 / 节点调试器 /
Token 内部状态。

**测试证据**：Project Graph 全路径（Idea Intake answer/skip/finish、escalation、modify_idea 循环、clarification 预算、
Research none/light/deep、invalid 重试、升级、Blueprint rewrite 循环、gate、升级、全部终态）；Chapter Graph 全路径
（plan→draft→三 Critic 并行→join→gate→commit→ready、rewrite 循环、reject/regenerate、升级、全部终态）。

**退出条件**：双图全路径测试绿；`pnpm check` 绿。

## 8. GE-3 — 真实 Idea Intake + CreationSpec 节点

**前置**：GE-2（骨架）+ GE-1（内核）。

**涉及 Graph 节点**：IDEA_CAPTURE / SPEC_EXTRACT / ASK_QUESTION / COLLECT_ANSWER / INTAKE_ESCALATION。

**输入输出 artifact**：`idea`（初始想法自动播种自 `projects.initial_idea`）；`creationSpec`（SPEC_EXTRACT 产出，
可编辑）。

**持久化变化**：复用现有 `grill_sessions` / `grill_questions` / `grill_answers`（R1 默认不新建表）；
修复 `grill.listQuestions` / `grill.markQuestionAsked` 死链；answer receipt 写入 grill_answers；
CreationSpec 复用 Creation Contract 快照/版本/provenance 基座。

**人工 Gate**：COLLECT_ANSWER（answer/skip/finish，自然对话式）；INTAKE_ESCALATION（continue_with_current_spec /
modify_idea / cancel / continue_later）。

**失败与恢复**：回答先落权威存储再推进 Graph（同事务）；应用重启恢复。

**失效传播**：CreationSpec 更新 → 按 Graph 规则失效 researchBundle / storyBlueprint / 后续 GenerationRun。

**非目标**：用户不接触 session / proposal / 字段锁等工程概念；不做物理重命名 grill 表。

**测试证据**：Intake→CreationSpec 真实路径端到端（播种、追问、answer/skip/finish、receipt 原子性、编辑、失效级联）。

**退出条件**：Intake→CreationSpec 真实路径端到端绿；`pnpm check` 绿。

## 9. GE-4 — 真实 Web Research + ResearchBundle

**前置**：GE-2（骨架）；GE-1（内核）。

**涉及 Graph 节点**：RESEARCH_DECISION / RESEARCH_PLAN / RESEARCH_EXECUTE / RESEARCH_VALIDATE / RESEARCH_ESCALATION。

**输入输出 artifact**：`researchBundle`（问题计划、来源记录、事实笔记与来源绑定、结论；版本化）。

**持久化变化**：`research-engine` 替换 stub（WebSearchPort / WebFetchPort / ResearchRepository / ResearchOrchestrator）；
新 migration（ResearchBundle 表）；新增 `RESEARCH_RUN` 任务类型；secret-store 增 search key 槽位；contracts 通道 + worker dispatch。

**人工 Gate**：调研问题计划用户增删跳过；RESEARCH_ESCALATION（use_current_research / skip_research / modify_requirements /
cancel / continue_later）；预算耗尽人工升级。

**失败与恢复**：搜索/抓取任务持久化、校验重试（research_retry_budget）、失败恢复、启动恢复。

**失效传播**：ResearchBundle 更新 → 失效 storyBlueprint 及后续 GenerationRun。

**安全边界（V1 不延后）**：仅 http/https；拒绝 private/loopback/link-local（含 DNS 解析后）；重定向后重新校验；
限制响应字节数与 content-type；连接/读取超时；拒绝 URL credentials；保留提取文本/事实笔记，不永久保存原始 HTML。

**非目标**：1.0 不建设知识图谱、通用 RAG 平台或无限自动搜索。

**测试证据**：none/light/deep 三档真实路径；来源记录/事实笔记绑定；来源排除；V1 安全边界测试；失败与重试；失效传播。

**退出条件**：三档真实调研 + 安全边界测试绿；`pnpm check` 绿。

## 10. GE-5 — StoryBlueprint + PROJECT_READY

**前置**：GE-3（CreationSpec）、GE-4（ResearchBundle）。

**涉及 Graph 节点**：BLUEPRINT_GENERATE / BLUEPRINT_USER_GATE / BLUEPRINT_ESCALATION / PROJECT_READY /
PROJECT_BLOCKED / PROJECT_CANCELLED。

**输入输出 artifact**：`storyBlueprint`（核心前提、人物、关系、世界背景、冲突、情节线、章节结构、每章目标；版本化）。

**持久化变化**：Blueprint 聚合 + 版本表 + 生成任务（prompt `blueprint-generate-v1`）。

**人工 Gate**：BLUEPRINT_USER_GATE（accept → PROJECT_READY；request_rewrite 循环；升级）；BLUEPRINT_ESCALATION
（accept_current / modify_requirements / cancel / continue_later）。

**失败与恢复**：改写循环（blueprint_rewrite_budget）；预算耗尽 → 升级；失败 → PROJECT_BLOCKED/CANCELLED。

**失效传播**：CreationSpec / ResearchBundle 变化 → 失效 storyBlueprint；必须重新生成。

**非目标**：蓝图不接受则不得形成 PROJECT_READY。

**测试证据**：只有已接受 CreationSpec + ResearchBundle（或明确 no-research）才能 PROJECT_READY；从模糊想法真实运行到
PROJECT_READY / PROJECT_BLOCKED / PROJECT_CANCELLED。

**退出条件**：Project Graph 从模糊想法真实运行到三种终态；`pnpm check` 绿。

## 11. GE-6 — Chapter Graph 真实章节生成节点

**前置**：GE-5（PROJECT_READY + 蓝图章节入口）。

**涉及 Graph 节点**：CHAPTER_PLAN / DRAFT / CONTINUITY_CRITIC / STYLE_CRITIC / REQUIREMENT_CRITIC /
CRITIQUE_JOIN / REWRITE / CANDIDATE_GATE。

**输入输出 artifact**：`generationRun`（一次章节生成运行；Scene Plan 为内部 artifact）。

**持久化变化**：接持久化 Task Engine + Model Gateway（prompt：`chapter-plan-v1` `draft-generate-v1`
`continuity-critic-v1` `style-critic-v1` `requirement-critic-v1` `rewrite-v1`）；新增生成任务类型与产物表。

**人工 Gate**：CANDIDATE_GATE（accept → MANUSCRIPT_COMMIT；reject → DRAFT 循环；request_rewrite → REWRITE 循环；
预算耗尽 → CANDIDATE_ESCALATION）。

**失败与恢复**：一次 run 只生成一个章节/明确生成单元；模型/任务结果必须经 Domain transition 才能推进 Graph；
fan-out 半完成恢复；预算耗尽升级。

**失效传播**：generationRun 变化 → 失效 manuscript（需重新提交）。

**非目标**：用户拒绝/重写/预算耗尽时不得自动接受或提交；PlotPilot 只作可替换 adapter，不进入不可替代关键路径。

**测试证据**：真实章节生成到 CANDIDATE_GATE 全链（三 Critic 真正并行、Join 只聚合三个已完成来源、rewrite 循环、
gate 决策、终态）。

**退出条件**：真实章节生成全链绿；`pnpm check` 绿。

## 12. GE-7 — MANUSCRIPT_COMMIT + 稿件工作区 + 导出闭环

**前置**：GE-6（生成候选）+ Manuscript 后端（main 已有，DB v7）。

**涉及 Graph 节点**：MANUSCRIPT_COMMIT / CHAPTER_READY / CHAPTER_BLOCKED / CHAPTER_CANCELLED。

**输入输出 artifact**：`manuscript`（权威稿件；仅用户显式接受并完成 MANUSCRIPT_COMMIT 后写入）。

**持久化变化**：复用 immutable manuscript/chapter versions、CAS、append-only chapter_versions；transport/renderer
从 PR #25 模式选择性移植；autosave；TXT/Markdown 导出（import-export 替换 stub）。

**人工 Gate**：CANDIDATE_GATE accept → MANUSCRIPT_COMMIT；下一章 → 新 ChapterGenerationRun。

**失败与恢复**：重启恢复；未保存 buffer 处理；无静默覆盖（CAS + 版本化 + 显式写入）。

**失效传播**：上游 CreationSpec/ResearchBundle/Blueprint 变化 → 失效 generationRun/manuscript（需重新提交）。

**非目标**：严格维持"生成候选 ≠ 权威稿件"。

**测试证据**：稿件工作区 + 导出闭环；防覆盖手写正文；重新生成保留旧版本；重启恢复。

**退出条件**：稿件工作区 + 导出闭环绿；`pnpm check` 绿。

## 13. GE-8 — 产品 1.0 端到端验收

**前置**：GE-3..GE-7 真实路径。

**验收路径**：模糊想法 → 少量追问 → CreationSpec → 必要调研 → ResearchBundle → StoryBlueprint → 完整章节生成 →
用户修改 → 继续生成 → 导出。

**故障注入**：模型中断、搜索中断、应用强制退出、human gate 等待重启、fan-out 半完成、CAS 冲突、Graph 版本不匹配、
预算耗尽、artifact stale。

**验证目标**：用户原始输入不丢失；手写正文不被静默覆盖；任意阶段可恢复。

**退出条件**：这条真实路径通过才算 V1 完成。

## 14. GE-9 — 质量与长篇增强

**前置**：GE-8（稳定基线）。

**增强能力**（作为可重建 / 可替换的派生层，消费权威正文与 Graph artifacts）：Story State Ledger、章节摘要、
动态检索上下文、人物知识范围、关系与状态、时间线、伏笔与未解决线程、Writer Preference Profile、多候选生成、
自动指标、Critic 质量基准、人工盲评、PlotPilot 对比实验、精确局部修订。

**约束**：不得反向阻塞 GE-1..GE-8 的产品闭环。

**退出条件**：增强能力在稳定基线上可重建、可替换、有评测证据。

## 15. 当前推进位置

> **Post-Merge Architecture Acceptance（2026-08-04）**：GE-3/4/5/6 的原始退出条件未达成。
> 已交付的是 FOUNDATION / BACKEND 能力；Graph 节点真实 executor、运行时接线、产品 UI 与 E2E 均为后续。
> 详见 `docs/development/post-merge-acceptance.md`。**在 GE-6 原退出条件通过前，下一步不写 GE-7。**
>
> **更新（2026-08-07，B3/PR #42）**：GE-3 原退出条件（Intake→CreationSpec 真实路径端到端绿）已达成；
> 产品 UI 按 D8 拆分为独立批次 B4。GE-4/5/6 判定不变。

| GE                                  | 状态                | FOUNDATION | BACKEND                               | RUNTIME_WIRING（节点 executor）                | PRODUCT_UI | E2E             |
| ----------------------------------- | ------------------- | ---------- | ------------------------------------- | ---------------------------------------------- | ---------- | --------------- |
| GE-0 文档收束                       | ✅ COMPLETE         | ✅         | —                                     | —                                              | —          | —               |
| GE-1 Runtime Kernel                 | ✅ COMPLETE（内核） | ✅         | ✅                                    | ✅（内核即运行时层；无节点 executor 属预期）   | —          | —               |
| GE-2 Walking Skeleton               | ⚠️ PARTIAL          | ✅         | ✅                                    | ❌（仅测试 fake runner，worker 非测试零引用）  | ❌         | ⚠️ 骨架测试达成 |
| GE-3 Idea Intake + CreationSpec     | 🟡 WIRING+E2E 达成  | ✅         | ✅（intake.* helper）                 | ✅ 五节点真实 executor（B3，PR #42，v13）      | ❌（B4）   | ✅ 真实链路 E2E |
| GE-4 Web Research + ResearchBundle  | 🔶 REWORK           | ✅         | ✅（research.execute, fake provider） | ❌ 节点未接                                    | ❌         | ❌              |
| GE-5 StoryBlueprint + PROJECT_READY | 🔶 REWORK           | ✅         | ✅（blueprint.*）                     | ❌ 节点未接；accept 与 Graph gate 非原子       | ❌         | ❌              |
| GE-6 Chapter 生成节点               | 🔶 REWORK           | ✅         | ✅（CHAPTER_DRAFT 任务引擎）          | ❌ 无 executor / 无 settlement 接线            | ❌         | ❌              |
| RW-1 执行与 Settlement 桥           | ✅ MERGED ON MAIN   | ✅         | ✅                                    | ✅（跨阶段门禁本体；节点 executor 属 GE-3..6） | —          | ✅ 真实 SQLite  |

- **当前状态**：见 `docs/development/current-project-state.md`（唯一状态文档）。
- **RW-1（跨阶段门禁，GE-3..GE-6 共同依赖）— MERGED ON MAIN**：Durable Node Execution & Settlement
  Bridge —— 持久化 execution 模型（migration v12）、Executor Registry、NodeRunner、
  NodeSettlementService（唯一非人工节点完成路径，同事务原子）、ArtifactResolver 严格边界、
  task 产物持久化、按 recoveryPolicy 恢复、关闭伪造节点完成通道。
  **验收记录**：2026-08-05 独立验收先判 REWORK（3 blocker：artifact provenance 登记与校验时序死锁导致
  除 generationRun 外无 artifact 可结算、lease 抢占绕过 infra 重试上限、基础设施瞬时错误被判为确定性失败
  而永久杀死 run），返工并补齐对应回归测试后复查 ACCEPT，PR #39 合并（merge commit `ec1e8e7`）。
- **已完成批次**（批次定义见 `docs/development/takeover-plan-2026-08-05.md`）：
  - **B0** ✅：D1–D9 决策落地与文档同步（PR #40，2026-08-07）；
  - **B1** ✅：Model Gateway 多 provider 最小形态（D6；PR #41 + 鉴权头补丁 `9f98278`，2026-08-07）；
  - **B3** ✅：GE-3 wiring：五节点真实 executor + SPEC_EXTRACT 任务执行器（v13）+ 真实链路 E2E
    （PR #42，2026-08-07；对抗式复查 REWORK 3 blocker → 修复 `e73f5ab` → ACCEPT；
    TD-019/020 同批解决，随行登记 TD-022..025）。
- **下一步（依依赖顺序）**：
  - **B4**：GE-3 UI：App shell 旅程改造 + 对话式访谈 + CreationSpec 编辑器（D8；可顺带消化 TD-022/024）；
  - **B5/B6**：补完 GE-4：Tavily provider（D7，需负责人提供 API key）+ Research 节点闭环 + Research UI；
  - **B7/B8**：补完 GE-5：真实 Blueprint executor + 模糊想法→PROJECT_READY E2E + 蓝图 UI；
  - **B9/B10**：补完 GE-6：PLAN/DRAFT/三 Critic/JOIN/REWRITE/GATE 全部真实 executor，运行至 CANDIDATE_GATE；
  - **仅 GE-6 原退出条件通过后才启动 GE-7 MANUSCRIPT_COMMIT**（D9）。

## 16. 已删除的历史资料

按 GE-0 决策（2026-08-04）删除以下被取代的旧规划文档；内容如需追溯可查 git 历史：

| 文档                                                                     | 取代者                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `docs/development/roadmap.md`（M0–M8）                                   | 本文件                                                      |
| `docs/development/generation-quality-roadmap.md`（R0.1–R6）              | 本文件（质量基线折入 §16）                                  |
| `docs/development/idea-to-novel-migration-plan.md`（P1–P11 / Cycle 1–3） | 本文件（资产审计证据折入各 GE）                             |
| `docs/development/current-state.md`                                      | `current-project-state.md`                                  |
| `docs/product/PRD.md`                                                    | `PRODUCT_DIRECTION.md` + `docs/product/idea-to-novel-v1.md` |
| `docs/architecture/state-machine.md`                                     | L3 Graph Definitions（唯一状态机）                          |
| `docs/architecture/technical-decisions.md`                               | `decision-log.md`（并入后删除）                             |

## 17. 质量基线（GE-9 起点）

沿用 Evaluation Harness（`packages/writing-evaluation` + `apps/writing-experiment-runner`）。已冻结 baseline
（`baseline-one-shot-v1`，3 cases / 1 rater）：

```text
continueReading: 3.67   expectationFit: 4.33   characterCredibility: 4.33
languageNaturalness: 3.33  aiSmellAbsence: 2.67   plotProgression: 3.67
concision: 4.00   continuity: 4.33
```

证据边界：这是 absolute baseline，非 A/B；不证明策略优越。最明显质量风险：AI 味（2.67）、语言自然度（3.33）。
新的付费质量实验继续暂缓，直到 GE-3..GE-7 真实纵向链路形成后启动（每 case ≥2 候选、baseline vs new pipeline、
≥2 名独立评分者、增加题材覆盖、计算评分者间一致性）。
