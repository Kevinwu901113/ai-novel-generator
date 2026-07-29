# 模块边界

## 分层架构

```
┌─────────────────────────────────────────────────┐
│                    UI 层                         │
│  apps/desktop/src/renderer                      │
│  - React 组件                                    │
│  - 用户交互                                      │
│  - 不直接访问基础设施                              │
└─────────────────────────────────────────────────┘
                       │
                       ↓
┌─────────────────────────────────────────────────┐
│                  应用层                          │
│  packages/application                          │
│  - 用例编排                                      │
│  - 流程控制                                      │
│  - 不依赖 UI                                     │
└─────────────────────────────────────────────────┘
                       │
                       ↓
┌─────────────────────────────────────────────────┐
│                  领域层                          │
│  packages/domain                               │
│  - 纯 TypeScript                                │
│  - 领域模型                                      │
│  - 业务规则                                      │
│  - 无外部依赖                                    │
└─────────────────────────────────────────────────┘
                       │
                       ↓
┌─────────────────────────────────────────────────┐
│                基础设施层                        │
│  packages/database, model-gateway,             │
│  task-engine, plotpilot-adapter                │
│  - 具体实现                                      │
│  - 外部服务集成                                   │
│  - 数据持久化                                    │
└─────────────────────────────────────────────────┘
```

## 安全边界与进程模型

```
┌─────────────────────────────────────────────────────────────────┐
│  Renderer（沙箱）                                                │
│  - contextIsolation: true, nodeIntegration: false, sandbox: true │
│  - 只能调用 window.desktop.* (typed DesktopAPI)                  │
│  - 无 Node.js、文件系统、SQLite、secret 权限                     │
│  - 不组装正式领域对象，只提交 intent + expectedVersion            │
└─────────────────────────────────────────────────────────────────┘
                              │
                        contextBridge
                        (preload/index.ts)
                              │
┌─────────────────────────────────────────────────────────────────┐
│  Main Process                                                    │
│  - 窗口管理、IPC broker、进程生命周期                             │
│  - ipcMain.handle → forwardToWorker                              │
│  - 不直接拥有 project.sqlite 的业务读写                           │
│  - 不直接执行业务命令                                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                     Worker / Utility Process RPC
                     (worker-client.ts ↔ worker/index.ts)
                              │
┌─────────────────────────────────────────────────────────────────┐
│  Worker / Utility Process                                        │
│  - SQLite 同步访问的唯一位置                                      │
│  - 业务命令执行（dispatch）                                       │
│  - SecretStore（macOS Keychain）                                  │
│  - 后台任务调度（grill-plan-runner）                              │
│  - 启动恢复（reconcile）                                          │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ↓               ↓               ↓
┌──────────────────┐ ┌────────────────┐ ┌──────────────────────┐
│  Application     │ │  Domain        │ │  Infrastructure      │
│  (use cases)     │ │  (rules)       │ │  Adapters            │
│                  │ │                │ │                      │
│  - mutation      │ │  - 纯函数      │ │  - database          │
│    orchestration │ │  - 状态机      │ │  - model-gateway     │
│  - 端口接口      │ │  - 验证        │ │  - task-engine       │
│                  │ │                │ │  - plotpilot-adapter │
└──────────────────┘ └────────────────┘ └──────────────────────┘
```

**关键约束**：

- Renderer 无 Node、文件系统、SQLite、secret 权限
- Preload 只暴露 typed DesktopAPI，不暴露 `ipcRenderer`
- Main 负责窗口、IPC broker 和进程生命周期
- Main 不直接拥有 project.sqlite 的业务读写
- Worker / Utility Process 是 SQLite 同步访问和业务命令执行位置
- Application 层拥有 mutation orchestration
- Database 是持久化 adapter
- Model-gateway 是模型 provider adapter
- Task-engine 负责持久化任务执行
- PlotPilot-adapter 是可替换的外部 sidecar adapter
- PlotPilot 不共享应用 SQLite 写权限
- 用户确认的本地数据始终是 source of truth

## 模块职责

### `packages/domain`

**职责**：纯领域模型和业务规则

**约束**：

- 不依赖 Electron、React、Node.js 专有 API
- 不依赖 SQLite 或具体模型提供商
- 只包含类型定义和纯函数

