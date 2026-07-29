# 开发路线图

## 里程碑概览

| 里程碑 | 名称               | 目标             | 状态    |
| ------ | ------------------ | ---------------- | ------- |
| M0     | 仓库与开发基线     | 建立工程基础     | ✅ 完成 |
| M1     | 项目创建至创作契约 | 纵向切片         | 进行中  |
| M2     | 正文编辑与版本     | 编辑器和版本管理 | 待开始  |
| M3     | 规划和正文生成     | AI 生成能力      | 待开始  |
| M4     | 状态与连续性       | 状态管理         | 待开始  |
| M5     | 审稿和定点修复     | 审稿流程         | 待开始  |
| M6     | 研究、上下文和成本 | 研究和优化       | 待开始  |
| M7     | 完整 V1 功能       | 功能完整         | 待开始  |
| M8     | 真实短篇质量验收   | 质量验收         | 待开始  |

## 交付切片状态表

> 历史编号是交付切片编号，不完全等于产品里程碑完成顺序。
> Grill 能力提前落地，但 M1 的"创作契约"目标尚未完成。
> PlotPilot foundation 已存在，但产品接入推迟到创作契约和稿件版本建立之后。

| 切片编号 | 名称                             | 状态         | 合并 PR / 备注         |
| -------- | -------------------------------- | ------------ | ---------------------- |
| M0       | 仓库与工程基线                   | ✅ 完成      | 初始提交               |
| M1-A     | 本地项目与 SQLite                | ✅ 完成      | PR #1 前置             |
| M1-B1    | Provider 与 Keychain             | ✅ 完成      | PR #1                  |
| M1-B2    | 持久化任务与模型调用             | ✅ 完成      | PR #2                  |
| M1-B2.5  | Task Activity Center             | ✅ 完成      | PR #6                  |
| M1-S1    | Renderer safety boundary         | ✅ 完成      | PR #7                  |
| M1-S2    | Renderer accessibility           | ✅ 完成      | PR #10                 |
| M2-A1    | Grill 领域、持久化、IPC          | ✅ 完成      | PR #3                  |
| M2-A1.5  | Grill 桌面工作台                 | ✅ 完成      | PR #4, #5              |
| M2-A2-BE | AI question-plan backend         | ✅ 完成      | PR #9                  |
| M2-A2-FE | AI question-plan Renderer        | 🔍 In Review | PR #11（open，未合并） |
| —        | PlotPilot sidecar foundation     | ✅ 完成      | PR #8                  |
| M1-C0    | 创作契约架构设计                 | 🔵 当前      | 本分支                 |
| M1-C1    | 创作契约 domain/contracts/db/app | ⬜ 下一项    |                        |
| M1-C2    | 创作契约 AI proposal task        | ⬜ 待开始    |                        |
| M1-C3    | 创作契约 Renderer                | ⬜ 待开始    |                        |
| M2-B     | 正文编辑与稿件版本               | ⬜ 待开始    |                        |
| M3       | 大纲与章节生成                   | ⬜ 待开始    |                        |

## M0：仓库与开发基线

**目标**：建立工程基础，不实现业务功能。

**范围**：

- 初始化 Git 仓库
- 建立 pnpm monorepo 结构
- 配置 TypeScript、ESLint、Prettier
- 创建 Electron 应用骨架
- 建立三栏工作台 UI 骨架
- 实现健康检查 IPC
- 创建所有包的占位结构
- 编写基础文档
- 建立测试框架

**验收标准**：

- `pnpm check` 全部通过
- Electron 应用可以启动
- 三栏 UI 正确显示
- 健康检查正常工作

## M1：项目创建至创作契约

**目标**：完成从项目创建到创作契约草案的纵向切片。

**范围**：

- 项目创建流程
- Grill-me 需求澄清
- 创作契约草案生成
- 基础 UI 交互

**验收标准**：

- 可以创建新项目
- Grill-me 流程可用
- 生成创作契约草案

### M1-A：本地项目与数据库 ✅

**目标**：创建本地项目、保存初始想法、显示项目列表、打开项目、重启后恢复。

**范围**：

- Electron 升级到 43.2.0
- 领域层：ProjectName、InitialIdea、ProjectSummary、Project、Unicode 长度工具
- 数据库层：node:sqlite 封装、AppDatabase（app.sqlite）、ProjectDatabase（project.sqlite）、迁移机制
- 应用层：CreateProject、ListProjects、OpenProject 用例及补偿逻辑
- Utility Process：RPC 协议、命令分发、生命周期管理
- IPC：project.create、project.list、project.open
- Preload：暴露 projects API
- Renderer：三栏 UI（项目列表、创建表单、状态面板）
- 测试：120 个测试全部通过（该切片合并时数据）

### M1-B1：模型提供商配置 ✅

