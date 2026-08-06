# Takeover Execution Plan — GE-3..GE-6 补完 + 多 Provider 网关（2026-08-05）

> 性质：接手执行方案（Handover Plan），由新任 Principal Architect 制定，项目负责人已授权全权决策。
> 本文档**不是**新的权威层级；批次 B0 会把本文的决策正式并入 `decision-log.md` 与
> `graph-engineering-roadmap.md`，之后仍以既有 L1–L4 权威层级为准。
> 阅读前置：`PRODUCT_DIRECTION.md`（L1）、`docs/development/graph-engineering-roadmap.md`、
> `docs/development/current-project-state.md`、`docs/development/post-merge-acceptance.md`。

---

## 0. 给 Planner（Claude Code CLI / Opus 5）的角色说明

- 你负责：逐批次做详细 plan、设计接口签名、拆分任务、review 每个 diff、把关合并门禁。
- 执行层分工沿用仓库根 `CLAUDE.md` 的既有约定（Opus 架构 / Sonnet executor 子代理写仓库代码 /
  `scripts/ds` DeepSeek 只做无仓库上下文的机械产出），详见 §6，必须遵守。
- 本文档已替项目负责人拍板所有悬而未决的架构决策（§2）。你不需要重新论证这些决策，
  但如果实现中发现决策与代码事实冲突，停下来向用户报告，不要自行改决策。
- **接手后的第一动作是 B2（独立验收 Draft PR #39 / RW-1），不是 B0**；
  按 `CLAUDE_HANDOFF.md` §9 的顺序执行。B0/B1 可与 B2 并行准备，但 B3 起严格依赖 B2 合并。
- 批次顺序（§4)有依赖关系，不得跳批次；每批一个 PR，合并门禁见 §5。

## 1. 现状判定（以 main `2f93ccd` + Draft PR #39（head `d67271a`）为准）

Post-Merge Acceptance（`post-merge-acceptance.md`）已核实：

| 层                                                                           | 状态                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 两张权威 Graph 定义（domain）                                                | ✅ 真实、已冻结                                                                                                                                                                                                   |
| GE-1 Durable Runtime Kernel（事务/CAS/幂等/receipt）                         | ✅ 真实                                                                                                                                                                                                           |
| GE-2 骨架                                                                    | ⚠️ 仅测试 fake，worker 非测试零引用                                                                                                                                                                               |
| GE-3/4/5/6                                                                   | 🔶 只有独立 backend helper（intake.* / research.execute / blueprint.* / CHAPTER_DRAFT 任务引擎），**没有任何真实 executor 把节点接到 GraphRunService**；artifact ref 全是 `art-${nodeId}` 占位；无产品 UI；无 E2E |
| RW-1 settlement 桥（**Draft PR #39**，`feat/rw1-node-execution-settlement`） | 🟡 已实现待独立验收：migration v12 + ExecutorRegistry + 原子 claim/settlement + provenance + 恢复；CI 绿；经三轮 review 后**未经独立复验、未合并**（见 `CLAUDE_HANDOFF.md`）                                      |

**根本缺口只有一个：节点执行器与 task→Graph settlement 桥。** 其实现已存在于 Draft PR #39，
但 Draft 内容不计入 main 能力；B2 的工作是独立验收它。其余（多 provider、Tavily、UI）都挂在这条主干上。

## 2. 架构决策（已拍板，B0 落入 decision-log）

### D1 — 不重构仓库

维持 Controlled Pivot。分层、内核、migration、测试资产全部保留。禁止以"接手"为由重写后端或重建仓库
（与 PRODUCT_DIRECTION §17 一致）。

### D2 — 节点执行器 = 持久化任务 + settlement 桥（核心设计）

所有需要模型/搜索调用的 Graph 节点，其执行器一律走：

```text
节点进入 active
→ executor 创建持久化 Task（Task Engine，绑定 runId + nodeId + attempt）
→ 任务完成后由 settlement 函数把结果写入权威存储（同事务得到真实 artifact id）
→ 以幂等 command key（由 taskId 派生）调用 GraphRunService.advanceNode / failNode
```

