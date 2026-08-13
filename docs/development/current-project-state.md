# Current Project State — Idea-to-Novel Graph Engineering 基线

> 本文档是仓库**唯一**项目状态文档：以合并后的 `main` 为事实来源，描述当前代码真实能力、用户旅程、可复用资产、
> 权威 Graph 基线、当前推进位置与验证基线。
> 状态文档版本：7（2026-08-13）。本文档由项目负责人维护，仅在目标状态、能力矩阵或推进位置发生实质变化时更新。
> 路线与验收标准见 `docs/development/graph-engineering-roadmap.md`。

---

## 0. Snapshot Metadata

| 项              | 值                                                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 状态文档版本    | 7                                                                                                                             |
| 更新日期        | 2026-08-11                                                                                                                    |
| 基线 main SHA   | `b6220ae`（PR #49 合并后，含 B7 GE-5 蓝图 wiring/accept 原子闭环；本版随 B8 PR #50 提交，合并后 main 含 B8 GE-5 蓝图产品 UI） |
| 代码核验范围    | apps/desktop、apps/worker、apps/writing-experiment-runner、packages（含 graph 模块）、数据库 migration v1–v16、CI             |
| CI/本地验证状态 | §10（`pnpm check`、`git diff --check`、CI）；GitHub Actions 曾于 08-05~08-07 停摆，已恢复，PR #43–#49 合并 commit CI 全绿     |

## 1. 权威层级

```text
L1  PRODUCT_DIRECTION.md                        产品方向（最高权威）
L2  docs/product/idea-to-novel-v1.md            产品 1.0 纵向切片规格
L3  packages/domain/src/idea-to-novel-graph.ts  流程权威：IdeaToNovelProjectGraphV1 + ChapterGenerationGraphV1
L4  docs/development/*                          graph-engineering-roadmap / 本文档 / module-boundaries / decision-log …
```

详见 `docs/development/graph-engineering-roadmap.md` §1。任何"当前状态 / 下一步 / 验收标准"在本仓库只有一个答案。

## 2. What Main Actually Provides

### AVAILABLE

