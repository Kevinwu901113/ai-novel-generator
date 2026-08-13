# 项目技术债务

## 状态规范

每项技术债务使用以下状态之一：

| 状态               | 含义                     |
| ------------------ | ------------------------ |
| OPEN               | 已确认，尚未开始修复     |
| PARTIALLY_RESOLVED | 部分修复，仍有剩余问题   |
| RESOLVED           | 已完全修复               |
| DEFERRED           | 明确推迟到特定里程碑之后 |
| DESIGN_DECISION    | 非缺陷，是有意的设计选择 |

每项包含：状态、优先级、最后核验基线 SHA、问题、影响、后续动作。

当前核验基线：`5cefd6e` (2026-07-29)

---

## TD-001: `--no-prune` 导致打包产物膨胀

**状态**: OPEN
**优先级**: 打包分发前必须解决
**最后核验基线**: 5cefd6e
**历史别名**: TD-006（内容重复，已合并为本条目）

### 问题

`@electron/packager` 的 `--no-prune` 标志导致所有 `devDependencies`（包括 typescript、vite、electron 等）被打包进生产 asar，使产物膨胀至 ~72MB。

### 根因

`@electron/packager` 的 prune 步骤使用 Node.js 模块解析来确定依赖树。在 pnpm strict mode（默认）下，`@electron-internal/extract-zip` 等深层依赖无法通过符号链接链被正确解析，导致 prune 阶段失败。

### 影响

- 生产 asar 包含不必要的开发依赖
- 包体积 ~72MB（理想情况下应 < 20MB）
- 安全扫描范围增大

### 后续动作

1. 升级 `@electron/packager` 到支持 pnpm strict mode 的版本
2. 或迁移到 `electron-builder`（原生支持 pnpm）
3. 移除 `--no-prune` 后验证 `pnpm package` 无 `Failed to locate module` 错误

---

## TD-002: Worker 类型声明不完整

**状态**: OPEN
**优先级**: 低
**最后核验基线**: 5cefd6e

### 问题

`apps/worker/src/index.ts` 中 `process.parentPort` 的类型声明是手动添加的 `declare const process`，覆盖了标准 NodeJS.Process 类型。Electron Utility Process 的 `parentPort` 不在标准 Node.js 类型定义中。

### 影响

- 类型安全性降低
- IDE 自动补全受限

### 后续动作

- 创建独立的 `.d.ts` 类型声明文件，或等待上游类型支持

---

## TD-003: 数据库测试需要 node:sqlite 运行时

**状态**: OPEN
**优先级**: 持续
**最后核验基线**: 5cefd6e

### 问题

数据库集成测试需要 Node.js 22+ 的 node:sqlite 模块。如果运行环境不支持 node:sqlite，这些测试会失败。

### 影响

- CI 环境必须使用 Node.js 22+
- 测试不能在浏览器环境中运行

### 后续动作

- 在 CI 配置中固定 Node.js 版本要求
- 考虑条件跳过机制（非必要）

---

## TD-004: Electron 42+ 二进制动态下载

**状态**: OPEN
**优先级**: CI 前
**最后核验基线**: 5cefd6e

### 问题

Electron 42+ 改为在首次运行时动态下载二进制文件，不再在 `postinstall` 时下载。这影响 CI 和打包流程。

### 影响

- CI 首次运行可能因网络问题失败
- 打包流程需要额外处理

### 后续动作

- 使用 `ELECTRON_MIRROR` 环境变量指定镜像
- 在 CI 中预先下载 Electron 二进制

---

## TD-005: Windows/Linux SecretStore 尚未实现

**状态**: OPEN
**优先级**: 跨平台分发前
**最后核验基线**: 5cefd6e

### 问题

macOS Keychain 实现已完成，但 Windows（Credential Manager）和 Linux（Secret Service）尚未实现。

### 影响

- 应用只能在 macOS 上完整运行
- 需要实现 SecretStore 接口的跨平台适配

### 后续动作

- 实现 Windows Credential Manager 适配
- 实现 Linux Secret Service（libsecret）适配
- 跨平台集成测试

---

## TD-007: 自动重试机制尚未实现

**状态**: OPEN
**优先级**: M3 前
**最后核验基线**: 5cefd6e

### 问题

当前任务执行失败后不会自动重试。用户需要手动重新创建任务。

### 影响

- 临时性错误（超时、限流）需要用户手动干预
- 缺少可重试错误分类

### 后续动作

1. 实现带退避的自动重试
2. 区分可重试错误（超时、限流）和不可重试错误（认证失败）
3. 限制最大重试次数

---

## TD-008: 任务队列自动调度尚未实现

**状态**: OPEN
**优先级**: M3 前
**最后核验基线**: 5cefd6e

### 问题

当前任务创建后需要手动触发执行（MODEL_INVOCATION_TEST）。GRILL_QUESTION_PLAN 已有后台调度，但缺少通用队列抽象。

### 影响

- 缺少通用 FIFO 队列、优先级和取消 UI
- 新任务类型需要各自实现调度逻辑

### 后续动作

1. 实现通用任务队列抽象
2. 支持任务优先级
3. 取消 UI