- settlement 必须幂等可重放：崩溃后重放 settlement，commandLog 去重保证 Graph 只推进一次。
- 纯逻辑节点（如 IDEA_CAPTURE 播种、RESEARCH_DECISION 规则判断、JOIN 聚合）可以是同步 executor，
  不必开任务，但同样只能经 GraphRunService 推进。
- worker 端建立 `GraphNodeExecutorRegistry`：nodeId/kind → executor。这是 B2 唯一主题。

### D3 — Recovery 语义修订（解决 post-merge 待决策 #1）

`recoverInFlightRuns` 的 fail-closed 语义修订为**与任务状态协同**：

- 节点 active 且其绑定任务已终态成功 → 启动时补跑 settlement（结果不丢）。
- 节点 active 且任务失败/被 reconcile 标记 TASK_INTERRUPTED → `applyNodeFailure`（走 Graph 预算/升级路径）。
- 节点 active 且无任务记录（同步 executor 中断）→ 维持现状 fail。
- `waiting_for_human` 一如既往不触碰。

### D4 — artifact ref 必须指向真实持久化对象（解决待决策 #3）

- settlement 只允许传真实持久化 id（creationSpec 版本 id / researchBundle id / storyBlueprint id /
  generationRun 产物 id）。
- `GraphRunService.advanceNode` 增加 artifact 存在性校验端口（按 artifact 类型注入 existence checker）；
  校验失败 → 拒绝推进。骨架测试可注入宽松 checker，生产 wiring 必须注入真实 checker。

### D5 — GE-2 `4b26c60` 直推 main（解决待决策 #2）

不改写历史。decision-log 记录流程违规一次性豁免；今后一切变更（包括文档）必须走 PR。

### D6 — Model Gateway 升级为多 provider（用户明确指令，修订原锁定决策）

原锁定决策"不提前建设多 Provider"由项目负责人修订为：**支持多 provider 配置，但只做最小形态**：

- 协议适配层：`anthropic-messages`（现有）+ `openai-chat`（新增，覆盖 DeepSeek / OpenAI 兼容端点）。
- Provider Profile：`{ id, label, protocol, baseUrl, model, secretRef }`，持久化；secret-store 每 profile 一个 key 槽位。
- 路由规则只有两层：全局默认 provider + 按任务类型（prompt 用途）可选覆盖。
- **不做**：负载均衡、自动 fallback、流式、复杂路由 DAG。
- 现有 MiMo V2.5 Pro 配置在迁移后继续可用（作为一个 anthropic-messages profile）。

### D7 — 联网搜索用 Tavily（用户已选定）

- `research-engine` 的 WebSearchPort 增加 TavilySearchProvider 实现；key 存 secret-store（GE-4 已预留槽位机制）。
- Tavily 返回的正文文本仍需过既有 V1 安全边界（协议/私网/重定向/字节数/超时校验适用于后续 fetch；
  Tavily API 本身走 https 白名单域）。
- fake provider 保留用于测试与无 key 环境。

### D8 — UI 节奏：每个 GE 阶段配最小产品 UI，wiring PR 与 UI PR 分离

- 每个阶段先合 wiring PR（人工 Gate 由测试注入决策，E2E 绿），紧接着合该阶段最小 UI PR（用户能真实操作）。
- GE-3 UI 批次同时完成 App shell 切换：默认入口从 Grill 工作台改为 Idea-to-Novel 四阶段旅程
  （Idea / Research / Blueprint / Manuscript），新建项目默认落在"告诉我你想写什么"。
- UI 必须遵守 PRODUCT_DIRECTION §4：作者语言、不暴露工程概念（run/node/task/token 一律不出现在界面）。

### D9 — GE-7 仍然后置

GE-6 原退出条件（真实章节生成全链到 CANDIDATE_GATE 绿）通过之前，不启动 GE-7（MANUSCRIPT_COMMIT/稿件工作区/导出）。
本方案不含 GE-7 批次；它是下一份方案的主题。

## 3. 锁定不变量（照抄自 roadmap §3，全批次生效，DeepSeek 每个任务都要贴着检查）

