# B6 — GE-4 Research UI 设计（决策记录）

> 状态：ACTIVE（B6 实现期间的工作设计，随 PR 入库）
> 决策人：Fable（Principal Architect，项目负责人授权）
> 日期：2026-08-11
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
