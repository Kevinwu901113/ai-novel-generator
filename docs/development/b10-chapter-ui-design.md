# B10 — GE-6 章节生成产品 UI 设计（2026-08-13）

> 批次定义见 `takeover-plan-2026-08-05.md` §4 B10。上游：B9（GE-6 wiring，
> `b9-chapter-wiring-design.md`）。本批次完成后 GE-6 的原退出条件即达成
> （真实章节生成全链 + 真人可操作），GE-7 方可立项（D9）。

## 1. 范围

真人能走完"从蓝图章节发起生成 → 看到进度 → 读候选正文与自查意见 → 做出决定"。

- `chapter.*` 四条通道（contracts / main / preload / worker 四层贯通）；
- 成稿阶段 Region（`apps/desktop/src/renderer/chapter/*`），四阶段旅程补齐最后一格；
- 候选 Gate 的**改写意见承载**（销 TD-031-2）：migration v18 + REWRITE prompt 消费。

**有意不做**：写入权威稿件、稿件编辑、导出（GE-7）。界面对此如实说明，
不把"采用"说成"已保存进稿件"。

## 2. 决策

### D-B10-1 章节 run 的绑定由 worker 取，渲染进程不拼装身份

`graph.createChapterRun` 需要 creationSpecVersionId / researchBundleId /
storyBlueprintId / blueprintChapterId 四个 id。让渲染进程去凑这些 id 等于把 Graph
身份语义搬进 UI。故新增 `chapter.startRun(projectId, blueprintChapterId)`：worker 从
**最新 project run 的权威状态**读 artifacts，并要求蓝图 `accepted=true`（未接受就发起
生成会绕开 BLUEPRINT_USER_GATE 的产品语义）。

同章重复点击"开始生成"复用既有非终态 run（幂等键含该章已有 run 数），不产生并行两条 run。

### D-B10-2 阶段在 worker 侧派生

`ChapterRunPhaseDto`（planning / drafting / reviewing / rewriting /
awaiting_decision / awaiting_escalation / accepted_pending_commit / 三终态 / idle）
由 worker 按 Graph 节点状态派生，renderer 只做中文映射。与 B4/B6/B8 同则：渲染进程
不推导 Graph 语义。

其中 `accepted_pending_commit` 是必须如实暴露的一态：用户点"采用"后 Graph 激活
`MANUSCRIPT_COMMIT`，而该节点的 executor 属 GE-7、**有意未注册**，run 会停在那里。
把它显示成"已完成"就是一次空承诺（B6/B7/B8 各踩过一次）。

### D-B10-3 改写意见：独立权威存储 + 顺序即语义（销 TD-031-2）

图的 `candidate_gate` 决策 DTO 没有 feedback 字段（图定义已冻结）。方案：

- migration v18 新增 `chapter_rewrite_feedback`（run + 被改写的候选修订号 + 意见）；
- `chapter.submitDecision` 在 `request_rewrite` 时**先**落意见、**再**推进 Graph。
  顺序不可颠倒：反过来 REWRITE 任务可能在意见落盘前就被调度，用户意见被静默丢弃
  （D-B7-1 教训的同族）。反向残留（意见已写但决策失败）是良性的——那条意见只会被
  "针对该修订的下一次改写"读取；
- `executeChapterRewrite` 按当前候选修订号取最新一条意见送进 prompt，取不到就如实
  告知模型"用户未附意见"，**绝不伪造**；
- 没有候选正文时带意见提交直接拒绝（不留孤儿意见）。

### D-B10-4 ChapterRegion 自持轮询

章节 run 与 project run 是两条独立 run，App 的旅程探针（useJourney）只跟踪 project
run，无法观察章节生成进度。故 `useChapter` 自持一条轮询：有后台工作时 1.7s，停在人工
Gate 或终态时降到 6s（生成一章是分钟级操作，恒定高频轮询没有收益）。选中某一章时立即
补拉一次，否则界面会停在"正在加载"直到下个周期。

### D-B10-5 预算耗尽不禁用按钮，只改文案