1. 任何 Graph 状态变化只能经 Domain transition（`applyNodeSuccess/applyNodeFailure/requestHumanDecision/applyHumanDecision/applyArtifactChange`），且只能通过 GraphRunService。禁止直写 `graph_runs`。
2. `packages/domain` 的两张 Graph 定义已冻结，禁止修改节点/边/预算（发现定义与需求冲突→停下上报）。
3. 一次 ChapterGenerationRun 只生成一个章节；Scene Plan 是内部 artifact。
4. 人工 Gate 处用户拒绝/重写/预算耗尽时不得自动接受或提交。
5. 生成候选 ≠ 权威稿件；本方案范围内任何代码不得写 Manuscript（那是 GE-7）。
6. `WorkflowStage` 只是 UI 投影，不作为权威状态。
7. 每批合并后 `pnpm check` 必须绿。

## 4. 批次计划（每批 = 一个 PR）

### B0 — 决策落地与文档同步（纯文档，半天级）

- `decision-log.md` 追加 D1–D9（含多 provider 对原锁定决策的修订及理由）。
- `graph-engineering-roadmap.md` §15 与 `current-project-state.md` §8 更新推进位置，写明本计划批次。
- `AGENTS.md`"模型配置"段与 D6 对齐：删除"固定 MiMo V2.5 Pro / Base URL 和 Model 只读"的表述
  （否则执行代理会按旧规则拒绝 B1 的多 provider 改造）。
- 退出：文档单一答案原则保持；`pnpm check` 绿。

### B1 — Model Gateway 多 provider（D6）

- `packages/model-gateway`：抽出协议适配接口；新增 `openai-chat` 适配（/chat/completions，严格解析，非流式）；
  ProviderProfile 类型 + 校验。
- `packages/secret-store`：per-profile key 槽位。
- contracts/preload/main/worker：provider 配置 CRUD + testConnection 通道（沿既有 typed IPC 模式）。
- 设置 UI 最小改动：provider 列表/新增/测试连接（可复用现有 ProviderRegion）。
- 退出：两种协议各自 invokeModel/testConnection 单测绿；现有 MiMo 配置迁移后不断；`pnpm check` 绿。

### B2 — 独立验收并处理 Draft PR #39（RW-1 settlement 桥；D2/D3/D4 的实现载体，**全方案基石**）

- RW-1 已在 Draft PR #39 实现 D2–D4 的主体：migration v12（node_executions / results / provenance）、
  ExecutorRegistry（Sync / TaskBacked 拆分）、原子 claim / settlement / failure、canonical input
  snapshot、artifact provenance 校验（Renderer 无法伪造非人工节点完成）、worker 启动恢复与
  PENDING task 重调度。CI 绿，但经三轮 review（RW-1 → R5 → R5-R2）后**尚未独立复验、未合并**。
- 本批工作 = 按 `CLAUDE_HANDOFF.md` §9 执行：核对 head/base/CI → 读全部三轮 Principal Architect
  reviews → 对 transaction / provenance / recovery / 并发测试做独立代码级审查（43 文件 ~6.6k 行，
  按边界分段）→ 判 **ACCEPT**（转正式 PR 合并）或 **REWORK**（列 blocker 清单返工）。
- 合并后做一次 post-merge acceptance（同 `post-merge-acceptance.md` 判定法），更新状态文档；
  核对 D2/D3/D4 是否全部被 RW-1 覆盖，缺的列为小补丁批次。
- 退出：PR #39 合并进 main + post-merge acceptance 通过；`pnpm check` 绿。
- **本批全程由 Opus 5 亲自执行，不下放。不得因 CI 绿跳过架构复验。**

### B3 — GE-3 wiring：Idea Intake 四节点真实 executor

- IDEA_CAPTURE：同步 executor，播种 `projects.initial_idea` → intake session（复用 `createIntakeSessionFromIdea`），
  产出真实 idea artifact ref。
- SPEC_EXTRACT：模型任务（prompt `spec-extract-v1`，走 B1 网关）→ CreationSpec 持久化（复用 Creation Contract
  快照/版本基座）→ settlement 推进，artifact ref = 真实版本 id。
- ASK_QUESTION：模型任务产出追问（复用 grill 问题存储；只追问必要问题）。
- COLLECT_ANSWER：走既有 answer receipt 原子契约（GE-1 已有）；answer/skip/finish 三决策。
- INTAKE_ESCALATION：人工 Gate 决策路由（continue_with_current_spec / modify_idea / cancel / continue_later）。
- CreationSpec 编辑 → `applyArtifactChange` 失效级联（复用 `propagateCreationSpecInvalidation`）。
- 退出：模糊想法→追问→CreationSpec 真实 E2E 绿（含 skip/finish/升级/编辑失效）；`pnpm check` 绿。

