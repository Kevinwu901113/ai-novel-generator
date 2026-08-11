# B6 — GE-4 Research UI 设计（决策记录）

> 状态：ACTIVE（B6 实现期间的工作设计，随 PR 入库；2026-08-11 追加 D-B6-10，见下）
> 决策人：Fable（Principal Architect，项目负责人授权）
> 日期：2026-08-11（初版）；D-B6-10 补记同日——独立对抗式复查判 REWORK，
> 一条已坐实 blocker：D-B6-7 的"中栏按 journeyStage 互斥挂载"在调研有结果的
> 那一刻会立即把 ResearchRegion 卸载换回 IntakeRegion（Graph sync 节点连推导致
> frontier 往往从未在某次可观测 poll 中停留在 research），本批交付的核心内容
> （ResearchBundleView/来源排除/版本链/作废横幅）事实上永不可达。
> 事实依据：B5 合并后 main 之侦察地图（b6 侦察报告）；批次定义 takeover-plan §B6、roadmap §15

## 1. 交付范围

GE-4 PRODUCT_UI：调研强度展示、问题计划与资料包（ResearchBundle）查看、来源排除、
Tavily search key 录入界面，挂进 B4 四阶段旅程 shell 的 research 阶段。

## 2. 决策

- **D-B6-1 问题计划 = 只读查看**：问题计划只存在于 bundle.questions（D-B5-8 既决：
  图 L3 的 plan→execute 为 fixed 边、无中间人工 Gate）。takeover-plan §B6 所列
  "问题计划增删跳过 / bundle 修正"与 L3 冲突，按权威层级（L3 > L4 文档）裁定不做，
  偏离在此记录。用户干预路径不变：validate 失败重试、escalation Gate、改创作要求。
- **D-B6-2 来源排除 = project 级 URL 排除表（migration v15）**：新表
  `research_source_exclusions(project_id, url, created_at, PK(project_id,url))`。
  不改 bundle 行（保 artifact 不可变与 D-B5-2 行链语义）、不触图 transition。
  排除按 URL 作用于整个项目：重新调研产生新 bundle 后排除仍生效。消费方为 B7
  BLUEPRINT_GENERATE（读 bundle 时过滤被排除 URL 的 source/factNote 引用），本批只建
  存储+通道+UI 标记。通道：`research.setSourceExclusion({projectId,url,excluded})` +
  `research.listSourceExclusions({projectId})`。
- **D-B6-3 调研态读取 = 新独立读通道**：`research.getResearchState({projectId})`——
  worker 读最新 project run state，返回 {runId, researchDecision: none/light/deep/null,
  researchValid: valid/invalid/null, bundleRef: string|null, bundleInvalidated: boolean,
  escalationActive: boolean, researchRetryUsed:number}。不扩 GraphProgressProjectionDto
  （exact-keys 校验器破坏面大，且 outcome/artifact 属 research 专用视图）。另开
  `research.getBundle({projectId,bundleId})` 与 `research.listBundles({projectId})`（repo 现成）。
- **D-B6-9 失效资料包必须单独标记（后端复查补充）**：`applyArtifactChange`
  （domain/idea-to-novel-graph-invalidation.ts:49-73）把下游 artifact 加入
  `invalidatedArtifacts` 时**不清空 `artifacts` 槽位**，旧 ref 仍在。因此创作要求变更
  （CreationSpecPanel 保存 → propagateSpecInvalidation → researchBundle 失效）之后，
  `bundleRef` 依然指向已作废的资料包。若不单独标记，UI 会把作废内容当现行展示
  （B4 踩过的 STALE 类问题）。故 `ResearchStateDto` 增 `bundleInvalidated`，
  UI 侧 `deriveResearchPhase` 增 `stale` 相位并优先于 `ready`，作废内容做降级呈现。
  回归测试以真实 `applyArtifactChange` 制造失效状态（非手搓 state），并已验证证伪力。
- **D-B6-4 depth=none 的 UI 表达**：靠 D-B6-3 的 researchDecision 区分"本项目无需调研
  （none，直达蓝图）"与"尚未调研（null）"。none 时 ResearchRegion 显示说明卡而非空态。
- **D-B6-5 Tavily key 面板位置 = 右栏全局配置区**：SearchKeyPanel 与"模型服务"
  （ProviderRegion）并列（全局单槽位语义、可预配）。ResearchRegion 内当
  hasApiKey=false 且存在 PENDING RESEARCH_RUN 时显示"缺少搜索 key"提示卡
  （弥补配置类错误不写 errorCode 导致 TaskCenter 不可见的 UX 缺口）。
  不做 search testConnection（无后端，不新增）。
