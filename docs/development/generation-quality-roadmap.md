# 文章生成质量路线与进度总账

> **文档定位**：本文件是文章生成质量方向的权威路线和进度记录。
>
> - `docs/development/roadmap.md` 主要记录工程交付里程碑（M0–M8 切片状态）。
> - 本文件记录产品最终价值、生成质量研究、长篇能力和实际进展。
> - Contract、Version、SQLite、IPC、Task 等是护栏和支撑层，不是产品最终目标。
> - AI 只生成 proposal、用户显式接受等原则仍必须保持。

---

## 一、产品北极星

用户给出模糊想法和创作偏好后，系统能够：

1. 理解用户真正想写什么；
2. 生成符合用户预期的文章；
3. 持续生成高质量长篇内容；
4. 长篇生成过程中不遗忘人物、情节、伏笔和世界规则；
5. 减少机械、套路、解释过度等"AI 味"；
6. 学习用户的个人语言和叙事偏好；
7. 发现具体写作问题；
8. 对局部内容进行定点修订，而非反复整章重写；
9. 保留用户控制权和完整修改历史；
10. 最终导出一篇可读、完整、一致的真实作品。

### 完整主链

```
初始想法
→ Grill-me 澄清
→ 用户偏好建模
→ 创作规格
→ 故事规划
→ 章节目标
→ 场景规划
→ 分场景生成
→ 结构/人物/连续性/语言审查
→ 定点修订
→ 用户接受
→ 稿件版本
→ 长篇持续生成
→ 导出和质量验收
```

---

## 二、真正需要攻克的质量问题

### 2.1 符合用户预期

需要捕获的用户信息：

- 显式创作要求（类型、题材、基调、主题）；
- 隐性语言偏好（句式、节奏、用词风格）；
- 叙事节奏（快节奏推进 vs 缓慢铺陈）；
- 对话密度（对话占比偏好）；
- 描写比例（环境/心理/动作描写偏好）；
- 情绪表达方式（直接命名 vs 暗示/行为表现）；
- 信息揭示速度（一次性交代 vs 逐步揭露）；
- 章节结尾偏好（悬念型/闭合型/余韵型）；
- 用户反复删除、改写和接受的模式。

**关键约束**：不能只用"细腻""文学感"等抽象标签，必须转化为可执行写作约束。

### 2.2 文章本身的质量

推荐流水线：

```
章节目标 → Scene Cards → 场景草稿 → 章节组合
→ 结构审查 → 人物审查 → 语言审查 → 定点修改 → 最终 proposal
```

**明确不采用**：

```
一个 prompt → 一次模型调用 → 直接生成整章权威正文
```

### 2.3 去除 AI 味

初版 AI-smell taxonomy：

| #   | 问题类型               | 说明                                                 |
| --- | ---------------------- | ---------------------------------------------------- |
| 1   | 解释过度               | 叙述者或角色直接解释情绪、动机、含义                 |
| 2   | 抽象描述               | 用抽象概念代替具体感官和物理细节                     |
| 3   | 句式重复               | 相邻句子使用相同句型结构                             |
| 4   | 段落长度均质           | 每段长度相近，缺少长短节奏变化                       |
| 5   | 人物声音趋同           | 不同角色说话方式、用词高度相似                       |
| 6   | 高频模型套话           | 反复出现"不禁""仿佛""似乎""竟然"等                   |
| 7   | 比喻堆积               | 连续使用多个比喻，互相冲突或累赘                     |
| 8   | 情绪直接命名           | "他感到悲伤""她心中一阵愤怒"而非通过行为/感官暗示    |
| 9   | 对话后重复解释         | 角色说完话后，叙述者再解释一遍刚才说了什么           |
| 10  | 情节因果过度顺滑       | 每个事件都有明确因果，缺少偶然、模糊和断裂           |
| 11  | 信息重复               | 同一信息在不同段落反复出现                           |
| 12  | 章节结尾总结化         | 章末用概括性语句总结本章发生的事                     |
| 13  | 对话只服务信息传递     | 对话仅用于交代信息，不体现人物关系、潜台词和权力动态 |
| 14  | 缺少潜台词和不确定性   | 所有信息都是表层的，没有暗示、未说出口的话、模糊地带 |
| 15  | 缺少具体物理与感官细节 | 缺少触觉、嗅觉、温度、重量、声音等具体感知描写       |

