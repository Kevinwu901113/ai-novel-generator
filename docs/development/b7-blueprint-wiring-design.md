# B7 — GE-5 StoryBlueprint 接线 + PROJECT_READY 原子闭环设计（决策记录）

> 状态：ACTIVE（B7 实现期间的工作设计，随 PR 入库）
> 决策人：Fable（Principal Architect，项目负责人授权）
> 日期：2026-08-11
> 事实依据：main `d70eca6`（B6 已合并）之侦察地图；批次定义 takeover-plan §B7、roadmap §10

## 1. 节点执行策略

| 节点                                | 策略                                                              | 说明                                                                                                                                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BLUEPRINT_GENERATE                  | **task-backed**（新任务类型 `BLUEPRINT_GENERATE`，migration v16） | 图契约 `out(null,'storyBlueprint')`——artifact-only 无 outcome，与 RESEARCH_EXECUTE 同形。骨架照 `research-run.ts`，配置校验段照 `spec-extract.ts`（无 search key）。recoveryPolicy=`settle_if_result`。 |
| BLUEPRINT_USER_GATE                 | **人工 Gate**（既有机制）                                         | `humanDecisionType='blueprint_gate'`，outcome `accept`/`request_rewrite`。运行时无需新代码，唯一新增是 accept 的同事务副作用（D-B7-1）。                                                                |
| BLUEPRINT_ESCALATION                | **人工 Gate**（既有机制）                                         | `escalation_decision` 四值。`accept_current` 同样需要 accept 副作用（D-B7-2）。                                                                                                                         |
| PROJECT_READY / BLOCKED / CANCELLED | **TERMINAL**（既有机制）                                          | `completeNode` 尾部按 `terminalStatus` 终态化，无需新代码。                                                                                                                                             |

## 2. 关键机制决策

- **D-B7-1 accept 与 Graph gate 原子化（本批次核心）**：现状是两条独立路径——
  `blueprint.accept` RPC 单发 `markAccepted`（无事务/无幂等/无 CAS/不校验 Graph 语义），
  而 PROJECT_READY 转换在 `applyHumanDecision` 的 `BEGIN IMMEDIATE` 事务里。中间失败会留下
  **run 已 `terminalStatus='completed'` 但 `accepted=0`** 的不可修复状态（终态守卫使
  `applyHumanDecision` 永久拒绝，只能旁路 UPDATE 手工修），直接违反 roadmap §10
  "蓝图不接受则不得形成 PROJECT_READY"。
  **决策**：并入 `applyHumanDecision` 的同一事务，镜像同函数内 `intake_answer` 分支的现成先例
  （先写权威存储再走 transition，任一步抛错整事务回滚）。依赖已就位：
  `repos.storyBlueprintRepo` 早已在 `GraphRunTransactionRepositories`（为 resolver 校验而备）。
  **blueprintId 取自 `record.state.artifacts.storyBlueprint.artifactId`，不接受调用方传入**
  ——杜绝对任意历史 blueprintId 置 accepted 的伪造（侦察场景 C），且 gate DTO 是 exact-keys
  校验，加字段反而破坏面大。`artifacts.storyBlueprint === null` 或 `markAccepted` 返回 false
  → 抛 `GraphRunStateConflictError` 回滚（fail-closed）。
- **D-B7-2 `accept_current` 同样标记 accepted**：`blueprint-escalation--project-ready-accept`
  是 PROJECT_READY 的第二条入边，现状**根本没有对应的 accept 写入路径**，走该路径到达终态时
  `accepted` 恒为 0。与 D-B7-1 同事务同处理。
- **D-B7-3 收口 blueprint 写入类 RPC**：`graph-handlers.ts` 已确立纪律——"伪造节点完成的通道
  必须从 RPC 面移除，非人工节点推进只能是 Worker 内部可信能力"。`blueprint.accept` 是同类残余
  （绕过 Graph 直接改业务状态），`blueprint.generate` 旁路写表、不产 provenance、污染版本号，
  与 executor 路径冲突。**两者从 RPC 分发移除**；`blueprint.listChapters` 只读保留。
  application 层 `acceptBlueprint`/`generateBlueprint` 若移除后无引用则一并删除，避免留下
  语义重叠的第二写入口。
