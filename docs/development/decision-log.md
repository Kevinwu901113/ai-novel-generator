# 决策日志

## 决策记录格式

```markdown
### [日期] 决策标题

**背景**：[描述决策背景]

**决策**：[描述决策内容]

**理由**：[描述决策理由]

**影响**：[描述决策影响]

**状态**：已确认 / 待确认 / 已废弃
```

---

## 2024-01 决策

### 2024-01-01 选择 Electron 作为桌面框架

**背景**：需要选择桌面应用框架。

**决策**：使用 Electron。

**理由**：

- 跨平台支持
- Web 技术栈熟悉
- 生态成熟
- 社区活跃

**影响**：

- 包体积较大
- 内存占用较高
- 开发效率高

**状态**：已确认

### 2024-01-01 选择 pnpm 作为包管理器

**背景**：需要选择包管理器。

**决策**：使用 pnpm 11。

**理由**：

- 磁盘空间效率高
- 安装速度快
- 严格的依赖管理
- workspace 支持好

**影响**：

- 需要团队学习
- 部分旧工具不兼容
- 依赖管理更严格

**状态**：已确认

### 2024-01-01 选择 SQLite 作为本地数据库

**背景**：需要选择本地数据存储方案。

**决策**：使用 SQLite。

**理由**：

- 零配置
- 单文件存储
- 性能好
- 可靠性高

**影响**：

- 不支持并发写入
- 需要备份机制
- 数据可移植性好

**状态**：已确认

### 2024-01-01 选择 Vitest 作为测试框架

**背景**：需要选择测试框架。

**决策**：使用 Vitest。

**理由**：

- 与 Vite 集成好
- 速度快
- 兼容 Jest API
- TypeScript 支持好

**影响**：

- 生态不如 Jest 成熟
- 学习成本低
- 开发体验好

**状态**：已确认

### 2024-01-01 采用严格的安全模型

**背景**：需要确定 Electron 安全配置。

