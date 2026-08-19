# B23 设计：图检索接入章节生成（D14 第二批）

> 背景：B22 已上线（抽取管线，main=`a956a3c`）。B23 = 把图检索接进
> `loadContext`（四类章节任务共用，`packages/task-engine/src/chapter-nodes.ts`），
> 按 D-D14-3 拍板同期上向量。技术摸底：node:sqlite 自带 FTS5 且 trigram
> 分词器可用（中文子串检索的正解）；model-gateway 只有 chat 通道，
> embeddings 需新增且仅 openai-chat 协议端点有 /v1/embeddings。

## 1. 决策

### D-B23-1 双路召回与降级顺位

三路召回：主干两路 = **别名/名称激活**（种子文本对别名表精确子串匹配，
JS 实现，别名表小）与 **FTS5 trigram 次级召回**（states 的
object_text/evidence、threads 的 description/payoff）；增强一路 =
**向量召回**。三路 RRF 融合。向量层任何失败或未配置 → 静默降级主干两路并
记日志。**生成主流程绝不因检索受阻**：检索模块整体 try/catch，失败时
loadContext 回落到无图形态（与开关关闭等价）。

### D-B23-2 向量机制：BLOB + 暴力余弦，sqlite-vec 推迟

嵌入向量存 v23 `story_embeddings`（kind/ref_id/model/dims/vector BLOB
float32/content_hash），查询时 JS 暴力余弦取 topK。依据：单项目图规模
≤1e4 行，ANN 无收益；避免原生扩展依赖。D-D14-3 的拍板语义「向量同期上」
保持，机制上 sqlite-vec 推迟到规模需要时（偏离字面，负责人可复议）。

### D-B23-3 嵌入路由：伪任务类型，未配置则向量层关闭

provider_routes 新增伪任务类型 `STORY_GRAPH_EMBED` 用于选择嵌入模型；仅
openai-chat 协议 provider 可路由（gateway 新增 `invokeEmbedding`，走
/v1/embeddings；anthropic-messages 无嵌入 API，路由到它按配置错误处理）。
**未配置该路由 → 向量层整体关闭**，别名/FTS5 主干照常工作——嵌入模型是
增强项不是前置条件。嵌入调用照记 `model_invocations`
（requestKind=`story_graph_embed`）。

### D-B23-4 嵌入写路径：抽取后置 best-effort

抽取任务主事务提交后批量嵌入本次新增/变更行（实体档案、状态边、线程），
失败不失败任务，计数进 result_json；查询时种子文本 1 次嵌入调用，失败降级
（D-B23-1）。重建/回填自然覆盖旧嵌入（content_hash 判断是否需要重算）。

### D-B23-5 因果截断与章号映射

图的章节戳 = 稿件 slot 序（B22 口径，含 archived 占号）。生成章的 N：
有 manuscript_chapter_links 绑定 → 该章 slot 号；未绑定（首次生成）→
max slot + 1。检索取 `valid_from_chapter < N` 的当前有效状态边（重生成
第 N 章不喂它自己旧内容的状态），线程取「N 时点仍未核销」
（opened < N 且 (closed IS NULL OR closed >= N)）。user 覆盖层优先于同
subject+predicate 的 extracted 记录（D14 §2 既定）。

### D-B23-6 组装与预算

命中实体的当前有效边 + 一跳对端实体卡（novelcrafter 级联同款）；线程包
优先级最高全量给出；状态包按 8k 字符预算截断，确定性排序（RRF 分 →
章节新近度 → id）。prompt 的 `chapterContextPayload` 新增 `storyGraph` 段，
`precedingChapterGoals` 只保留近 3 章（远章 goal 被图状态替代，净增量受控）。

### D-B23-7 开关与 dogfood

worker 环境变量 `AI_NOVEL_STORY_GRAPH_CONTEXT=off` 全局关（缺省开）。
dogfood 双臂 = 同项目同章、env 切换各生成一次、负责人盲读；B23 交付接线
与开关，dogfood 实验在验收合并后单独排期（需负责人参与）。

### D-B23-8 FTS 索引维护：写路径显式同步，不用触发器

v23 建 `story_graph_fts`（fts5, tokenize='trigram'，kind + ref_id
UNINDEXED + text）。由仓库层写方法显式同步（插边/删边/线程开关/实体档案
更新各自维护对应 FTS 行），rebuild 清空重灌。仓库层是唯一写路径（B22 已
成立），显式同步比 SQL 触发器可测可控。

## 2. 工单拆分

- 工单一（地基）：migration v23（story_embeddings + story_graph_fts）+
  仓库层 FTS 同步与嵌入存取/余弦 topK + gateway invokeEmbedding +
  STORY_GRAPH_EMBED 路由 + 抽取后置嵌入步 + 测试。
- 工单二（组装）：检索模块（激活/FTS/向量三路 RRF、一跳扩展、预算、因果
  截断、user 优先）+ loadContext/chapterContextPayload 注入 + env 开关 +
  测试（含全降级矩阵：无嵌入路由/嵌入失败/图为空/开关关闭）。

## 3. 验证基线

`pnpm check` 全绿；工单各自带测试；实测：对夹缝客栈项目生成场景计划或
自查（任一消费 loadContext 的任务），比对开关开/关两态的 prompt payload
（storyGraph 段存在且内容正确、近 3 章 goal 保留）；嵌入未配置时降级路径
实测。dogfood 双臂另排。