**目标**：配置 MiMo V2.5 Pro 模型提供商，API Key 存 macOS Keychain，实现连接测试。

**范围**：

- 领域层：ProviderProfileId 品牌类型
- 契约层：ProviderPublicState、ConnectionTestResult、SaveApiKeyInput 类型，错误码扩展，验证函数
- 数据库层：app.sqlite 迁移 3（provider_profiles 表）、ProviderProfileRepository
- 模型网关：Anthropic-compatible 客户端（fetch、超时、错误码映射）
- 应用层：SecretStore 接口、GetProviderState、SaveProviderApiKey、DeleteProviderApiKey、TestProviderConnection 用例
- Worker：macOS Keychain SecretStore 实现、4 个 provider 命令处理
- IPC：provider.getState、provider.saveApiKey、provider.deleteApiKey、provider.testConnection
- Preload：暴露 provider API
- Renderer：右栏"模型服务"区域
- 测试：232 个测试全部通过（该切片合并时数据）

**关键设计决策**：

- 固定 MiMo V2.5 Pro，Base URL 和 Model 只读
- API Key 存 macOS Keychain（service: `com.ai-novel-generator.provider.mimo-token-plan-cn`）
- app.sqlite 只保存非敏感 provider profile
- 不安装 Anthropic SDK，使用 Node 24 内置 fetch
- 不复用 Claude Code Keychain

### M1-B2：持久化任务与模型调用基础设施 ✅

**目标**：建立任务持久化、模型调用记录、恢复机制、token 与错误统计基础设施。

**范围**：

- 领域层：TaskStatus、TaskType、ModelInvocationStatus 状态机
- 数据库层：project.sqlite 迁移 2（tasks、model_invocations 表）
- 应用层：TaskRepositoryPort、ModelInvocationRepositoryPort 端口接口
- 契约层：TaskPublicData、TaskStatsPublicData、新错误码、验证函数
- 模型网关：通用 invokeModel 调用、usage 提取、安全结果
- 任务引擎：MODEL_INVOCATION_TEST 执行、prompt hashing、原子提交
- Worker：任务恢复逻辑、4 个 task RPC 命令
- IPC：task.createModelInvocationTest、task.get、task.list、task.getStats
- Preload：暴露 tasks API
- 测试：365 个测试全部通过（该切片合并时数据）

**关键设计决策**：

- 任务和调用记录在 project.sqlite（随项目数据）
- prompt 不持久化，只保存 SHA-256 hash
- CAS claim 防止并发执行
- token 统计时 null 按 0 处理，但不改写数据库
- RUNNING 任务在启动时恢复为 FAILED（TASK_INTERRUPTED）
- 当前不支持自动重试和队列自动调度

### M1-B2.5：Task Activity Center ✅

**目标**：在 Renderer 中提供任务活动监控界面。

**范围**：

- 任务列表、详情、统计面板
- 创建 MODEL_INVOCATION_TEST 任务
- 实时状态展示
- 错误消息安全映射

### M1-S1：Renderer Safety Boundary ✅

**目标**：建立 Renderer 安全错误边界。

**范围**：

- RendererErrorBoundary 组件
- safe-error 工具（不暴露内部路径、堆栈、SQL）
- 错误码到中文消息的安全映射

### M1-S2：Renderer Accessibility ✅

**目标**：建立 Renderer 无障碍基础设施。

**范围**：

- LiveRegion（aria-live 通知）
- focus-utils、useFocusOnMount、useRestoreFocus
- 键盘导航支持

### M2-A1：Grill 领域、持久化、IPC ✅

**目标**：建立 Grill-me 需求澄清的领域模型和持久化。

**范围**：

- 领域层：GrillSession、GrillQuestion、GrillAnswer、GrillQuestionPlanProposal
- 数据库层：grill_sessions、grill_questions、grill_answers、grill_question_plan_proposals 表
- 应用层：Grill session/question/answer 用例
- Worker：Grill 命令处理
- IPC：完整 Grill DesktopAPI 链路

### M2-A1.5：Grill 桌面工作台 ✅

**目标**：在现有 Electron 桌面应用中提供最小但完整可用的 Grill-me 操作界面。

**范围**：

- 完成 DesktopAPI 链路（contracts IPC channels → main ipcMain.handle → preload contextBridge → renderer type）
- 三栏 UI：session 列表、session 面板与问题列表、问题详情与提案审核
- 创建/启动/暂停/恢复/完成/放弃 session
- 添加问题、标记已提问、回答、修订、跳过、废弃
- 创建/接受/拒绝 proposal
- 版本冲突检测与自动刷新
- 终态控件禁用
- 表单基础验证

**关键设计决策**：

- 开发工作台，非最终产品 UI
- 全部通过 preload 暴露的 DesktopAPI，不直接访问 SQLite
- 所有 mutation 携带 expectedVersion
- 版本冲突：显示提示 + 自动刷新，不自动重试
- 不引入状态管理库，使用 React hooks
- 不修改 domain 规则、数据库 schema、task engine

