# B8 — GE-5 蓝图产品 UI 设计（决策记录）

> 状态：ACTIVE（B8 实现期间的工作设计，随 PR 入库）
> 决策人：Fable（Principal Architect，项目负责人授权）
> 日期：2026-08-11
> 事实依据：B7 快照 `510e53f` 之侦察地图；批次定义 takeover-plan §B8、roadmap §10

## 1. 交付范围

GE-5 产品 UI：蓝图查看（前提/人物/关系/世界/冲突/情节线/章节结构/结局）+ 人工确认
（accept / request_rewrite）+ 预算耗尽升级四选项 + 项目就绪终态展示。挂进 B4 建立、
B6 扩展的旅程 shell，使蓝图成为 viewStage 的第三个已实现阶段。

## 2. 决策

- **D-B8-1 新开蓝图内容通道**：B7 只给了状态投影（`BlueprintStateDto` 七个标量），
  **渲染进程当前拿不到蓝图正文**。新增 `blueprint.getBlueprint({projectId, blueprintId})`
  → `StoryBlueprintDto | null`，四层贯通；contracts 建 `StoryBlueprintDto` 族
  （+ character/plotline/chapter 子 DTO）与手写校验器，worker 侧加 `toStoryBlueprintDto`
  投影（镜像 B6 的 `toResearchBundleDto`）。application 的 `getBlueprint` 现成，只差接线。
  `blueprint.listChapters` **不接 UI**——`getBlueprint` 已含 chapters，避免第二事实源；
  GE-6 需要时再单独接。
- **D-B8-2 阶段派生上提到 App（本批次架构性修正）**：现状"由当前挂载的 Region 经
  `onStageChange` 回报阶段"已连续产生两条同质 blocker——B6 的 D-B6-10（frontier 走到未实现
  阶段则 Region 被卸载、内容不可达），以及本次侦察发现的终态 blocker（run 终态后
  `activeNodes` 为空 → 阶段派生回落 `idea` → 显示"访谈已结束/重新开始访谈"，冷启动时
  JourneyNav 的蓝图项 disabled，**用户永远回不到已接受的蓝图**）。根因是同一个：
  **终态或未实现阶段下"没有 Region 该被挂载"，而阶段又只能由被挂载的 Region 回报**——鸡生蛋。
  **决策**：App 自持一条轻量 journey 探针（`graph.listRuns` + `graph.getRunProgress`
  - `blueprint.getState`），独立于任何 Region 计算 frontierStage / maxFrontierStage /
    viewStage；Region 不再回报阶段（移除 `onStageChange`），只负责渲染与自身内容拉取。
    探针数据以 props 下发，Region 不重复拉 run/progress，故轮询总量不增（仍是"一条阶段循环
  - 当前 Region 的内容拉取"）。D-B6-7 的"任一时刻只有一条轮询循环"意图得以保持，且
    结构上消除该类 bug。
- **D-B8-3 终态阶段 = 已产出的最远 artifact**：run 终态时不看 `activeNodes`（恒空），
  按 artifact 推导：有 storyBlueprint → `blueprint`；否则有 researchBundle → `research`；
  否则 `idea`。三种终态各自文案：`completed`（项目已就绪）/ `blocked`（已搁置，可继续）/
  `cancelled`（已取消）。**已就绪的项目冷启动后必须能直接看到蓝图**，这是本决策的验收点。
- **D-B8-4 失效蓝图：点击前禁用，不靠报错**：`blueprintInvalidated===true` 时
  （D-B7-8 后端会 fail-closed 抛 `GRAPH_RUN_STATE_CONFLICT`），UI **直接禁用"接受"按钮**
  并给出失效横幅，只留"请求重新生成"。照 B6 stale 范式**降级展示旧蓝图内容**（用户仍需
  看到旧内容才能判断），但视觉上明确标记作废。第二道防线：`error-code-labels` 补
  `GRAPH_RUN_STATE_CONFLICT` 中文映射（竞态下真触发时不至于走兜底文案）。
- **D-B8-5 蓝图内容不进轮询循环**：`getState` 轮询（1700ms，镜像 useResearch），
  `getBlueprint` **仅在 `blueprintRef` 变化时拉一次并缓存**。理由：章节上限 200 × goal 500 字
  ≈ 百 KB 量级，每轮传输不可接受。
- **D-B8-6 V1 不做蓝图版本链**：改写上限仅 3 次，且 B6 的版本链是为"重试链回看"服务；
  蓝图场景下用户关心的是当前版本。不接 `blueprint.listBlueprints`。记录偏离。
- **D-B8-7 request_rewrite 的 feedback 承载：本批次仍不做（第二次偏离，登记 TD-029-1）**：
  takeover-plan §B8 写的是"请求改写（附意见）"。承载需要改 `blueprint_gate` 决策 DTO
  （exact-keys 校验，破坏面大）或新开旁路存储，且 `BLUEPRINT_GENERATE.input` 不含
  storyBlueprint、模型也拿不到上一版做对比——**只加 UI 输入框而后端不消费，是又一个空承诺**
  （B6/B7 已各踩一次）。故本批次 UI 上**不提供意见输入框**，改写按钮的文案如实说明
  "将重新生成一版蓝图"，不暗示能定向修改。完整方案（图 input 契约 + DTO + prompt 三处
  同步）留给独立批次，TD-029-1 升级为**阻塞 GE-5 产品完整性**的债务。