**目标**：提高真实写作质量，不是绕过或欺骗 AI 检测器。

### 2.4 长篇不丢失信息

分层上下文架构：

| 层级 | 名称                               | 说明                               |
| ---- | ---------------------------------- | ---------------------------------- |
| A    | Creation Contract / 全局创作规格   | 项目创作意图的唯一权威来源         |
| B    | Story Blueprint / 全局故事蓝图     | 全局大纲、章节结构、情节线         |
| C    | Story State Ledger / 权威事实账本  | 当前时刻所有已确立的事实           |
| D    | Chapter Summaries / 章节摘要       | 每章已完成内容的压缩摘要           |
| E    | Current Chapter Working Memory     | 当前正在生成的章节的完整工作记忆   |
| F    | Retrieval Context / 动态检索上下文 | 根据当前场景动态检索的相关历史片段 |

**事实账本（Story State Ledger）必须包含**：

- 人物状态（位置、情绪、身体状况）；
- 人物知识范围（谁知道什么、谁不知道什么）；
- 人物关系（当前关系状态和变化）；
- 地点状态（哪些地点出现过、当前状态）；
- 时间线（已确立的时间顺序）；
- 世界规则（已确立的物理/魔法/社会规则）；
- 物品归属（重要物品在谁手中）；
- 伤势（角色受伤情况）；
- 承诺（角色做出的承诺）；
- 秘密（读者知道但角色不知道的信息，反之亦然）；
- 伏笔（已埋下但未揭示的线索）；
- 未解决线程（已开启但未闭合的情节线）。

**强调**：不能依赖把全部历史正文不断塞进超长 prompt。

### 2.5 用户个性化

定义 **Writer Preference Profile** 概念。

信息来源：

- 用户显式填写（创作偏好表单）；
- 用户提供的参考样文；
- 用户接受的文本；
- 用户删除的文本；
- 用户自己的改写；
- 用户接受或拒绝的 proposal；
- 用户反复提出的修改意见。

偏好必须尽可能表示为可执行特征：

| 特征类型       | 示例                                       |
| -------------- | ------------------------------------------ |
| 对话占比范围   | 30%–50%                                    |
| 句长分布       | 短句为主 / 长短交替 / 长句为主             |
| 描写密度       | 高（每场景 200+ 字描写）/ 低               |
| 比喻密度       | 每千字 1–2 个 / 极少使用                   |
| 心理解释上限   | 不超过 2 句 / 允许大段心理描写             |
| 章节结尾类型   | 悬念型 / 闭合型 / 余韵型                   |
| 感官细节偏好   | 偏重视觉 / 偏重视听触嗅均衡                |
| 留白程度       | 高（大量未说出口的话）/ 低（信息充分交代） |
| 人物说话差异   | 强（每个角色有独特语言）/ 弱               |
| 禁止词和高频词 | 用户自定义黑名单                           |

### 2.6 如何证明文章变好

定义 **Generation Evaluation Harness**。

**必须包含**：

- 固定创作题库（多种类型/题材/长度的创作任务）；
- 固定 Contract/Scene Brief fixtures；
- 多生成策略对比（不同 pipeline、不同 prompt、不同参数）；
- 模型与 prompt version 记录；
- 自动质量指标；
- critic findings；
- 人工盲测；
- 用户打分；
- 输出和修订结果留档。

**自动指标至少包括**：

| 指标                 | 说明                             |
| -------------------- | -------------------------------- |
| 创作约束遵循率       | 是否遵守 Contract 中的显式约束   |
| 人物事实冲突         | 人物行为是否与其已知信息矛盾     |
| 时间线冲突           | 事件顺序是否存在逻辑错误         |
| 未授权设定新增       | 是否引入了 Contract 未定义的设定 |
| 重复 n-gram          | 高频重复短语比例                 |
| 高频套话             | AI-smell taxonomy 中的套话频率   |
| 句长分布             | 与目标分布的偏差                 |
| 段落长度分布         | 与目标分布的偏差                 |
| 人物声音区分度       | 不同角色语言差异度               |
| 伏笔遗失             | 已埋伏笔是否被遗忘               |
| 摘要与正文事实一致性 | 摘要是否准确反映正文内容         |
| 状态账本更新一致性   | 账本是否与正文保持同步           |