**导出**：

- ProjectId, ProjectStatus, TaskStatus, TaskType
- GrillSession, GrillQuestion, GrillAnswer 状态机
- GrillQuestionPlanProposal 验证（parseQuestionPlanV1、validatePlanReferences、topologicalPlanOrder）
- DecisionScope, ChangeSet
- 工厂函数和验证函数

### `packages/application`

**职责**：应用用例和流程接口

**约束**：

- 不依赖 Electron UI
- 定义接口，不包含具体实现
- 不依赖 Electron、React、node:sqlite、`/usr/bin/security`、process.env

**导出**：

- 项目用例（CreateProject、ListProjects、OpenProject）
- 提供商用例（GetProviderState、SaveProviderApiKey、DeleteProviderApiKey、TestProviderConnection）
- Grill 用例（session/question/answer CRUD、question-plan proposal 管理）
- 任务用例（task 创建、查询、统计）
- 端口接口（SecretStore、ProviderProfileRepository、Clock、IdGenerator、TaskRepositoryPort、ModelInvocationRepositoryPort、GrillSessionRepositoryPort、GrillQuestionRepositoryPort、GrillAnswerRepositoryPort、GrillQuestionPlanProposalRepositoryPort）
- 错误类（AppError 及子类）

### `packages/contracts`

**职责**：IPC 类型和运行时验证

**约束**：

- 所有进程共享
- 只包含类型定义和验证函数

**导出**：

- HealthCheckResponse
- DesktopAPI（projects、provider、tasks、grill 完整 typed API）
- IPC_CHANNELS
- TaskPublicData、TaskStatsPublicData
- Grill DTO（GrillSessionPublicData、GrillQuestionPublicData、GrillAnswerPublicData、QuestionPlanProposalPublicData）
- ErrorCode 联合类型
- 验证函数

### `packages/database`

**职责**：SQLite 数据持久化

**约束**：

- 使用 node:sqlite（Node.js 内置）
- 所有同步调用只在 Worker/Utility Process 中运行
- 不暴露给 Renderer
- 封装为可替换适配器

**导出**：

- `AppDatabase`：app.sqlite 管理
- `ProjectDatabase`：project.sqlite 管理
- `SQLiteMigrator`：迁移运行器
- 仓库实现（ProjectIndexRepository、ProjectMetadataRepository、ProviderProfileRepository、TaskRepository、ModelInvocationRepository、GrillSessionRepository、GrillQuestionRepository、GrillAnswerRepository、GrillQuestionPlanProposalRepository）

**实现特性**：

- 迁移机制（版本控制、事务、幂等）
- STRICT tables
- WAL 模式、foreign_keys、busy_timeout

### `packages/model-gateway`

**职责**：多提供商、多模型统一网关

**约束**：

- 屏蔽提供商差异
- 统一接口
- 不安装 Anthropic SDK，使用 Node 内置 fetch
- 不接受 Renderer URL，从固定 profile 构造

**导出**：

- `testConnection`：Anthropic-compatible 连接测试
- `invokeModel`：通用模型调用（支持 systemPrompt、maxTokens、temperature）
- `ConnectionTestInput`、`ConnectionTestOutput`、`ModelInvocationOutput` 类型

**实现特性**：

- Anthropic-compatible 客户端（fetch、AbortController 超时、错误码映射）
- 固定 MiMo V2.5 Pro，不支持自定义端点
- 支持依赖注入 fetch 和 clock
- usage 提取（inputTokens、outputTokens、cacheReadTokens、cacheWriteTokens）

### `packages/task-engine`

**职责**：任务编排与执行

**约束**：

- 管理任务生命周期
- 任务先落库再调用模型
- prompt 不写入数据库
- CAS 防止并发执行

**导出**：

- `executeModelInvocationTest`：执行测试型任务
- `executeGrillQuestionPlan`：执行 AI 问题规划任务
- `sha256Hex`：计算 prompt hash
- `TaskExecutionError`：任务执行错误
- `TaskEngineDeps`、`GrillQuestionPlanEngineDeps`：依赖接口

**支持的任务类型**：

- `MODEL_INVOCATION_TEST`：连接测试
- `GRILL_QUESTION_PLAN`：AI 问题规划（stale 检测、严格解析、依赖图验证、proposal 持久化）