---

## TD-009: 缺少通用 typed task registry 和调度抽象

**状态**: PARTIALLY_RESOLVED
**优先级**: M3 前
**最后核验基线**: 5cefd6e

### 问题

当前任务引擎已支持 MODEL_INVOCATION_TEST 和 GRILL_QUESTION_PLAN 两种任务类型，但缺少：

- 通用 typed task registry（任务类型 → 执行器的声明式映射）
- 统一的重试策略接口
- 通用调度抽象（各类型各自实现调度）

### 影响

- 新增任务类型需要手动接入 worker dispatch
- 重试和调度逻辑分散

### 后续动作

- 设计 TaskRegistry 接口，声明式注册任务类型和执行器
- 统一重试策略
- 通用调度队列

---

## TD-010: Grill-me 工作台为开发工作台

**状态**: OPEN
**优先级**: 产品发布前
**最后核验基线**: 5cefd6e

### 问题

当前 Grill-me UI 是开发工作台，不是最终产品 UI。缺少正式视觉设计、交互优化和用户体验打磨。

### 影响

- 功能可用但视觉粗糙
- 需要后续专门的 UX/视觉设计迭代

### 后续动作

- 正式产品 UX 设计
- 视觉打磨和交互优化

---

## TD-011: AI 问题规划 Renderer 集成

**状态**: RESOLVED
**优先级**: —
**最后核验基线**: 7df3ac5

### 问题

AI 问题规划后端已完成（PR #9，GRILL_QUESTION_PLAN 任务类型、严格解析、stale 检测、proposal 持久化）。Renderer 集成曾在 PR #11 中处于 open 状态。

### 解决

- PR #11 已合并（merge commit `7df3ac5640f1c3f5ba6fcf46ffe563ca19ac0717`）
- Renderer 提供触发规划任务、任务状态轮询、proposal 审核与显式接受
- 覆盖操作所有权、hidden/visible 轮询、accept 刷新上下文、焦点/RAF 生命周期、FAILED 安全标签等回归测试

---

## TD-012: 版本冲突采用刷新策略

**状态**: DESIGN_DECISION
**优先级**: 评估后决定
**最后核验基线**: 5cefd6e

### 问题

当检测到 GRILL_VERSION_CONFLICT 时，当前策略是自动刷新数据并提示用户，不自动重试 mutation。

### 设计理由

这是保护用户修改的有意策略，不是普通 bug：

- 避免自动重试导致意外覆盖其他修改
- 让用户明确决定是否重新执行操作
- 简化实现复杂度

### 可能的改进

1. 实现 conflict diff 展示，帮助用户理解变更
2. 支持手动重试按钮
3. 考虑 Operational Transform 或 CRDT 方案（远期）

---

## TD-013: Grill planner 缺少真实 provider 端到端测试

**状态**: OPEN
**优先级**: M1-C 前
**最后核验基线**: 5cefd6e

### 问题

Grill question-plan 后端测试使用 mock provider。缺少真实 provider + SQLite 约束释放的端到端测试，无法验证完整链路在真实网络条件下的行为。

### 影响

- 模型返回格式变化时可能延迟发现
- SQLite 并发约束在真实负载下未验证

### 后续动作

- 设计带真实 provider 的集成测试（可选标记，CI 中按需运行）
- 验证 SQLite busy_timeout 在并发写入下的行为

---

## TD-014: CAS=false 终态结算路径测试不足

**状态**: OPEN
**优先级**: M1-C 前
**最后核验基线**: 5cefd6e

### 问题

settlement 逻辑中 CAS 返回 false 的分支（并发竞争导致）测试覆盖不足。虽然代码有防御性处理，但缺少对极端并发场景的验证。

### 影响

- 极端并发下可能出现未预期的状态组合
- 防御性代码路径未被充分验证

### 后续动作

- 增加 CAS 竞争场景的单元测试
- 考虑并发压力测试

---

## TD-015: PlotPilot live local E2E 尚未实现

**状态**: OPEN
**优先级**: PlotPilot 产品接入前
**最后核验基线**: 5cefd6e

### 问题

PlotPilot adapter 测试使用 mock fetch 和 mock spawn。缺少与真实 PlotPilot sidecar 进程的本地端到端测试。

### 影响

- SSE 流式行为在真实进程间未验证
- 进程生命周期管理在真实环境下未验证

### 后续动作

- 设计可选的 live E2E 测试（需要本地 PlotPilot 安装）
- CI 中标记为可选

---

## TD-016: PlotPilot Windows 真实 spawn/ENOENT 行为未验证

**状态**: OPEN
**优先级**: 跨平台分发前
**最后核验基线**: 5cefd6e

### 问题

PlotPilot sidecar 生命周期管理使用 Node.js child_process.spawn。Windows 上的 ENOENT 行为、路径分隔符和进程终止语义与 macOS/Linux 不同，尚未在真实 Windows 环境验证。

### 影响

- Windows 用户可能遇到 sidecar 启动失败
- 错误消息可能不准确

### 后续动作

- Windows 环境手动验证
- 必要时增加平台特定处理

---