**决策**：

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`

**理由**：

- 安全性优先
- 符合最佳实践
- 防止恶意代码

**影响**：

- 开发复杂度增加
- 需要 preload 脚本
- IPC 通信更安全

**状态**：已确认

### 2024-01-01 采用 monorepo 结构

**背景**：需要确定项目结构。

**决策**：使用 pnpm workspace 的 monorepo。

**理由**：

- 代码共享方便
- 依赖管理统一
- 构建流程一致
- 版本管理简单

**影响**：

- 需要 workspace 配置
- 包之间依赖关系清晰
- 构建顺序需要管理

**状态**：已确认

### 2024-01-01 采用分层架构

**背景**：需要确定代码组织方式。

**决策**：采用 UI → 应用 → 领域 → 基础设施的分层架构。

**理由**：

- 职责分离清晰
- 可测试性好
- 可维护性高
- 依赖关系明确

**影响**：

- 需要定义清晰的接口
- 跨层调用需要通过接口
- 初期开发成本略高

**状态**：已确认

---

## 2026-07 决策

### 2026-07-26 升级 Electron 到 43.2.0

**背景**：M1-A 需要 node:sqlite 支持和 Utility Process API。

**决策**：从 Electron 36.9.5 升级到 43.2.0。

**理由**：

- node:sqlite 在 Electron 43 中可用
- Utility Process API 稳定
- 无影响现有安全模型的 breaking changes

**影响**：

- 需要手动下载 Electron 二进制（Electron 42+ 动态下载）
- 包大小不变
- 安全配置不变

**状态**：已确认

### 2026-07-26 使用 node:sqlite 作为数据库驱动

**背景**：需要选择 SQLite 驱动方案。

**决策**：使用 Node.js 内置的 node:sqlite（DatabaseSync），不安装 better-sqlite3 或其他第三方驱动。

**理由**：

- 避免 Electron 原生模块重编译问题
- 避免打包时的 node-gyp 问题
- 内置模块无需额外依赖
- 同步 API 适合数据库操作

**影响**：

- 需要封装为可替换适配器
- 只能在 Utility Process 中使用
- 未来可替换为其他驱动

**状态**：已确认

### 2026-07-26 project.sqlite 是项目正式数据来源

**背景**：需要确定 app.sqlite 和 project.sqlite 的数据所有权。

**决策**：project.sqlite 是单个项目的正式数据来源，app.sqlite 仅是应用级索引。

**理由**：

- 项目数据应该独立于应用
- 便于项目备份和迁移
- 避免索引和实际数据不一致时的歧义

**影响**：

- 打开项目时从 project.sqlite 读取正式元数据
- app.sqlite 的 last_opened_at 是辅助信息
- 两者差异时以 project.sqlite 为准

**状态**：已确认

### 2026-07-26 Utility Process 是数据库唯一写入者

**背景**：需要确定数据库访问模型。

**决策**：所有数据库写入操作必须通过 Utility Process。

**理由**：

- 同步 SQLite 调用不能阻塞 Renderer
- 集中写入便于管理
- 安全隔离

**影响**：

- Main Process 通过 RPC 与 Utility Process 通信
- Renderer 不知道数据库路径
- 需要实现 RPC 协议和错误处理

**状态**：已确认

### 2026-07-27 API Key 存储在 macOS Keychain

**背景**：需要安全存储用户的 API Key。

**决策**：使用 macOS Keychain 存储 API Key，通过 `/usr/bin/security` 命令交互。

**理由**：

- macOS 原生安全存储，加密保护
- 不需要额外依赖
- 应用专属 namespace 避免冲突
- stdin 写入避免进程列表泄露

**影响**：

- 需要实现 SecretStore 接口和 macOS 实现
- Windows/Linux 尚未实现
- 测试使用 fake SecretStore，不访问真实 Keychain

**状态**：已确认

### 2026-07-27 固定 MiMo V2.5 Pro 作为唯一提供商

**背景**：M1-B1 需要配置模型提供商。

**决策**：当前阶段固定使用 MiMo V2.5 Pro，Base URL 和 Model 只读。

**理由**：

- 当前开发和验收固定使用 MiMo V2.5 Pro
- 避免任意 URL 带来的 SSRF 和配置复杂度
- 多提供商和自定义端点以后再实现

**影响**：

- UI 不允许用户修改 Base URL 和 Model
- provider_profiles 表中只有一条固定记录
- 未来多提供商需要扩展

**状态**：已废弃（2026-08-05 被 D6「Model Gateway 升级为多 provider」取代；
MiMo V2.5 Pro 迁移为一个 `anthropic-messages` profile 继续可用）

### 2026-07-27 不安装 Anthropic SDK

**背景**：需要与 Anthropic-compatible API 通信。

**决策**：不安装 Anthropic SDK，使用 Node 24 内置 fetch。

**理由**：

- 减少依赖
- 连接测试只需要最小请求
- 避免 SDK 版本锁定

**影响**：

- 需要手动构造请求和验证响应
- 错误映射需要自行实现
- 未来完整调用可能需要更完善的实现

**状态**：已确认

### 2026-07-27 provider_profiles 在 app.sqlite

**背景**：需要存储提供商非敏感配置。

**决策**：provider_profiles 表放在 app.sqlite，不在 project.sqlite。

**理由**：

- 提供商配置是应用级配置，不是项目级
- 避免每个项目重复存储
- API Key 不进入任何 SQLite 数据库

**影响**：

- app.sqlite 新增 migration 3
- provider_profiles 只存储非敏感信息
- API Key 通过 Keychain 的 service/account 引用

**状态**：已确认

### 2026-07-28 任务和调用记录在 project.sqlite

**背景**：需要决定 tasks 和 model_invocations 的数据位置。

**决策**：tasks 和 model_invocations 表放在 project.sqlite，随项目数据管理（migration 2）。

**理由**：任务属于具体项目；项目备份应包含任务历史；便于项目迁移恢复。

**影响**：UNIQUE(task_id, attempt_number) 防重复；prompt 不持久化只存 hash。

**状态**：已确认（原记于 `technical-decisions.md` 决策 18，本日志合并）

### 2026-07-28 prompt 不持久化

**背景**：需要确定 prompt 的存储策略。

**决策**：prompt 不写入任何数据库、日志或测试快照；数据库只保存 promptHash（SHA-256 hex）和 promptLength。

**理由**：prompt 可能含敏感内容；用户创作内容不应泄露；避免不必要的数据保留。

**影响**：request_metadata_json 只含安全元数据；错误消息不含 prompt。

**状态**：已确认（原记于决策 19，本日志合并）

### 2026-07-28 CAS claim 防止并发执行

**背景**：需要防止多个 Worker 并发执行同一任务。

**决策**：任务领取使用 compare-and-set：`UPDATE tasks SET status='RUNNING' WHERE id=? AND status='PENDING'`，受影响行数≠1 视为冲突。

**理由**：不依赖进程内 mutex；SQLite 是 source of truth。

**影响**：每次执行前从数据库重新读取任务状态。

**状态**：已确认（原记于决策 20，本日志合并）

### 2026-07-28 token 统计语义

**背景**：provider 可能不返回 usage。

**决策**：null token 统计时按 0 处理，但不改写数据库中的 null。

**理由**：统计需要数值聚合；保留 null 表示"未知"而非"0"。

**影响**：`COALESCE(SUM(COALESCE(input_tokens,0)),0)` 聚合；总 token 上游缺失时不自行推断。

**状态**：已确认（原记于决策 21，本日志合并）

### 2026-07-28 任务恢复策略

**背景**：应用崩溃后数据库可能遗留 RUNNING 状态。

**决策**：Worker 启动时将 RUNNING 任务恢复为 FAILED（TASK_INTERRUPTED），不自动重新执行。

**理由**：明确标记中断；避免意外消耗配额。

**影响**：RUNNING task/invocation 在同一事务恢复为 FAILED；PENDING 保持 PENDING。

**状态**：已确认（原记于决策 22，本日志合并）

---

## 2026-08 决策

### 2026-08-04 采用 Graph Engineering 为唯一执行模型

**背景**：Idea-to-Novel 产品主链需要显式、可验证、可恢复的流程权威；旧 M0–M8 / R0.1–R6 / P1–P11 规划彼此冲突且均为工程阶段式描述。

**决策**：以两张权威 Graph——IdeaToNovelProjectGraphV1（project）与 ChapterGenerationGraphV1（chapter）——为唯一流程依据，
按 GE-0..GE-9 阶段推进（见 `graph-engineering-roadmap.md`）。不再沿用旧 M0–M8、Grill-first、Contract-first、Writer-first
或按 package/页面分割的施工顺序。

**理由**：Graph 定义节点/转移/人工 Gate/预算/循环/终态/失效传播，是把"模糊想法→小说"主链变成可持久化、可恢复、可验收状态机的最小权威层。

**影响**：新路线取代旧规划文档（后者删除）；所有新工程按 Graph 状态机推进。

**状态**：已确认

### 2026-08-04 确立权威层级

**背景**：仓库存在多份互相冲突的方向/路线/状态文档。

**决策**：确立 L1 PRODUCT_DIRECTION.md → L2 docs/product/idea-to-novel-v1.md → L3 Graph Definitions → L4 docs/development/*。
低层不得与高层冲突；任何"当前状态/下一步/验收标准"只有一个答案。

**理由**：产品方向、产品 1.0 纵向规格、流程权威、工程文档分层，避免旧流程文档与 Graph 冲突。

**影响**：`current-project-state.md` 为唯一状态文档；`graph-engineering-roadmap.md` 为唯一路线文档。

**状态**：已确认

### 2026-08-04 两张权威 Graph 合入 main（PR #32）

**背景**：Graph 定义在分支开发完成并通过多轮评审；本地 main 曾滞后于 origin/main。

**决策**：以 `54c6b31`（PR #32 merge）为 Graph 权威基线；两张 Graph 及其纯 transition/校验/失效传播进入 main，
作为 GE-1 运行时内核的唯一依据。

**理由**：`pnpm check` PASS（103 files / 2774 tests）；175 项 Graph 测试；无 DB/任务/IPC/Renderer 改动。

**影响**：main 新增 `packages/domain/src/idea-to-novel-graph*.ts` 与 `packages/contracts/src/idea-to-novel-graph.ts`。

**状态**：已确认

### 2026-08-04 任何 Graph 状态变化只能经 Domain transition

**背景**：运行时内核需要保证状态机不被绕过。

**决策**：GraphRunService 的硬不变量：load → `validateGraphRunState` → 纯 domain transition → `validateGraphRunState` →
CAS 原子持久化。Renderer / Worker / Task Engine 均不得直接拼装或修改 Graph state；`WorkflowStage` 永不作为权威状态。

**理由**：只有 domain transition 承载图/预算/join/终态语义；绕过会导致状态不合法。

**影响**：GE-1 起所有 mutation 走同一管线；执行器结果必须回到 service 经 transition。

**状态**：已确认

### 2026-08-04 UI 隐藏 Graph 内部状态

**背景**：PRODUCT_DIRECTION 要求基础设施不可见。

**决策**：UI 只显示用户当前需要理解与操作的内容；不暴露 Graph 控制台、节点调试器、Token 或任务内部状态。

**理由**：避免工程化状态成为产品负担（PRODUCT_DIRECTION §4.7 / §14）。

**影响**：contracts 只暴露 run progress 投影；executor 面命令 worker 内部用。

**状态**：已确认

### 2026-08-04 删除被取代的旧规划文档

**背景**：多份旧规划文档与权威层级冲突。

**决策**：删除 `roadmap.md`、`generation-quality-roadmap.md`、`idea-to-novel-migration-plan.md`、`current-state.md`、
`docs/product/PRD.md`、`docs/architecture/state-machine.md`、`docs/architecture/technical-decisions.md`
（后者的决策已并入本日志）。

**理由**：旧路线已降级为历史资料；删除使"当前状态/下一步/验收标准"只有一个答案；git 历史可追溯。

**影响**：见 `graph-engineering-roadmap.md` §16。

**状态**：已确认

### 2026-08-04 已知问题：manuscript invalidation 注释与行为不一致

**背景**：`idea-to-novel-graph-invalidation.ts` 头注释称"manuscript 不因任何上游变化失效"，但 Chapter order
`['generationRun','manuscript']` 使 generationRun 变化确实把 manuscript 加入 invalidatedArtifacts。

**决策**：接受当前行为（generationRun 变化会失效 manuscript，需重新提交），由 GE-7（MANUSCRIPT_COMMIT）解决
语义与文档一致性问题；不在此 PR 改动已合并 domain。

**理由**：行为正确性由测试锁定；注释问题延后到稿件提交闭环时一并澄清。

**影响**：GE-7 需明确"生成候选失效 vs 已提交稿件"的边界。

**状态**：待 GE-7 处理

---

## 2026-08-05 接手执行方案决策（D1–D9）

> 决策人：项目负责人授权的接手会话（Principal Architect 通道），2026-08-05。
> 来源：`docs/development/takeover-plan-2026-08-05.md`（接手执行方案，非新权威层级）。
> 本节即该方案 §2 的正式落地；落地后仍以 L1–L4 权威层级为准，方案文档只作交接记录。

### 2026-08-05 D1 不重构仓库

**背景**：接手时可能倾向于重写后端或重建仓库。

**决策**：维持 Controlled Pivot。分层、内核、migration、测试资产全部保留；禁止以"接手"为由重写。

**理由**：与 PRODUCT_DIRECTION §17 一致；已合并资产经过验收，重写会丢失已锁定的不变量与测试证据。

**影响**：GE-3..GE-6 只做补完，不做重建。

**状态**：已确认

### 2026-08-05 D2 节点执行器 = 持久化任务 + settlement 桥

**背景**：GE-3..GE-6 缺的是把节点接到 GraphRunService 的执行器与结算桥。

**决策**：所有需要模型/搜索调用的节点，执行路径固定为：节点 active → executor 创建持久化 Task（绑定
runId + nodeId + attempt）→ 任务完成后 settlement 把结果写入权威存储并取得真实 artifact id →
以幂等 command key 经 GraphRunService 推进。settlement 必须幂等可重放。纯逻辑节点可用同步 executor，
但同样只能经 GraphRunService 推进。worker 端建立 executor registry（nodeId/kind → executor）。

**理由**：崩溃后重放 settlement 时，commandLog 去重保证 Graph 只推进一次。

**影响**：RW-1（PR #39，merge commit `ec1e8e7`）即本决策的实现载体。

**状态**：已确认（RW-1 已合并）

### 2026-08-05 D3 Recovery 语义与任务状态协同

**背景**：`recoverInFlightRuns` 原为无差别 fail-closed。

**决策**：节点 active 且绑定任务已终态成功 → 启动时补跑 settlement；任务失败 / TASK_INTERRUPTED →
按基础设施重试配额受控重试，配额用尽走 `applyNodeFailure`；无任务记录（同步 executor 中断）→ 维持 fail；
`waiting_for_human` 不触碰。

**理由**：区分基础设施中断与业务失败，避免结果丢失，也避免无界重放。

**影响**：RW-1 已实现；B2 验收补充了 `canInfraRetryCount` 对 lease 抢占路径的统一守卫。

**状态**：已确认

### 2026-08-05 D4 artifact ref 必须指向真实持久化对象

**背景**：GE-3..GE-6 的 artifact ref 曾是 `art-${nodeId}` 占位。

**决策**：settlement 只接受真实持久化 id；artifact 必须经事务内 resolver 校验存在性/归属/version，
并在同一事务登记 execution→artifact provenance。骨架测试可注入宽松 resolver，生产接线必须注入真实 resolver。

**理由**：没有存在性与归属校验的 artifact ref 会让下游节点消费不存在或他人的产物。

**影响**：RW-1 以 `ArtifactResolverPort` + `node_artifact_provenance` 实现，并把 provenance 主键
`(artifact_kind, artifact_id)` 作为归属的原子闸门（B2 验收修正了登记与校验的时序）。

**状态**：已确认

### 2026-08-05 D5 GE-2 直推 main 的一次性豁免

**背景**：GE-2（`4b26c60`）未走 PR 直接推 main。

**决策**：不改写历史；记录该次流程违规为一次性豁免。今后一切变更（包括纯文档）必须走 PR。

**理由**：改写已发布历史的代价高于收益；规则前瞻生效即可。

**影响**：本条之后的所有提交均需 PR + CI 门禁。

**状态**：已确认

### 2026-08-05 D6 Model Gateway 升级为多 provider（修订原锁定决策）

**背景**：原锁定决策为"不提前建设多 Provider"。项目负责人明确要求支持多 provider 配置。

**决策**：修订该锁定决策为**支持多 provider，但只做最小形态**：协议适配层 `anthropic-messages` +
`openai-chat`；Provider Profile `{ id, label, protocol, baseUrl, model, secretRef }` 持久化，
secret-store 每 profile 一个 key 槽位；路由只有"全局默认 + 按任务类型可选覆盖"两层；
**不做**负载均衡、自动 fallback、流式、复杂路由 DAG。现有 MiMo V2.5 Pro 迁移为一个
`anthropic-messages` profile 并继续可用。

**理由**：项目负责人的产品决策；最小形态可控，不引入 Agent 平台复杂度。

**影响**：`AGENTS.md` 模型配置段已同步；`current-project-state.md` §7 的锁定决策同步修订；
实现批次为 B1。

**状态**：已确认（取代 `current-project-state.md` §7 原锁定项"不提前建设多 Provider"，
并使 2026-07-27「固定 MiMo V2.5 Pro 作为唯一提供商」转为已废弃）

### 2026-08-05 D7 联网搜索使用 Tavily

**背景**：GE-4 的 WebSearchPort 只有 fake provider。

**决策**：实现 TavilySearchProvider，key 存 secret-store（不写进代码或配置文件）。返回正文仍需过既有 V1
安全边界（协议/私网/重定向/字节数/超时）。fake provider 保留用于测试与无 key 环境。

**理由**：项目负责人选定；既有安全边界不因换 provider 而放宽。

**影响**：实现批次为 B5；需要项目负责人提供 Tavily API key。

**状态**：已确认

### 2026-08-05 D8 每个 GE 阶段配最小产品 UI，wiring 与 UI 分离为两个 PR

**背景**：既往阶段只交付 backend，用户无法真实操作。

**决策**：每阶段先合 wiring PR（人工 Gate 由测试注入决策，E2E 绿），紧接着合该阶段最小 UI PR。
GE-3 的 UI 批次同时把默认入口从 Grill 工作台切换为 Idea-to-Novel 四阶段旅程。UI 必须遵守
PRODUCT_DIRECTION §4：不出现 run / node / task / token 等工程概念。

**理由**：保证每阶段结束时用户可真实使用，同时保持 PR 可审查。

**影响**：批次序列 B3/B4、B5/B6、B7/B8、B9/B10。

**状态**：已确认

### 2026-08-05 D9 GE-7 继续后置

**背景**：稿件提交闭环诱人但依赖前置链路。

**决策**：GE-6 原退出条件（真实章节生成全链到 CANDIDATE_GATE 绿）通过前，不启动 GE-7。

**理由**：与既有锁定不变量一致（候选 ≠ 权威稿件）。

**影响**：本轮方案不含 GE-7 批次。

**状态**：已确认

### 2026-08-05 空 registry 下的启动恢复不得判死在途 run

**背景**：B2 验收返工过程中发现：生产 `recoverGraphRuns` 使用的 registry 在 GE-3 前为空，
任何 active 非人工节点在启动恢复时会得到 `EXECUTOR_NOT_REGISTERED` → `applyNodeFailure` →
run 终态 failed 且按不变量不可复活。

**决策**：registry 缺少该节点 executor 时，启动恢复**跳过该节点、保持原状**，不 fail-closed。
该修改是 B3 开工的第一个任务。

**理由**：executor 尚未注册是部署/推进阶段的事实，不是业务失败；用不可复活的终态惩罚它会销毁用户数据。

**影响**：见 `tech-debt.md` TD-020；B3 前置。

**状态**：已确认（待 B3 实施）

### 2026-08-14 D10 单章篇幅独立建模，长章节内部切片但不改变章节权威语义

**背景**：旧实现把“每章约 3000 字”藏在 `structure` 自由文本里，用单条正则推断，并让一次模型调用
承担整章正文。它既无法可靠区分全书篇幅、章节数和单章篇幅，也无法完成“一共一章、单章 15000 字”
这类正常需求；8192 token 的 provider 上限还会造成截断。模型风格 Critic 的非阻塞意见也可能绕过
确定性 AI 腔检查。

**决策**：CreationSpec 新增独立 `chapterLength`（目标及可选上下限），允许 500–40,000 字；
`targetLength` 只表示全书总字数或总章节数。超过单次可靠输出范围的 DRAFT / REWRITE 按约 3200 字
切成连续调用，携带前段尾部与场景边界后组装为一个候选。蓝图必须严格遵守用户声明的章节总数。
运行时以去空白 Unicode 字符数核验篇幅，并以保守的模板化类比、套话、直陈情绪和重复句指标兜底
风格 Critic；命中后进入既有改写循环，不对正文做机械正则替换。

**理由**：篇幅是用户要求，不应依赖提示词猜测；provider 限制属于内部实现细节，不应迫使用户拆章。
检测后定点改写比批量词语替换更能保留叙事语义，同时仍允许人工确认最终候选。

**影响**：领域与 IPC 合同新增可选字段但无需数据库迁移（CreationSpec 以版本化 JSON 保存）；旧版
`structure` 中的单章字数在抽取时兼容升级。一个逻辑任务可能包含多次 provider 调用，调用记录聚合 token、
延迟并记录 `modelCallCount`。详见 `docs/development/ai-writing-quality.md`。

**状态**：已确认

---

### 2026-08-17 D11 桌面壳退役，全面转为 WebUI（本机服务 + 浏览器访问）

**背景**：负责人决定放弃 Electron 桌面架构，动机是多端适配（手机/iPad 也能用）与前端选择
空间。可行性经代码盘点确认：packages/ 15 个包零 Electron/React 依赖（boundary 测试锁死）；
全部 81 个 RPC command 纯 request/response 零推送；renderer 只经 `window.desktop`
（DesktopAPI）通信；唯一的 Electron 业务渗漏是导出落盘对话框。

**决策**：分三批（B11 server / B12 前端迁移 / B13 Electron 删除）完成迁移，目标形态：
浏览器（本机 + 局域网多设备）→ apps/server（hand-rolled node:http）→ @ai-novel/worker
（进程内直调）→ packages/*（零改动）。子决策：

- **worker 库化而非子进程**：export dispatchCommand/initialize 进程内直调；单用户无隔离
  收益，消除 RPC 序列化与生命周期整层（D-B11 系列）。
- **单 RPC 端点** `POST /api/rpc`（复用 worker `{command,payload}` 信封），不做 81 条
  REST；业务错误一律 HTTP 200 + 信封。
- **hand-rolled node:http**：生产运行时保持零外部依赖；要推送（SSE/WS）时另记决策。
- **校验层搬进 contracts 由服务端强制**（RPC_COMMAND_VALIDATORS，parity 守卫钉死全覆盖）
  ——原 main 进程 82 个 handler 的前置校验是真实安全边界（research 域 handler 内部零校验）。
- **认证**：文件 token（`${dataRoot}/auth-token`，0600）+ Bearer 头（免 CSRF）+
  timingSafeEqual + Host 白名单防 DNS rebinding；**localhost 不豁免**。默认绑定
  127.0.0.1:4870，`AI_NOVEL_HOST=0.0.0.0` 显式放开局域网。
- **不做 TLS**：局域网明文风险显式接受并披露（TD-034）；API key 录入建议在本机完成。
- **数据根**：env 优先 → 探测老 Electron userData（双候选按 app.sqlite 存在性 + mtime）
  → 全新目录；只读原位绝不自动搬迁。API key 继续 macOS Keychain（服务端跑在 Mac 上）。
- **导出** = worker 渲染 + 浏览器 Blob 下载；`saved`/`filePath` 原生对话框语义删除。
- **前端零重写**：renderer 整体 git mv 至 apps/web，`window.desktop` 改由 HTTP 客户端
  注入（95 个调用点与 19 个测试零改动）；TokenGate 包在 App 外。

**理由**：业务层与 UI 边界干净且被测试强制，换传输层是低风险路径；重写前端会重蹈
可达性缺陷老坑。单用户本地优先形态不变，BYOK 与 Keychain 语义不变。

**影响**：apps/desktop 删除（macos-package CI 随之删除，web 冒烟接替进 ubuntu）；
IPC_CHANNELS 从 contracts 移除（命令面 RPC_COMMANDS）；TD-001/002/004 销账、TD-005 改写、
新增 TD-034/035/036。多客户端并发（Mac + iPad 同开）依赖既有 CAS/版本冲突路径兜底。
详见 `b11-web-server-design.md` / `b12-web-frontend-design.md` / `b13-electron-removal-design.md`。

**状态**：已确认

---

### 2026-08-17 D12 前端界面重设计：Tailwind v4 + shadcn/ui，保留「纸感写作台」视觉身份

**背景**：WebUI 迁移（D11）合并后，负责人拍板下一阶段做前端界面设计改造。现状摸底：
5535 行单文件 App.css、token 只覆盖颜色（22 个变量，403 处硬编码色 / 79 个十六进制值）、
三套强调色并存、暗色模式靠 38 个手写 `@media` 块、无基础组件抽象（12+ 种 ad-hoc 按钮类）、
约 1/3 CSS + 1300 行 TSX 服务于已从入口摘除的旧 Grill 工作台/创作契约面板。
底子好的部分：无障碍资产扎实（`src/accessibility/`、近 2000 行 a11y 测试、60 处
live region）、中文文案纪律（界面不出现工程概念）、inline style 仅 1 处、零 UI 依赖。

**决策**：负责人三项拍板——①技术路线全面转 Tailwind CSS v4 + shadcn/ui（Radix 原语 +
lucide-react），弃手写 CSS 体系；②旧 Grill 工作台与创作契约面板死代码全部删除（git
历史保留，重接入时按新设计重写）；③使用场景桌面为主，移动端做到「顺手看稿」即可。
子决策：

- **视觉身份保留，不用 shadcn 默认风**：暖白纸感画布（`#f4f3ef` 系）、近黑侧 rail、
  宋体展示标题、克制动效、中文文案纪律全部延续；shadcn 主题变量映射为现有配色。