**人工评分至少包括**：

| 维度               | 说明                               |
| ------------------ | ---------------------------------- |
| 是否想继续读       | 读者是否有继续阅读的欲望           |
| 是否符合用户要求   | 是否满足用户的显式和隐性期望       |
| 人物是否可信       | 人物行为和对话是否自然合理         |
| 语言是否自然       | 是否读起来像人写的，而非机器生成的 |
| 是否有明显 AI 味   | 是否存在上文 taxonomy 中的问题     |
| 情节是否推进       | 本章是否推动了故事发展             |
| 是否存在废话       | 是否有可删除而不影响理解的段落     |
| 是否存在连续性错误 | 人物、地点、时间是否存在矛盾       |

---

## 三、两条并行技术主线

项目未来不是单线推进，而是两条并行主线。

### 主线 A：权威数据和用户护栏

```
Grill → Contract → Outline Version → Manuscript Version
→ Proposal / Accept / Reject → Lock / User Protection
→ Rollback / Audit → Continuity State
```

### 主线 B：文章生成质量引擎

```
Evaluation Harness → Scene Planner → Draft Generator
→ Structural Critic → Character Critic → Continuity Critic
→ AI-Smell Critic → Targeted Rewriter
→ Writer Preference Learning → Long-form Context Engine
```

**定位**：

- 主线 A 只做到足以保护用户、支撑生成和实验；
- 不应无限打磨基础设施；
- 主线 B 决定产品真正上限；
- 后续资源投入必须优先考虑文章质量收益。

---

## 四、完整路线与状态

### 状态标记说明

| 标记 | 含义                          |
| ---- | ----------------------------- |
| ✅   | 已合并并验证                  |
| 🟡   | 正在开发或 PR 未合并          |
| 🧱   | 只有 foundation，尚非产品能力 |
| ⬜   | 尚未开始                      |
| ⏸    | 暂缓                          |

### 状态表

#### 工程和运行基础

| 能力                                | 状态 | PR / 备注  |
| ----------------------------------- | ---- | ---------- |
| 本地项目 / SQLite                   | ✅   | M1-A       |
| Provider / Keychain                 | ✅   | PR #1      |
| Task / Invocation / recovery        | ✅   | PR #2      |
| Task Activity Center                | ✅   | PR #6      |
| Renderer safety / accessibility     | ✅   | PR #7, #10 |
| Grill domain / persistence / IPC    | ✅   | PR #3      |
| Grill Renderer                      | ✅   | PR #4, #5  |
| AI Grill question planning backend  | ✅   | PR #9      |
| AI Grill question planning Renderer | ✅   | PR #11     |

#### 外部生成适配器与 Foundation

| 能力                         | 状态 | PR / 备注                                                                    |
| ---------------------------- | ---- | ---------------------------------------------------------------------------- |
| PlotPilot sidecar foundation | 🧱   | PR #8（adapter + lifecycle + SSE；无 Worker RPC、无产品 UI、无真实生成 E2E） |

#### 创作契约

| 能力                                                | 状态 | PR / 备注                                             |
| --------------------------------------------------- | ---- | ----------------------------------------------------- |
| Creation Contract C0 design                         | ✅   | PR #12 / `dd5613ca`（design + document rebaseline）   |
| Creation Contract C1-A foundation                   | ✅   | PR #13（domain / contracts / database / application） |
| Creation Contract C1-B1 Accept/Reject               | ✅   | PR #14                                                |
| Creation Contract C1-B2 User Update / Lock / Unlock | ✅   | PR #15                                                |
| Creation Contract C2 AI task / process bridge       | 🟡   | PR #17（尚未合并，正在 review）                       |

#### 生成质量能力（部分 foundation 开发中，其余尚未开始）

