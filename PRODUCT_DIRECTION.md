# AI Novel Generator — Writing-first Product Direction

> Status: ACCEPTED
> Effective date: 2026-08-03
> Priority: Repository-level product and technical direction

本文档是项目产品方向的最高级别权威来源。

- roadmap、architecture 和 feature 设计不得与本文档冲突；
- 如旧文档仍描述 Grill-first 或 Contract-first 流程，以本文档为准；
- 本次决策是 controlled pivot，不是推倒重写。

---

## 1. Executive Decision

项目采用：

```text
Controlled Pivot
```

核心决定：

```text
保留现有技术底座；
停止以 Grill-me、Creation Contract、任务阶段和工程状态为中心继续扩张；
重启产品层和用户旅程；
把产品改造成 Writing-first 小说创作工具；
把复杂状态、检索、Agent 和质量治理下沉为 Narrative Engine。
```

一句话产品定义：

> AI Novel Generator 首先是一款作者愿意长期使用的小说编辑器，其次才是一套叙事引擎和 Agent 系统。

核心架构表达：

```text
Writer Workspace
+
Narrative Engine
```

前台产品主要参考：

```text
The Story Nexus
Novelcrafter
Sudowrite
AugmentedQuill
NovelAI
```

后台叙事引擎主要参考：

```text
PlotPilot
novel-studio
StoryWriter
```

不是复制任何单一项目，而是采用：

```text
The Story Nexus 式 editor-first 前台
+
PlotPilot 式 narrative-engine 后台
```

---

## 2. Why the Pivot Is Necessary

当前项目已经形成较强的工程底座，但产品体验发生偏航。

当前用户感知更接近：

```text
Agent 控制台
契约审批系统
任务状态工作台
数据库和模型调用监控界面
```

而目标应是：

```text
小说稿件
章节编辑
故事规划
人物和世界资料
AI 写作协作
连续性和质量帮助
```

已经出现的具体偏航：

- 打开项目后默认进入 Grill-me，而不是正文；
- 用户先面对需求澄清、问题规划和创作契约；
- 数据库状态、任务活动、Token 和模型调用占据长期界面；
- "契约是否完成"被错误地表现为创作开始的门禁；
- 作者需要理解 Pipeline、Proposal 和 Stage，才能使用系统；
- 技术安全和可审计性被误当成了产品主体验。

正确关系应为：

```text
写作是主流程；
Grill-me 是可选辅助；
Story Bible 是资料层；
Contract snapshot 是内部实现；
Agent pipeline 是后台或高级能力。
```

---

## 3. Product North Star

用户打开一个项目后，系统应帮助其完成以下主循环：

```text
打开项目
→ 进入当前章节
→ 写正文
→ 调用 AI 续写、改写、讨论或规划
→ 查看必要的一致性和质量提示
→ 接受、修改或拒绝 AI 建议
→ 保存版本
→ 继续写作
```

任何基础设施都必须服务于该循环。

产品成功不是：

- 数据库约束足够多；
- Contract 字段足够完整；
- Agent 阶段足够复杂；
- Token 统计足够详细；
- Pipeline 自动运行足够长。

产品成功是：

- 用户能立即开始写；
- AI 能够理解当前故事；
- AI 输出符合作者意图；
- 长篇写作不遗忘关键事实；
- AI 不会静默覆盖作者内容；
- 用户最终得到可读、完整且一致的作品。

---

## 4. Non-negotiable Product Principles

### 4.1 Editor First

项目打开后默认进入稿件编辑器。

不得默认进入：

- Grill-me；
- Dashboard；
- Contract；
- Task activity；
- Pipeline 状态；
- 开发者诊断。

目标：

```text
从打开项目到开始输入正文不超过一次点击。
```

### 4.2 Prose Is the Primary Surface

桌面主界面应采用：

```text
左侧：章节、场景和结构
中间：正文编辑器
右侧：AI 助手和故事资料
```

正文编辑区域应始终是最主要的视觉区域。

### 4.3 Use Author Language

用户侧动作使用：

```text
续写
改写
扩写
压缩
润色
加强对话
增加感官细节
规划下一场
讨论剧情
检查连续性
```

普通用户不应被迫理解：

```text
Invocation
Task stage
Contract version
Proposal status
Context packet
Pipeline node
Model routing
```

### 4.4 Structure Must Not Block Writing

故事设定、人物资料、大纲和 Grill-me 全部是可选脚手架。

用户可以：

```text
直接开始写
```

也可以选择：

```text
帮我完善故事
```

两条路径同等有效。

### 4.5 AI Proposes, User Controls Authoritative Content

AI 不能静默覆盖：

- 稿件正文；
- 章节标题；
- 正式故事设定；
- 正式大纲；
- 用户固定的写作偏好。

AI 写作结果必须允许用户：