- **强调色统一为靛蓝紫系**（logo `#514cc9` 家族）作为唯一 primary；蓝 `#2563eb` 退役。
- **暗色模式继续跟随系统**（不做手动开关）；token 单点定义，38 个手写暗色块销账。
- **无障碍红线**：`src/accessibility/` 工具、`accessibility.test.tsx`、role/aria 语义
  保留；Dialog/Drawer/Select 的焦点管理改由 Radix 原语接管（替换手写焦点陷阱）。
- **分四批**：B14 基建与死代码清理（视觉零变化）→ B15 基础组件与壳层 → B16 各
  Region 逐屏迁移 → B17 收口（App.css 移除、暗色/移动端销账 TD-035 桌面外最小集）。
- 迁移期 Tailwind **不启用 preflight**，避免重置冲击存量 App.css；B17 收口时启用。

**理由**：负责人在「手写 token 体系 / headless 库 / 全面 shadcn」三案中选最彻底一案，
接受重写成本换开发速度与弹层交互质量。视觉身份与文案是产品资产，与实现技术解耦保留。
死 CSS 占全文件 1/3，留着会让 token 收敛白做一遍。

**影响**：apps/web 新增依赖 tailwindcss / @tailwindcss/vite / shadcn 生态（radix、
lucide-react、cva 等）——「生产运行时零外部依赖」原则不受影响（仅构建期/前端依赖）。
19 个 .tsx 测试作为迁移防线必须逐批全绿；断言类名的用例随批调整。
详见 `b14-ui-foundation-design.md`（后续批次设计文档随批新增）。