## TD-017: PlotPilot 日志清洗 defense-in-depth

**状态**: OPEN
**优先级**: PlotPilot IPC 层实现时
**最后核验基线**: 5cefd6e

### 问题

PlotPilot adapter 已实现基础日志清洗（onLog 回调），但未来 IPC 层将日志传递到 Renderer 时，需要额外的 defense-in-depth 清洗层。

### 影响

- 如果 PlotPilot 输出包含敏感路径或 token，可能泄露到 UI

### 后续动作

- 在 IPC 层增加独立清洗
- 确保 Renderer 永远不接收原始 sidecar 输出

---

## TD-018: PlotPilot 商业分发许可审查

**状态**: DEFERRED
**优先级**: 商业分发前
**最后核验基线**: 5cefd6e

### 问题

PlotPilot 是外部项目。商业分发前需要单独审查其许可证条款，确认与本产品分发模式兼容。

### 影响

- 未经许可分发可能存在法律风险

### 后续动作

- 商业分发前进行许可审查
- 必要时联系 PlotPilot 作者获取授权

---

## TD-019: 测试 `realResolver` 与生产 artifact resolver 各写一份，已发生漂移

**状态**: RESOLVED
**优先级**: —
**最后核验基线**: b80f0d2

### 问题

生产 artifact resolver 在 `apps/worker/src/index.ts`（`productionArtifactResolver`），测试的"生产等价"
resolver 在 `packages/database/src/node-execution-integration.test.ts`（`realResolver()`）。两者是两份手写
实现。RW-1 的 B2 验收期间已确认漂移：测试版对 `idea` / `creationSpec` / `manuscript` 抛
`unsupported kind`，而生产版显式放行；该分歧直接导致新增端到端测试首次运行时给出误导性的红。

### 影响

- "生产等价 resolver 下的行为"这一测试断言可能不成立，削弱端到端覆盖的可信度
- GE-3/GE-4/GE-5 每新增一类 artifact，都要在两处同步修改，漂移会重复发生

### 后续动作

- 把 resolver 提取为单一实现（application 层，接受注入的 repository 端口），生产与测试共用
- 测试只允许注入宽松 resolver 作为显式替身，不得另写一份"仿生产"实现

### 解决

- B3 内 commit `03e241c`（PR #42）：worker 内联实现移至
  `packages/application/src/production-artifact-resolver.ts` 并导出；
  database 集成测试删除手写 `realResolver`，4 处调用点改用同一实现，断言未放松

---

## TD-020: 空 registry 下启动恢复会把一切在途 run 判为终态 failed

**状态**: RESOLVED
**优先级**: —
**最后核验基线**: b80f0d2

### 问题

生产 `recoverGraphRuns`（`apps/worker/src/index.ts`）使用的 `productionRegistry` 在 GE-3 之前为空。
启动恢复对每个非终态 run 调用 `driveRun`，任何 active 非人工节点因查不到 executor 走
`EXECUTOR_NOT_REGISTERED` → `applyNodeFailure`；而 `applyNodeFailure` 直接把 run 置为终态 `failed`，
按锁定不变量该 run 不可复活。

### 影响

- 当前无真实 run，故实际影响为零；但 GE-3 注册 executor 之前，任何遗留在途 run 会在 worker 启动时被永久判死
- 未来任一节点的 executor 未注册（版本回滚、部署不一致）都会造成同类数据损失

### 后续动作

- registry 缺少该节点 executor 时，启动恢复跳过该节点、保持原状，不 fail-closed（见 decision-log 2026-08-05 同名决策）
- 补测试：空 registry 恢复后 run 仍为非终态、节点仍 active

### 解决

- B3 内 commit `52d8dcc`（PR #42）：三条路径统一为「能力缺口 ≠ 节点失败，跳过保持原状」——
  claimAndDispatch descriptor 缺失/runner 未注入 → 跳过；reDispatchPending 保持等待；
  settleNodeExecution registry 缺失 → `NODE_EXECUTOR_UNAVAILABLE`（保留 durable 结果等有能力 worker）
- registry 把可执行节点登记成 human 的配置损坏仍 fail-closed（与能力缺口分离）；
  新增 `NodeRunnerDeps.onExecutorMissing` 观测回调

---

## TD-021: NodeRunner 中两处不可达分支

**状态**: DESIGN_DECISION
**优先级**: 低（只需注释澄清，不删代码）
**最后核验基线**: ec1e8e7

### 问题

`packages/application/src/node-runner.ts` 有两处当前不可达的防御性分支：

1. `reDispatchPending` 的 sync 分支 —— `claimExecution` 要么在同一事务内 `markRunning`，要么抛错回滚，
   不会留下 pending 状态的 sync execution；
2. `claimExecution` 的"latest failed + infra retryable → 同 activation 续 attempt"分支 ——
   `applyNodeFailure` 直接把 run 置终态，失败节点不会再次 active。

### 影响

- 无功能影响；但会让后续读者误以为存在对应的运行时路径，进而在这些分支上叠加逻辑

### 后续动作