与 B8 蓝图侧同一结构性理由：图上 gate→escalation 的边要求"提交该决策**且**预算已耗尽"
才路由进 `CANDIDATE_ESCALATION`——耗尽后再提交一次是进入升级四选项的**唯一入口**。
禁用按钮会让候选 Gate 变成死端（不满意又不想采用的用户没有任何出路）。

### D-B10-6 PROJECT_READY 后旅程阶段推进到"成稿"

**这是本批次由 App 级测试坐实的一处可达性缺陷**（与 D-B6-10 / D-B8-3 同族）：
`deriveFrontierStage` 原先在 run 终态时按 artifact 推导，最远只到 `blueprint`。于是
`manuscript` 永远不进 `reachedStages`，JourneyNav 的"成稿"恒为 disabled——B10 交付的
整个章节生成界面**永不可达**。

修复：run `completed` 且蓝图 `accepted`（即 PROJECT_READY）时 frontierStage 推到
`manuscript`。随之而来的行为变化：项目就绪后默认展示成稿阶段，已接受的蓝图改为点
JourneyNav 回看（B8 的冷启动可达性承诺仍然成立，入口从"默认展示"变成"点导航"，
对应 app.test.tsx 那条测试已同步改写）。

### D-B10-7 预算上限的跨层守卫

界面要如实显示"还能改写几次"就必须知道上限，而 contracts 引用不到 domain 的图定义
（TD-030-3 记录的那类手抄面）。做法：contracts 导出三个常量，
`apps/worker/src/chapter-graph-parity.test.ts` 逐条比对图上 `loop.maxIterations`——
图上调预算而常量没跟上时即红。

## 3. 持久化（migration v18）

```text
chapter_rewrite_feedback   候选 Gate 的改写意见（run + 候选修订号 + 意见 + 时间）
```

只追加新版本号，未改历史 migration。

## 4. 测试证据

| 层                          | 文件                                                       | 覆盖                                                                                                       |
| --------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| worker RPC（11，真 SQLite） | `apps/worker/src/chapter-handlers.test.ts`                 | 阶段派生优先级；未接受蓝图不给入口；绑定取自权威 run；重复发起复用；意见先落库（顺序即语义）；非法输入拒绝 |
| 跨层 parity（3）            | `apps/worker/src/chapter-graph-parity.test.ts`             | contracts 三个预算常量 = 图定义 loop.maxIterations                                                         |
| 展示逻辑（9）               | `apps/desktop/src/renderer/chapter/chapter-logic.test.ts`  | 阶段文案穷尽；"已采用"不冒充"已完成"；候选恒可见；耗尽改文案不禁用；选项集合与闭合枚举一致                 |
| 组件（8，jsdom）            | `apps/desktop/src/renderer/chapter/ChapterRegion.test.tsx` | 未就绪说明；章节列表；发起生成；候选与自查意见；**意见随请求发出**；采用后如实说明；升级四选项；错误重试   |
| App 级可达性（1）           | `apps/desktop/src/renderer/app.test.tsx`                   | 项目就绪 → 点"成稿" → 中栏真的挂 ChapterRegion，章节列表与发起入口可达（D-B10-6 的回归守卫）               |

`pnpm check` 全绿。

## 5. 不变量自查

1. 无 `graph_runs` 直写：决策经 `applyHumanDecision`，创建经 `createChapterRun`；
2. 未改 domain 图定义；
3. 一次 run 一章：`startRun` 拒绝蓝图外的章节 id，同章不并行两条 run；
4. 人工 Gate 处不自动接受：预算耗尽只改文案，决策一律由用户提交；
5. 不写 Manuscript：`MANUSCRIPT_COMMIT` 仍无 executor，界面如实说明；
6. UI 文案零工程术语（run/node/task/token/pipeline/proposal 均不出现）；
7. migration 只追加 v18。

## 6. 随行登记

- TD-031-2 **已解决**（本批次 D-B10-3）；
- 新增 TD-032（B10 随行两项），见 `tech-debt.md`。