```text
插入
替换
保留为草稿
重新生成
丢弃
```

### 4.6 Derived State May Be Automated

以下内容属于可重建的派生状态，可由后台自动维护：

- 章节摘要；
- 人物出场记录；
- 事件抽取；
- 人物状态候选；
- 关系变化候选；
- 伏笔候选；
- 张力评分；
- AI 味检测；
- 向量索引；
- 检索切片。

要求：

- 可以从权威正文重新生成；
- 记录来源版本；
- 允许人工纠正；
- 不能取代正文成为最终事实来源；
- 不要求用户逐项审批所有技术派生数据。

### 4.7 Infrastructure Must Stay Invisible by Default

以下内容只允许出现在高级设置或开发者诊断中：

- SQLite 状态；
- Worker 状态；
- Token 统计；
- 模型调用次数；
- 任务成功或失败计数；
- Pipeline 阶段；
- 向量索引状态；
- 内部 ID；
- prompt hash；
- 数据库迁移版本。

---

## 5. Target Product Information Architecture

一级产品视图：

```text
Write
Plan
Story
Review
```

### Write

包含：

- 章节列表；
- 正文编辑器；
- 章节标题；
- 保存和版本历史；
- AI 写作动作；
- 专注模式；
- 字数和基础写作状态。

### Plan

包含：

```text
Act
Chapter
Scene
```

用于：

- 故事结构；
- 章节目标；
- 场景卡；
- 情节线；
- 节奏规划。

### Story

取代用户侧的 Creation Contract 概念。

包含：

- 故事简介；
- 人物；
- 地点；
- 世界规则；
- 物品；
- 关系；
- 伏笔；
- 秘密；
- 内容边界；
- 写作风格；
- 必须包含；
- 避免事项。

### Review

包含：

- 连续性检查；
- 人物一致性；
- 情节推进；
- 语言问题；
- AI 味；
- 重复内容；
- 定点修订建议；
- 质量趋势。

---

## 6. Product Role of Grill-me

Grill-me 保留，但降级为可选的故事教练。

用户侧名称建议：

```text
帮我完善故事
```

适用场景：

- 用户只有模糊创意；
- 补充人物动机；
- 发现世界观缺口；
- 讨论情节选择；
- 写作卡住；
- 检查故事设定是否完整。

Grill-me 不得：

- 成为项目默认首页；
- 成为开始写作的前置条件；
- 决定项目是否允许进入稿件；
- 长期占据一级导航；
- 要求用户完成所有问题；
- 把"契约完成"作为产品成功指标。

---

## 7. Product Role of Creation Contract

废弃以下用户侧产品形态：

```text
强制 Creation Contract 流程
Contract 审批页面
Contract 完成门禁
大量 Lock / Proposal / Version 术语
```

保留以下内部思想：

- 明确的权威故事设定；
- 用户输入优先于 AI 建议；
- 不可变 snapshot；
- 版本和 provenance；
- 生成时可复现的 context 基线；
- 用户确认内容不可被静默覆盖。

前台将 Creation Contract 拆解为：

```text
Story Bible
Writer Preferences
Content Boundaries
Plan
```

内部仍可生成：

```text
StoryContextSnapshot
```

用于模型调用、审计和可复现性。

普通作者不需要直接管理 snapshot hash、proposal status 或 lock event。

---

## 8. Authority Model

系统数据分成三级。

### Level A — Authoritative User Data

必须由用户显式保存或接受：

- 稿件正文；
- 章节标题；
- Story Bible 正式内容；
- 人物和世界规则；
- 正式大纲；
- 正式场景计划；
- 用户写作偏好；
- 内容边界。

AI 不能静默修改。

### Level B — Rebuildable Derived State

允许自动生成：

- 章节摘要；
- 事件流；
- 人物状态；
- 知识范围；
- 关系变化；
- 物品归属；
- 伏笔状态；
- 未解决剧情线；
- 质量评分；
- 向量 embedding；
- 检索索引。

必须可从 Level A 重建。

### Level C — Ephemeral Runtime Data

默认不向用户暴露：

- prompt；
- 完整 context packet；
- critic 中间结果；
- token 预算；
- 模型路由；
- Pipeline 内部状态；
- 重试和熔断细节。

只保留必要的审计摘要、hash 和错误信息。

---

## 9. Target Technical Architecture