| 能力                                 | 状态 | 说明                                                            |
| ------------------------------------ | ---- | --------------------------------------------------------------- |
| Minimal Creation Contract Renderer   | ⬜   | Contract 后端已有，需最小 UI                                    |
| Writing Evaluation Lab               | 🟡   | PR #18 foundation（固定题库 + 多策略对比 + 评分体系；尚未合并） |
| Minimal Manuscript / Chapter Version | ⬜   | 稿件版本管理基础                                                |
| Scene Planner                        | ⬜   | 从章节目标到场景卡片                                            |
| Chapter Draft Pipeline               | ⬜   | 分场景生成 + 组合                                               |
| Structural Critic                    | ⬜   | 结构审查（情节、节奏、信息揭示）                                |
| Character Voice Critic               | ⬜   | 人物声音一致性和区分度                                          |
| AI-Smell Critic                      | ⬜   | 基于 taxonomy 的自动检测                                        |
| Targeted Rewriter                    | ⬜   | 定点修订，非整章重写                                            |
| Writer Preference Profile            | ⬜   | 用户偏好建模和可执行约束                                        |
| Story State Ledger                   | ⬜   | 权威事实账本                                                    |
| Chapter Summary / Fact Extraction    | ⬜   | 章节摘要和事实抽取                                              |
| Retrieval Context Engine             | ⬜   | 动态检索上下文                                                  |
| Outline Proposal / Version           | ⬜   | 大纲生成和版本管理                                              |
| Long-form Generation                 | ⬜   | 长篇持续生成                                                    |
| Continuity Detection                 | ⬜   | 连续性检测                                                      |
| Review / Fix Workflow                | ⬜   | 审稿和定点修复流程                                              |
| PlotPilot Product Integration        | ⬜   | PlotPilot 产品级接入                                            |
| Export / Backup / Recovery           | ⬜   | 导出、备份、恢复                                                |
| Real Novel Quality Acceptance        | ⬜   | 真实作品质量验收                                                |

---

## 五、调整后的执行优先级

| 顺序 | 能力                                           | 前置依赖                      |
| ---- | ---------------------------------------------- | ----------------------------- |
| 1    | 完成当前 M1-C2                                 | M1-C1（已完成）               |
| 2    | 实现最小可用 Contract Renderer                 | M1-C2                         |
| 3    | 建立 Writing Evaluation Lab                    | 无（可与 #2 并行）            |
| 4    | 建立最小 Manuscript / Chapter Version          | M1-C2                         |
| 5    | 实现第一版 Scene Planner                       | Manuscript Version            |
| 6    | 实现场景级 Draft Generator                     | Scene Planner                 |
| 7    | 实现 Structural / Character / AI-Smell critics | Draft Generator               |
| 8    | 实现 Targeted Rewriter                         | Critics                       |
| 9    | 建立 Story State Ledger 和章节摘要             | Manuscript Version            |
| 10   | 实现动态 Retrieval Context                     | State Ledger + Summaries      |
| 11   | 建立 Writer Preference Profile                 | 多次生成 + 用户反馈数据       |
| 12   | 扩展到 Outline 和长篇持续生成                  | Scene Planner + State Ledger  |
| 13   | 接入 PlotPilot 产品链路                        | Contract + Manuscript Version |
| 14   | 审稿、导出、备份和真实作品验收                 | 全部上游能力                  |

**关键约束**：

- 不应在 Manuscript Version 和 Evaluation Harness 建立前，直接大规模开发长篇正文生成。
- Writing Evaluation Lab 不依赖完整 Contract UI，可与 Minimal Contract Renderer 并行推进；质量实验链路不得因 Contract UI 延期。

---

## 六、当前真实产品能力

### 现在已经能做

- 创建本地项目；
- 配置模型；
- 运行持久化任务；
- 执行 Grill-me；
- 使用 AI 规划问题；
- 在 UI 审核并接受问题计划；
- 后端管理 Creation Contract proposal / version；
- 接受、拒绝、用户更新、Lock、Unlock；
- 查看任务和模型调用状态。

### 现在还不能完整做

