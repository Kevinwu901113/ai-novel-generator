# AI Novel Generator — Idea-to-Novel Product Direction (V1)

> Status: ACCEPTED
> Effective date: 2026-08-03
> Priority: Repository-level product and technical direction

本文档是项目产品方向的最高级别权威来源。

- roadmap、architecture 和 feature 设计不得与本文档冲突；
- 如旧文档仍描述 Grill-first、Contract-first 或纯 Writer-first 流程，以本文档为准；
- 本次决策是在 controlled pivot 基础上的进一步校正，不是推倒重写，也不是回退到 Contract-first。

---

## 1. Executive Decision

项目继续采用：

```text
Controlled Pivot
```

产品 1.0 的目标是：

```text
快速收集用户想法，
进行必要程度的联网调研，
然后按照用户要求的形式生成小说。
```

新的产品定位：

```text
Idea-to-Novel
```

核心价值不是让用户快速进入空白编辑器，而是：

```text
以尽可能低的表达成本
将用户的模糊想法
转化为经过必要调研
并符合其形式要求的小说。
```

编辑器仍然存在，但主要用于：

- 查看生成结果；
- 修改正文；
- 调整后续方向；
- 重新生成；
- 继续生成；
- 导出作品。

它不是产品 1.0 唯一入口。

一句话产品定义：

> AI Novel Generator 首先帮助用户以尽可能低的表达成本，把模糊想法变成经过必要调研、符合其形式要求的小说，其次才是一款小说编辑器和叙事引擎。

核心架构表达：

```text
Idea Intake（低表达成本入口）
+
Web Research（必要程度的联网调研）
+
Story Blueprint（故事蓝图）
+
Manuscript Workspace（查看 / 修改 / 继续生成 / 导出）
+
Narrative Engine
```

保留的既有决定（技术底座见第 12 节）：

```text
Controlled Pivot
保留当前仓库和技术底座
保留 Domain / Application / Infrastructure 分层
保留 Renderer / Preload / Main / Worker 边界
保留 MV1-A Manuscript 基础
复杂引擎能力不直接暴露成工程控制台
PlotPilot 不是本地 source of truth
PR #25 不按 product-complete 合并
```

---

## 2. Why the Further Correction Is Necessary

上一轮 controlled pivot 把产品方向校正为 Writing-first，建立了 "打开项目即进入正文编辑器" 的产品心智。

但纯 Writer-first 入口仍然假设：

- 用户已经知道自己要写什么；
- 用户已经完成想法到创作要求之间的转化；
- 编辑器是用户旅程的起点。

这些假设对已有项目和深度作者成立，却不利于产品 1.0 的核心场景：**用户只有一段模糊想法**。

产品 1.0 的核心问题不是 "如何让作者更顺畅地进入编辑器"，而是：

```text
如何以尽可能低的表达成本，
把用户的模糊想法，
转化为经过必要调研、符合其形式要求的小说。
```

因此，入口从 "打开即进入编辑器" 进一步校正为 "告诉我你想写什么"。

本次校正不是回退到 Contract-first：

- 不作为强制用户流程的是：Grill-me 工程化需求澄清、Creation Contract 审批门禁、任务状态工作台；
- 产品 1.0 仍不把数据库状态、Token、Invocation、proposal、session 状态机等暴露给普通用户；
- 工程化的状态、检索、Agent 和质量治理继续下沉为 Narrative Engine。

---

## 3. Product North Star — 产品 1.0 主流程

产品 1.0 主流程：

```text
用户输入初始想法
→ 系统抽取已有要求
→ 只追问必要问题
→ 形成可编辑创作要求
→ 判断是否需要联网调研
→ 用户查看或调整调研计划
→ 执行必要调研并保留来源
→ 形成可用于创作的Research Bundle
→ 设计故事蓝图
→ 按用户指定形式生成小说
→ 用户查看、修改、继续生成或导出
```

任何基础设施都必须服务于该主流程。

产品 1.0 成功不是：