- 保留代码作为防御性兜底，在两处补注释说明为何当前不可达、以及什么变化会使其可达
- 若将来 `applyNodeFailure` 语义改为可路由回业务循环，需重新评估第 2 处的 activation 归属判定

---

## TD-022: settle_if_result 任务 RUNNING 中断 = intake run 报废（缺产品化恢复）

**状态**: RESOLVED
**优先级**: —
**来源**: B3 对抗式复查 Note-1（2026-08-07）

### 问题

SPEC_EXTRACT 任务 RUNNING 时应用退出 → 启动 `reconcileTasks` 标 `TASK_INTERRUPTED` →
settle_if_result 策略不允许重放（防重复计费）→ run 终态 failed。策略自洽，但"抽取进行中退出
应用 = intake run 报废"对产品第一入口不可接受。

### 后续动作

- 产品层给 failed intake run 一键重建（复用既有 CreationSpec/session），或允许
  settle_if_result 在 TASK_INTERRUPTED 下有界重试（需重复计费评估）。

### 解决

- B4（D-B4-2）：failed run 在访谈 UI 显示友好提示 +「重新开始访谈」——以代际幂等键
  （`intake-auto:${projectId}:${run 数}`）创建新 run；IDEA_CAPTURE 重新播种会话
  （旧会话由 TD-024 弃用），既有 CreationSpec 版本保留。回归：intake E2E 测试 8 +
  IntakeRegion 组件测试。settle_if_result 有界重试（重复计费路线）按原策略不采用。

---

## TD-023: graph-handlers buildDeps 的 ProjectDatabase 连接泄漏（main 既有）

**状态**: RESOLVED
**优先级**: —
**来源**: B3 对抗式复查 Note-2（2026-08-07）

### 问题

`graph-handlers.ts` `buildDeps` 每次 RPC 打开 `ProjectDatabase` 从不 close（grill handlers
均 finally close）。B3 的 driveAfter 已修（随驱动结束关闭）；buildDeps 的 main 既有泄漏未动。

### 后续动作

- 对齐 grill handlers 模式：graph.* 五条命令 finally close；或引入连接池/共享句柄。

### 解决

- 2026-08-10 独立小修：`withGraphDeps` 包装五条 graph.* 命令，结束（含抛错）finally close；
  `driveAfter` 移到连接关闭后触发（其自开自关，B3 已修）。回归测试覆盖成功与抛错路径的
  连接关闭断言，双向红绿反转验证。

---

## TD-024: intake 孤儿 ACTIVE session 清理 + resolver 不校验 session 状态

**状态**: RESOLVED
**优先级**: —
**来源**: B3 设计声明偏离 + 对抗式复查 Note-6（2026-08-07）

### 问题

IDEA_CAPTURE 每次执行新建 session（provenance 唯一闸门要求），重试/重启组合会留下未使用的
ACTIVE 会话；resolver 的 idea 校验不看 session 状态（ABANDONED 亦可结算）；
`executeSpecExtract` 直接 `questionRepo.create` 绕过 `addGrillQuestions` 的 ACTIVE 检查。

### 后续动作

- B4 或维护批次：新建时 abandon 前一 ACTIVE 会话；resolver 增状态白名单；问题写入走用例层。

### 解决

- B4（D-B4-7）三项落地：
  1. IDEA_CAPTURE 执行前弃用项目全部 ACTIVE 会话（全局至多一个 ACTIVE，
     `getActiveIntakeSession` 歧义消除）；
  2. resolver `idea` 校验加状态白名单（仅 ACTIVE 可结算；集成测试 16b）；
  3. `executeSpecExtract` 追问写入前重读会话，非 ACTIVE 跳过写入（E2E 测试 9）。
     未改走 `addGrillQuestions` 用例——其 CAS/版本推进语义嵌入任务终态事务的
     风险大于收益，防护达到同等效果（决策记录 D-B4-7）。

---

## TD-025: B3 修复验证随行三项（复查 ACCEPT 附带 notes，2026-08-07）

**状态**: OPEN
**优先级**: 低-中
**来源**: PR #42 对抗式复查修复验证

1. **ASK_QUESTION 多问题批次重放双标**（良性残留）：批次 >1 时崩溃重放会把第二问也标 ASKED
   （悬挂问题，run 存活）。注意：把幂等检查提到 PLANNED 判断之前是错误修法——skip 语义下会
   死循环到预算耗尽；需先调整 skip 对问题状态的处理再收此残留。
2. **BLK-3 附带语义**：用户在抽取在途手工修改创作要求 → 本次抽取作废 → task 确定性 FAILED →
   run fail-closed 终态。数据完整性正确（用户版本必胜），但体验上是"编辑杀 run"；
   后续可把该冲突转为新 activation 重抽而非杀 run。
3. ~~**配置修复后无自动重驱动**~~：已由 B4（D-B4-8）解决——provider.create/update/
   setDefault/saveApiKey 成功后 fire-and-forget 触发一次全项目恢复扫描（复用
   `recoverGraphRuns`，含 PENDING task 重调度），in-flight 去重防抖。
   第 1、2 项仍 OPEN（需先调整 skip 语义 / activation 归属，留后续批次）。

---

