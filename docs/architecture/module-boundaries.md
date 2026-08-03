# 模块边界 — Graph Engineering 版

> 本文件描述模块边界与所有权。**流程权威是 L3 Graph Definitions**
> （`packages/domain/src/idea-to-novel-graph.ts`），任何节点/转移/人工 Gate/预算/失效语义以图为准。
> 路线见 `docs/development/graph-engineering-roadmap.md`；单一状态见 `docs/development/current-project-state.md`。

## 0. 核心不变量

```text
任何 Graph 状态变化只能经已合并的 Domain transition
（applyNodeSuccess / applyNodeFailure / requestHumanDecision / applyHumanDecision / applyArtifactChange）。

Renderer / Worker / Task Engine / Model Gateway / Research / Import-Export 均不得直接拼装或修改 Graph state。
WorkflowStage 是派生 UI 投影，永不作为权威状态；下一个可执行节点以 possibleNextNodes 为准。
```

## 1. 分层架构

```
┌─────────────────────────────────────────────────┐
│                    UI 层                         │
│  apps/desktop/src/renderer                      │
│  - React 组件（Idea / Research / Blueprint /    │
│    Manuscript 产品页）                          │
│  - 只提交 intent + expectedVersion + idempotencyKey
│  - 不暴露 Graph 控制台 / 节点调试器 / Token 内部状态
└─────────────────────────────────────────────────┘
                       │
                       ↓
┌─────────────────────────────────────────────────┐
│                  应用层                          │
│  packages/application                          │
│  - GraphRunService（GE-1）：load → validate →    │
│    纯 domain transition → validate → CAS 原子持久化
│  - 端口接口（GraphRunRepositoryPort 等）        │
│  - 不依赖 UI，不直接写 Graph state              │
└─────────────────────────────────────────────────┘
                       │
                       ↓
┌─────────────────────────────────────────────────┐
│                  领域层                          │
│  packages/domain                               │
│  - 两张权威 Graph 定义 + 纯 transition +        │
│    graph-aware 校验 + 失效传播 + WorkflowStage  │
│    投影                                          │
│  - 无外部依赖，生成不了 ID / 时间               │
└─────────────────────────────────────────────────┘
                       │
                       ↓
┌─────────────────────────────────────────────────┐
│                基础设施层                        │
│  database（run-state 持久化）、model-gateway、  │
│  task-engine、research-engine、import-export、  │
│  plotpilot-adapter                              │
│  - 具体实现；外部服务集成；数据持久化            │
│  - 执行器结果必须回到 application 经 Domain      │
│    transition 才能推进 Graph                    │
└─────────────────────────────────────────────────┘
```

## 2. 安全边界与进程模型

```
┌─────────────────────────────────────────────────────────────────┐
│  Renderer（沙箱）                                                │
│  - contextIsolation: true, nodeIntegration: false, sandbox: true │
│  - 只能调用 window.desktop.* (typed DesktopAPI)                  │
│  - 无 Node.js、文件系统、SQLite、secret 权限                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                        contextBridge
                        (preload/index.ts)
                              │
┌─────────────────────────────────────────────────────────────────┐
│  Main Process                                                    │
│  - 窗口管理、IPC broker、进程生命周期                             │
│  - ipcMain.handle → forwardToWorker                              │
│  - 不直接执行业务命令                                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                     Worker / Utility Process RPC
                              │
┌─────────────────────────────────────────────────────────────────┐
│  Worker / Utility Process                                        │
│  - SQLite 同步访问的唯一位置（database 唯一写入者）                │
│  - 业务命令执行（dispatch：project.* / provider.* / task.* /      │
│    grill.* / contract.* / graph.*）                               │
│  - GraphRunService 组合根 + 启动恢复（reconcile + recoverInFlight）│
│  - SecretStore（macOS Keychain）；后台执行器调度                  │
└─────────────────────────────────────────────────────────────────┘
```

**关键约束**：Utility Process 是数据库唯一写入者；application 通过 `GraphRunTransactionPort` 在单个
`BEGIN IMMEDIATE` 事务内执行"transition + 持久化"；执行器（Task Engine）先落库再调用模型，结果经
GraphRunService 的 `advanceNode`/`failNode` 进入 Domain transition。

## 3. 模块职责

### `packages/domain`（流程权威）

- 两张权威 Graph 定义：IdeaToNovelProjectGraphV1（16 节点/36 边）、ChapterGenerationGraphV1（13 节点/23 边）。
- 纯 transition（`applyNodeSuccess` / `applyNodeFailure` / `requestHumanDecision` / `applyHumanDecision`）。
- graph-aware 状态校验（`validateGraphRunState`）、静态图校验器（`validateGraphDefinition`）。
- 失效传播（`applyArtifactChange`）、WorkflowStage 投影（派生，非权威）。
- **约束**：无外部依赖；不生成 ID/时间；不调用模型/搜索/Keychain。
- **导出**：graph 模块 + grill / creation-contract / manuscript / task 状态机等既有领域模型。

### `packages/application`（用例编排 + 端口）