- 数据库约束足够多；
- Contract 字段足够完整；
- Agent 阶段足够复杂；
- Token 统计足够详细；
- Pipeline 自动运行足够长。

产品 1.0 成功是：

- 用户只输入一段模糊想法，就能以最少追问开始创作旅程；
- 必要的联网调研形成可追溯、可修正的 Research Bundle，而不是黑盒检索；
- 创作要求与故事蓝图清晰、可编辑，用户始终掌握权威信息；
- 系统按用户指定形式生成至少一个完整章节；
- 用户能查看、修改、继续生成并导出作品；
- 用户原始想法和手写内容不会丢失，重启后能恢复最近工作。

---

## 4. Non-negotiable Product Principles

### 4.1 Low-Cost Expression Entry

"项目打开后默认进入稿件编辑器" 不再是绝对要求。

- 新建项目默认入口是"告诉我你想写什么"；
- 已有项目可根据状态返回想法、调研、规划、生成或稿件阶段；
- 正文编辑器仍是稿件阶段的主要界面。

不得默认进入：

- 工程化 Grill-me 工作台；
- Dashboard / 任务控制台；
- Contract 审批页；
- Task activity / Pipeline 状态；
- 开发者诊断。

目标：

```text
从用户说出模糊想法到形成可编辑创作要求，所需追问尽可能少。
```

### 4.2 Prose Is the Primary Surface in Manuscript Stage

稿件阶段仍是正文为主：

```text
左侧：章节、场景和结构
中间：正文编辑器
右侧：AI 助手和故事资料
```

正文编辑区域在稿件阶段应始终是最主要的视觉区域。

### 4.3 Use Author Language

用户侧动作使用：

```text
告诉我你想写什么
接着写
改这段
重新生成
规划下一章
查资料
调整后续方向
导出
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
session 状态机
question-plan proposal
契约完成度
数据库和 Token 状态
```

### 4.4 Structure Must Not Block Writing

故事设定、人物资料、大纲、调研资料和创作访谈全部是可选脚手架。

用户可以：

```text
直接粘贴已有设定，跳过追问
```

也可以选择：

```text
帮我一步步理清想法
```

两条路径同等有效，产品 1.0 优先保证低表达成本路径。

### 4.5 AI Proposes, User Controls Authoritative Content

AI 不能静默覆盖：

- 用户原始想法；
- 稿件正文；
- 章节标题；
- 正式创作要求（CreationSpec）；
- 正式故事蓝图；
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

## 5. Five Core Objects of Product 1.0

产品 1.0 围绕五个核心对象组织：

```text
CreationSpec
ResearchBundle
StoryBlueprint
Manuscript
GenerationRun
```

可以在用户侧使用中文名称，但内部概念必须清晰：

| 内部概念       | 用户侧名称 | 说明                                                               |
| -------------- | ---------- | ------------------------------------------------------------------ |
| CreationSpec   | 创作要求   | 抽取用户已表达要求 + 少量必要追问后，形成的可编辑结构化创作要求    |
| ResearchBundle | 调研资料包 | 必要联网调研的问题计划、来源、事实笔记与结论，带来源记录           |
| StoryBlueprint | 故事蓝图   | 故事前提、人物、关系、世界背景、冲突、情节线、章节结构等创作蓝图   |
| Manuscript     | 稿件       | 按章组织的正文，用户查看、修改、继续生成与导出的对象               |
| GenerationRun  | 生成记录   | 一次章节生成从内部场景计划到写入稿件的运行记录，用于理解与控制生成 |

### 5.1 CreationSpec（创作要求）

至少包含：

```text
题材与类型
目标读者
篇幅或章节目标
作品形式
叙事视角
基调
节奏
语言偏好
必须包含
必须避免
内容边界
生成方式
```

内部可保留结构化 snapshot 与版本思想，但在 1.0 不作为审批、字段锁或契约完成门禁。

### 5.2 ResearchBundle（调研资料包）

包含：