| 能力                                              | 实际证据路径                                                                                                                                                                                                                                           | 当前作用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 下一目标状态处理                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **权威 Graph 定义**                               | `packages/domain/src/idea-to-novel-graph*.ts`（PR #32 已合并）                                                                                                                                                                                         | IdeaToNovelProjectGraphV1（16 节点/36 边）+ ChapterGenerationGraphV1（13 节点/23 边）+ 纯 transition / graph-aware 校验 / 失效传播 / WorkflowStage 投影；contracts DTO；175 项测试                                                                                                                                                                                                                                                                                                                      | 唯一流程权威；GE-1 在其上建运行时内核                                                |
| **Graph Run Runtime**                             | `packages/application/src/graph-run*.ts`、`database/src/graph-run-*.ts`（migration v8）、`apps/worker/src/graph-handlers.ts`、contracts GRAPH_* 通道 + DesktopAPI.graph                                                                                | GraphRunService（createRun/advanceNode/failNode/requestHumanDecision/applyHumanDecision/listRuns/recoverInFlightRuns）+ BEGIN IMMEDIATE/CAS 原子持久化 + 幂等命令 + 启动恢复 + answer receipt 原子契约                                                                                                                                                                                                                                                                                                  | GE-2 在其上跑双 Graph 全路径                                                         |
| **Node Execution & Settlement（RW-1）**           | `packages/application/src/node-runner.ts`、`node-settlement.ts`、`production-artifact-resolver.ts`、`database/src/node-execution-repositories.ts`（migration v12）                                                                                     | 持久化 execution 模型 + Executor Registry + NodeRunner + NodeSettlementService（唯一非人工节点完成路径，同事务原子）+ ArtifactResolver 严格边界（生产/测试同源，TD-019）+ 按 recoveryPolicy 恢复；registry 能力缺口跳过不杀 run（TD-020）                                                                                                                                                                                                                                                               | GE-3..GE-6 全部真实节点 executor 的共同底座                                          |
| **GE-3 Intake wiring（B3）**                      | `apps/worker/src/intake-executors.ts`、`packages/application/src/idea-intake.ts`、SPEC_EXTRACT 任务执行器（migration v13）、GE-3 真实链路 E2E（PR #42）                                                                                                | IDEA_CAPTURE / SPEC_EXTRACT / ASK_QUESTION / COLLECT_ANSWER / INTAKE_ESCALATION 五节点真实接线；SPEC_EXTRACT 走 B1 网关产出 CreationSpec；resolver 补 idea/creationSpec 底层权威存储校验（TD-024 起含会话状态白名单）                                                                                                                                                                                                                                                                                   | 已完成（UI 见下行）                                                                  |
| **GE-3 Intake 产品 UI（B4）**                     | `apps/desktop/src/renderer/intake/*`、`journey/JourneyNav.tsx`、App.tsx 旅程 shell、contracts/preload/main intake.* 通道、`docs/development/b4-intake-ui-design.md`                                                                                    | 四阶段旅程导航 + 对话式访谈（回答/跳过/完成/升级 Gate/失败重建）+ CreationSpec 编辑器（CAS + 显式失效级联）；旧 Grill 工作台移出默认入口（代码保留）；随行解决 TD-022/024/025-3                                                                                                                                                                                                                                                                                                                         | GE-4 起 B5/B6 逐阶段扩展旅程                                                         |
| **GE-4 Research wiring（B5）**                    | `apps/worker/src/research-executors.ts`、`packages/task-engine/src/research-run.ts`（RESEARCH_RUN，migration v14）、`research-engine` Tavily + SafeWebFetch、search.* 三层通道、`docs/development/b5-research-wiring-design.md`                        | DECISION/PLAN/VALIDATE sync + EXECUTE task-backed 四节点真实接线；Tavily provider（D7）+ V1 安全边界运行时补全（DNS 解析后校验/重定向重校验/content-type 白名单/字节上限/超时）；invalid 回环（researchRetry ≤2）→ 人工升级；key 缺失任务保持 PENDING                                                                                                                                                                                                                                                   | B6 配套产品 UI；真实使用需负责人录入 Tavily key                                      |
| **GE-4 Research 产品 UI（B6，D-B6-10 复查修复）** | `apps/desktop/src/renderer/research/*`、`journey/journey-logic.ts`、App.tsx 按 viewStage 分流、contracts/preload/main research.* 五通道、`research_source_exclusions`（migration v15）、`docs/development/b6-research-ui-design.md`                    | 十态相位（"无需调研 none" vs "尚未调研 null" 可区分；含 D-B6-10 复查随行新增的 unsettled）+ 资料包查看（问题/来源/长笔记折叠/结论/版本链）+ 来源排除（project 级 URL 表）+ Tavily key 录入（录入后自动重驱动）+ 五选项人工升级 Gate；D-B6-9 失效资料包 stale 标记优先于 ready。**D-B6-10（独立复查 REWORK 修复）**：调研有结果时 frontier 常已同快照推进到 blueprint，旧版按 frontierStage 互斥挂载会让上述内容永不可达；现按展示阶段（viewStage，独立于推进阶段）挂载，JourneyNav 可点击回看已到达阶段 | B8 已落地 BlueprintRegion：blueprint 成为 viewStage 第三个已实现阶段                 |
| **GE-5 Blueprint wiring（B7）**                   | `apps/worker/src/blueprint-*.ts`、`packages/task-engine/src/blueprint-generate.ts`（BLUEPRINT_GENERATE，migration v16）、`packages/application/src/graph-run.ts` accept 原子闭环、`docs/development/b7-blueprint-wiring-design.md`                     | BLUEPRINT_GENERATE task-backed executor + accept 与 Graph gate 同事务原子闭环（D-B7-1/2）+ 失效蓝图 fail-closed（D-B7-8）+ prompt 消费来源排除（D-B7-13）+ skip_research 真正生效（D-B7-14）+ 三终态真实 E2E                                                                                                                                                                                                                                                                                            | 已完成（UI 见下行）                                                                  |
| **GE-5 Blueprint 产品 UI（B8，独立复查修复）**    | `apps/desktop/src/renderer/blueprint/*`、`journey/useJourney.ts` App 探针、contracts `blueprint.getBlueprint` 四层贯通、`ipc-channel-parity.test.ts`、错误码 message 编码传输（contracts encode/decode）、`docs/development/b8-blueprint-ui-design.md` | 十相位蓝图区（查看/确认/改写/升级四选项/就绪/三终态回看）+ 阶段派生上提 App（D-B8-2）+ 终态按 artifact 推导（D-B8-3）+ 失效禁用接受（D-B8-4）。**独立对抗复查 REWORK→修复→核验 ACCEPT**：2 BLOCKER + 6 MAJOR（详见设计文档 §6），含预算耗尽 escalation 入口、决策 busy 护航、terminal/stale 优先级、错误码跨 IPC 传输等；遗留 TD-030-1..5                                                                                                                                                               | GE-6（B9/B10）章节生成接入后扩展 manuscript 阶段                                     |
| Project lifecycle                                 | `packages/application/create-project.ts`、`open-project.ts`、`list-projects.ts`                                                                                                                                                                        | 项目创建/打开/列表/启动恢复                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 保留；产品入口随 GE-3 改为 Idea Intake                                               |
| Grill / questioning                               | `packages/domain/grill.ts`、`application/grill-session.ts`、`database/grill-repositories.ts`、`worker/grill-handlers.ts`、`renderer/grill/*`                                                                                                           | 会话/问题/回答/提案全链路                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | GE-3 适配为 Idea Intake；修复 `grill.listQuestions` / `grill.markQuestionAsked` 死链 |
| Creation Contract                                 | `packages/domain/creation-contract.ts`、`application/creation-contract*.ts`、DB v4–v6、`worker/contract-handlers.ts`、`renderer/contract/*`                                                                                                            | 契约提案/版本/current 指针/字段锁/CAS                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | GE-3 复用快照/版本/provenance 为 CreationSpec 基座，废弃审批门禁                     |
| Task Engine                                       | `packages/task-engine/`                                                                                                                                                                                                                                | 持久化长任务：MODEL_INVOCATION_TEST / GRILL_QUESTION_PLAN / CREATION_CONTRACT_DRAFT / CHAPTER_DRAFT / SPEC_EXTRACT（v13）；CAS claim + 启动恢复                                                                                                                                                                                                                                                                                                                                                         | GE-2+ 作为所有 AI 执行器底座                                                         |
| Model Gateway                                     | `packages/model-gateway/`（B1/D6，PR #41）                                                                                                                                                                                                             | 多 provider 最小形态：anthropic-messages + openai-chat 协议适配、provider profile（app.sqlite，Key 走 Keychain）、两层路由（全局默认 + 按任务类型覆盖）；非流式 + 严格解析；无负载均衡/fallback/流式                                                                                                                                                                                                                                                                                                    | 保留；GE-6 接入生成                                                                  |
| Manuscript backend                                | `packages/domain/manuscript.ts`、`application/manuscript*.ts`、DB v7、contracts manuscript 类型                                                                                                                                                        | 章/章节版本/CAS/position/不可变版本                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | GE-7 接 transport/renderer                                                           |
| Evaluation harness                                | `packages/writing-evaluation/`、`apps/writing-experiment-runner/`                                                                                                                                                                                      | 离线确定性评测 + LIVE 门控实验                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | GE-9 质量基线                                                                        |
| Packaged application                              | `apps/desktop`（electron-packager + smoke-test）                                                                                                                                                                                                       | macOS arm64 打包 + 冒烟测试                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 保留                                                                                 |