## TD-026: B4 对抗式复查随行三项（复查 ACCEPT 附带 notes，2026-08-10）

**状态**: OPEN
**优先级**: 低
**来源**: B4 独立对抗式复查（ACCEPT）notes

1. **createProjectRun 缺"单非终态 run"守卫**：产品 UI 已按 D-B4-2 避免并发创建，但 RPC 面
   仍允许同项目多个非终态 project run 并存；跨 run 弃用会话会使被替换 run 的 ASK_QUESTION
   fail-closed（收敛性可接受，见 spec-extract.ts 注释）。建议 application 层
   createProjectRun 增守卫：存在非终态 project run 时拒绝或返回既有 run。
2. ~~**provider 重驱动防抖无尾随重扫**~~：已由 B6（D-B6-8，TD-026-2）解决——
   redriveAfterProviderConfig 改为 leading+trailing 防抖（`leading-trailing-debounce.ts`）：
   扫描在途时的后续触发不再被丢弃，记为尾随请求，当前扫描结束后立即补跑一次；
   多次触发合并为至多一次尾随执行。回归测试见 `leading-trailing-debounce.test.ts`
   （先红：旧简单 in-flight 布尔丢弃模式下尾随触发被吞掉；后绿：新实现补跑）。
3. **intake E2E 测试 9 断言偏弱**：只断言追问未写入被弃用会话，未覆盖后续 settlement 走向
   （旧 run fail-closed 终态化）。补断言可固化该收敛语义。
   第 1、3 项仍 OPEN（留后续批次）。

---

## TD-027: B5 对抗式复查随行四项（REWORK 修复附带，非阻塞，2026-08-11）

**状态**: OPEN
**优先级**: 低-中
**来源**: B5 独立对抗式复查（REWORK，blocker B-1 已修）随行 notes

1. **SafeWebFetch 无 IP 钉连，DNS rebinding TOCTOU 残余**：校验（resolveHost）与连接
   （fetch 内部再解析）之间存在解析结果变化窗口（D-B5-5 第 7 点已声明的设计残余）。
   修复方向：校验通过后按已解析 IP 直连（Host header 保留原主机名），消除二次解析。
2. **research E2E 覆盖缺口**：缺 light 深度全链用例与真实"任务 RUNNING 中断 → 重启恢复"
   用例（现有覆盖为 none/deep 全链 + executeResearchRun 层的 key 缺失保持 PENDING）。
3. **调研深度启发式不一致**：depth.ts 的 REAL_WORLD_REQUIRING_KEYWORDS 与 deepSignals
   关键词集漂移（如"二战"命中前者判 light，"晚清"命中后者判 deep，粒度标准不一）；
   且 worker 构造 ResearchInput 时 requiresFactuality 恒为 false，该输入位形同虚设。
   需统一关键词集或改为单一信号源。
4. **RESEARCH_RUN recoveryPolicy=settle_if_result 中断即 fail-closed**：重启后 RUNNING
   任务标 TASK_INTERRUPTED 不重试（与 SPEC_EXTRACT 同则的有意保守，防重复计费/重复搜索）。
   与 SPEC_EXTRACT 不同，RESEARCH_RUN 的搜索/抓取可幂等重放，可议改 replayable；
   记录待议，暂维持保守策略。

---

## TD-028: 真实调研链路验证发现两项（Tavily key 到位后实测，2026-08-11）

**状态**: OPEN
**优先级**: 中
**来源**: 负责人提供 Tavily key 后，架构师用真实 key 做的一次性链路验证
（3 个中文历史类查询 x 每查询 5 条结果 = 15 次真实 SafeWebFetch 抓取，成功 10 / 失败 5）。
key 仅以环境变量瞬时使用，未落文件、未存 Keychain、未提交。

**正向结论（不是债，是已验证的事实）**：安全边界在真实网页上零误杀——15 条中仅 1 条被
我方规则拒（PDF），私网判定 / 512KiB 截断 / 三跳重定向限制均未产生假阳性；其余 4 条
失败为远端自身的 403/404/500。另已实证 403 与 User-Agent 缺失无关（补一个如实标识的
UA 后状态码不变），**不做浏览器伪装**（属绕过机器人检测），此路已证伪不必再试。

1. **PDF 来源被静默丢弃**：content-type 白名单直接拒收 application/pdf，而本应用主场景
   （历史 / 资料类创作调研）中学术 PDF 占比可观（本次样本 15 条里 2 条是 PDF，约 13%）。
   且用户在 B6 资料包界面看不到"某来源因格式被跳过"，只会觉得调研结果偏薄。
   方向：(a) 增加 PDF 文本抽取；(b) 至少把被跳过的来源与原因回传，供 UI 展示。
2. **真实抓取成功率约 67% 可能推高 invalid 回环 churn**：D-B5-4 校验要求每问题 >=1 来源、
   每条 factNote 的 sourceUrls 非空。若某问题的 top 结果恰好全是 PDF / 403，该问题将得到
   0 来源 → bundle 判 invalid → 回环重试 → 预算耗尽进人工升级 Gate。fake provider 永远
   测不到这条路径（fake 恒成功）。方向：提高 maxResults 冗余，或把校验改为"问题级尽力"
   语义（整包有效即可，不强求每问题都有来源）。