- 从 UI 请求并审核 AI Creation Contract；
- 维护真实稿件；
- 生成大纲；
- 生成章节和正文；
- 长期保持人物和情节信息；
- 自动发现 AI 味；
- 学习用户个人风格；
- 定点修改文章；
- 导出和备份完整作品。

### 当前产品描述

**这是一个成熟的本地项目、需求澄清、任务执行和创作规格后端平台；还不是完整小说生成器。**

---

## 七、当前执行状态

| 字段                       | 值                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Last verified date         | 2026-08-01                                                                                                               |
| Verified main SHA          | `dd0448116d6ff55b823d3579b25e69738d7a85fb`                                                                               |
| Active implementation      | M1-C2 Creation Contract Draft Pipeline & Process Bridge；GQ1 Writing Evaluation Lab Foundation                           |
| Active PR                  | PR #17 / feat/m1c2-contract-draft-pipeline（尚未合并）；PR #18 / feat/gq1-writing-evaluation-lab（foundation，尚未合并） |
| Last merged capability     | M1-C1B2 Creation Contract User Update / Lock / Unlock（PR #15）                                                          |
| Next product capability    | Minimal Contract Renderer 与 Writing Evaluation Lab 并行推进；质量实验链路不得因 Contract UI 延期                        |
| Current largest risk       | 项目继续过度投资基础设施，而未建立生成质量评测与文章生成实验闭环                                                         |
| Current quality hypothesis | 分场景生成 + 多维 critic + 定点修订，会显著优于单次整章生成                                                              |

---

## 八、Progress Log

| Date       | PR / SHA                                                        | Status | Capability                                                                | Quality Impact                                         | Evidence                                                                                     | Next                                                     |
| ---------- | --------------------------------------------------------------- | ------ | ------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 2026-07    | 初始提交 / M0                                                   | ✅     | 仓库与工程基线                                                            | 无                                                     | Electron 启动、三栏 UI、健康检查                                                             | 本地项目和 Provider                                      |
| 2026-07    | PR #1                                                           | ✅     | M1-A 本地项目 + M1-B1 Provider / Keychain                                 | 无                                                     | 232 tests passed                                                                             | 持久化任务                                               |
| 2026-07    | PR #2                                                           | ✅     | M1-B2 持久化任务与模型调用                                                | 无                                                     | 365 tests passed                                                                             | Task Activity Center                                     |
| 2026-07    | PR #3                                                           | ✅     | M2-A1 Grill 领域 / 持久化 / IPC                                           | 无                                                     | 领域模型 + 4 张表 + IPC 全链路                                                               | Grill Renderer                                           |
| 2026-07    | PR #4, #5                                                       | ✅     | M2-A1.5 Grill 桌面工作台                                                  | 无                                                     | 三栏 UI、session/question/answer/proposal                                                    | AI question planning                                     |
| 2026-07    | PR #6                                                           | ✅     | M1-B2.5 Task Activity Center                                              | 无                                                     | 任务列表 / 详情 / 统计                                                                       | Renderer safety                                          |
| 2026-07    | PR #7                                                           | ✅     | M1-S1 Renderer safety boundary                                            | 无                                                     | ErrorBoundary + safe-error                                                                   | Grill Renderer safety                                    |
| 2026-07    | PR #8                                                           | 🧱     | PlotPilot sidecar foundation                                              | 无                                                     | adapter + lifecycle + SSE（仅 foundation）                                                   | 产品接入推迟                                             |
| 2026-07    | PR #9                                                           | ✅     | M2-A2-BE AI question-plan backend                                         | 无                                                     | GRILL_QUESTION_PLAN 任务类型 + 严格解析                                                      | AI question-plan Renderer                                |
| 2026-07    | PR #10                                                          | ✅     | M1-S2 Renderer accessibility                                              | 无                                                     | LiveRegion + focus-utils                                                                     | AI question-plan Renderer                                |
| 2026-07-30 | PR #11                                                          | ✅     | M2-A2-FE AI question-plan Renderer                                        | 无                                                     | 触发、审核、显式接受                                                                         | Creation Contract                                        |
| 2026-07-29 | PR #12 / `dd5613ca`                                             | ✅     | M1-C0 Creation Contract architecture design and document rebaseline       | 无直接文章质量证据；建立生成规格护栏                   | creation-contract-design.md、roadmap/current-state/module-boundaries 重基线                  | M1-C1 foundation                                         |
| 2026-07    | `497611f` PR #13                                                | ✅     | M1-C1A Creation Contract foundation                                       | 无                                                     | domain / contracts / database / application                                                  | Accept / Reject                                          |
| 2026-07    | `569d912` PR #14                                                | ✅     | M1-C1B1 Accept / Reject                                                   | 无                                                     | CAS、typed operations、原子事务                                                              | User Update / Lock                                       |
| 2026-08-01 | `b4f40d2` PR #15                                                | ✅     | M1-C1B2 User Update / Lock / Unlock                                       | 无                                                     | lock/unlock 创建新 version、user update                                                      | M1-C2 AI task / process bridge                           |
| 2026-08-01 | PR #17（尚未合并）                                              | 🟡     | M1-C2 AI task / process bridge                                            | 打通创作规格生成链路；尚无文章生成质量提升证据         | task-engine、runner、process bridge、SQLite concurrency、backend E2E（最终 HEAD 见 PR 顶部） | Minimal Contract Renderer 与 Writing Evaluation Lab 并行 |
| 2026-08-01 | PR #18 / `b2456f353cfe765499adf303700ba73152543a1a`（尚未合并） | 🟡     | GQ1 Writing Evaluation Lab foundation（固定题库 + 多策略对比 + 评分体系） | 建立评测骨架；尚无文章质量提升证据                     | evaluation harness foundation、fixtures、评分体系骨架                                        | 合并后接入 generation pipeline 对比                      |
| 2026-08-01 | `dd04481` PR #16                                                | ✅     | Generation quality roadmap and progress ledger                            | 建立质量方向的权威路线和维护制度；尚无文章质量实验结果 | generation-quality-roadmap.md                                                                | 合并后由所有 DeepSeek / MiMo 任务持续维护                |