### PARTIAL / STUB

| 能力                          | 状态                           | 说明                                                                                                                                                               |
| ----------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Manuscript transport/renderer | MISSING（main 无）             | PR #25 参考资产；GE-7 选择性移植                                                                                                                                   |
| Web Research 产品 UI          | DONE（B6 + D-B6-10 复查修复）  | 调研态展示 + 资料包查看 + 来源排除（v15）+ Tavily key 录入 + 升级 Gate；B6 独立复查曾判 REWORK（frontier 常同快照推进到 blueprint 导致内容永不可达），已修复见上表 |
| StoryBlueprint                | DONE（B7 wiring + B8 产品 UI） | 蓝图 executor + accept 原子闭环 + 三终态 E2E（B7）；蓝图查看/确认/升级 UI + 阶段派生上提 App（B8，独立对抗复查 REWORK→修复→核验 ACCEPT）                           |
| Chapter Generation            | WIRING DONE（B9）；UI 待 B10   | 六节点真实 executor + 四类章节任务（v17：候选修订链/场景计划/审查结论三表）+ 章节终态 executor（销 TD-029-4）+ 全链 E2E 到 CANDIDATE_GATE；产品 UI 属 B10          |
| Export                        | MISSING                        | `packages/import-export` 为 stub；GE-7                                                                                                                             |
| PlotPilot                     | PARTIAL                        | 可选 adapter foundation；不进入关键路径                                                                                                                            |

