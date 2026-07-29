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

**状态**: PARTIALLY_RESOLVED
**优先级**: 当前
**最后核验基线**: 5cefd6e

### 问题

AI 问题规划后端已完成（PR #9，GRILL_QUESTION_PLAN 任务类型、严格解析、stale 检测、proposal 持久化）。Renderer 集成在 PR #11 中，当前 open 未合并。

### 影响

- 后端能力已可用，但用户无法通过 UI 触发和审核 AI 问题规划
- 需要 PR #11 合并后此项才能标记 RESOLVED

### 后续动作

- 完成 PR #11 审核和合并
- 合并后更新本条目为 RESOLVED

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

## TD-019: 导入、导出、备份尚未实现

**状态**: OPEN
**优先级**: M7
**最后核验基线**: 5cefd6e

### 问题

项目数据的导入、导出和备份功能尚未实现。packages/import-export 为占位结构。

### 影响

- 用户无法备份或迁移项目数据
- 数据丢失风险

### 后续动作

- M7 阶段设计和实现
- 确保 API Key 不进入备份