### B4 — GE-3 UI：旅程 shell + 对话式访谈 + CreationSpec 编辑器

- App shell：四阶段旅程导航（Idea/Research/Blueprint/Manuscript）；新建项目落"告诉我你想写什么"；
  已有项目按 Graph 状态回到对应阶段（用 WorkflowStage 投影，仅展示用）。
- 对话式访谈界面（提问/回答/跳过/直接粘贴设定/完成）；CreationSpec 可编辑表单视图。
- 旧 Grill 工作台从默认入口移除（代码保留）。
- 退出：真人可从新建项目走到"看到并编辑创作要求"；不暴露任何工程概念；`pnpm check` 绿。

### B5 — GE-4 wiring + Tavily：Research 四节点真实 executor

- RESEARCH_DECISION：同步 executor 用 `determineResearchDepth`（none/light/deep）。
- RESEARCH_PLAN：模型任务产出问题计划；人工 Gate 支持增/删/跳过（Graph 语义）。
- RESEARCH_EXECUTE：TavilySearchProvider（D7）+ 既有编排/安全边界；来源与事实笔记落 `research_bundles`；
  settlement 用真实 bundle id。
- RESEARCH_VALIDATE / RESEARCH_ESCALATION：校验重试预算与人工升级路由。
- 退出：none/light/deep 三档真实 E2E（deep 用 Tavily 真调用的 gated 测试 + fake 的确定性测试）；
  来源排除；安全边界回归；`pnpm check` 绿。

### B6 — GE-4 UI：调研计划与资料包

- 调研强度展示、问题计划增删跳过、来源列表与事实笔记查看、来源排除、bundle 修正。
- 退出：真人可查看/调整调研并拿到资料包；`pnpm check` 绿。

### B7 — GE-5 wiring：Blueprint executor + PROJECT_READY 原子闭环

- BLUEPRINT_GENERATE：模型任务（prompt `blueprint-generate-v1`）→ `story_blueprints` 持久化 → settlement，
  artifact ref = 真实 blueprint id。
- **BLUEPRINT_USER_GATE 原子化**：accept 决策的 `applyHumanDecision` 与 `blueprintRepo.markAccepted`
  放进同一事务（消除 post-merge §1.6 指出的双事务不一致）。
- rewrite 循环（blueprint_rewrite_budget）+ BLUEPRINT_ESCALATION。
- 退出：模糊想法→PROJECT_READY / BLOCKED / CANCELLED 三终态真实 E2E 绿；accept 原子性测试绿；`pnpm check` 绿。

### B8 — GE-5 UI：蓝图查看与接受

- 蓝图分区展示（前提/人物/关系/世界/冲突/情节线/章节结构）、接受、请求改写（附意见）。
- 退出：真人可接受蓝图使项目达 PROJECT_READY；`pnpm check` 绿。

### B9 — GE-6 wiring：章节生成全链到 CANDIDATE_GATE

- CHAPTER_PLAN（`chapter-plan-v1`，Scene Plan 内部 artifact）→ DRAFT（`draft-generate-v1`，
  扩展既有 CHAPTER_DRAFT 任务引擎）→ 三 Critic **真并行**（三个独立任务：continuity/style/requirement）
  → CRITIQUE_JOIN（同步聚合，只聚合三个已完成来源）→ REWRITE 循环（`rewrite-v1`）→ CANDIDATE_GATE。
- 一次 run 单章约束运行时强制（绑定 blueprintChapterId）。
- fan-out 半完成恢复（一个 Critic 崩溃重启后按 D3 处理）。
- 退出：PROJECT_READY 项目真实生成一章到 CANDIDATE_GATE 全链 E2E 绿（含 rewrite 循环、reject→DRAFT、升级、
  三终态）；`pnpm check` 绿。

### B10 — GE-6 UI：生成与候选 Gate

- 从蓝图章节列表发起生成、进度呈现（作者语言，如"正在起草"，不暴露节点/任务）、候选正文查看、
  accept / reject / request_rewrite（附意见）。