### 已知死链

- ~~`grill.listQuestions` / `grill.markQuestionAsked` worker dispatch 无 case~~ —— 已由 B3 修复
  （`apps/worker/src/grill-handlers.ts` dispatch 补 case + 测试），当前无已知死链。

## 3. Current User Journey

打包应用当前实际走到（`apps/desktop/src/renderer/App.tsx`，B4 起）：

```text
启动 → 健康检查 → 项目列表 → 新建项目（名称 + 初始想法）→ 打开
→ 有项目：四阶段旅程（想法/调研/蓝图/成稿导航）+ 对话式创作访谈（IntakeRegion）
   ├─ 自动创建 project run → 追问 → 回答/跳过/我说完了（answer receipt 契约）
   ├─ SPEC_EXTRACT 整理中提示 / 升级 Gate 四选项 / 失败一键重建（TD-022）
   └─ CreationSpec 展示与编辑（CAS + 显式失效级联）
→ 右栏：状态面板（ProviderRegion / TaskCenter）
```

旅程在 **调研之后停止**（蓝图/成稿阶段尚无真实 executor、尚无 Region）：B5 接线
四节点、B6 补齐调研阶段 UI，spec 完成后可走完 DECISION/PLAN/EXECUTE/VALIDATE
并在界面查看资料包、排除来源、处理人工升级——**这一句在 B6 独立复查中曾被证伪**：
Graph 的 sync 节点会在同一状态快照内连推（deep 全链调研成功后，
`RESEARCH_VALIDATE` 已 succeeded、`BLUEPRINT_GENERATE` 已 active，两者从未在
同一次 poll 中分开出现），旧版 App 中栏按 journeyStage 互斥挂载 Region，
调研刚有结果的那一刻 frontier 往往已经在 blueprint，ResearchRegion 立即被
卸载换回 IntakeRegion 占位文案——ResearchBundleView、来源排除、作废横幅等
本批交付的核心内容事实上永不可达。已修复（D-B6-10，展示阶段 viewStage 与
推进阶段 frontierStage 分离，`apps/desktop/src/renderer/journey/journey-logic.ts`；
详见 `b6-research-ui-design.md`）：frontier 推进到蓝图/成稿后，只要调研已有
结果，中栏默认继续展示调研内容（顶部有"蓝图阶段开发中"提示），JourneyNav
也补上了对已到达阶段的点击回看。蓝图/成稿阶段本身仍显示占位（尚无 Region）。
旧 Grill 工作台已移出默认入口（代码保留）。其余是 GE-5..GE-7（B7..B10）的目标。