### `packages/plotpilot-adapter`

**职责**：PlotPilot 外部 sidecar 适配器

**约束**：

- 可替换的外部 sidecar adapter
- 不共享应用 SQLite 写权限
- 不直接访问应用数据库
- 环境变量 allowlist

**导出**：

- `PlotPilotAdapter`：HTTP 客户端（health、generateChapter、hostedWrite）
- `PlotPilotSidecarManager`：生命周期管理（spawn、health poll、graceful stop）
- SSE 流式事件处理与 AbortSignal 取消
- 错误分类（PLOTPILOT_UNAVAILABLE、PLOTPILOT_TIMEOUT、PLOTPILOT_ABORTED 等）

**边界**：

- Ownership（当前）：尚未实例化或接入 Main/Worker，仅有 package foundation
- Ownership（未来集成时）：adapter 实例必须由受信任的 Main/Worker side 持有
- Renderer 永远不直接调用 PlotPilot adapter
- 当前无 Worker RPC、IPC 或产品 UI
- SSE：事件通过 adapter 回调传递，不暴露原始 Response
- Cancellation：通过 AbortSignal，adapter 负责清理

### Grill-me 工作台（M2-A1.5）

**数据流**：

```
Renderer (React)
  → window.desktop.grill.* (preload contextBridge)
    → ipcMain.handle (main process)
      → forwardToWorker (worker-client RPC)
        → dispatchGrillCommand (worker)
          → application use cases
            → domain rules + database
```

**约束**：

- Renderer 只调用 `window.desktop.grill.*`，不直接访问 SQLite
- Preload 编译为自包含 CJS，不运行时导入 workspace ESM 包
- 所有 mutation 携带 `expectedVersion`（乐观并发控制）
- 错误码映射为中文消息，不暴露内部 ID、路径或堆栈
- 版本冲突 → 自动刷新 + 用户提示，不自动重试 mutation
- 终态 session 禁用内容修改控件，后端为最终约束来源

## Renderer Mutation Rule

所有 Renderer 到后端的状态变更必须遵循：

1. **Renderer 不组装正式领域对象**：Renderer 只提交 intent（动作意图）和 expectedVersion
2. **后端返回值是事实来源**：mutation 成功后，Renderer 使用后端返回的完整对象更新 UI
3. **AI 输出始终是 proposal**：AI 生成的内容在用户显式接受前不具有权威性
4. **用户显式 accept 才创建权威版本**：没有自动接受路径
5. **错误必须经过 safe error boundary**：RendererErrorBoundary + safe-error 映射，不暴露内部细节

## 依赖规则

1. **单向依赖**：上层可以依赖下层，下层不能依赖上层
2. **接口隔离**：通过 contracts 包定义共享接口
3. **依赖倒置**：依赖抽象接口，不依赖具体实现

## 跨模块通信

### 同步调用

直接函数调用，用于：

- 领域逻辑计算
- 数据验证
- 类型转换

### 异步调用

通过 IPC 或事件，用于：

- Main ↔ Renderer 通信
- Main ↔ Worker RPC
- 长时间运行的任务
- 外部 API 调用

### ChangeSet

跨模块状态更新使用 ChangeSet：

- 原子操作
- 可追溯
- 支持撤销

## 计划中的创作契约边界（NOT IMPLEMENTED）

> 以下为 M1-C 计划，尚未实现。详见 `docs/architecture/creation-contract-design.md`。

**计划数据流**：

```
Renderer
  → window.desktop.contract.* (preload contextBridge)
    → ipcMain.handle (main)
      → forwardToWorker (worker RPC)
        → dispatchContractCommand (worker)
          → application contract use cases
            → domain contract rules
            → database (creation_contract_* tables)
            → task-engine (CREATION_CONTRACT_DRAFT)
            → model-gateway (AI proposal generation)
```

**计划约束**：

- AI 永远不能直接更新当前创作契约
- Proposal 出现不代表契约已更新
- 用户显式接受后才创建权威版本
- 已锁定字段不得被 AI proposal 静默覆盖
- 接受、版本写入、current pointer 更新必须同一事务
- PlotPilot 只消费已接受 ContractVersion snapshot，不能成为 source of truth