- accept 后提示"写入稿件"能力属于下一阶段（GE-7），本批 accept 只落 Gate 决策。
- 退出：真人可走完"生成一章→看到候选→做出决定"；`pnpm check` 绿。

> B10 之后：对照 roadmap GE-6 原退出条件做一次验收（同 post-merge-acceptance 的判定法），
> 通过后才立项 GE-7（MANUSCRIPT_COMMIT + 稿件工作区 + 导出）方案。

## 5. 每批合并门禁（Planner 逐批执行）

1. `pnpm check` 绿（format/lint/build/typecheck/test）+ `git diff --check` 干净。
2. 新增测试证据清单写进 PR 描述（对应本方案该批"退出"条目逐条勾选）。
3. §3 不变量自查清单贴在 PR 描述里（特别是：无 graph_runs 直写、无 domain graph 定义改动、
   artifact ref 全为真实 id）。
4. 涉及 migration 的批次：只追加新版本号，禁止改历史 migration。
5. UI 批次额外检查：界面文案零工程术语（run/node/task/token/pipeline/proposal 不得出现）。

## 6. 执行层分工与任务拆分纪律（Planner 必须执行）

分工沿用仓库根 `CLAUDE.md` 的既有约定，不得推翻：

- **Opus 5（主线程）**：架构决策、任务拆解、跨模块设计、代码审查、疑难调试、最终验收。
  B2 验收、B7 原子化改造、所有 migration 编写，亲自做或逐行 review。
- **executor 子代理（Sonnet，`.claude/agents/executor.md`）**：规格明确的仓库内实现/测试/重构/
  修检查错误。**这是写仓库代码的主力执行器。** 适合：协议适配器、按模板复制展开的同构节点
  executor（B3/B5/B9）、UI 组件、测试用例扩充。
- **`scripts/ds`（DeepSeek v4 flash，外部云 API）**：只做**不依赖仓库上下文**的批量机械产出——
  样板草稿、格式转换、fixture/测试数据批量生成、文档初稿。输出一律视为草稿，必须经 Opus 或
  executor 审查修正后才能落盘。
  **隐私边界（硬约束，出自 CLAUDE.md）**：内容会离开本机；禁止投喂作品正文、API Key、用户数据
  或未公开的项目细节。因此 DeepSeek 不直接编写依赖仓库上下文的产品代码；若项目负责人未来要
  放宽此边界，必须先由其本人修改 CLAUDE.md，Planner 不得自行放宽。

任务拆分纪律（对 executor 与 ds 通用）：

1. **单任务 ≤ 300 行 diff、≤ 5 个文件**；超过就再拆。每个任务给出：目标一句话、允许触碰的文件白名单、
   接口签名（输入/输出/错误类型）、要新增/修改的测试名单、验收命令。
2. **测试先行**：先写失败的测试，review 测试正确后再写实现。
3. **禁改清单随任务下发**：`packages/domain/src/idea-to-novel-graph*.ts` 的节点/边/预算（冻结）、
   历史 migration、`graph-run-transaction.ts` 事务原语（B2 之外）。
4. **每任务独立可验证**：交付后 Planner 必须实际运行该任务声明的验收命令，不接受"看起来对"。
5. prompt 文件（`spec-extract-v1` 等）由 Planner 起草定稿；可让 ds 出初稿，但 Planner 负责质量。
6. 每任务回执格式（executor 已内置）：改动文件清单、实际运行的验收命令与结果、未决问题与风险。

## 7. 需要项目负责人（用户）提供的东西

- **Tavily API key**（B5 前提供；经应用 secret-store 界面/通道录入，禁止写进代码或配置文件）。
- 如需在应用内用 DeepSeek 生成小说：DeepSeek API key + baseUrl（B1 合并后在 provider 设置里录入）。
- 如希望 DeepSeek 直接编写依赖仓库上下文的代码（当前被 CLAUDE.md 隐私边界禁止）：由你本人修改
  CLAUDE.md 明确放宽，否则维持 Sonnet executor 写代码、DeepSeek 只做无上下文产出的分工。
- 每个 UI 批次合并后做一次真人试用，反馈直接进下一批。
