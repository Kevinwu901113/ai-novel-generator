# 故事知识图谱设计（D14）：长篇一致性的派生层

> 负责人 2026-08-18 定向：参照 GraphRAG/LightRAG 为长篇小说建知识图谱/图结构，
> 保障剧情发展与人物关系构建；要求充足调研后设计；已拍板两点——**图谱做成可见
> 可编辑的「故事圣经」产品功能**、**抽取跟随默认模型**（走网关按任务类型路由，
> 可随时切换）。本文档 = 调研结论 + 架构设计 + 分批实施计划 + 待拍板项。
> 状态：**待负责人确认**。

---

## 1. 调研结论（三路调研的收敛点）

### 1.1 外部方案怎么选

- **Microsoft GraphRAG**（实体图 + 层级社区摘要）：索引贵、社区结构与增量更新
  互斥（社区漂移即全量重算）、global 查询单次可达数十万 token。**社区层不采用**；
  其管线阶段划分（抽取→合并→摘要→检索）作为参照。
- **LightRAG**（HKUDS，EMNLP 2025）：砍掉社区层，实体+关系双索引，增量插入 =
  并集合并（同实体描述合并超阈值才重摘要）——**逐章更新的正确形态**。四个存储
  接口恰好是 SQLite 四张表的形状；前身 nano-graphrag 核心约 1100 行，**借思路
  自建（TypeScript + SQLite），不引 Python 库**。
- **Narrative World Model**（arXiv 2607.05577，本设计最重要的单一参照）：为长篇
  写作记忆专门设计的**带章节戳的时序状态图**——每条关系/状态边带
  `[valid_from_chapter, valid_until_chapter]` 有效区间 + 来源章 + 证据片段；
  伏笔线程是一等公民节点（open/closed + 许诺的 payoff）；改章重发布 = 重抽该章 +
  级联失效。关键消融：**查询条件化（检索）而非存储内容是成败线**（0.898 vs
  0.358），且换便宜抽取模型结果不降——schema 比模型档次重要。
- **一致性核验**：FlawedFictions 证伪「整篇丢给强模型找矛盾」（最强模型长文近
  随机）；可行路径是 ConStory-Checker 式**分类别、小上下文、成对矛盾检查**
  （生死状态/知识范围/时间线/称名外貌等 5 大类 19 子类），图的作用正是把「相关
  旧状态」精准递到检查器面前。
- **抽取质量三大坑**：指代消解（逐章抽取 + 携带前情登记表缓解）；别名增殖
  （人工别名表，照抄 novelcrafter Aliases）；**同名异人/秘密身份不能自动合并**
  （Conan 基准的教训：一人多名常是剧情设定），疑似同实体进待审队列。

（完整外部调研含来源链接存档于本文档 §9。）

### 1.2 PlotPilot 参照（负责人点名）

PlotPilot = `THIRD_PARTY_NOTICES.md` 登记的外部 Python 项目（shenminglinyi/
PlotPilot）。仓库内只有零接线的 sidecar adapter 骨架（packages/plotpilot-adapter，
无任何消费方）；原 sidecar 架构里「知识图谱与伏笔账本」划归 PlotPilot 侧所有权
（`docs/architecture/plotpilot-sidecar-integration.md`）——本设计即把这块能力收归
自建。其源码设计与本设计高度收敛，直接借鉴四点：

- Story Bible：人物档案（含 POV 防火墙）+ 地点图 + 世界设定三元组；
- 正文自动抽取 `(主体, 关系, 客体)` 三元组，结构化 + 语义混合查询；
- **伏笔注册表：钩子的开启/悬置/消费状态全程追踪**；
- **章末管线**：章节生成后自动跑「摘要/事件/三元组/伏笔」抽取 + 索引更新。

### 1.3 仓库内现状（机会与先例）