- **D-B6-6 不做"重新调研"按钮**：无对应 RPC；V1 干预路径 = escalation Gate 与
  修改创作要求（propagateSpecInvalidation 级联）。待后续批次按产品反馈决定。
- **D-B6-7 Region 按 stage 互斥挂载**：App 中栏按 journeyStage 分流：
  idea/clarify → IntakeRegion；research → ResearchRegion。journeyStage 仍由挂载中的
  Region 经 onStageChange 回报（沿用 B4 约定），各 Region 自带轮询 hook
  （useResearch 镜像 useTaskCenter 的可见性门控 + generationRef 竞态防护），
  任一时刻只有一条轮询循环。阶段回退（spec 失效回 clarify）由 ResearchRegion
  轮询检测并回报，App 换回 IntakeRegion。
- **D-B6-8 TD-026-2 随批修复**：redriveAfterProviderConfig 防抖补尾随重扫
  （录 key 后调研自动继续是 B6 用户可感知主路径，可靠性随批闭环）。
- **D-B6-10 展示阶段与推进阶段分离（复查 REWORK 修复，2026-08-11 补记）**：
  D-B6-7 的"中栏按 journeyStage 互斥挂载"把"Graph 真实进度"与"中栏展示什么"
  当成同一个状态，二者实际不是一回事——`driveRun` 会在同一状态快照内连续
  推进 sync 节点：deep 全链调研成功后，`RESEARCH_VALIDATE` 已 succeeded、
  `BLUEPRINT_GENERATE` 已 active（TD-020 无 executor 故停在 active），从未有
  一次可观测的 poll 快照让 frontier 停留在 research。旧实现下，调研刚有结果
  的那一刻，App 已经把 ResearchRegion 换成 IntakeRegion 的占位文案——
  ResearchBundleView（问题/来源/事实笔记/结论/版本链/来源排除开关）、
  D-B6-9 的作废横幅，全部永不渲染；`escalation` 相位下用户被问"就用现在的
  调研结果吗"却看不到结果；JourneyNav 纯展示不可点击，没有任何回到 research
  视图的入口。修复：
  - **frontierStage**（推进阶段）：沿用现有 `deriveResearchJourneyStage`，
    表达 Graph 真实位置；JourneyNav 用它标示"当前进度"（`aria-current="step"`）。
  - **viewStage**（展示阶段）：决定中栏挂载哪个 Region，纯函数
    `journey-logic.deriveViewStage`，按优先级：
    1. 用户在 JourneyNav 上显式点选某个**已到达过**的阶段——用户意图优先，
       即使该阶段尚无 Region 也锁定展示（诚实反馈"该阶段尚未提供界面"，
       不做二次回落）；
    2. 否则默认跟随 frontierStage，前提是该阶段已建 Region；
    3. frontierStage 指向尚未建 Region 的阶段（当前为 blueprint/manuscript）
       且无显式用户选择——回落到 research。这里**不需要**额外读一次
       `researchDecision` 来判断"调研是否有内容可展示"：Graph 结构保证
       frontier 能越过 research 阶段（到达 BLUEPRINT_GENERATE 及之后）之前，
       `RESEARCH_DECISION` 必然已产出结果（条件边要求 outcome 存在才能前进），
       所以用 frontierStage 相对 research 的序号位置本身就是"调研已有可展示
       内容"的结构性代理信号。这避免了 App 端一个真实的鸡生蛋问题——冷启动
       时（重开一个已经推进到 blueprint 的项目）第一次 poll 就直接落在
       blueprint，ResearchRegion 尚未挂载、读不到 `researchDecision`，若坚持
       要用"实时读到的 researchDecision"做判断，就必须额外发一次一次性探测
       请求或维持第二条轮询循环，与 D-B6-7"任一时刻只有一条轮询循环"的约束
       冲突。frontierStage 序号仍小于 research（即 idea/clarify）时，回落到
       idea。
  - **JourneyNav 可点击回看**：新增"已到达阶段"集合
    `journey-logic.reachedStagesUpTo`，由"历史最远 frontier"
    （`advanceMaxFrontierStage`，单调增长，切项目重置）推导；已到达阶段
    （含当前）用真实 `<button>` 渲染、可点击切 viewStage，未到达阶段
    `disabled + aria-disabled`。无障碍：当前进度项标 `aria-current="step"`，
    被查看项标 `aria-pressed`（未到达阶段恒为 `undefined`，不给出误导性
    "未按下"语义）；两者都各自附一条 `sr-only` 文案（"（当前进度）"/
    "（正在查看）"），可同时出现在同一项上（当二者恰好是同一阶段时），
    保证屏幕阅读器能明确区分"当前进度在蓝图，正在查看调研"这类不一致场景。
  - **blueprint/manuscript 尚无 Region**：viewStage 因规则 3 回落到 research
    展示调研内容时，App 计算 `showBeyondResearchNotice`（`viewStage==='research'`
    且 frontierStage 不是已实现阶段）传给 ResearchRegion，顶部渲染一条说明
    （"调研已完成，蓝图阶段开发中"），不让用户以为流程卡住。
  - 纯逻辑落在新文件 `apps/desktop/src/renderer/journey/journey-logic.ts`
    （`stageIndex`/`isImplementedStage`/`advanceMaxFrontierStage`/
    `reachedStagesUpTo`/`deriveViewStage`），node 环境单测覆盖三条优先级
    规则与集合推导的边界情形。`JourneyNav`/`App.tsx` 相应改造；
    `ResearchRegion`/`useResearch` 不变更挂载判定逻辑本身（仍由 App 决定是否
    挂载），只新增 `showBeyondResearchNotice` 展示 prop。
  - 新增 App 级集成测试（此前测试盲区：没有任何测试覆盖"真实 progress →
    阶段派生 → App 挂载哪个 Region"这条链，`ResearchRegion.test.tsx` 直接挂载
    组件手喂 state 绕开了 App 分流，`app.test.tsx` 的 journeyStage 此前恒为
    idea）：mock `graph.getRunProgress` 直接返回
    `activeNodes:[{nodeId:'BLUEPRINT_GENERATE', stage:'blueprint', ...}]`
    模拟冷启动场景，断言 ResearchBundleView 的内容（问题/来源/排除开关）可达，
    且 JourneyNav 的"当前进度"（蓝图）与"正在查看"（调研）在无障碍语义上
    可区分。

