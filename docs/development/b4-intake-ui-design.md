# B4 — GE-3 产品 UI 设计（决策记录）

> 状态：ACTIVE（B4 实现期间的工作设计，随 PR 入库）
> 决策人：Fable（Principal Architect，项目负责人授权）
> 日期：2026-08-10
> 事实依据：main `6d76cb2`（TD-023 已修）之侦察地图；批次定义 takeover-plan §B4

## 1. 范围

App shell 四阶段旅程（Idea/Research/Blueprint/Manuscript）+ 对话式 Intake 访谈 + CreationSpec
编辑器；随行消化 TD-022（failed intake run 一键重建）、TD-024（孤儿 session + resolver 白名单 +
问题写入防护）、TD-025-3（provider 配置成功后重驱动）。旧 Grill 工作台从默认入口移除（代码保留）。

## 2. 关键机制决策

- **D-B4-1 旅程阶段派生**：shell 用 `graph.listRuns`（取最新 project run）+ `graph.getRunProgress`
  的 `GraphNodeProjectionDto.stage`（WorkflowStage 投影）驱动四阶段导航高亮与中栏内容；
  WorkflowStage 仅展示用（锁定不变量 1）。无 run → Idea 阶段起点（自动创建 run）。
- **D-B4-2 run 自动创建与重建（TD-022）**：进入 Idea 阶段且无非终态 project run 时自动
  `graph.createProjectRun`；幂等键 `intake-auto:${projectId}:${既有 run 数}`——自动创建在同一
  run 代际内天然去重，failed 后重建（"重新开始访谈"按钮）因 run 数增长得到新键、创建新 run。
  IDEA_CAPTURE 会重新播种 session（TD-024-1 顺带弃用旧会话）；既有 CreationSpec 版本不受影响。
- **D-B4-3 intake 通道暴露**：contracts/preload/main 补 `intake.getActiveIntakeSession` 与
  `intake.propagateSpecInvalidation` 两通道（worker dispatch B3 已有）；`createIntakeSession`
  不暴露（IDEA_CAPTURE executor 内部职责）。
- **D-B4-4 CreationSpec 编辑级联**：编辑器 `contract.updateByUser`（CAS）成功后显式调
  `intake.propagateSpecInvalidation`（B3 E2E 同路径）；不把级联隐藏进 updateByUser（该通道被
  旧工作台共用，隐式级联会改变共享语义）。
- **D-B4-5 访谈数据源**：会话 = `intake.getActiveIntakeSession`；消息流 = `grill.listQuestions`
  - `grill.getCurrentAnswers`（goal 即初始想法）；回答/跳过/完成 = `graph.applyHumanDecision`
    （intake_answer 传原文，answer receipt 在 worker 事务内生成——B3 契约不变）；升级 Gate =
    `applyHumanDecision`(kind:'escalation')。renderer 不暴露 session/proposal/工程概念。
- **D-B4-6 未接线阶段占位**：Research/Blueprint/Manuscript 阶段渲染占位视图（能力随 B5..B10 开放）。
  spec_complete 后 RESEARCH_DECISION 无 executor，按 TD-020 语义 run 保持非终态挂起——
  shell 显示 Research 占位而非错误。
- **D-B4-7 TD-024 修法**：
  1. IDEA_CAPTURE 执行前 abandon 该项目全部 ACTIVE 会话（`abandonGrillSession`，CAS 失败重读
     容忍并发）→ ACTIVE 会话全局至多一个，`getActiveIntakeSession` 歧义消除；
  2. resolver `idea` 校验加状态白名单：仅 ACTIVE 会话可结算（settlement 时点 IDEA_CAPTURE
     刚建会话必为 ACTIVE；被弃用会话不可再结算）；
  3. `executeSpecExtract` 追问写入前重读会话，非 ACTIVE 则跳过写入（结果注定 STALE，不向
     非活跃会话注入问题；结算语义不变）。不改走 `addGrillQuestions` 用例——其 CAS/版本推进
     语义嵌入任务终态事务的风险大于收益，防护到位即可。
- **D-B4-8 TD-025-3 修法**：provider.create/update/setDefault/saveApiKey 成功后 fire-and-forget
  触发一次全项目 `runProjectRecovery` 扫描（复用启动恢复；含 PENDING task 重调度），带
  in-flight 去重防抖；失败静默（启动恢复兜底）。delete/testConnection 不触发。

## 3. UI 结构

```text
App.tsx（shell）
├─ 顶栏：项目名 + 四阶段旅程导航（stage 高亮派生自 D-B4-1）
├─ 中栏（按 stage）
│  ├─ idea/clarify → IntakeRegion（对话式访谈）
│  │   ├─ 消息流：初始想法 + 已问答 Q/A + 当前追问
│  │   ├─ COLLECT_ANSWER 待答：多行输入（支持长文粘贴设定）+ 回答 / 跳过 / 我说完了
│  │   ├─ SPEC_EXTRACT 在途：「正在整理你的创作要求…」
│  │   ├─ INTAKE_ESCALATION：四选项友好文案（继续用当前要求 / 修改想法 / 取消 / 稍后再说）
│  │   ├─ run failed：友好提示 +「重新开始访谈」（D-B4-2）
│  │   └─ CreationSpecPanel：当前创作要求展示 + 编辑（D-B4-4）
│  └─ research/blueprint/generate/manuscript/done → StagePlaceholder
└─ 右栏：状态面板不变（ProviderRegion / TaskCenter）
```

轮询沿用既有自递归 `setTimeout` 模式；组件测试沿用 jsdom + mock DesktopAPI 模式。

## 4. 非目标

- 不做 Research/Blueprint/Generation UI（B6/B8/B10）；
- 不改 Graph 定义、不动 applyHumanDecision 契约、不物理删除 Grill 工作台代码；
- 不处理 TD-025-1（批次双标）与 TD-025-2（编辑杀 run 转 activation）——需先调整 skip 语义，留后续批次。