- **跨章一致性现状是裸奔**：章节生成 prompt 只带整张蓝图 + 前面各章的一句话
  goal，**已完成章节的正文从不进 prompt**（`packages/task-engine/src/
chapter-nodes.ts` 的 `chapterContextPayload`）。图检索哪怕只返回「相关人物当前
  状态 + 未解决伏笔 + 最近事件」也是净增信息——收益上限高。
- **架构先例现成**：派生数据走「独立表、不占冻结的 Graph 槽位」（v17 场景计划 /
  v18 改写意见同款）；失效模型照抄 v20 草稿层「读取端比对判 stale」——图记录锚定
  `source_version_id + content_hash`，正文写路径一行不改。
- **注入点单点收敛**：`loadContext` / `chapterContextPayload` 被四类章节任务共用，
  图检索注入一次全线受益，且天然可开关（A/B 便利）。
- **模型路由零代码**：新 task_type + `provider_routes` 一条配置即可换抽取模型；
  机械成本只有 migration 放宽 `tasks.task_type` CHECK（v13/14/16/17 模式）。
- **评测装置缺口**：writing-evaluation 边界禁止依赖 database；实验输入单元是
  单场景 scene brief，无章节序列概念；且 GE-9 首轮 A/B 教训——短篇装置测不出
  「怎么提示」类改动的人类可感知差异（场景难度的影响是提示的十倍）。**图的验证
  需要新的长序列实验形态，且预设效应量可能小**。

---

## 2. 数据模型（project.sqlite，migration v22，全部 STRICT）

图是**正文的纯派生物**：任何时刻可全量 DROP 重建；用户编辑走独立的覆盖层记录
（`origin='user'`），重抽永不覆盖。不占 Graph artifact 槽位、不改冻结的图定义。

```
story_entities         实体：id, project_id, kind(character/location/item/setting),
                       canonical_name, profile_summary, first_chapter, origin(extracted/user),
                       merged_into_id(合并后指向存续实体，软合并可回退)
story_entity_aliases   别名表：entity_id, alias, origin, UNIQUE(project, alias, entity)
story_states           状态/关系边（核心表）：id, subject_entity_id, predicate,
                       object_entity_id NULL, object_text NULL,
                       valid_from_chapter, valid_until_chapter NULL(仍有效),
                       source_chapter_id, source_content_hash, evidence_span,
                       confidence, origin, superseded_by_id NULL
                       —— 状态变化 = 关闭旧边(填 valid_until) + 开新边，append-only
story_threads          伏笔/线程：id, kind(foreshadow/promise/mystery/...),
                       description, status(open/closed/abandoned), promised_payoff,
                       opened_chapter, closed_chapter NULL, evidence_span, origin
story_events           事件时间线（二期，见 §8 拍板项）：chapter 序锚定，不解析
                       故事内绝对时间
story_extractions      抽取账本（惰性失效锚点）：chapter_id, source_version_id,
                       source_content_hash, task_id, status, extracted_at
story_merge_reviews    同名异人待审队列：entity_a, entity_b, suggested_reason,
                       status(pending/merged/rejected), decided_at
```

要点：

- **章节戳有效区间**（NWM/Graphiti/novelcrafter Progressions 三方收敛）：查询取
  「≤ 当前章的最新有效状态」，历史不丢，能回答「第 10 章时他们是什么关系」。
- **content_hash 锚定**：与 MANUSCRIPT_COMMIT 幂等判据同构；版本恢复到旧版时
  读取端自然判 stale，触发重抽。
- **用户覆盖层**：故事圣经里的人工编辑写 `origin='user'` 记录；检索时 user 记录
  优先于同 subject+predicate 的 extracted 记录；重抽只动 extracted。
- **秘密身份**：合并是软合并（`merged_into_id`）+ 支持「A 是 B 的秘密身份
  （第 N 章揭示）」的带章节戳等价边；自动抽取只能提交待审，不能直接合并。

## 3. 抽取管线

- **新 task_type `STORY_GRAPH_EXTRACT`**（migration 放宽 CHECK；默认模型，
  可经 provider_routes 换档）。