---

## TD-029: B7 对抗式复查随行四项（两路复查——原子性/图语义 ACCEPT + 任务引擎 REWORK，2026-08-11）

**状态**: PARTIALLY_RESOLVED（TD-029-3 已由 D-B7-14 解决；TD-029-1/2/4 仍 OPEN）
**优先级**: 中
**来源**: B7（GE-5 StoryBlueprint 接线）两路独立对抗式复查修复随行

1. **TD-029-1：改写循环无 feedback 承载（D-B7-4 记录偏离）**：`BLUEPRINT_GENERATE.input`
   未声明 `requiresArtifacts` 含 `storyBlueprint`（拿不到上一版 ref），`blueprint_gate`
   决策 DTO 也无 feedback 字段。本批次取最小方案，只用 `budget.blueprintRewrite` 计数
   告知模型"这是第 N 次改写"，改写只能靠计数变异，用户点"请求改写"时无法说明原因。
   产品上是缺口，由 B8（蓝图 UI）批次连同 feedback 承载一并设计。
2. **TD-029-2：失效后不自动重置节点，且 escalation 分支的出路受限**：`applyArtifactChange`
   只追加 `invalidatedArtifacts`、不清空 `artifacts` 槽位，本批次未做失效后自动把
   `BLUEPRINT_GENERATE` 重置为 pending（属 transition 层改动，超出本批次）。复查发现
   衍生问题：若蓝图在停留于 `BLUEPRINT_ESCALATION`（改写预算已耗尽）期间失效，
   `accept_current` 会被 fail-closed 拒绝，而该节点**没有** `request_rewrite` 出口——
   四个出口只有 `accept_current`（现在拒绝）/ `modify_requirements`（回环到
   `SPEC_EXTRACT`，代价远高于直接改写）/ `cancel` / `continue_later`，用户此时无法
   "直接改写重新生成蓝图"，只能走成本更高的 `modify_requirements` 或放弃。
3. ~~**TD-029-3：`skip_research` 与 `use_current_research` 在图层不可区分（BLK-2）**~~：
   **已解决（D-B7-14，2026-08-11 同日）**。原始问题：`RESEARCH_ESCALATION` 与
   `BLUEPRINT_USER_GATE`/`BLUEPRINT_ESCALATION` 一样是两条语义不同的入边
   （`use_current_research` / `skip_research`），但
   `BLUEPRINT_GENERATE.input.requiresOutcomes` 只声明了 `[RESEARCH_DECISION]`，
   `prepareTask` 只按 `artifacts.researchBundle` 是否存在决定 `researchBundleId`，
   而走到 `RESEARCH_ESCALATION` 时该 artifact 恒非空——所以用户点"跳过调研"零效果，
   与"沿用当前调研"完全不可区分。首次评估时该修法需要修改
   `packages/domain/src/idea-to-novel-graph.ts` 的节点 input 契约定义，超出执行者
   边界，曾走保底方案（如实记录 + 登记本债务）。**架构师复核后判断"存在但不生效的
   按钮"在产品上不可接受，明确授权追加图契约声明**：`BLUEPRINT_GENERATE.input`
   追加 `RESEARCH_ESCALATION` 到 `requiresOutcomes`（纯追加声明，不改既有节点/边/
   预算定义）；`prepareTask` 按此 outcome 判断 `skip_research` 时不传
   `researchBundleId`；executor 侧新增 `status:'skipped_by_user'` 态，与
   `not_conducted` 区分措辞。两条对照 E2E（`14a`/`14b`，
   `apps/worker/src/blueprint-e2e.integration.test.ts`）先红后绿验证。详见
   `docs/development/b7-blueprint-wiring-design.md` D-B7-14。
   **附带已修复的相邻问题**（不属于本条债务，记录以防混淆）：bundle 存在但
   `factNotes` 为 0（抓取全失败，escalation 的典型成因）时，过滤器此前会返回
   "用户已将全部可用来源排除"——没有任何人排除过任何来源，是对模型说假话；已在
   `blueprint-generate.ts` 的 `classifyResearchInput` 里拆出独立的 `no_sources_gathered`
   态与 `all_excluded` 区分开，随 B7 本轮修复一并提交（见
   `packages/task-engine/src/blueprint-generate.test.ts` 对应用例）。
4. ~~**TD-029-4：Chapter Graph 终止节点同样缺 executor**~~ —— **已解决（B9，D-B9-5，
   2026-08-13）**：`apps/worker/src/chapter-executors.ts` 的
   `registerChapterTerminalExecutors` 给 `CHAPTER_READY` / `CHAPTER_CANCELLED` /
   `CHAPTER_BLOCKED` 各注册一个平凡 sync executor（照 project 侧先例，节点集合从图定义
   派生而非手抄）。E2E 用例 6/7 真正驱动到 `cancelled` / `blocked` 两个终态并断言
   `onExecutorMissing` 未记录终态节点跳过。原文如下：**TD-029-4：Chapter Graph 终止节点同样缺 executor**：`PROJECT_READY` 一类的 project
   图终止节点已有 `registerProjectTerminalExecutors`（`project-terminal-executors.ts`）
   兜底；但 Chapter Generation Graph（`CHAPTER_GENERATION_GRAPH_V1`）的终止节点目前
   没有对应的 executor 注册。GE-6（`createChapterRun` 接线）批次落地 chapter run 入口
   时需要一并处理，否则章节生成 run 到达终止节点会因 `onExecutorMissing` 静默跳过而
   卡住，不会真正终态化。