- **D-B8-8 展示策略**：`ending`（结局方向）默认折叠 + 显式"查看结局方向"（剧透保护）；
  `world`/`conflict`/`characters[].description` 超长折叠（复用 B6 的截断范式）；
  `chapters` 默认只列序号+标题，点开单章看 goal，并为 GE-6"从本章发起生成"预留入口位
  （B10 接线，本批次只留布局不放按钮）。
- **D-B8-9 顺带补登记 TD-029**：B7 设计文档承诺登记但 tech-debt 至今最后一条仍是 TD-028。
  本批次补齐 TD-029-1（改写无 feedback，见 D-B8-7）/ TD-029-2（失效后不自动重置节点，
  且 escalation 分支出路受限）/ TD-029-4（Chapter Graph 终止节点同样缺 executor，GE-6 需处理）。

## 3. 改动点清单（按依赖序）

1. contracts：`StoryBlueprintDto` 族 + 校验器 + `GetBlueprintInputDto` + IPC 通道 + `BlueprintAPI` 扩展。
2. worker：`toStoryBlueprintDto` + `blueprint.getBlueprint` case + 分发。
3. main + preload 三层对齐（preload 字面量手工同步）。
4. renderer 纯逻辑 `blueprint/blueprint-logic.ts`（相位判别含失效优先与终态、gate 两选项、
   escalation 四选项）+ node 单测。
5. **journey 逻辑改造（D-B8-2/3）**：`IMPLEMENTED_STAGES` 加 blueprint、回落规则调整、
   终态阶段推导、阶段派生上提到 App、Region 移除 `onStageChange`；journey-logic 扩测。
6. 组件：`BlueprintView` → `BlueprintGatePanel` → `BlueprintEscalationPanel` →
   `ProjectReadyPanel` → `BlueprintRegion`；`useBlueprint` hook。
7. App.tsx 中栏三分流 + 自持 journey 探针；IntakeRegion 的 terminal 分支让位。
8. 样式 `.blueprint-*`；`error-code-labels` 补 `GRAPH_RUN_STATE_CONFLICT`。
9. 测试：jsdom 组件测试（各相位 + 失效禁用 accept + gate/escalation 入参正确）；
   **App 级可达性两条**（frontier 停在 BLUEPRINT_USER_GATE 时蓝图正文与按钮可达；
   **run 已 completed + accepted 的冷启动下蓝图仍可达且不显示"重新开始访谈"**）——
   后者是 D-B8-3 的回归证据，必须先红后绿；`app.test.tsx` 的 mock 补 `blueprint` 组。
10. 文档：roadmap GE-5 PRODUCT_UI、current-project-state、tech-debt（D-B8-9）。
11. `pnpm check` 全绿。

## 4. 非目标

- 不做版本链（D-B8-6）、不做改写意见承载（D-B8-7，TD-029-1）、不接 listChapters 到 UI；
- 不做 GE-6 的章节生成入口（只留布局位）；不改 L3 图定义。

## 5. 实施后的偏离与修正（如实记录，随实现提交）

设计是动笔前写的，实现过程中有四处与原文不符。B6 的教训是"文档不能写成没发生的事"，
故在此逐条改口，而不是让正文继续宣称一个没做到的性质。

- **D-B8-2 的"轮询总量不增"不成立，实际净增约一轮**。原文预期"Region 不再重复拉
  run/progress，故总量不增"。实现时发现 `useIntake` 仍需 progress 派生自己的访谈相位、
  `useResearch` 仍需 run 拿 runId 提交升级决策；把它们改成纯 props 驱动是一次跨 B4/B6
  的大改，风险高于收益。实际结果：viewStage 为 idea/research 时净增约一轮
  `blueprint.getState`（`useResearch` 少了一次 `getRunProgress`，抵掉一部分）；viewStage
  为 blueprint 时反而更少——BlueprintRegion 完全不轮询。**D-B6-7"任一时刻只有一条
  Region 轮询循环"的约束不变**，D-B8-2 的结构性目的（阶段派生不依赖谁被挂载）已达成。
- **"生成中"信号不走 tasks.list，改用节点 active**。原设计沿用 B6 的"在途任务"判定；
  实现时改为 `hasActiveBlueprintGenerate(progress)`——节点 active 是 Graph 权威事实，
  任务在途只是它的实现细节。B6 之所以要读 tasks.list，是因为要区分 key-missing 导致的
  PENDING，蓝图侧没有这个分叉。省掉一条轮询。
- **D-B8-9 已由 B7 完成，本批次无需补登记**。设计写作时 tech-debt 最后一条确为 TD-028，
  但 B7 合并（PR #49）时已登记 TD-029-1/2/3/4，且 TD-029-3 已由 D-B7-14 销账。本批次
  只是让 D-B8-7 的 UI 行为与既有的 TD-029-1 记录对上，未新增条目。
- **失效蓝图的 gate 按钮以 `gateActive` 为准，而非相位**。`stale` 相位也会出现在非 gate
  态（如已失效、等待重新生成），此时给出 gate 决策按钮必然被后端拒绝。故正文展示由相位
  决定，决策按钮由 `state.gateActive` 决定，两者分开。

### 验证基线（本批次）

- `pnpm check` 全绿：146 文件 / 3302 测试通过（另 2 文件 7 测试 skip）。
- **先红后绿的回归证据**：把 `deriveFrontierStage` 的终态分支改回旧行为（终态回落
  `idea`）后，App 级测试"run 已 completed + 已接受的冷启动下，蓝图仍可达且不显示
  重新开始访谈"确认变红（超时 5s 找不到 `blueprint-view`），改回后转绿。D-B8-3
  不是空断言。