- **触发时机 = 章末管线（PlotPilot 同款）**：MANUSCRIPT_COMMIT 成功后自动排队
  抽取该章；用户显式保存新版本后同样排队（防抖：同章未跑的 pending 任务合并）。
  抽取失败不阻塞任何主流程（派生层纪律）。
- **抽取源 = 权威稿件版本（`chapter_versions` current）**，绝不从候选抽取
  （候选未被接受，会污染图）。代价「候选审阅时图看不到本章」由核验设计消化
  （核验读的是候选正文 vs 图中既有状态，方向正确）。
- **输入** = 该章正文 + 前情登记表（该项目已知实体 canonical_name + 别名表 +
  open threads）——这是指代消解的锚。**输出** = 类型化 JSON（实体/状态边/线程
  开启与核销/疑似合并），带证据 span；走既有严格解析纪律。
- **合并语义**：同名实体追加描述，累计超阈值才触发一次 LLM 重摘要
  （LightRAG `FORCE_LLM_SUMMARY_ON_MERGE` 思路）；疑似同实体进待审队列。
- **改章 = 重抽该章 + 级联失效**：删除/失效 `source_chapter=N` 的 extracted
  记录及其 superseded 链下游，重抽；全量重建命令兜底一切增量 bug。
- **回填**：对既有项目提供「重建故事圣经」入口（逐章顺序抽取，进度可见）。

## 4. 检索接入生成（NWM 四段式）

注入点：`loadContext`（四类章节任务共用），开关 `useStoryGraph`（A/B 用）。

1. **因果截断**：只取 `valid_from_chapter < 当前章` 的记录（防剧透未来）；
2. **种子匹配**：本章蓝图 goal + 场景计划文本，经别名表精确/FTS5 匹配命中实体
   （起步不用向量，见 §8 拍板项）；
3. **一跳扩展**：命中实体的当前有效状态边 + 关系对端实体卡（novelcrafter 级联
   拉入同款）；
4. **预算封顶**：open threads 全量 + 状态包按字符预算截断（起步 ~8k 字符，
   可调），确定性排序（相关度→章节新近度）。

替换 `precedingChapterGoals` 里离当前章较远的部分（近 3 章 goal 保留），prompt
净增量受控。

## 5. 故事圣经 UI（负责人已拍板：可见可编辑）

- 项目工作台新增「故事圣经」入口（与四阶段旅程并列的项目级视图，具体导航形态
  实现批设计）：**人物卡**（档案 + 当前状态 + 关系 + 出场章节）、**关系视图**
  （起步用结构化列表 + 按章节滑块回放状态，图形化二期）、**时间线**（章节序
  事件流，随 §8 事件层拍板）、**伏笔列表**（open/closed + 开启章 + 许诺 payoff）、
  **待审队列**（疑似同实体合并确认）。
- 编辑语义 = 用户覆盖层（§2）：可改实体档案/别名/状态/线程状态，用户记录优先、
  重抽不覆盖；界面明确标注「自动抽取 / 你写的」（与稿件版本来源标注同款语言）。
- 每条抽取记录可跳转证据原文（evidence_span → 阅读视图定位），可审计。

## 6. 一致性核验（图锚定的定向检查，不做全文扫描）

- 接入点：**候选审阅的自查结果区**（既有 UI 位与 chapter_critiques 机制），新增
  一个图核验 Critic：按 ConStory 分类学子集逐类检查——
  ①生死/存在状态（提及已死亡实体）②知识范围（角色引用无知识边支撑的信息）
  ③称名/外貌与设定冲突 ④时间线序冲突（事件层落地后）⑤该章应核销的 open thread。
- 每类检查 = 从图取相关状态 + 候选片段的成对矛盾判定，输出证据引用。
- **产品语义待拍板**（§8）：推荐非阻断黄色警告（与现有自查结果同级呈现），
  不阻断采用——误报打扰度优先于查全率。

## 7. 验证（GE-9 结合）与成本

