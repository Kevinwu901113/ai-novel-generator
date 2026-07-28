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
- 测试：120 个测试全部通过

**未实现**：Grill-me、AI、创作契约、正文编辑器、任务系统。

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
- 测试：232 个测试全部通过

**关键设计决策**：

- 固定 MiMo V2.5 Pro，Base URL 和 Model 只读
- API Key 存 macOS Keychain（service: `com.ai-novel-generator.provider.mimo-token-plan-cn`）
- app.sqlite 只保存非敏感 provider profile
- 不安装 Anthropic SDK，使用 Node 24 内置 fetch
- 不复用 Claude Code Keychain

**未实现**：多提供商切换、自定义端点、Grill-me、创作契约、任务系统。

### M1-B2：持久化任务与模型调用基础设施

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
- 测试：365 个测试全部通过

**关键设计决策**：

- 任务和调用记录在 project.sqlite（随项目数据）
- prompt 不持久化，只保存 SHA-256 hash
- CAS claim 防止并发执行
- token 统计时 null 按 0 处理，但不改写数据库
- RUNNING 任务在启动时恢复为 FAILED（TASK_INTERRUPTED）
- 当前不支持自动重试和队列自动调度
- 当前只支持 MODEL_INVOCATION_TEST 任务类型

**未实现**：Grill-me、创作契约、大纲、人物、世界观、正文生成、多 Agent 编排、流式 UI、取消按钮、重试 UI、多模态、搜索、导入导出。

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

### M2-A1.5：Grill-me 桌面工作台

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
- 61 个新增测试
- 文档更新

**关键设计决策**：

- 开发工作台，非最终产品 UI
- 全部通过 preload 暴露的 DesktopAPI，不直接访问 SQLite
- 所有 mutation 携带 expectedVersion
- 版本冲突：显示提示 + 自动刷新，不自动重试
- 不引入状态管理库，使用 React hooks
- 不修改 domain 规则、数据库 schema、task engine

**未实现**：AI 问题规划、创作契约、正式视觉设计、自动问题生成。

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
