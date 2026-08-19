# B22 设计：故事图谱数据层与抽取管线（D14 首批）

> 背景：D14 已拍板（见 `story-graph-design.md` §8）。B22 = migration v22 图数据层 +
> STORY_GRAPH_EXTRACT 抽取任务 + 章末触发 + 回填命令，纯后台（无 UI，任务中心的
> 任务名注册除外）。检索接入（B23）、故事圣经 UI（B24）、核验 Critic（B25）后续批。

## 1. 决策

### D-B22-1 migration v22 = 六表 + tasks CHECK 放宽（一个 migration 收口）

- 六表按 `story-graph-design.md` §2 落地：story_entities / story_entity_aliases /
  story_states / story_threads / story_extractions / story_merge_reviews。
  **不建 story_events**（D-D14-1 事件层二期）。全部 STRICT、带 project_id、
  FK 到 project_metadata；origin CHECK ('extracted','user')。
- 同一 v22 里重建 tasks 表，CHECK 加入 `STORY_GRAPH_EXTRACT`（照 v13
  SPEC_EXTRACT 的重建模式）。
- story_states 为 append-only：状态变化 = 旧边填 valid_until_chapter +
  superseded_by_id 指向新边；UPDATE 只允许触碰这两列与 merged_into_id 类管理列。

### D-B22-2 抽取任务走独立 runner（非图节点）

图是派生层，不占 Graph 槽位——STORY_GRAPH_EXTRACT 不是图节点任务，参照
GRILL_QUESTION_PLAN 的独立 runner 形态（`apps/worker/src/grill-plan-runner.ts` +
`runner-kernel.ts`）。payload = `{ chapterId, sourceVersionId, sourceContentHash }`；
模型经 `resolveProviderForTask` 按任务类型路由（D14 已拍板跟随默认模型）；
调用照旧记 `model_invocations` 账本。**同项目的图抽取任务必须按章节顺序串行**
（前情登记表逐章递进是指代消解的锚，乱序会退化）。

### D-B22-3 触发点两处 + 防抖

- MANUSCRIPT_COMMIT 成功路径（`manuscript-commit-executor.ts`）与用户显式保存
  新版本成功路径（manuscript 保存用例）各排队一次抽取。
- 防抖：入队前查同章未开跑（pending）的 STORY_GRAPH_EXTRACT——同 content_hash
  直接跳过；不同 hash 取消旧 pending 再入队（running 的不动，靠 hash 锚定判 stale）。
- 抽取失败不阻塞任何主流程（派生层纪律）：触发点吞错误只记日志。

### D-B22-4 抽取输入/输出契约

- 输入 = 权威版本正文（chapter_versions current，绝不取候选）+ 前情登记表
  （该项目已知实体 canonical_name + 别名 + open threads 清单）。
- 输出 = 类型化 JSON：`entities[] / states[] / threads_open[] / threads_close[] /
merge_suspects[]`，每条带 evidence（原文短引片段）；严格解析照 spec-extract
  纪律：**结构非法**（缺字段/类型错/越界）整体判失败重试；**语义无效**
  （如核销引用了不存在的线程 id）丢弃该条并计入结果统计——模型幻觉出的
  引用不该拖垮整章抽取。
- 写入 = 单事务：登记 story_extractions（含 source_version_id + content_hash）、
  合并实体（见 D-B22-5）、开/关状态边、开/核销线程、疑似合并入待审队列。
- 改章重抽 = 先失效该章来源的 extracted 记录（及 superseded 链下游）再写入；
  `origin='user'` 记录永不触碰。

### D-B22-5 实体合并从简，LLM 重摘要推迟

canonical_name 或别名精确命中 → 归并到既有实体，profile_summary 追加新描述；
超 2000 字符阈值截断最旧段落（保留最新）。LightRAG 式超阈值 LLM 重摘要推迟到
B24（故事圣经 UI 需要可读档案时再上），登记 TD。**自动抽取永不合并两个既有实体**
——疑似同实体（含秘密身份场景）只写 story_merge_reviews 待审（D14 铁律）。

### D-B22-6 回填 = 重建命令

新 dispatch 命令（storyGraph:rebuild 形态随 81 命令信封惯例）：清空该项目全部
extracted 图记录（user 覆盖层保留）→ 按章节顺序逐章入队抽取。B22 无 UI 入口
（B24 接故事圣经的「重建」按钮），验收用命令直接驱动；进度经任务中心既有任务
列表可见（任务名注册进 task-labels：「故事圣经抽取」）。

### D-B22-7 工单一验收裁定（设计未覆盖的边角，2026-08-19）

- **改章失效不级联删除下游，改「链接拼接」**：重抽第 N 章只删 `source_chapter=N`
  的 extracted 边；被删边的前驱边重新链接到链上最近的存续后继
  （`superseded_by` 指向后继、`valid_until` 取后继的 `valid_from`），无存续后继
  则重开（两列置 NULL）。理由：下游边锚定在未改动章节的正文上，证据仍然成立，
  级联删除只制造要靠全量重建才能补回的空洞；`story-graph-design.md` §3 的
  「级联失效」按此口径收窄，全量重建命令仍是增量 bug 的兜底。
- **回填清空连已裁决的 merge_reviews 一并清**：重建后成员实体引用全部失效，
  留任何裁决记录都是悬空语义。
- **回填清空保留仍被 user 记录引用的 extracted 实体**：「清空 extracted」与
  「user 层永不受损」冲突时后者优先。
- 其余工单一自主判断（线程补来源锚、账本 status 取值、来源列不加 FK、
  重抽撤回线程核销等）全部追认，口径以实现为准。
- 已知交叉点留给 B24：拼接只修补 extracted 前驱——若 B24 允许 user 边
  supersede 抽取边，重抽时 user 前驱会悬空（FK 会拦住删除），届时随用户
  覆盖层编辑语义一并定。

## 2. 工单拆分

- 工单一（数据层）：migration v22 全量 + database 仓库与类型 + contracts 任务
  类型并集（编译波及处随手修）+ task-labels 注册 + 迁移/仓库测试。
- 工单二（管线）：application 用例 + worker runner + 触发两处 + 防抖 + 回填命令 +
  抽取 prompt 与严格解析 + provider 路由 + 测试（fake gateway 全链 + 触发/防抖/
  回填/串行序）。

## 3. 验证基线

`pnpm check` 全绿；两工单各自带测试；验收另起隔离数据副本实例走一遍
「生成章节 → commit → 自动抽取 → 表内容正确 → 改章重抽 → 回填重建」。