### 早期能力汇总基线

PR #1 至 #15 合并后，main 上已建立的工程能力包括：本地项目管理（SQLite 持久化）、Provider 配置与 Keychain、持久化任务与模型调用审计、Task Activity Center、Renderer safety boundary 与 accessibility、Grill 领域模型 / 持久化 / IPC / Renderer、AI question-planning 后端与 Renderer、PlotPilot adapter foundation、Creation Contract C1 权威数据和 mutation 后端（read queries、proposal accept/reject、user update、lock/unlock）。这些是工程护栏和支撑层，尚未产生任何产品级的文章生成质量能力。CREATION_CONTRACT_DRAFT task、Worker/Main/Preload process bridge、Contract Renderer 均尚未完成。

---

## 九、长期维护协议

1. 任何 DeepSeek 或 MiMo 任务开始前，都应先阅读本文件。
2. 任何改变下列内容的 PR，都必须在同一 PR 更新本文件：
   - 产品能力状态；
   - 生成质量策略；
   - 长篇上下文架构；
   - 用户偏好学习；
   - Evaluation Harness；
   - Generation / Critic / Rewrite pipeline；
   - 已知风险；
   - 质量实验结果；
   - 推荐优先级。
3. 尚未合并的能力只能标为 🟡，不能标为 ✅。
4. 只有 main 上已合并并经过复核的能力才能标为 ✅。
5. Foundation-only 能力必须标为 🧱，不能描述为产品已可用。
6. 更新时不得删除历史 Progress Log。
7. 每条进度必须包含日期、PR 或 SHA、证据和下一步。
8. 测试通过只证明工程正确，不证明文章质量。
9. 文章质量结论必须提供人工评估或固定评测集证据。
10. 不相关的 PR 不强制修改本文件，但 Agent 报告中必须明确：
    "Generation quality roadmap update: not required."
11. 若本文件与旧 roadmap / current-state 冲突：
    - 本文件是文章质量方向的事实来源；
    - GitHub main 和已合并 PR 是工程状态的最终事实来源。
12. 不得把 Contract、IPC、SQLite 或测试数量本身描述为最终产品价值。
