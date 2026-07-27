# 技术决策记录

## 决策 1：AI 输出只是提案

**决策**：AI 生成的所有内容都只是提案，用户拥有最终决定权。

**理由**：

- 用户是创作者，AI 是辅助工具
- 避免 AI 错误导致不可逆的损失
- 保持用户对创作过程的控制

**影响**：

- 所有 AI 生成内容都需要用户确认
- 用户文字默认受保护
- 支持版本回滚

## 决策 2：UI 不直接访问基础设施

**决策**：Renderer 进程不直接访问数据库、文件系统等基础设施。

**理由**：

- 安全性：防止恶意代码访问敏感数据
- 可维护性：清晰的职责分离
- 可测试性：UI 和基础设施可独立测试

**影响**：

- 所有基础设施访问通过 Main Process
- 通过 IPC 通信
- 需要定义清晰的 API 接口

## 决策 3：项目状态和任务状态分离

**决策**：项目状态（整体进度）和任务状态（具体工作项）独立管理。

**理由**：

- 关注点分离：项目管理和任务管理是不同关注点
- 灵活性：任务可以独立于项目状态变化
- 可追溯性：清晰的状态变更历史

**影响**：

- 定义两套独立的状态机
- 通过 ChangeSet 关联状态变更
- UI 需要分别展示两种状态

## 决策 4：Grill-me 是横向能力

**决策**：Grill-me 不是独立阶段，而是贯穿整个创作流程的横向能力。

**理由**：

- 需求澄清可能在任何阶段发生
- 避免僵化的线性流程
- 提高用户体验

**影响**：

- Grill-me 可以在任何状态触发
- 需要维护上下文连续性
- 结果可能影响多个模块

## 决策 5：正文、契约、规划和状态需要版本化

**决策**：关键数据都需要版本化管理。

**理由**：

- 支持回滚到任意历史版本
- 追踪变更历史
- 避免数据丢失

**影响**：

- 需要版本存储机制
- 增加存储空间需求
- 需要版本比较和合并功能

## 决策 6：跨模块更新使用 ChangeSet

**决策**：所有跨模块的状态更新都通过 ChangeSet 进行。

**理由**：

- 原子性：确保数据一致性
- 可追溯性：记录所有变更
- 可撤销性：支持撤销操作

**影响**：

- 定义 ChangeSet 数据结构
- 所有跨模块操作需要封装为 ChangeSet
- 需要 ChangeSet 执行和回滚机制

## 决策 7：任务输入引用具体数据版本

**决策**：任务的输入数据引用具体的数据版本，而不是最新版本。

**理由**：

- 确定性：相同输入产生相同输出
- 可重现性：可以重现历史任务
- 避免并发问题

**影响**：

- 任务输入需要包含版本信息
- 需要版本查询机制
- 增加任务配置复杂度

## 决策 8：用户文字默认受保护

**决策**：用户手动编辑的文字默认受保护，AI 不得覆盖。

**理由**：

- 尊重用户创作
- 避免意外丢失用户内容
- 建立用户信任

**影响**：

- 需要区分用户文字和 AI 文字
- AI 修改需要明确标记
- 需要保护机制

## 决策 9：本地数据是项目正式来源

**决策**：本地存储的数据是项目的正式来源，不依赖云服务。

**理由**：

- 隐私保护：敏感内容不上传
- 离线可用：不依赖网络
- 数据主权：用户完全控制数据

**影响**：

- 使用 SQLite 本地存储
- 需要本地备份机制
- 云同步是可选功能

## 决策 10：API Key 不进入项目备份

**决策**：API Key 不包含在项目备份中。

**理由**：

- 安全性：避免泄露 API Key
- 灵活性：不同环境使用不同 Key
- 隔离性：项目数据和凭证分离

**影响**：

- API Key 单独存储
- 备份时排除 API Key
- 恢复时需要重新配置 Key

## 决策 11：使用 node:sqlite 作为数据库驱动

**决策**：使用 Node.js 内置的 node:sqlite（DatabaseSync），不安装第三方 SQLite 驱动。

**理由**：

- 避免 Electron 原生模块重编译和打包问题
- 内置模块无需额外依赖
- 同步 API 适合数据库操作
- 可封装为可替换适配器

**影响**：

- 只能在 Node.js 22+ 和 Electron 43+ 中使用
- 同步调用必须在 Utility Process 中运行
- 需要定义清晰的仓库接口以便未来替换

## 决策 12：project.sqlite 是项目正式数据来源

**决策**：project.sqlite 是单个项目的正式数据来源，app.sqlite 仅是应用级索引。

**理由**：

- 项目数据应独立于应用
- 便于项目备份和迁移
- 避免索引与实际数据不一致时的歧义

**影响**：

- 打开项目时从 project.sqlite 读取正式元数据
- app.sqlite 的 last_opened_at 是辅助信息
- 两者差异时以 project.sqlite 为准

## 决策 13：Utility Process 是数据库唯一写入者

**决策**：所有数据库写入操作必须通过 Electron Utility Process。

**理由**：