**状态**：已确认

---

### 2026-08-17 D13 前端设计持续优化：阅读优先，三批推进（B18–B20）

**背景**：D12 合并推送后，对新基线做了一轮结构化设计评审（桌面明暗 × 全部关键屏 +
375pt 移动视口，逐屏实测）。结论：信息架构与文案诚实度是强项，但「读小说正文」这一
核心场景排版不合格（行宽 ~50 字/无规范）、移动端成稿阶段两处 flex 布局崩坏（文字列
被挤到 0 宽逐字竖排）、「手机顺手看稿」实际是打开编辑 textarea、另有两处文案与产品
能力不符（蓝图横幅仍称章节生成"还在开发中"）。

**决策**（负责人 2026-08-17 拍板批次划分与顺序）：

- **B18「阅读优先」**：阅读排版组件类 `.reading-prose`（17px/1.9/40em）统一候选正文
  与稿件编辑；成稿两处 flex 行换行化修竖排；<768px 侧栏收纳为底部导航（条件渲染保证
  可访问性树中同名控件唯一）；两处文案更正。见 `b18-reading-first-design.md`。
- **B19「设置页」**（B18 验收通过后负责人 2026-08-18 插队拍板：否定右侧抽屉形态，
  编排交实现方设计）：设置从 Sheet 抽屉改独立页面（锚点导航 + 分区卡片），评审中
  记录的设置区两处编排问题（添加表单在前、破坏性按钮占首位）随批解决。
  见 `b19-settings-page-design.md`。