```text
┌──────────────────────────────────────────────┐
│ Writer Workspace                             │
│ Write / Plan / Story / Review                │
└──────────────────────┬───────────────────────┘
                       │ typed user intent
┌──────────────────────▼───────────────────────┐
│ Authoring Application                        │
│ Manuscript / Story Bible / Plan / AI Actions │
└──────────────────────┬───────────────────────┘
                       │
┌──────────────────────▼───────────────────────┐
│ Authoritative Story Store                    │
│ Manuscript / Bible / Plan / Preferences      │
└──────────────────────┬───────────────────────┘
                       │
┌──────────────────────▼───────────────────────┐
│ Narrative Engine                             │
│ Context Assembly                             │
│ Scene Planner                                │
│ Draft Generator                              │
│ Critics                                      │
│ Targeted Rewriter                            │
│ Derived State Updater                        │
└───────────────┬────────────────┬─────────────┘
                │                │
       Built-in Engine      PlotPilot Adapter
                │                │
┌───────────────▼────────────────▼─────────────┐
│ Model Gateway / Task Engine / Retrieval/Eval │
└──────────────────────────────────────────────┘
```

---

## 10. Existing Assets to Preserve

### Preserve Without Product Redesign

保留：

- 当前 monorepo；
- Domain / Application / Infrastructure 分层；
- Renderer / Preload / Main / Worker 进程隔离；
- typed IPC；
- safe error boundary；
- SQLite migration 体系；
- project.sqlite；
- Model Gateway；
- Task Engine；
- Secret Store；
- Evaluation Harness；
- GQ2 评测资产；
- PlotPilot adapter 边界。

### Preserve MV1-A

保留：

- Manuscript；
- Chapter 稳定身份；
- ChapterVersion 不可变快照；
- current pointer；
- CAS 冲突保护；
- 版本历史；
- chapter 排序；
- archive/restore；
- provenance；
- migration v7；
- 后端用例和测试。

MV1-A 是有效的写作产品基础，不属于偏航内容。

### Reuse Selectively From PR #25

可复用：

- Manuscript typed IPC；
- preload allowlist；
- Main handlers；
- Worker dispatch；
- SQLite E2E；
- restart persistence；
- ChapterList；
- EditorPanel；
- VersionHistory；
- dirty guard；
- CAS conflict handling；
- mutation lock；
- buffer safety；
- 可访问性测试。

需要重做：

- App shell；
- 默认工作区；
- 导航层级；
- 页面比例；
- 右侧区域；
- 项目打开后的默认行为；
- 开发状态展示；
- Grill-me 在产品中的位置；
- 整体视觉和作者心智模型。

---

## 11. PR #25 Decision

PR #25 不得按当前形态直接作为 "Minimal Manuscript 产品完成" 合并。

当前状态：

```text
OPEN
Draft
Not merged
```

原因不是其技术实现完全无效，而是：

```text
产品入口和信息架构不符合 Writing-first 方向。
```

处理方式：

### Replacement PR A — Manuscript Transport Foundation

从 PR #25 提取并独立验证：

- contracts；
- typed IPC；
- preload；
- Main handlers；
- Worker dispatch；
- backend E2E；
- restart persistence。

该 PR 合并后状态仍为：

```text
🧱 foundation
```

不得标记完整产品能力。

### Replacement PR B — Writer-first Workspace

选择性复用 PR #25 的 Renderer 逻辑，但基于新的产品壳重新实现：

- 项目打开后默认进入 Write；
- 正文位于视觉中心；
- Grill-me 降级；
- 开发状态隐藏；
- 右侧变为 AI 助手或轻量故事资料；
- 无 AI 时仍是一款可正常使用的小说编辑器。

当两个 replacement PR 建立并验证后：

```text
关闭 PR #25
标记 superseded
不直接 merge
```

禁止通过 rebase 或历史改写把 PR #25 强行变成新产品方向。

---

## 12. Revised Technical Roadmap

### R0 — Product Reset

目标：

- 建立本文档；
- 冻结 Scene Planner 开发；
- 冻结新的付费质量实验；
- 拆分 PR #25；
- 重写 roadmap；
- 定义 Writer Workspace 和 Narrative Engine 边界。

完成标准：

- 项目中的所有活动路线均引用本文档；
- 没有进行中的工作仍把 Grill-me 或 Creation Contract 当作默认入口；
- PR #25 有明确 replacement 计划。

### R1 — Writer-first Workspace

交付：

- 打开项目默认进入稿件；
- 创建和切换章节；
- 正文编辑器；
- 显式保存；
- 版本历史；
- promote；
- 归档和恢复；
- 重启持久化；
- 基础导出；
- 专注写作模式。

此阶段不要求模型调用。

完成标准：

```text
项目打开到开始输入正文不超过一次点击；
正文区域占据主工作区至少 60%；
普通模式不显示数据库、Token 和 Task 统计；
真实 UI 人工验收通过。
```

### R2 — Story Bible and Lightweight Planning

交付：

- 人物；
- 地点；
- 世界规则；
- 关系；
- 物品；
- 伏笔；
- 故事简介；
- 内容边界；
- 幕、章节目标和场景卡。

首版以用户手动维护为主，不自动修改权威资料。

### R3 — AI Writing Actions V1