- 调研触发判断结果；
- 调研问题计划；
- 每个问题的来源列表；
- 事实笔记；
- 调研结论。

生成时只注入与当前创作相关的调研内容；来源错误时允许删除或排除。

产品 1.0 不设计复杂知识图谱。

### 5.3 StoryBlueprint（故事蓝图）

至少包含：

```text
核心前提
主角与关键人物
主要关系
世界背景
主要冲突
结局方向
主要情节线
章节结构
每章目标
```

### 5.4 Manuscript（稿件）

按章组织，支持查看、编辑、重新生成、局部重写、继续生成与导出。

### 5.5 GenerationRun（生成记录）

记录一次章节生成运行，让用户理解并控制生成过程，但不暴露工程实现细节。

---

## 6. Web Research — 一级产品能力

联网调研是产品 1.0 的一级能力，不是可选附加。

### 6.1 三档调研强度

调研强度分成三档：

```text
无需调研
轻量调研
深度调研
```

### 6.2 强度决定因素

调研强度由以下因素决定：

- 题材是否依赖现实事实；
- 用户是否要求真实性；
- 是否涉及具体时代、地域、职业或事件；
- 现有输入是否已经足够；
- 调研成本与创作收益。

### 6.3 调研流程

- 判断是否需要调研；
- 形成调研问题计划；
- 用户查看、调整（增加、删除、跳过）问题；
- 执行搜索并记录来源；
- 形成事实笔记；
- 汇总为 ResearchBundle；
- 生成时只注入相关研究内容；
- 来源错误时允许删除或排除。

产品 1.0 不设计复杂知识图谱。

---

## 7. Product Role of Grill-me — Idea Intake / 创作访谈

Grill-me 从工程化需求澄清工作台，重构为自然对话式 Idea Intake / 创作访谈。

它是产品 1.0 核心资产：

```text
用户输入初始想法
→ 系统抽取用户已表达的要求
→ 只追问必要问题
→ 形成可编辑创作要求
```

原则：

- 只追问缺失且值得追问的信息；
- 问题数量应尽可能少；
- 用户可随时跳过问题；
- 用户可粘贴已有设定直接开始；
- 访谈结束即生成可编辑 CreationSpec；
- 用户可以直接修改创作要求。

Grill-me 不得向用户暴露：

```text
session 状态机
question-plan proposal
task / invocation
contract 完成度
数据库和 Token 状态
```

---

## 8. Product Role of Creation Contract — 创作要求

用户侧名称：

```text
创作要求
```

废弃以下用户侧产品形态：

```text
强制 Creation Contract 审批流程
Contract 审批页面
Contract 完成门禁
逐字段 accept 流程
大量 Lock / Proposal / Version 术语
```

保留以下内部思想：

- 明确的权威创作要求；
- 结构化 snapshot；
- 版本和 provenance；
- 生成时可复现的 context 基线；
- 用户确认内容不可被静默覆盖。

内部仍可保留结构化 snapshot 和版本思想，但：

```text
不以审批、字段锁和契约完成门禁作为 1.0 主体验
```

---

## 9. Target Product Information Architecture

一级产品视图按用户旅程阶段组织：

```text
Idea（告诉我你想写什么 / 创作访谈）
Research（调研资料包）
Blueprint（故事蓝图）
Manuscript（稿件）
```

### Idea

- 初始想法输入（自由文本）；
- 多轮补充；
- 跳过问题；
- 直接粘贴已有设定；
- 选择目标作品形式；
- 可编辑创作要求（CreationSpec）。

### Research

- 调研强度判断结果；
- 调研问题计划；
- 用户增加、删除、跳过问题；
- 来源记录；
- 事实笔记；
- ResearchBundle 查看与修正。

### Blueprint

- 核心前提；
- 人物与关系；
- 世界背景；
- 冲突与情节线；
- 章节结构与每章目标。

### Manuscript