- **D-B7-4 改写循环的上下文（记录偏离）**：`BLUEPRINT_GENERATE.input.requiresArtifacts` 不含
  `storyBlueprint`，snapshot 拿不到上一版 ref；`blueprint_gate` DTO 也无 feedback 字段。
  本批次取**最小方案**：只用 snapshot 里的 `budget.blueprintRewrite` 计数告知模型"这是第 N 次
  改写，需产出实质不同的蓝图"。不改 L3 权威图（改 input 契约会牵动 validator 测试与 inputHash
  语义），不改决策 DTO。**代价与偏离**：用户点"请求改写"时无法说明原因，改写只能靠计数变异。
  产品上这是缺口，登记 TD-029-1，由 B8（蓝图 UI）批次连同 feedback 承载一并设计。
- **D-B7-5 版本号策略**：现 `generateBlueprint` 用 `listByProject().length + 1`（项目级计数，
  旁路生成与并发下可重复；UNIQUE 是三元组拦不住）。改为在 executor 的最终事务内取
  **该项目现有 `MAX(version) + 1`**。resolver 会校验 envelope 声明的 `artifactVersion` 与行内
  `version` 一致，故版本号必须在同一事务内确定并写入 envelope。
- **D-B7-6 模型输出解析边界**：镜像 spec-extract 纪律——`schemaVersion === 1`、顶层 exact keys、
  逐字段类型与长度边界、数量上限（chapters 1..200、characters ≤ 50、plotlines ≤ 20、
  relationships ≤ 100、每章 goal ≤ 500 字），越界一律抛 `MODEL_RESPONSE_INVALID`；
  解析通过后再用 domain 的 `createStoryBlueprint` 作第二道域校验（复用既有不变量）。
- **D-B7-7 无调研路径的 prompt 分支（复查后如实修正，原表述有误）**：`research_decision=none`
  路径确实没有 researchBundle，`prepareTask` 的该引导字段 `required=false`，prompt 走"本项目
  未做调研"的显式分支（不得把缺失伪装成空调研）——这部分按原设计落地。
  **但 escalation 的 `skip_research` 路径与原表述不符**：`BLUEPRINT_GENERATE.input.requiresOutcomes`
  只声明了 `[RESEARCH_DECISION]`，未纳入 `RESEARCH_ESCALATION` 的 outcome；`prepareTask`
  （`blueprint-executors.ts`）只按 input snapshot 里 `artifacts.researchBundle` 是否存在来判断
  `researchBundleId`，不读 escalation 的具体决策值。而 `RESEARCH_ESCALATION` 只能经
  `research_valid=invalid` + 预算耗尽到达，此时必然已有至少一次成功的 `RESEARCH_EXECUTE`，
  `artifacts.researchBundle` 恒非空——所以 `skip_research` 路径实际上**仍然会把上一轮 bundle
  当正常调研喂进 prompt**，与 `use_current_research` 完全不可区分，用户点"跳过调研"没有
  任何效果。复查发现（BLK-2）后评估了把 `RESEARCH_ESCALATION` 追加进 `requiresOutcomes` 的
  首选修法，但该项属于修改 `packages/domain/src/idea-to-novel-graph.ts` 的节点定义，超出本次
  执行边界（执行者被明确禁止改动该文件的节点/边/预算定义），故未实现，改走保底方案：
  如实记录现状，登记 TD-029-3。