## 4. Canonical Assets（复用路线）

- **Grill** → GE-3 适配为 Idea Intake（对话式，隐藏状态机/提案/任务细节；复用 `grill_*` 表）。
- **Creation Contract** → GE-3 作为 CreationSpec（保留 snapshot/version/provenance，废弃审批门禁/字段锁主体验）。
- **Task Engine** → GE-2+ 所有 AI 执行器底座（graph 节点执行器作为持久化任务）。
- **Model Gateway** → 非流式 + 严格解析 + 轮询。
- **Manuscript backend**（MV1-A）→ GE-7 权威稿件存储；transport/renderer 移植。
- **Evaluation** → GE-9 质量基线。

## 5. Non-Main Reference Assets

- **PR #25**（`feat/manuscript-renderer-mv1b`）：保持 Draft / 不合并 / 不关闭；GE-7 从其中选择性移植 transport + renderer 资产。
  （2026-08-10 例行核查发现其曾被误关闭，已按本约定重新打开为 Draft；分支未受影响。）
- 不把 PR #25 能力记为 main 已实现。

## 6. Current Target State

**唯一目标状态**：Product 1.0 真实纵向链路（GE-8 端到端验收通过）：

```text
输入想法 → Idea Intake → CreationSpec → 必要调研 → ResearchBundle → StoryBlueprint
→ 完整章节生成 → 用户修改 → 继续生成 → TXT/Markdown 导出
```

在 GE-8 之前允许 fixture/确定性 executor，但必须使用真实的：Graph 状态机内核、核心 contracts、跨进程 API、持久化、
Manuscript、Export、重启恢复。

## 7. Locked Decisions

```text
- 不按时间估算推进；以门禁和依赖推进
- 任何 Graph 状态变化只能经 Domain transition
- WorkflowStage 永不作为权威状态
- 生成候选 ≠ 权威稿件；仅 MANUSCRIPT_COMMIT 后可写 Manuscript
- 人工 Gate 处不得自动接受或提交
- 不建立长期集成分支
- 多 Provider 按 D6（2026-08-05）只做最小形态：两种协议适配 + profile + 两层路由；
  仍不建设任务 DAG 或复杂 Agent 平台（不做负载均衡 / 自动 fallback / 流式）
- 不静默覆盖用户正文（CAS / 版本化 / 显式写入）
- 未合并 PR 不计入 main 能力
```

## 8. Current Position（推进位置）

> 2026-08-04 Post-Merge Acceptance：GE-3/4/5/6 原始退出条件未达成；已交付为 FOUNDATION / BACKEND。
> Graph 节点真实 executor、运行时接线、产品 UI、E2E 均未达。详见 `docs/development/post-merge-acceptance.md`。

```text
GE-0 权威文档收束        → ✅ COMPLETE（2026-08-04，PR #33）
GE-1 Durable Runtime     → ✅ COMPLETE（内核，2026-08-04，PR #34，migration v8）
GE-2 Walking Skeleton    → ⚠️ PARTIAL（2026-08-04，骨架测试达成；无运行时 runner / 无 UI；直接推 main）
GE-3 Idea Intake+Spec    → ✅ COMPLETE（B3 wiring+E2E，PR #42；B4 产品 UI，2026-08-10）
GE-4 Web Research        → ✅ COMPLETE（B5 wiring v14 + B6 产品 UI v15，2026-08-11）
GE-5 StoryBlueprint      → ✅ COMPLETE（B7 wiring v16 + B8 产品 UI + 独立复查修复，2026-08-11）
GE-6 Chapter 生成        → ⚠️ PARTIAL（B9 wiring v17 + 全链 E2E 到 CANDIDATE_GATE，2026-08-13；产品 UI 待 B10）
RW-1 执行与 Settlement   → ✅ MERGED ON MAIN（2026-08-05，PR #39，merge `ec1e8e7`，migration v12）
B1 多 provider 网关      → ✅ MERGED ON MAIN（2026-08-07，PR #41 + 补丁 `9f98278`，D6 最小形态）
GE-7 Manuscript/导出     → 待 GE-6 原退出条件通过后才启动
GE-8 端到端验收          → 待开始
GE-9 质量增强            → 待开始
```