## TD-030: B8 独立对抗复查随行遗留（四路复查坐实、不阻塞合并，2026-08-11）

**状态**: OPEN

**背景**: B8（GE-5 蓝图产品 UI）合并前由四个独立复查员对抗复查（竞态 / 状态机枚举 /
四层手抄面 / 可达性与空承诺），坐实 2 BLOCKER + 6 MAJOR 已随批次修复；以下为坐实但
影响有界、登记后合并的遗留项。

1. **TD-030-1：项目切换的一帧内旧 frontier 挂错 Region + 跨项目正文读**：
   `handleOpenProject` 里 `setCurrentProject` 与 journey 状态清零分属 commit 与
   passive effect 两个时机——切换后的首个绘制帧内，旧项目的 frontierStage 仍会把
   中栏挂成旧阶段 Region（如 BlueprintRegion 闪现"正在加载蓝图…"），并真实发出一次
   `getBlueprint({projectId: 新, blueprintId: 旧})` 的跨项目 IPC（worker 查不到返回
   null，响应被 generation 守卫丢弃）。无数据错挂，纯闪帧 + 冗余请求。结构性修法是
   journey 状态与 projectId 同步派生（keyed state 或 reducer），改动面大于收益，登记。
2. **TD-030-2：journey 单轮刷新的 getState/getRunProgress 撕裂快照**：两条独立
   worker RPC 之间图可提交（如"GENERATE 成功 + gate 激活"落在两次读取中间），拼出
   state 旧 / progress 新的自相矛盾快照——蓝图刚生成完的 ≤1 个轮询周期内，导航已标
   "蓝图"而正文显示"蓝图还没有生成"。下一轮自纠正。反方向偏斜已被 P9 gate 兜底
   吸收。修法：worker 侧提供单命令原子快照（getJourneySnapshot），待有同类需求时一并做。
3. **TD-030-3：仍无守卫的跨层手抄面（当前已逐一比对一致）**：renderer 硬编码节点 ID
   （`useBlueprint.ts` 的 BLUEPRINT_USER_GATE/BLUEPRINT_ESCALATION、`blueprint-logic.ts`
   的 BLUEPRINT_GENERATE）、`BLUEPRINT_REWRITE_LIMIT = 3`（domain loop maxIterations
   调整后 UI"剩余 N 次"会静默错）、preload 两个不在 IPC_CHANNELS 的裸通道
   （data-service-status/retry，存量）。contracts 未导出 NODE_IDS，renderer 结构上
   引用不到真源；补导出或做源码比对 parity 测试（范式已有：ipc-channel-parity）。
   注：gate/escalation outcome 字符串已有闭合枚举双向守卫测试，不在此列。
4. ~~**TD-030-4：research 侧 escalation 的 userSelectedStage 锁死**~~ —— **已解决
   （2026-08-13）**：`useResearch` 增 `onDecisionSettled` 回调，App 传入与蓝图侧同一个
   `handleHumanDecisionSettled`（清视图锁 + 刷新探针，busy 护航到新态落地）。
   ResearchRegion 组件测试补三条覆盖。
5. **TD-030-5：探针可观测性小项**：单条 IPC 挂住时探针静默冻结最长 30s（worker-client
   超时后自恢复，期间无提示）；`loading` 每轮 poll 翻转两次导致 App 每 1.7s 两次无谓
   重渲（仅 `state===null` 时被消费）。均有界。

## TD-031: B9（GE-6 章节生成 wiring）随行三项

**状态**: OPEN
**优先级**: 中
**来源**: B9 交付随行（2026-08-13，设计见 `b9-chapter-wiring-design.md`）

1. **TD-031-1：章节任务中断即整条章节 run 报废**：四类章节任务的 recoveryPolicy 都是
   `settle_if_result`（与 SPEC_EXTRACT / RESEARCH_RUN 同则，防重复计费）。应用在
   DRAFT/REWRITE 任务 RUNNING 时退出 → 启动 `reconcileTasks` 标 `TASK_INTERRUPTED` →
   不重放 → `applyNodeFailure` → 章节 run 终态 failed。代价比 intake 侧更痛：一章正文
   的生成时间最长、用户等待感最强，而失败后只能新建 chapter run 从 CHAPTER_PLAN 重来
   （既有候选修订仍在库里，但不属于新 run）。方向：(a) 章节任务改可重放并接受重复计费；
   (b) 允许新 run 继承同一 blueprintChapterId 的既有候选修订链。与 TD-022/TD-027-4 同族。
