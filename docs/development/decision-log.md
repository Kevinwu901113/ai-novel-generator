# 决策日志

## 决策记录格式

```markdown
### [日期] 决策标题

**背景**：[描述决策背景]

**决策**：[描述决策内容]

**理由**：[描述决策理由]

**影响**：[描述决策影响]

**状态**：已确认 / 待确认 / 已废弃
```

---

## 2024-01 决策

### 2024-01-01 选择 Electron 作为桌面框架

**背景**：需要选择桌面应用框架。

**决策**：使用 Electron。

**理由**：

- 跨平台支持
- Web 技术栈熟悉
- 生态成熟
- 社区活跃

**影响**：

- 包体积较大
- 内存占用较高
- 开发效率高

**状态**：已确认

### 2024-01-01 选择 pnpm 作为包管理器

**背景**：需要选择包管理器。

**决策**：使用 pnpm 11。

**理由**：

- 磁盘空间效率高
- 安装速度快
- 严格的依赖管理
- workspace 支持好

**影响**：

- 需要团队学习
- 部分旧工具不兼容
- 依赖管理更严格

**状态**：已确认

### 2024-01-01 选择 SQLite 作为本地数据库

**背景**：需要选择本地数据存储方案。

**决策**：使用 SQLite。

**理由**：

- 零配置
- 单文件存储
- 性能好
- 可靠性高

**影响**：

- 不支持并发写入
- 需要备份机制
- 数据可移植性好

**状态**：已确认

### 2024-01-01 选择 Vitest 作为测试框架

**背景**：需要选择测试框架。

**决策**：使用 Vitest。

**理由**：

- 与 Vite 集成好
- 速度快
- 兼容 Jest API
- TypeScript 支持好

**影响**：

- 生态不如 Jest 成熟
- 学习成本低
- 开发体验好

**状态**：已确认

### 2024-01-01 采用严格的安全模型

**背景**：需要确定 Electron 安全配置。

**决策**：

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`

**理由**：

- 安全性优先
- 符合最佳实践
- 防止恶意代码

**影响**：

- 开发复杂度增加
- 需要 preload 脚本
- IPC 通信更安全

**状态**：已确认

### 2024-01-01 采用 monorepo 结构

**背景**：需要确定项目结构。

**决策**：使用 pnpm workspace 的 monorepo。

**理由**：

- 代码共享方便
- 依赖管理统一
- 构建流程一致
- 版本管理简单

**影响**：

- 需要 workspace 配置
- 包之间依赖关系清晰
- 构建顺序需要管理

**状态**：已确认

### 2024-01-01 采用分层架构

**背景**：需要确定代码组织方式。

**决策**：采用 UI → 应用 → 领域 → 基础设施的分层架构。

**理由**：

- 职责分离清晰
- 可测试性好
- 可维护性高
- 依赖关系明确

**影响**：

- 需要定义清晰的接口
- 跨层调用需要通过接口
- 初期开发成本略高

**状态**：已确认

---

## 2026-07 决策

### 2026-07-26 升级 Electron 到 43.2.0

**背景**：M1-A 需要 node:sqlite 支持和 Utility Process API。

**决策**：从 Electron 36.9.5 升级到 43.2.0。

**理由**：

- node:sqlite 在 Electron 43 中可用
- Utility Process API 稳定
- 无影响现有安全模型的 breaking changes

**影响**：

- 需要手动下载 Electron 二进制（Electron 42+ 动态下载）
- 包大小不变
- 安全配置不变

**状态**：已确认

### 2026-07-26 使用 node:sqlite 作为数据库驱动

**背景**：需要选择 SQLite 驱动方案。

**决策**：使用 Node.js 内置的 node:sqlite（DatabaseSync），不安装 better-sqlite3 或其他第三方驱动。

**理由**：

- 避免 Electron 原生模块重编译问题
- 避免打包时的 node-gyp 问题
- 内置模块无需额外依赖
- 同步 API 适合数据库操作

**影响**：

- 需要封装为可替换适配器
- 只能在 Utility Process 中使用
- 未来可替换为其他驱动

**状态**：已确认

### 2026-07-26 project.sqlite 是项目正式数据来源

**背景**：需要确定 app.sqlite 和 project.sqlite 的数据所有权。

**决策**：project.sqlite 是单个项目的正式数据来源，app.sqlite 仅是应用级索引。

**理由**：

- 项目数据应该独立于应用
- 便于项目备份和迁移
- 避免索引和实际数据不一致时的歧义

**影响**：

- 打开项目时从 project.sqlite 读取正式元数据
- app.sqlite 的 last_opened_at 是辅助信息
- 两者差异时以 project.sqlite 为准

**状态**：已确认

### 2026-07-26 Utility Process 是数据库唯一写入者

**背景**：需要确定数据库访问模型。

**决策**：所有数据库写入操作必须通过 Utility Process。

**理由**：

- 同步 SQLite 调用不能阻塞 Renderer
- 集中写入便于管理
- 安全隔离

**影响**：

- Main Process 通过 RPC 与 Utility Process 通信
- Renderer 不知道数据库路径
- 需要实现 RPC 协议和错误处理

**状态**：已确认

### 2026-07-27 API Key 存储在 macOS Keychain

**背景**：需要安全存储用户的 API Key。

**决策**：使用 macOS Keychain 存储 API Key，通过 `/usr/bin/security` 命令交互。

**理由**：

- macOS 原生安全存储，加密保护
- 不需要额外依赖
- 应用专属 namespace 避免冲突
- stdin 写入避免进程列表泄露

**影响**：

- 需要实现 SecretStore 接口和 macOS 实现
- Windows/Linux 尚未实现
- 测试使用 fake SecretStore，不访问真实 Keychain

**状态**：已确认

### 2026-07-27 固定 MiMo V2.5 Pro 作为唯一提供商

**背景**：M1-B1 需要配置模型提供商。

**决策**：当前阶段固定使用 MiMo V2.5 Pro，Base URL 和 Model 只读。

**理由**：

- 当前开发和验收固定使用 MiMo V2.5 Pro
- 避免任意 URL 带来的 SSRF 和配置复杂度
- 多提供商和自定义端点以后再实现

**影响**：

- UI 不允许用户修改 Base URL 和 Model
- provider_profiles 表中只有一条固定记录
- 未来多提供商需要扩展

**状态**：已确认

### 2026-07-27 不安装 Anthropic SDK

**背景**：需要与 Anthropic-compatible API 通信。

**决策**：不安装 Anthropic SDK，使用 Node 24 内置 fetch。

**理由**：

- 减少依赖
- 连接测试只需要最小请求
- 避免 SDK 版本锁定

**影响**：

- 需要手动构造请求和验证响应
- 错误映射需要自行实现
- 未来完整调用可能需要更完善的实现

**状态**：已确认

### 2026-07-27 provider_profiles 在 app.sqlite

**背景**：需要存储提供商非敏感配置。

**决策**：provider_profiles 表放在 app.sqlite，不在 project.sqlite。

**理由**：

- 提供商配置是应用级配置，不是项目级
- 避免每个项目重复存储
- API Key 不进入任何 SQLite 数据库

**影响**：

- app.sqlite 新增 migration 3
- provider_profiles 只存储非敏感信息
- API Key 通过 Keychain 的 service/account 引用

**状态**：已确认

---

## 待确认决策

[待确认的决策记录]

---

## 已废弃决策

[已废弃的决策记录]