RW-1 验收记录：2026-08-05 独立验收先判 REWORK（3 blocker：artifact provenance 登记与校验时序死锁、
lease 抢占绕过 infra 重试上限、基础设施瞬时错误被判为确定性失败），返工并补齐回归测试后复查 ACCEPT 合并。

B3 验收记录：2026-08-07 对抗式复查先判 REWORK（3 blocker：ASK_QUESTION 重放杀 run、未配置 provider/key
秒杀 run、假 CAS 静默覆盖用户对 CreationSpec 的修改），修复 `e73f5ab`（+3 回归 +15 parse 单测，双向红绿反转）
后复查 ACCEPT 合并；随行登记 TD-022/023/024/025，TD-019/020 同批解决。

B4 交付记录：2026-08-10，App shell 四阶段旅程 + 对话式访谈 + CreationSpec 编辑器
（设计 `b4-intake-ui-design.md`）；随行解决 TD-022（失败一键重建）/TD-024（会话卫生三项）/
TD-025-3（provider 配置成功后重驱动）；intake.* 通道 contracts/preload/main 三层暴露；
旧 Grill 工作台移出默认入口（代码保留）。TD-023 由独立小修 PR #44 解决。

B5 交付记录：2026-08-10，GE-4 wiring（设计 `b5-research-wiring-design.md`）：
RESEARCH_DECISION/PLAN/VALIDATE sync + RESEARCH_EXECUTE task-backed（RESEARCH_RUN，
migration v14）；Tavily provider（D7）+ SafeWebFetch（V1 安全边界运行时补全：DNS 解析后
校验/重定向重校验/content-type 白名单/字节上限/超时）；search key 槽位
（com.ai-novel-generator.search.tavily）+ search.* 三层通道（录入触发重驱动）；
确定性 E2E 四条（none 直达/deep 全链/invalid 回环升级/key 缺失 PENDING）；
Tavily live 测试 TAVILY_LIVE 门控。**真实使用需负责人录入 Tavily API key**
（B6 提供界面；当前可经 search.saveApiKey 通道）。

B6 交付记录：2026-08-11，GE-4 产品 UI（设计 `b6-research-ui-design.md`，D-B6-1..9）：
ResearchRegion 九态相位（区分"本项目无需调研 none"与"尚未调研 null"）+ 资料包查看
（问题/来源/长事实笔记折叠/结论/basedOnBundleId 版本链）+ 来源排除（project 级 URL
排除表，migration v15）+ SearchKeyPanel（Tavily key 录入，录入后 worker 自动重驱动）+
RESEARCH_ESCALATION 五选项人工 Gate；App 中栏按阶段互斥挂载（单轮询循环，D-B6-7）。
随行：**D-B6-9**——applyArtifactChange 只追加 invalidatedArtifacts 不清空 artifacts 槽位，
故改创作要求后 bundleRef 仍指作废资料包，新增 ResearchStateDto.bundleInvalidated 与
stale 相位（优先于 ready），避免作废内容被当现行展示；TD-026-2 销账（重驱动改
leading+trailing 防抖）；任务/错误码标签补齐；TD-028 登记（真实链路实测发现）。