## 3. 改动点清单（按依赖序）

1. migration **v15**：research_source_exclusions 表。
2. database：exclusions repo（set/delete/list）；project-database 访问器。
3. contracts：ResearchBundleDto/ResearchQuestionDto/ResearchSourceRecordDto/FactNoteDto/
   ResearchDepthDto + ResearchStateDto + 手写校验器；IPC_CHANNELS 新增 research.* 五通道；
   ResearchAPI 挂 DesktopAPI。
4. worker：research-handlers.ts 增 getResearchState/getBundle/listBundles/
   setSourceExclusion/listSourceExclusions（不复用 fake provider ctx）；index.ts 分派；
   TD-026-2 尾随重扫。
5. main + preload：三层对齐（preload IPC_CHANNELS 字面量手工同步）。
6. renderer 纯逻辑：research/research-logic.ts（相位派生、强度文案、版本链排序、
   escalation 选项、缺 key 推断）+ node 单测（先红后绿）。
7. renderer 组件：SearchKeyPanel（镜像 ProviderRow key 区块）→ ResearchBundleView
   （强度徽标/问题+来源/事实笔记折叠/结论/版本链/排除开关）→ escalation 面板
   （镜像 IntakeRegion Gate）→ ResearchRegion 组装；全包 RendererErrorBoundary。
8. App.tsx 中栏分流 + SearchKeyPanel 右栏挂载；IntakeRegion beyond-intake 占位让位。
9. 标签：error-code-labels 补 SEARCH_KEY_REQUIRED/SEARCH_KEY_READ_FAILED；
   task-labels 补 RESEARCH_RUN。
10. 测试：jsdom 组件测试（强度展示/无 bundle/none/invalid+escalation 四选项/
    缺 key 提示/key 录入/来源排除标记）+ accessibility 追加；worker 通道测试；
    migration v15 断言。
11. 样式 App.css `.research-*`；文档同步（roadmap GE-4 PRODUCT_UI ✅、
    current-project-state、tech-debt 销 TD-026-2 + 随行登记）。
12. pnpm check 全绿。

## 4. 非目标

- 不做问题计划增删跳过（D-B6-1）；不做重新调研按钮（D-B6-6）；不做 search
  testConnection；不改图定义；不扩 GraphProgressProjectionDto；B7 才做排除的消费侧过滤。