2. ~~**TD-031-2：候选 Gate 的"请求改写"无用户意见承载**~~ —— **已解决（B10，D-B10-3，
   2026-08-13）**：意见走独立权威存储 `chapter_rewrite_feedback`（migration v18），
   `chapter.submitDecision` 先落意见再推进 Graph（顺序即语义），
   `executeChapterRewrite` 按当前候选修订号取最新一条送进 prompt；取不到就如实告知
   模型"用户未附意见"，不伪造。原文如下：**TD-031-2：候选 Gate 的"请求改写"无用户意见承载（章节侧的 TD-029-1）**：
   `candidate_gate` 决策 DTO 无 feedback 字段，用户点"请求改写"时无法说明原因；本批次
   如实在 prompt 里标注 `userRequestedRewrite: true / userFeedback: null`，不伪造意见。
   B10（生成 UI）批次连同 feedback 承载一并设计——否则界面上会出现一个"看起来能提意见、
   实际意见不传"的空承诺（B6/B7/B8 各踩过一次的坑）。
3. **TD-031-3：Critic 的审查对象与图 artifact 语义不重合**：图上 Critic 的
   `requiresArtifacts` 是 `generationRun`（恒指向 DRAFT 那一版），而实际审查对象是
   "同 run 最大修订号"的候选（改写后是 REWRITE 那一版）。两者在 rewrite 循环里必然不同，
   靠 `budget.rewrite` 进入 inputHash 才使 stale 校验仍然正确。这层错位是图契约冻结
   （REWRITE 为 noOut）的直接后果，当前实现自洽且有 E2E 覆盖，但对读者不直观；若将来
   放开图定义，应让 REWRITE 也产出 generationRun artifact，消除这层错位。

## TD-032: B10（GE-6 章节生成 UI）随行两项

**状态**: OPEN
**优先级**: 低-中
**来源**: B10 交付随行（2026-08-13，设计见 `b10-chapter-ui-design.md`）

1. **TD-032-1：章节列表的阶段是逐章串行读出来的**：`chapter.getOverview` 对每个蓝图
   章节各查一次最新 run + 最新候选（N 章 = 2N 次查询，同一连接内）。当前蓝图上限 200
   章，冷启动时最坏两百多次小查询，实测无感但不是可扩展写法。方向：改为一次按
   project 拉全部 chapter run 后在内存里分组（`listByProject` 已经把它们全取回来了，
   现在是每章重复遍历同一份结果）。
2. **TD-032-2：候选正文没有"整章重来"以外的局部修改入口**：用户只能整章改写
   （按意见 / 重写一版），不能像稿件编辑那样自己动手改一句。这是 GE-7（稿件工作区）
   的能力，B10 界面已如实说明"写入稿件与编辑还在开发中"，此处登记以免被当成遗漏。
   注意 GE-7 落地时要同时给出"手写正文不被静默覆盖"的保证（锁定不变量）。

## TD-033: GE-7（稿件工作区）随行三项

**状态**: OPEN
**优先级**: 中
**来源**: GE-7 交付随行（2026-08-13，设计见 `ge7-manuscript-design.md`）

1. ~~**TD-033-1：稿件章节顺序按提交先后**~~ —— **已解决（收尾批次 D-GE7-7，2026-08-13）**：
   MANUSCRIPT_COMMIT 首次为某蓝图章节建稿件章节时，按蓝图章节序定位插入点
   （找蓝图里排在其后、且已在稿件中存在的第一章，插到它前面）。product-e2e 新增
   "先写第二章再写第一章 → 稿件顺序仍是蓝图顺序"回归，先红后绿验证。原文如下：
   **TD-033-1：稿件章节顺序按提交先后，不按蓝图章节序**：`MANUSCRIPT_COMMIT` 首次
   提交某章时用 `createChapter(insertBeforeChapterId: null)` 追加到末尾。用户若跳着
   生成（先写第三章再写第一章），稿件里的顺序就是 3、1。后端已有
   `updateChapterOrder`（含 rebalance），补一个"按蓝图章节序插入"的定位即可；
   当前先如实登记，不假装顺序正确。
2. ~~**TD-033-2：版本历史没有界面**~~ —— **已解决（收尾批次，2026-08-13）**：
   `manuscript.listVersions` / `manuscript.restoreVersion` 两条通道四层贯通；稿件工作区
   给出版本列表（第 N 版 · 来源中文标注 · 当前版）与"恢复到这一版"（只移动 current
   指针、带 CAS，任何一版都不删除），并在界面上如实说明这一点。"不静默覆盖"至此
   从数据层保证变成用户看得见的能力。原文如下：**TD-033-2：版本历史没有界面**：后端有完整的版本链与 `promoteChapterVersion`
   （回滚到某一版），但稿件工作区只显示"当前第 N 版 · 共 M 版"，看不到也回不去
   历史版本。"不静默覆盖"的保证因此只体现在数据层，用户暂时感知不到。
3. **TD-033-3：编辑无自动保存**：roadmap §12 提到 autosave，本批次只做显式保存
   （按钮 + 未保存提示）。自动保存要与 CAS 基线协同（每次自动保存都会推进
   currentVersionId），需要单独设计防抖与版本膨胀策略，故未做。