B6 复查记录：2026-08-11 独立对抗式复查判 **REWORK**（一条已坐实 blocker）：
D-B6-7"中栏按 journeyStage 互斥挂载"混淆了"Graph 真实进度"与"中栏展示什么"——
`driveRun` 在同一状态快照内连推 sync 节点，deep 全链调研成功后
`RESEARCH_VALIDATE` 已 succeeded、`BLUEPRINT_GENERATE` 已 active（TD-020 无
executor 故停在 active），从未有一次可观测的 poll 让 frontier 停留在
research；调研刚有结果的那一刻 App 已把 ResearchRegion 换回 IntakeRegion 占位
文案，ResearchBundleView（问题/来源/事实笔记/结论/版本链/来源排除开关）与
D-B6-9 的作废横幅事实上永不可达；JourneyNav 纯展示不可点击，没有任何回到
research 视图的入口。测试盲区：`ResearchRegion.test.tsx` 直接挂载组件手喂
state 绕开了 App 分流，`app.test.tsx` 的 journeyStage 此前恒为 idea，没有任何
测试覆盖"真实 progress → 阶段派生 → App 挂载哪个 Region"这条链。
修复（**D-B6-10**，见 `b6-research-ui-design.md`）：展示阶段（viewStage，决定
中栏挂载哪个 Region）与推进阶段（frontierStage，Graph 真实位置，JourneyNav
标示进度）分离，新增 `apps/desktop/src/renderer/journey/journey-logic.ts`；
JourneyNav 补上对已到达阶段的点击回看（`aria-current` 标进度、`aria-pressed`
标查看，二者可区分）；frontier 越过 research 时 ResearchRegion 顶部给出"蓝图
阶段开发中"说明。新增 App 级集成测试锁定这条此前完全没有测试覆盖的链路
（红→绿两次运行，见 PR 描述）。随行修复六项：ResearchBundleView 强度徽标
未跟随版本链切换、来源排除轮询回滚闪烁、来源排除测试证伪力偏弱（mock 与
乐观结果一致，改为相反值锁定"必须用后端返回值"）、escalation 五选项断言
从硬编码改为对齐 domain `GRAPH_CONDITION_OUTCOMES.research_escalation_decision`
闭合枚举、取消来源排除不应受 `isSafeSourceUrl` 约束（只在新增排除时校验）、
`deriveResearchPhase` 新增 `unsettled` 相位（任务已 FAILED 但节点未 settle 的
瞬时窗口，不再误报"尚未开始调研"，相位由九态扩为十态）。

**Tavily 真实链路已实测**（2026-08-11，负责人提供 key，瞬时使用未持久化）：3 查询 x 5 结果
共 15 次真实抓取，成功 10；**安全边界零误杀**（仅 1 条 PDF 被 content-type 白名单拒），
其余为远端 403/404/500；403 与 User-Agent 缺失无关（已实证，不做浏览器伪装）。
详见 TD-028。**应用内真实使用仍需负责人在 SearchKeyPanel 录入 key**。

B7 交付记录：2026-08-11，GE-5 wiring（设计 `b7-blueprint-wiring-design.md`，D-B7-1..14）：
BLUEPRINT_GENERATE task-backed executor（新任务类型，migration v16）+ **accept 与 Graph gate
原子闭环**（D-B7-1：并入 applyHumanDecision 同事务；原状态是两条独立路径，中间失败会留下
"run 已 completed 终态但 accepted=0"且因终态守卫永久无法经正规路径修复）+ accept_current
补写 accept（D-B7-2：该条 PROJECT_READY 入边原本从无 accept 写入路径）+ 失效蓝图 fail-closed
拒绝接受（D-B7-8）+ 蓝图 prompt 消费来源排除（D-B7-13，兑现 B6 留下的承诺）+ skip_research
真正生效（D-B7-14）；随行补齐三个 TERMINAL 节点 executor（自图诞生起从未注册，此前批次
均止步于人工 Gate 故空白未被触发）。三终态真实 E2E（READY/BLOCKED/CANCELLED）+ 反向原子性
回归（markAccepted 成功后图写入失败 → accepted 必须回滚）+ PROJECT_READY 入边结构性守卫
（将来新增入边若未接 accept 副作用即红）。独立对抗复查两路：原子性与图语义 ACCEPT，
任务引擎路 REWORK 两 blocker（来源排除只删 URL 不删正文 / skip_research 与
use_current_research 等价）已修复。