- **先 dogfood 后装置**：对既有多章项目回填建图 → 生成后续章节的图辅助/无图
  双臂对照（同 seed），负责人盲读——长序列一致性收益在真实项目上最直观。
- 装置化（独立批次）：writing-evaluation 扩 schema（case 携带预烘焙的图检索
  结果，维持无 DB 依赖边界）+ 跨章一致性维度进盲评 rubric；上轮教训预设效应量
  可能小、需独立评分者。
- 成本：抽取每章 1 次调用（+合并重摘要偶发 +核验每候选 1 次）；`model_invocations`
  账本现成可核算；无金额上限设施——rewrite 循环最坏放大 ~10×，检索本身零模型
  调用（FTS5/别名匹配），风险可控但写进验收观察项。

## 8. 待负责人拍板（按影响排序）

1. **MVP 图粒度**：推荐「实体 + 状态边 + 伏笔线程」三件套先行，事件时间线
   （story_events + 时间线 UI + 时序冲突核验）二期——事件层价值大但 schema 与
   抽取难度都翻倍。是否同意？
2. **核验产品语义**：推荐「非阻断黄色警告，进候选自查结果区」。还是要更强的
   （阻断采用/一键改稿建议）？
3. **检索起步形态**：推荐 FTS5 + 别名激活（零新依赖），向量检索（sqlite-vec +
   嵌入模型走网关）二期再评估。还是同期上向量？
4. **上帝视角/读者视角**：故事圣经默认展示到「已写到的最新章」的状态（上帝
   视角）；「按章节滑块回放」已覆盖读者视角需求。有无异议？

## 9. 分批实施计划（每批独立验收，B22 起）

| 批次 | 内容                                                                                       | 依赖           |
| ---- | ------------------------------------------------------------------------------------------ | -------------- |
| B22  | migration v22 图数据层 + STORY_GRAPH_EXTRACT 抽取 executor + 章末触发 + 回填命令（纯后台） | 拍板 §8.1      |
| B23  | 检索接入 loadContext（useStoryGraph 开关）+ dogfood 双臂对照                               | B22            |
| B24  | 故事圣经 UI（实体卡/状态/伏笔/待审队列 + 用户覆盖层编辑）                                  | B22            |
| B25  | 图核验 Critic 进候选自查区                                                                 | B22、拍板 §8.2 |
| B26  | 评测装置长序列形态 + 正式 A/B                                                              | B23            |

B23/B24 可并行（不同层）。每批照例设计文档 + 实现工单派 Opus + 我验收整合。

## 10. 外部调研来源存档

GraphRAG: microsoft.github.io/graphrag（default_dataflow / drift_search）、
arXiv 2404.16130、github.com/microsoft/graphrag/issues/741（增量索引现状）。
LightRAG: github.com/HKUDS/LightRAG、arXiv 2410.05779。轻量变体:
github.com/gusye1234/nano-graphrag、github.com/circlemind-ai/fast-graphrag、
HippoRAG 2 arXiv 2502.14802。SQLite 图先例: github.com/shwetarkadam/sqlite-graph
（recursive CTE + FTS5 + RRF + bi-temporal 边）。时序叙事图: Narrative World
Model arXiv 2607.05577、Graphiti/Zep arXiv 2501.13956、DyG-RAG arXiv 2507.13396。
角色一致性: CHIRON arXiv 2406.10190、Conan arXiv 2402.11051（秘密身份/分视角）、
SCORE arXiv 2503.23512。核验: ConStory arXiv 2603.05890（5 大类 19 子类分类学）、
FlawedFictions arXiv 2504.11900（全文扫描证伪）。产品机制: docs.novelai.net/text/
lorebook（关键词激活/级联/预算）、novelcrafter Codex（Aliases/Relations/
Progressions）、Sudowrite Story Bible/Chapter Continuity。PlotPilot:
github.com/shenminglinyi/PlotPilot（章末管线/三元组索引/伏笔注册表）。