- **D-B7-8 失效蓝图不得被接受（fail-closed）**：`applyArtifactChange` 只追加
  `invalidatedArtifacts`、不清空 `artifacts` 槽位（B6 已就 researchBundle 记录同类问题），
  且**全仓无任何运行时门禁消费 `invalidatedArtifacts`**。因此用户改了 CreationSpec 之后，
  停在 BLUEPRINT_USER_GATE 的 run 仍可点 accept 直达 PROJECT_READY，违反 roadmap §10
  "必须重新生成"。**决策**：在 D-B7-1 的同一事务内，若 `state.invalidatedArtifacts` 含
  `storyBlueprint` → 抛 `GraphRunStateConflictError` 拒绝 accept。
  **用户出路（复查后如实修正，原表述不完整）**：仅当 run 停在 `BLUEPRINT_USER_GATE` 时，
  用户改点 `request_rewrite` 才能回环重新生成（预算内），语义正确且无需改图。但若
  run 已因改写预算耗尽停在 `BLUEPRINT_ESCALATION`、且此时蓝图又失效（例如用户在
  escalation 等待期间又改了一次 CreationSpec），`accept_current` 会被本决策 fail-closed
  拒绝，而 `BLUEPRINT_ESCALATION` 上**没有** `request_rewrite` 这个 outcome——该节点只有
  `accept_current` / `modify_requirements` / `cancel` / `continue_later` 四个出口。此时
  用户唯一能重新生成蓝图的出路是 `modify_requirements`（回环到 `SPEC_EXTRACT` 重新走一遍
  抽取→调研→蓝图，代价比 `request_rewrite` 大得多），停在这一态时不存在"直接改写重生成蓝图"
  的路径。自动把 BLUEPRINT_GENERATE 重置为 pending 属 transition 层改动，本批次不做，
  登记 TD-029-2（一并记录上述 escalation 分支出路受限的问题）。
- **D-B7-9 不写 `project_metadata.status`**：该字段自建表起是死字段（默认 `'idea'`，全仓无写入方）。
  `terminalStatus` 已是权威，roadmap §10 未要求项目级状态投影。本批次不引入第二事实源。
- **D-B7-10 预埋蓝图读通道**：新增 `blueprint.getState`（四层贯通），返回
  `BlueprintStateDto`（镜像 B6 的 `ResearchStateDto`）：`runId / blueprintRef / accepted /
blueprintInvalidated / gateActive / escalationActive / rewriteUsed`。B8 的蓝图 UI 与
  GE-6 的 `createChapterRun`（需要"当前已接受蓝图 + 章节"）都依赖它；按 B5→B6 的分工惯例，
  通道在 wiring 批次预埋，UI 批次纯渲染。`blueprint.listChapters` 保留。
- **D-B7-11 任务类型命名**：`BLUEPRINT_GENERATE`（与节点同名，可读性优先）。
- **D-B7-12 顺带销账**：`blueprint-repositories.ts` 的 `save(…, updatedAt)` 实际写入
  `created_at` 列（参数名与列语义错位）；`getById` 的 `ORDER BY version DESC LIMIT 1` 在
  PK `(project_id,id)` 下恒单行、无意义。一并修正。