- 同步 SQLite 调用不能阻塞 Renderer
- 集中写入便于管理和监控
- 安全隔离：Renderer 不知道数据库路径

**影响**：

- Main Process 通过 RPC 与 Utility Process 通信
- 需要实现 RPC 协议和错误处理
- Utility Process 崩溃时需要优雅降级

## 决策 14：API Key 存储在 macOS Keychain

**决策**：使用 macOS Keychain 存储 API Key，通过 `/usr/bin/security` 命令交互。

**理由**：

- macOS 原生安全存储，加密保护
- 不需要额外依赖
- 应用专属 namespace 避免冲突

**影响**：

- 使用 `execFileSync` 调用 `/usr/bin/security`，不使用 shell
- `-w <value>` 方式传递密码（`-w` 无值时 stdin 不可靠）
- 密码短暂出现在进程列表中（macOS security 命令限制）
- Windows/Linux 尚未实现
- 测试使用 fake SecretStore，不访问真实 Keychain

## 决策 15：固定 MiMo V2.5 Pro 作为唯一提供商

**决策**：M1-B1 阶段固定使用 MiMo V2.5 Pro，Base URL 和 Model 只读。

**理由**：

- 当前开发和验收固定使用 MiMo V2.5 Pro
- 避免任意 URL 带来的 SSRF 和配置复杂度
- 多提供商和自定义端点以后再实现

**影响**：

- UI 不允许用户修改 Base URL 和 Model
- provider_profiles 表中只有一条固定记录
- 未来多提供商需要扩展

## 决策 16：Model Gateway 不使用 SDK

**决策**：不安装 Anthropic SDK，使用 Node 24 内置 fetch 实现 Anthropic-compatible 客户端。

**理由**：

- 减少依赖
- 连接测试只需要最小请求
- 避免 SDK 版本锁定

**影响**：

- 需要手动构造请求和验证响应
- 错误映射需要自行实现
- 未来完整调用可能需要更完善的实现

## 决策 17：provider_profiles 在 app.sqlite

**决策**：provider_profiles 表放在 app.sqlite，不在 project.sqlite。

**理由**：

- 提供商配置是应用级配置，不是项目级
- 避免每个项目重复存储
- API Key 不进入任何 SQLite 数据库

**影响**：

- app.sqlite 新增 migration 3
- provider_profiles 只存储非敏感信息（不含 API Key）
- API Key 通过 Keychain 的 service/account 引用
- 固定 profile 通过 INSERT OR IGNORE 初始化，不覆盖已有的测试状态

## 决策 18：任务和调用记录在 project.sqlite

**决策**：tasks 和 model_invocations 表放在 project.sqlite，随项目数据一起管理。

**理由**：

- 任务属于具体项目，不是应用级数据
- 项目备份时应包含任务历史
- 便于项目迁移和恢复

**影响**：

- project.sqlite 新增 migration 2
- tasks 和 model_invocations 通过 FOREIGN KEY 关联
- UNIQUE(task_id, attempt_number) 防止重复调用记录
- prompt 不持久化，只保存 SHA-256 hash

## 决策 19：prompt 不持久化

**决策**：prompt 不写入任何数据库、日志或测试快照。

**理由**：

- 安全性：prompt 可能包含敏感内容
- 隐私：用户创作内容不应被意外泄露
- 合规：避免不必要的数据保留

**影响**：

- prompt 只存在于调用栈内
- 数据库只保存 promptHash（SHA-256 hex）和 promptLength
- request_metadata_json 只包含安全元数据
- 错误消息不包含 prompt 内容

## 决策 20：CAS claim 防止并发执行

**决策**：任务领取使用 compare-and-set 模式。

**理由**：

- 防止多个 Worker 同时执行同一任务
- 不依赖进程内 mutex
- SQLite 是 source of truth

**影响**：

- `UPDATE tasks SET status = 'RUNNING' WHERE id = ? AND status = 'PENDING'`
- 受影响行数不是 1 时视为冲突
- 每次执行前从数据库重新读取任务状态

## 决策 21：token 统计语义

**决策**：null token 在统计时按 0 处理，但不改写数据库中的 null。

**理由**：

- provider 可能不返回 usage 信息
- 统计时需要数值聚合
- 保留 null 表示"未知"而非"0"

**影响**：

- `COALESCE(SUM(COALESCE(input_tokens, 0)), 0)` 聚合
- 数据库中 null 保持 null
- 总 token 在上游缺失时不自行推断（除非 input + output 都有值）

## 决策 22：任务恢复策略

**决策**：Worker 启动时将 RUNNING 任务恢复为 FAILED。

**理由**：

- 应用崩溃后数据库中可能遗留 RUNNING 状态
- 需要明确标记这些任务为中断
- 不自动重新执行（避免意外消耗配额）

**影响**：

- RUNNING task → FAILED (TASK_INTERRUPTED)
- RUNNING invocation → FAILED (INVOCATION_INTERRUPTED)
- 两者在同一事务中恢复
- 已恢复的记录不会被重复修改
- PENDING 任务保持 PENDING