### M2-A2-BE：AI Question-Plan Backend ✅

**目标**：实现 AI 自动问题规划后端。

**范围**：

- task-engine：executeGrillQuestionPlan（GRILL_QUESTION_PLAN 任务类型）
- 严格结构化输出解析（拒绝非 JSON/markdown/额外文本/额外字段）
- 完整依赖图验证（引用 + 环检测）
- stale-before-call 和 stale-after-call 版本校验
- proposal 与 task completion 同事务提交
- Worker：grill-plan-runner（异步执行、settlement、recovery）
- 启动时 PENDING 任务恢复调度

**关键设计决策**：

- AI 只生成"问题计划提案"，绝不直接创建正式问题
- prompt 不持久化（仅 hash）
- 模型返回无效时任务标记 FAILED，不留半成品
- 会话版本变化时任务标记 STALE，丢弃结果

### M2-A2-FE：AI Question-Plan Renderer 🔍 In Review

**目标**：在 Renderer 中集成 AI 问题规划的触发和审核界面。

**状态**：PR #11 open，未合并。不将其视为主线事实。

**范围**：

- 触发 AI 问题规划任务
- 显示规划任务状态
- Proposal 审核（接受/拒绝）
- 接受后批量创建正式问题

### PlotPilot Sidecar Foundation ✅

**目标**：建立 PlotPilot 外部 sidecar 的适配器基础设施。

**范围**：

- PlotPilotAdapter：HTTP 客户端（health、generateChapter、hostedWrite）
- SSE 流式事件处理与取消
- Sidecar 生命周期管理（spawn、health poll、graceful stop）
- 环境变量 allowlist、日志清洗
- 错误分类（PLOTPILOT_UNAVAILABLE、PLOTPILOT_TIMEOUT、PLOTPILOT_ABORTED 等）

**关键设计决策**：

- PlotPilot 是可替换的外部 sidecar adapter，不共享应用 SQLite 写权限
- 产品接入推迟到创作契约和稿件版本建立之后
- 当前仅 foundation，无 Worker RPC 或产品 UI

## M1-C：创作契约（当前焦点）

**目标**：完成从 Grill 结果到权威创作规格的纵向切片。

**流程**：

```
Grill answers/proposals
→ CreationContractProposal（AI 生成）
→ 用户显式审核
→ CreationContractVersion（不可变权威版本）
→ 字段锁定
→ 后续大纲与稿件版本消费
```

**核心约束**：

- AI 输出始终是 proposal，用户显式接受才创建权威版本
- 已锁定字段不得被 AI proposal 静默覆盖
- 所有 mutation 使用 expectedVersion
- Renderer 不组装持久化对象，后端返回值是事实来源

详见 `docs/architecture/creation-contract-design.md`。

## M2：正文编辑与版本

**目标**：实现正文编辑和版本管理。

**范围**：

- 富文本编辑器
- 版本历史
- 回滚功能
- 用户文字保护

**验收标准**：

- 可以编辑正文
- 版本历史可查看
- 可以回滚到历史版本

## M3：规划和正文生成

**目标**：实现 AI 辅助的规划和正文生成。

**范围**：

- 章节规划生成
- 样稿生成
- 正文生成
- 模型配置

**验收标准**：

- 可以生成章节规划
- 可以生成样稿和正文
- 模型配置可用

## M4：状态与连续性

**目标**：实现状态管理和上下文连续性。

**范围**：

- 项目状态机
- 任务状态管理
- 上下文压缩
- 状态持久化

**验收标准**：

- 状态转换正确
- 任务管理可用
- 上下文连续性保持

## M5：审稿和定点修复

**目标**：实现审稿和定点修复流程。

**范围**：

- AI 自动审稿
- 用户手动审稿
- 定点修复
- 审稿历史

**验收标准**：

- 审稿流程可用
- 可以定点修复
- 审稿历史可追溯

## M6：研究、上下文和成本

**目标**：实现资料研究和成本优化。

**范围**：

- 原作资料研究
- 人物资料研究
- Token 统计
- 费用估算

**验收标准**：

- 资料研究可用
- Token 统计准确
- 费用估算合理

## M7：完整 V1 功能

**目标**：完成所有 V1 功能。

**范围**：

- 完善所有功能
- 多格式导出
- 项目备份
- 性能优化

**验收标准**：

- 所有功能可用
- 导出正确
- 备份恢复可用

## M8：真实短篇质量验收

**目标**：使用真实场景验收短篇创作质量。

**范围**：

- 真实短篇创作
- 质量评估
- 用户体验优化
- Bug 修复

**验收标准**：

- 完成一篇高质量中文短篇
- 用户体验流畅
- 无严重 Bug