B8（GE-5 UI）交付记录：蓝图查看/确认/升级四选项/三终态展示 + 阶段派生上提 App（D-B8-2）

- 终态按 artifact 推导（D-B8-3）。合并前独立对抗复查（四路）判 REWORK：2 BLOCKER +
  6 MAJOR 全部修复、独立核验 ACCEPT 后合并；先红后绿验证两组（相位优先级 / 耗尽入口）；
  遗留登记 TD-030-1..5。详见 `b8-blueprint-ui-design.md` §6。

B9 交付记录：2026-08-13，GE-6 wiring（设计 `b9-chapter-wiring-design.md`，D-B9-1..9）：
CHAPTER_PLAN / DRAFT / 三 Critic / CRITIQUE_JOIN / REWRITE 六节点真实 executor；三类新
任务类型 + migration v17（`chapter_candidates` 候选修订链 / `chapter_scene_plans` /
`chapter_critiques`）；**候选正文的权威定义是"同 run 最大修订号"而非 artifact ref**
（D-B9-1：图上 REWRITE 是 noOut，改写不换 artifact）；上下文一律按权威 run binding 反查
（D-B9-2）；三 Critic 共用任务类型、角色由 execution.nodeId 派生（D-B9-3）；CRITIQUE_JOIN
只触发 domain 聚合（D-B9-4）；**Chapter Graph 终态 executor 补齐，TD-029-4 销账**（D-B9-5）；
正文任务输出上限抬到 8192（D-B9-7）。E2E 10 条（含三 Critic 真并行、rewrite 预算耗尽
不自动接受、escalation 三终态、重启恢复）。MANUSCRIPT_COMMIT 有意不注册（GE-7），
accept 后 run 停在该节点等接线——B10 界面必须如实说明。随行登记 TD-031-1/2/3。

下一步：**B10**（GE-6 产品 UI：发起生成 / 进度 / 候选查看 / Gate 决策 + 改写意见承载）。
批次定义见 `docs/development/takeover-plan-2026-08-05.md`。

详见 `docs/development/graph-engineering-roadmap.md` §5–§15 与 `docs/development/post-merge-acceptance.md`。

## 9. Shared Hotspots（单一 owner）

```text
packages/domain（graph 模块）   → 已合并，冻结（PR #32）
packages/application（GraphRunService） → GE-1
packages/database（migration 注册表）    → 每 GE 单 owner 追加
packages/contracts（IPC 通道）            → 每 GE 单 owner 追加
apps/worker（root dispatch）             → 每 GE 单 owner 追加
apps/desktop（main/preload/renderer）     → GE-3 起按阶段接管
```

## 10. Verification Baseline

与 CI 相同的验证，本地实际执行结果（未设置 `WRITING_EXPERIMENT_LIVE`）：

| 项                  | 命令                                                          | 结果                                                                            |
| ------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `pnpm check`        | `format:check && lint && build && typecheck && test`          | PASS（exit 0，2026-08-11 于 feat/b8-blueprint-ui 复查修复批次实测）             |
| `git diff --check`  | —                                                             | PASS（exit 0，2026-08-11 同上）                                                 |
| macOS package smoke | `pnpm package` + `pnpm --filter @ai-novel/desktop smoke-test` | CI macos-package 门禁（未本地实测）                                             |
| 测试 passed/skipped | `pnpm test` 输出                                              | Test Files 148 passed / 2 skipped（150）；Tests 3346 passed / 7 skipped（3353） |
| GitHub Actions      | main 分支 CI                                                  | PR #49 合并 commit `b6220ae` success；PR #50 分支 CI 全绿                       |

测试通过 ≠ 产品验收通过（GE-8 才是验收）。