- **B20「读写分离」**：只读阅读视图（点章节默认进阅读，编辑是显式动作）+ 编辑器
  高度自适应去双滚动。（评审原判「无自动保存」不成立——TD-033-3 已于 08-15 解决，
  范围据此缩小。）
- **B21「信息密度」**：任务中心产品化（任务名优先、哈希退居详情、Token/延迟收进
  折叠）、蓝图就绪面板接「去成稿」跳转、项目卡相对时间。原计划的「项目卡带真实
  阶段/进度」推迟——阶段真相在各项目 project.sqlite，列表页全量获取需要反规范化
  缓存的后端设计，伪造违反文案纪律（见 `b21-info-density-design.md`）。

**评审遗留（记录在案、未排批）**：JourneyNav 对「跳过的调研」也打绿勾（「跳过」与
「完成」在旅程语义上是否该区分）；稿件无重命名入口（后端能力待查）；项目卡真实
阶段/进度（需后端反规范化设计，B21 明确不做）。

**追加登记（2026-08-18，负责人定向）**：长篇一致性的**故事知识图谱**（GraphRAG/
LightRAG 式：实体/关系/事件时间线/伏笔线程，逐章抽取、检索式上下文、一致性核验）
已登记进 `graph-engineering-roadmap.md` GE-9 段，含设计要点清单，届时单独出设计文档。

**过程纪律（2026-08-18 负责人定）**：主会话只做设计/规格/验收/合并（项目经理），
实现类工单派给 Opus 子代理执行。

**状态**：B18、B19、B19b、B20 已验收合并；B21 已实现待验收（首个 Opus 工单批次）

---

## 待确认决策

[待确认的决策记录]

---

## 已废弃决策

[已废弃的决策记录]