- **D-B7-13 蓝图 prompt 消费来源排除（复查追加）**：B6 交付了 `research_source_exclusions`
  （project 级 URL 排除表）与配套 UI，但截至 B7 首版没有任何消费方——`research.ts` 里
  `ResearchSourceExclusionRepositoryPort` 的注释早已写明"消费方（B7 BLUEPRINT_GENERATE）
  读 bundle 时过滤"，可 `executeBlueprintGenerate` 实际只读 `researchRepo`，从未碰过排除表。
  后果与 B6 那条 blocker 同质：用户在 UI 里排除了一条来源，蓝图生成时依旧会把它当依据，
  是一句没有兑现的产品承诺。**决策**：`executeBlueprintGenerate` 在装配 prompt 阶段
  （与读 bundle 同处，最终事务之外）读取该项目的 `sourceExclusionRepo.listByProject`，
  经纯函数 `filterResearchForPrompt` 过滤后再喂给 `buildBlueprintGeneratePrompt`——
  **只影响本次 prompt 可见内容，不改写 bundle 行**（bundle 是不可变 artifact，
  D-B5-2 行链语义；排除表本身是 project 级、独立于 bundle 版本）。
  **过滤规则（BLK-1 复查修复，整条剔除语义，取代首版实现）**：首版实现只按 URL 裁剪
  `factNotes[].sourceUrls`、`text` 字段原样透传——但 `text` 是 research-engine
  orchestrator 按问题把该问题下**全部**抓取文档正文拼接而成的聚合体（并非逐来源可
  分割的内容，light/deep 抓取本就是多来源常态），只裁 URL 不裁正文的结果是：被排除
  来源的正文仍整段留在 prompt 里、且被错误归属给幸存来源，排除动作从"看得见"变成
  "看不见"，用户的排除决定没有真正生效（复查 BLK-1 blocker）。修正为：**只要笔记引用
  的来源中有任意一个被排除，整条笔记（含 text）一起剔除**；完全未涉及排除来源的笔记
  原样保留。`questions[].sources` 不受此规则约束（每条 source 只是独立的
  `{url, title}`，不聚合正文）——仍按来源逐条过滤，过滤后变空的问题本身仍保留
  （question 文本仍是有效调研意图），prompt 里以空 `sources: []` 体现"当前无可用来源"。
  被排除的来源**直接不出现**在 prompt 里（不采用"以下来源已排除、不得作为依据"式的
  显式列出）——一旦把排除来源的 URL/标题送进模型上下文，就从"模型没见过"变成"模型
  见过但被告知别用"，对指令遵循较弱的模型这道防线更脆弱，直接不出现是更强的边界。
  **无可用内容的三态区分（BLK-2 附带修复）**：过滤后若已无任何可用事实笔记，需要
  进一步区分是"bundle 本身一条事实笔记都没有"（`no_sources_gathered`，典型成因是
  抓取全失败，与任何人的排除操作无关）还是"bundle 原本有事实笔记、被排除操作清空"
  （`all_excluded`）——首版实现把这两者都记成 `all_excluded`，对模型说了假话（没有
  任何排除操作时也声称"用户已将全部可用来源排除"）；与 D-B7-7 的 `not_conducted`
  （根本没做调研）合计四态，措辞各自如实，不相互冒充。

## 3. 改动点清单（按依赖序）

1. **migration v16**：`tasks` CHECK 重建加 `BLUEPRINT_GENERATE`（镜像 v13/v14）；
   `DbTaskType` / `TaskType` 联合同步。
2. **application**：`graph-run.ts` gate/escalation 分支加同事务 accept + 失效 fail-closed
   （D-B7-1/2/8）；`blueprint.ts` 按 D-B7-3 收口、版本号改 MAX+1（D-B7-5）。
3. **task-engine**：新建 `blueprint-generate.ts`（system prompt / buildPrompt /
   parseBlueprintGenerateV1 / executeBlueprintGenerate），index 导出。
4. **worker**：新建 `blueprint-executors.ts`（descriptor + prepareTask + register）；
   `graph-task-runner.ts` 加 taskType 分派与 deps 并集；`index.ts` 注册 + deps 装配 +
   RPC 面收口（D-B7-3）+ `blueprint.getState` 分发。
5. **contracts / preload / main**：`BlueprintStateDto` + 校验器 + IPC 通道三层（D-B7-10）。
6. **测试**：blueprint-generate 单测（解析边界 + 失败三分支 + 最终事务 all-or-nothing）；
   blueprint-executors 单测（prepareTask 引导字段、researchBundle 缺失分支）；
   **blueprint-e2e 全链**（三终态 + 原子性回归 + 失效拒绝 + rewrite 循环 + 重启恢复）；
   更新 research-e2e 里失效的 `BLUEPRINT_GENERATE:unregistered` 断言；
   task-labels 补 `BLUEPRINT_GENERATE`。
7. **文档**：roadmap（GE-5 行 + 下一步）、current-project-state、tech-debt（TD-029 登记）。

## 4. 非目标

- 不做蓝图 UI（B8）；不改 L3 权威图定义；不引入改写 feedback 承载（D-B7-4，B8 再议）；
- 不做失效后自动重置节点（D-B7-8，TD-029-2）；不写 `project_metadata.status`（D-B7-9）；
- 不做 GE-6 的 chapter run 入口（仅预埋读通道）。
