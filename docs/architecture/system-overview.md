# 系统架构概览

> 本文档是系统架构的**高层概览**。权威流程语义见 L3 Graph Definitions（`packages/domain/src/idea-to-novel-graph.ts`）；
> 模块边界与所有权见 `module-boundaries.md`；数据模型索引见 `data-model.md`。

## 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│         浏览器（本机 + 局域网多设备，同源访问 apps/server）      │
│  apps/web：React UI（三栏工作台）                              │
│  - 只经 window.desktop（desktop-client.ts，HTTP 客户端）通信   │
│  - 不直接访问 Node.js / 数据库 / 文件系统 / API Key            │
└───────────────────────────┬─────────────────────────────────┘
                             │  POST /api/rpc  {command, payload}
                             │  Authorization: Bearer <token>
┌───────────────────────────┴─────────────────────────────────┐
│  apps/server（hand-rolled node:http，零外部依赖）               │
│  - 认证（token + Host 白名单）/ 按 command 校验 / 静态托管       │
│    apps/web 构建产物 / 安全响应头                               │
│  - 只做传输层，不含业务逻辑                                     │
└───────────────────────────┬─────────────────────────────────┘
                             │  进程内直调
┌───────────────────────────┴─────────────────────────────────┐
│  @ai-novel/worker（库）：dispatchCommand() / initialize()      │
├─────────────────────────────────────────────────────────────┤
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

> 单进程形态（D11，2026-08-17）：apps/server 一个 Node.js 进程内既做 HTTP 传输，又把
> `@ai-novel/worker` 当库直调（无 IPC、无子进程序列化）。浏览器与服务进程之间只有一跳
> HTTP，服务进程内部到业务逻辑是一次直接函数调用。

### apps/web（浏览器，前端）

- React UI；只通过 `window.desktop`（`desktop-client.ts` 注入的 HTTP 客户端）调用 API。
- 只依赖 `@ai-novel/contracts`；不直接访问 Node.js、数据库、文件系统、API Key。
- `TokenGate` 包在 App 外：无有效访问令牌时拦截，录入后存 `localStorage`。

### apps/server（Web 服务端，传输层）

- hand-rolled `node:http`：单一 `POST /api/rpc` 端点（信封 `{command, payload}`）+ 静态
  托管 `apps/web` 构建产物 + 安全响应头（CSP 等）。
- 认证：文件 token（`${数据根}/auth-token`）+ `Authorization: Bearer` + Host 白名单，
  localhost 不豁免；默认绑定 `127.0.0.1:4870`，`AI_NOVEL_HOST=0.0.0.0` 显式放开局域网。
- 按 `RPC_COMMAND_VALIDATORS` 校验每个 command 的 payload，校验通过后转发给 worker 库；
  **只做传输/认证/校验/托管，不含业务逻辑**。
- 三个 `app.*` readiness 命令（healthCheck / dataServiceStatus / dataServiceRetry）由
  server 本地处理（`SERVER_COMMANDS`），语义与其余命令一致，仍走同一端点。

### @ai-novel/worker（库，业务命令执行）

- **SQLite 同步访问的唯一位置（数据库唯一写入者）**，由 apps/server 进程内直调
  `dispatchCommand()` / `initialize()`（不再是独立进程，不再有 IPC 序列化）。
- 业务命令执行（dispatch：project.\* / provider.\* / task.\* / grill.\* / contract.\* / graph.\*，
  共 82 个 command）。
- GraphRunService 组合根（GE-1 起）；启动恢复（reconcile + recoverInFlightRuns，`initialize()`
  重入幂等）。
- SecretStore（macOS Keychain）；后台执行器调度（grill-plan / contract-draft / story-graph；
  GE-2+ graph 节点执行器）。

## 安全边界

```
┌─────────────────────────────────────────────────────────┐
│  浏览器（apps/web）                                       │
│  - 无 Node.js / 文件系统 / 数据库 / secret 访问            │
│  - 通过 window.desktop（HTTP 客户端）调用 API              │
└───────────────────────┬───────────────────────────────────┘
                         │  POST /api/rpc + Authorization: Bearer
                         │  （Host 白名单防 DNS rebinding，localhost 不豁免）
┌───────────────────────┴───────────────────────────────────┐
│  apps/server（认证 + 校验 + 静态托管，无数据库业务读写）      │
│  @ai-novel/worker（库，进程内直调，数据库唯一写入者）        │
└─────────────────────────────────────────────────────────┘
```

无 TLS：局域网访问是明文 HTTP（风险披露与缓解见 `docs/development/tech-debt.md` TD-034）。

## 数据流

### 用户输入 → Graph 状态变化（GE-1 起）

```
apps/web（提交 intent + expectedVersion + idempotencyKey）
  → window.desktop.graph.*（desktop-client.ts，HTTP 客户端）
    → POST /api/rpc（apps/server：认证 + Host 白名单 + 按 command 校验）
      → dispatchCommand（worker 库，进程内直调）→ dispatchGraphCommand
        → GraphRunService（load → validateGraphRunState → 纯 domain transition
            → validateGraphRunState → BEGIN IMMEDIATE + CAS 原子持久化）
```

### 项目数据持久化

1. 权威状态定义在 domain 层（Graph Definitions / 各领域模型）。
2. application 层协调用例并持有端口接口。
3. database 层负责 SQLite 持久化（migration 版本化，STRICT 表）。
4. 所有 Graph 状态变化经 Domain transition；其它跨模块更新经 ChangeSet 追踪。

### 导出流程

`packages/import-export` 的 TXT/Markdown 渲染仍是纯函数，由 worker 库在服务进程内调用；
落盘方式随 Electron 退役改变——不再有原生保存对话框，渲染结果经 `/api/rpc` 信封回传给
apps/web，前端用 `download-file.ts`（Blob + `<a download>`）触发浏览器下载。浏览器端全程
不接触服务器文件系统，只接收渲染好的字符串内容。

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
