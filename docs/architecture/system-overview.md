# 系统架构概览

> 本文档是系统架构的**高层概览**。权威流程语义见 L3 Graph Definitions（`packages/domain/src/idea-to-novel-graph.ts`）；
> 模块边界与所有权见 `module-boundaries.md`；数据模型索引见 `data-model.md`。

## 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                      Electron 桌面应用                        │
├──────────────┬──────────────────┬───────────────────────────┤
│  Main Process │  Preload Script  │     Renderer Process      │
│              │                  │                           │
│  - 窗口管理   │  - contextBridge │  - React UI               │
│  - IPC broker│  - 最小 API 暴露  │  - 三栏工作台              │
│  - 应用生命周期│                  │  - 不直接访问 Node.js      │
└──────┬───────┴────────┬─────────┴──────────────┬────────────┘
       │                │                        │
       │         IPC 通道（类型安全，contracts）   │
       │                │                        │
┌──────┴────────────────┴────────────────────────┴────────────┐
│                     共享类型层（contracts）                    │
├─────────────────────────────────────────────────────────────┤
│                      应用层（application）                    │
├─────────────────────────────────────────────────────────────┤
│                      领域层（domain）                         │
├──────────────┬──────────────┬───────────────┬───────────────┤
│   database   │ model-gateway│  task-engine  │ 其他 engines   │
└──────────────┴──────────────┴───────────────┴───────────────┘
```

## 进程模型

### Main Process（主进程）

- 创建和管理 BrowserWindow；处理应用生命周期事件。
- **IPC broker**：`ipcMain.handle` → `forwardToWorker`，不直接执行业务命令。
- **不直接拥有 project.sqlite 的业务读写**；不直接调用模型。

### Preload Script（预加载脚本）

- 通过 `contextBridge` 暴露最小 typed API（`window.desktop.*`）。
- 不暴露 `ipcRenderer` 整体；所有 API 有 TypeScript 类型。

### Renderer Process（渲染进程）

- React UI；通过 `window.desktop` 调用 API。
- 不直接访问 Node.js、数据库、文件系统、API Key。

### Worker / Utility Process（工作进程）

- **SQLite 同步访问的唯一位置（数据库唯一写入者）**。
- 业务命令执行（dispatch：project.* / provider.* / task.* / grill.* / contract.* / graph.*）。
- GraphRunService 组合根（GE-1 起）；启动恢复（reconcile + recoverInFlightRuns）。
- SecretStore（macOS Keychain）；后台执行器调度（grill-plan / contract-draft；GE-2+ graph 节点执行器）。

## 安全边界

```
┌─────────────────────────────────────────────────────────┐
│                    安全沙箱（sandbox: true）              │
│  ┌─────────────────────────────────────────────────┐    │
│  │              Renderer Process                   │    │
│  │  - 无 Node.js / 文件系统 / 数据库 / secret 访问  │    │
│  │  - 通过 window.desktop 调用 API                 │    │
│  └─────────────────────────────────────────────────┘    │
│                         │                    contextBridge
│  Main Process（无数据库业务读写，仅 IPC broker）            │
│  Worker / Utility Process（数据库唯一写入者）               │
└─────────────────────────────────────────────────────────┘
```

## 数据流

### 用户输入 → Graph 状态变化（GE-1 起）

```
Renderer（提交 intent + expectedVersion + idempotencyKey）
  → window.desktop.graph.*（preload）
    → ipcMain.handle（main，仅转发）
      → worker RPC → dispatchGraphCommand
        → GraphRunService（load → validateGraphRunState → 纯 domain transition
            → validateGraphRunState → BEGIN IMMEDIATE + CAS 原子持久化）
```

### 项目数据持久化

1. 权威状态定义在 domain 层（Graph Definitions / 各领域模型）。
2. application 层协调用例并持有端口接口。
3. database 层负责 SQLite 持久化（migration 版本化，STRICT 表）。
4. 所有 Graph 状态变化经 Domain transition；其它跨模块更新经 ChangeSet 追踪。

## 模块依赖关系

```
contracts ← domain
    ↑          ↑
    │          │
application ───┘
    ↑
    │
┌───┴───┬─────────┬──────────┬──────────┐
│       │         │          │          │
database model-gateway task-engine 其他 engines
```

- `contracts`：共享类型与校验，最底层。
- `domain`：纯领域模型（含两张权威 Graph），无外部依赖。
- `application`：依赖 domain，定义用例接口与端口。
- 基础设施包：依赖 domain 和/或 contracts；执行器结果必须回到 application 经 Domain transition 才能推进 Graph。