- 章节目录；
- 正文查看与编辑；
- 重新生成章节；
- 局部重写；
- 继续生成下一章；
- 修改后续方向；
- TXT 和 Markdown 导出。

---

## 10. Authority Model

系统数据分成三级。

### Level A — Authoritative User Data

必须由用户显式保存或接受：

- 用户原始想法；
- 稿件正文；
- 章节标题；
- 正式创作要求（CreationSpec）；
- 正式故事蓝图；
- 人物和世界规则；
- 正式大纲；
- 正式场景计划；
- 用户写作偏好；
- 内容边界；
- 正式调研资料（ResearchBundle 中用户确认的部分）。

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

## 11. Target Technical Architecture

```text
┌──────────────────────────────────────────────┐
│ Idea-to-Novel User Journey                   │
│ Idea / Research / Blueprint / Manuscript     │
└──────────────────────┬───────────────────────┘
                       │ typed user intent
┌──────────────────────▼───────────────────────┐
│ Authoring Application                        │
│ Idea Intake / Research Bundle / Blueprint /  │
│ Manuscript / AI Actions                      │
└──────────────────────┬───────────────────────┘
                       │
┌──────────────────────▼───────────────────────┐
│ Authoritative Story Store                    │
│ CreationSpec / ResearchBundle / Blueprint /  │
│ Manuscript / Preferences                     │
└──────────────────────┬───────────────────────┘
                       │
┌──────────────────────▼───────────────────────┐
│ Narrative Engine                             │
│ Context Assembly                             │
│ Scene Planner（R4 内部生成能力）              │
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

复杂引擎能力不应直接暴露成工程控制台。

---

## 12. Existing Assets to Preserve

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

PR #25 的资产在 Replacement PR 建立前保持待处理状态（见第 13 节）。

---

## 13. PR #25 Decision

PR #25 不得按当前形态直接作为 "Minimal Manuscript 产品完成" 合并。

当前状态：

```text
OPEN
Draft
Not merged
```

原因：

```text
产品入口和信息架构不符合 Idea-to-Novel 方向。
```

处理方式：

- PR #25 保持 Draft，等待后续资产处理；
- Replacement Manuscript Transport PR 暂缓，不按产品 1.0 优先拆分目标处理；
- 产品 1.0 完成前优先构建真实纵向链路（Idea Intake → Web Research → Blueprint → Chapter Generation）；
- PR #25 的可复用资产仍可在后续 Replacement PR 中选择性复用。

禁止通过 rebase 或历史改写把 PR #25 强行变成新产品方向。

---

## 14. Protection Capability Priority

产品 1.0 暂不优先投入复杂保护能力。

降低优先级：

```text
复杂 CAS 冲突 UX
字段级 lock
严格 proposal 不可变展示
逐字段 accept
完整 provenance UI
多人协同
版本分支与合并
复杂审计中心
```

产品 1.0 仍必须保留最低安全线：

```text
用户原始想法不会丢失
用户手写正文不会被生成结果静默覆盖
应用重启后能够恢复最近工作
```

现有后端 CAS、不可变版本和事务能力不删除，只是不再作为主要产品投资方向。

---

## 15. Revised Technical Roadmap

```text
R0.1 — Idea-to-Novel V1 Direction Clarification
R1 — Idea Intake V1
R2 — Web Research V1
R3 — Story Blueprint V1
R4 — Chapter Generation V1
R5 — Manuscript Review and Export
R6 — Long-form Narrative Engine
```

### R0.1 — Idea-to-Novel V1 Direction Clarification

目标：

- 建立本文档；
- 校正 Writer-first 入口为 Idea-to-Novel；
- 明确五个核心对象与三档调研；
- 重写 roadmap；
- 冻结新的付费质量实验；
- PR #25 保持 Draft，Replacement Manuscript Transport PR 暂缓。

完成标准：

- 所有活动路线均引用本文档；
- 没有进行中的工作仍把 Grill-me / Contract-first / 纯 Writer-first 当作唯一默认入口；
- 产品 1.0 完成前优先构建真实纵向链路。

### R1 — Idea Intake V1

交付：

- "告诉我你想写什么"入口；
- 自由文本、多轮补充、跳过问题、直接粘贴已有设定、选择作品形式；
- 抽取用户已表达的信息；
- 只追问必要问题；
- 生成可编辑 CreationSpec；
- 用户修改创作要求。

此阶段可包含少量模型调用，但不要求联网调研。

### R2 — Web Research V1

交付：

- 调研触发判断（三档）；
- 调研问题计划；
- 用户增加、删除、跳过问题；
- 搜索来源记录；
- 事实笔记；
- ResearchBundle；
- 生成时只注入相关研究内容。

### R3 — Story Blueprint V1

交付：

- 核心前提；
- 主角与关键人物；
- 主要关系；
- 世界背景；
- 主要冲突；
- 结局方向；
- 主要情节线；
- 章节结构；
- 每章目标。

### R4 — Chapter Generation V1

交付：

```text
章节目标
→ 内部场景计划
→ 分场景生成
→ 章节组合
→ 基础检查
→ 定点修订
→ 写入稿件
```

Scene Planner 是 R4 内部的生成能力，不要求先做成独立复杂产品页面。

### R5 — Manuscript Review and Export

交付：

- 章节目录；
- 正文查看与编辑；
- 重新生成章节；
- 局部重写；
- 继续生成下一章；
- 修改后续方向；
- TXT 和 Markdown 导出。

### R6 — Long-form Narrative Engine

交付：

- 长篇持续生成；
- 章节摘要链；
- 人物状态；
- 连续性检测；
- 动态检索上下文；
- 高级质量治理循环。

PlotPilot 作为可选 adapter，不成为本地 source of truth。

---

## 16. Quality Strategy

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

新的付费质量实验继续暂缓，直到真实纵向链路（Idea Intake → Web Research → Blueprint → Chapter Generation）形成后启动：

```text
每 case 至少 2 个候选；
baseline vs new pipeline；
至少 2 名独立评分者；
增加题材覆盖；
计算评分者间一致性。
```

---

## 17. Explicitly Rejected Directions

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

### Pure Writer-first as the Sole Entry

不得把 "打开项目即进入空白编辑器" 作为产品 1.0 唯一入口。

产品 1.0 默认入口是"告诉我你想写什么"；编辑器是稿件阶段的主要界面，不是唯一入口。

### Scene Planner Before Chapter Generation

在 R4 Chapter Generation V1 之前，不得把 Scene Planner 独立启动为复杂产品页面。它是 R4 内部生成能力。

### Expose Engine Internals as UX

不得把 PlotPilot 式内核阶段、检索和质量治理直接作为默认作者界面。

---

## 18. Decision Summary

```text
Strategy:
Controlled Pivot（进一步校正为 Idea-to-Novel）

Repository:
Keep

Backend foundation:
Keep

MV1-A:
Keep

PR #25:
Draft，保持不合并，等待后续资产处理

Renderer:
Idea-to-Novel 纵向切片

Default project entry:
新建项目：告诉我你想写什么
已有项目：按状态返回想法 / 调研 / 规划 / 生成 / 稿件阶段

Grill-me:
Idea Intake / 创作访谈（1.0 核心资产）

Creation Contract:
用户侧改称"创作要求"；
保留内部 snapshot / version；
不以审批、字段锁和门禁作为 1.0 主体验

Web Research:
一级产品能力（无需 / 轻量 / 深度调研）

Scene Planner:
R4 内部生成能力

Protection capabilities:
降低优先级，保留最低安全线

Narrative engine:
Internal service layer

PlotPilot:
Optional NarrativeEngine adapter，
not UI，
not source of truth

Next product milestone:
R1 Idea Intake V1
```

最终原则：

> 以尽可能低的表达成本，把用户的模糊想法，转化为经过必要调研、符合其形式要求的小说；编辑器是稿件阶段的主要界面，但不是产品 1.0 唯一入口。
