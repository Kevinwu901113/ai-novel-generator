# 模块边界

## 分层架构

```
┌─────────────────────────────────────────────────┐
│                    UI 层                         │
│  apps/desktop/renderer                          │
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
│  packages/database, model-gateway, etc.        │
│  - 具体实现                                      │
│  - 外部服务集成                                   │
│  - 数据持久化                                    │
└─────────────────────────────────────────────────┘
```

## 模块职责

### `packages/domain`

**职责**：纯领域模型和业务规则

**约束**：

- 不依赖 Electron、React、Node.js 专有 API
- 不依赖 SQLite 或具体模型提供商
- 只包含类型定义和纯函数

**导出**：

- ProjectId, ProjectStatus, TaskStatus
- DecisionScope, ChangeSet
- 工厂函数和验证函数

### `packages/application`

**职责**：应用用例和流程接口

**约束**：

- 不依赖 Electron UI
- 定义接口，不包含具体实现

**导出**：

- 用例接口
- 流程定义

### `packages/contracts`

**职责**：IPC 类型和运行时验证

**约束**：

- 所有进程共享
- 只包含类型定义和验证函数

**导出**：

- HealthCheckResponse
- DesktopAPI
- IPC_CHANNELS
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
- 仓库接口（ProjectIndexRepository、ProjectMetadataRepository）

**M1-A 实现**：

- 迁移机制（版本控制、事务、幂等）
- STRICT tables
- WAL 模式、foreign_keys、busy_timeout

### `packages/model-gateway`

**职责**：多提供商、多模型统一网关

**约束**：

- 屏蔽提供商差异
- 统一接口

**导出**：

- 模型调用接口
- 提供商适配器

### `packages/task-engine`

**职责**：任务编排与执行

**约束**：

- 管理任务生命周期
- 协调多个 engine

**导出**：

- 任务调度器
- 任务执行器

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
- 长时间运行的任务
- 外部 API 调用

### ChangeSet

跨模块状态更新使用 ChangeSet：

- 原子操作
- 可追溯
- 支持撤销

## 安全边界

```
┌─────────────────────────────────────────────┐
│           Renderer（沙箱）                   │
│  - 只能调用 window.desktop API               │
│  - 不能访问 Node.js                          │
│  - 不能访问文件系统                           │
└─────────────────────────────────────────────┘
                    │
              contextBridge
                    │
┌─────────────────────────────────────────────┐
│           Main Process（完全权限）            │
│  - 可以访问所有资源                           │
│  - 管理 API Key                              │
│  - 管理数据库                                 │
└─────────────────────────────────────────────┘
```