首批动作：

```text
续写
改写选中内容
扩写
讨论剧情
```

调用流程：

```text
用户选择或光标位置
+ 当前章节
+ 故事简介
+ 相关人物
+ 最近上下文
→ AI proposal
→ 预览
→ 用户接受或拒绝
→ 创建 ChapterVersion
```

完成后必须执行比较盲评：

```text
baseline-one-shot-v1
vs
AI Writing Actions V1
```

### R4 — Scene Planner

交付可编辑 Scene Card：

- 场景目标；
- 冲突；
- 登场人物；
- 地点；
- POV；
- 必须发生；
- 禁止发生；
- 结束状态。

Planner 只生成 proposal，不直接覆盖正式计划。

### R5 — Narrative State and Context Engine

建立：

```text
NarrativeEnginePort
```

首批接口：

```text
buildContextPacket
planScene
generateDraft
reviewDraft
updateDerivedState
```

维护：

- 章节摘要链；
- 人物状态；
- 人物知识范围；
- 关系变化；
- 事件时间线；
- 物品归属；
- 伏笔；
- 未解决剧情线；
- 动态历史检索。

PlotPilot 作为可选 adapter，不成为本地 source of truth。

### R6 — Quality Governance Loop

流水线：

```text
Scene Brief
→ Draft
→ Structural Critic
→ Character Critic
→ Continuity Critic
→ AI-Smell Critic
→ Targeted Rewrite
→ User Preview
```

重点质量目标：

- 降低 AI 味；
- 提高语言自然度；
- 提高继续阅读欲望；
- 提高情节推进；
- 减少重复和解释过度；
- 维持人物与事实连续性。

### R7 — Preference Learning and Advanced Automation

最后再实现：

- Writer Preference Profile；
- 从接受、拒绝和用户改写中学习；
- 故事线 DAG；
- 高级多 Agent Pipeline；
- 批量生成；
- 无人值守生成；
- 自动伏笔治理；
- 长期质量趋势。

这些属于高级能力，不得重新阻塞基础写作流程。

---

## 13. Quality Strategy

继续保留 Generation Evaluation Harness。

现有人工 baseline：

```text
Strategy:
baseline-one-shot-v1

Cases:
3

Raters:
1

continueReading:
3.67

expectationFit:
4.33

characterCredibility:
4.33

languageNaturalness:
3.33

aiSmellAbsence:
2.67

plotProgression:
3.67

concision:
4.00

continuity:
4.33
```

证据边界：

- 这是 absolute baseline；
- 不是 A/B；
- 不能证明策略优越；
- 不能证明质量显著提升；
- preferredRank=1 无比较意义。

当前最明显质量风险：

```text
AI 味
语言自然度
```

下一次付费质量实验只能在新的 AI 写作 pipeline 形成后启动：

```text
每 case 至少 2 个候选；
baseline vs new pipeline；
至少 2 名独立评分者；
增加题材覆盖；
计算评分者间一致性。
```

---

## 14. Explicitly Rejected Directions

以下方向被明确否决：

### Continue Contract-first Expansion

不得继续把：

- Grill-me；
- Creation Contract；
- Agent 阶段；
- 任务审计；

扩展为产品默认主流程。

### Full Repository Rewrite

不得因为产品转向而重新创建仓库或重写全部后端。

原因：

- 现有分层有效；
- 数据和 migration 有效；
- Worker 边界有效；
- MV1-A 有效；
- Task Engine 和 Model Gateway 可复用；
- 评测系统可复用。

### Merge PR #25 As Product Complete

不得把当前 PR #25 原样合并并标记为：

```text
Minimal Manuscript ✅
```

### Scene Planner Before Writer Workspace

在 R1 Writer-first Workspace 完成前，不得启动 Scene Planner 正式实现。

### Expose Engine Internals as UX

不得把 PlotPilot 式内核阶段、检索和质量治理直接作为默认作者界面。

---

## 15. Decision Summary

```text
Strategy:
Controlled Pivot

Repository:
Keep

Backend foundation:
Keep

MV1-A:
Keep

PR #25:
Draft, split, then supersede

Renderer:
Major product-layer reset

Default project entry:
Write

Grill-me:
Optional story coach

Creation Contract:
Remove mandatory user-facing workflow;
retain internal snapshot/provenance concepts

Story data UX:
Story Bible + Plan + Preferences

Narrative engine:
Internal service layer

PlotPilot:
Optional NarrativeEngine adapter,
not UI,
not source of truth

Next product milestone:
R1 Writer-first Workspace

Scene Planner:
Deferred until R1–R3 foundations exist

Next quality experiment:
Deferred until AI Writing Actions V1 exists
```

最终原则：

> 先成为一款优秀的小说编辑器，再把 PlotPilot 级别的叙事引擎藏到编辑器背后。