- `GraphRunService`（GE-1）：createProjectRun / createChapterRun / advanceNode / failNode / requestHumanDecision /
  applyHumanDecision / listRuns / recoverInFlightRuns；硬不变量：load → validate → 纯 transition → validate → CAS 持久化。
- 端口：`ProjectRunRepositoryPort`、`ChapterGenerationRunRepositoryPort`、`GraphRunCommandLogPort`、
  `IdeaIntakeAnswerPort`、`GraphRunTransactionPort`、既有 `TaskRepositoryPort` / `ModelInvocationRepositoryPort` /
  `SecretStore` / `ProviderProfileRepository` 等。
- **约束**：不依赖 Electron/React/node:sqlite；不直接写 Graph state。
- **导出**：graph-run 用例、既有 project / provider / grill / contract / manuscript 用例。

### `packages/contracts`（共享 IPC 面）

- `IPC_CHANNELS`、`DesktopAPI`（projects / provider / tasks / grill / contract / graph（GE-1+））、ErrorCode、
  手写校验器、graph DTO（GraphIdentityDto / GraphProgressProjectionDto / HumanDecisionInputDto / RunTerminalStateDto）。
- **约束**：所有进程共享；只包含类型与验证；不复制 domain 执行器；不依赖 domain 包。
- 注意：`WorkflowStage` 是 contracts 中的派生 UI 类型，不是权威状态。

### `packages/database`（持久化 adapter）

- `AppDatabase`（app.sqlite，v1–v4）、`ProjectDatabase`（project.sqlite，v1–v7；GE-1 追加 v8 graph_runs +
  graph_run_commands）。
- `SQLiteMigrator`、STRICT 表、WAL、BEGIN IMMEDIATE 事务、`GraphRunTransactionPortImpl`（GE-1）。
- **约束**：node:sqlite；只在 Worker/Utility Process 运行；不暴露给 Renderer。
- **导出**：migration 注册表、既有 repo 实现 + graph-run repo（GE-1）。

### `packages/model-gateway`

- `testConnection` / `invokeModel`（Anthropic 兼容，非流式，120s 超时，错误码映射，usage 提取）。
- **约束**：固定 MiMo V2.5 Pro；不接受 Renderer URL；不直接推进 Graph。

### `packages/task-engine`（执行器底座）

- 持久化任务（MODEL_INVOCATION_TEST / GRILL_QUESTION_PLAN / CREATION_CONTRACT_DRAFT；GE-2+ 增加 graph 节点执行器）。
- CAS claim / 原子提交 / 启动恢复。
- **约束**：**任务结果不能直接推进 Graph**；必须经 GraphRunService 的 Domain transition。

### `packages/research-engine` / `packages/import-export`（stub → GE-4 / GE-7）

- 当前为 stub（仅导出 `*_PACKAGE_LOADED`）。GE-4 实现 WebSearchPort / WebFetchPort / ResearchRepository /
  ResearchOrchestrator；GE-7 实现 TXT/Markdown 导出。

### `packages/plotpilot-adapter`（可选 adapter）

- 可替换的外部 sidecar adapter（spawn/SSE/生命周期）。**不进入不可替代关键路径**；不共享应用 SQLite 写权限；
  不直接推进 Graph。

## 4. Graph 数据流（GE-1 起）

```
Renderer（Idea / Research / Blueprint / Manuscript 产品页）
  → window.desktop.graph.* (preload contextBridge)
    → ipcMain.handle (main)
      → forwardToWorker (worker RPC)
        → dispatchGraphCommand (worker)
          → GraphRunService use cases（load → validate → 纯 domain transition → validate）
            → GraphRunTransactionPort（BEGIN IMMEDIATE + CAS 原子持久化）
              → domain transition + database（graph_runs / graph_run_commands / grill_answers）
```

执行器（Task Engine / Model Gateway / Research）：

```
持久化任务（先落库）→ 调用模型/搜索 → 结果提交到 GraphRunService.advanceNode/failNode
  → domain transition 校验 → CAS 原子提交
```

## 5. Renderer Mutation Rule

1. Renderer 不组装正式领域对象：只提交 intent + expectedVersion + idempotencyKey。
2. 后端返回值是事实来源：mutation 成功后用返回的完整对象更新 UI。
3. AI 输出始终是 proposal：用户显式接受前无权威性。
4. 用户显式 accept 才创建权威版本：人工 Gate 处没有自动接受路径。
5. 错误经过 safe error boundary：不暴露内部路径/堆栈/SQL/Token。
6. UI 不暴露 Graph 控制台 / 节点调试器 / Token 与任务内部状态：只显示用户当前需要理解与操作的内容。

## 6. 依赖规则

1. 单向依赖：上层依赖下层，下层不依赖上层。
2. 接口隔离：通过 contracts 定义共享接口。
3. 依赖倒置：依赖抽象端口，不依赖具体实现。

## 7. ChangeSet

跨模块状态更新使用 ChangeSet：原子操作、可追溯、支持撤销（保留既有机制；Graph 状态更新另以 run 事务 + CAS 为准）。
