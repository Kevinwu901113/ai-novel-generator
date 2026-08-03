# AI 小说创作代理

中文优先、本地优先、BYOK 的桌面 AI 小说创作代理，主要面向成人向同人网文创作。

## 产品方向与路线

- 产品方向（最高权威）：[`PRODUCT_DIRECTION.md`](PRODUCT_DIRECTION.md)
- 产品 1.0 纵向切片规格：[`docs/product/idea-to-novel-v1.md`](docs/product/idea-to-novel-v1.md)
- **统一路线（GE-0..GE-9）**：[`docs/development/graph-engineering-roadmap.md`](docs/development/graph-engineering-roadmap.md)
- **当前状态（唯一状态文档）**：[`docs/development/current-project-state.md`](docs/development/current-project-state.md)
- 模块边界：[`docs/architecture/module-boundaries.md`](docs/architecture/module-boundaries.md)

流程权威是两张 Graph（[`packages/domain/src/idea-to-novel-graph.ts`](packages/domain/src/idea-to-novel-graph.ts)）：
IdeaToNovelProjectGraphV1 + ChapterGenerationGraphV1。

## 技术栈

- **运行时**：Electron 43.2.0 + Node.js 24
- **前端**：React 19 + TypeScript + Vite 7
- **数据库**：SQLite（node:sqlite 内置模块，本地优先）
- **包管理**：pnpm 11 workspace（monorepo）
- **测试**：Vitest
- **代码质量**：ESLint + Prettier

## 快速开始

```bash
# 安装依赖
pnpm install

# 开发模式
pnpm dev

# 构建
pnpm build

# 代码检查
pnpm check
```

## 项目结构

```
ai-novel-generator/
├── apps/
│   ├── desktop/          # Electron 桌面应用
│   │   ├── src/
│   │   │   ├── main/     # 主进程
│   │   │   ├── preload/  # 预加载脚本
│   │   │   └── renderer/ # React 渲染进程
│   │   └── ...
│   └── worker/           # 独立 Worker
├── packages/
│   ├── domain/           # 纯领域模型 + 两张权威 Graph（idea-to-novel-graph.ts）
│   ├── application/      # 应用用例（含 GE-1 GraphRunService）
│   ├── contracts/        # IPC 类型定义（DesktopAPI）
│   ├── database/         # SQLite 持久化（migration v1–v8）
│   ├── model-gateway/    # 模型网关（invokeModel / testConnection）
│   ├── task-engine/      # 持久化任务引擎（执行器底座）
│   ├── secret-store/     # macOS Keychain
│   ├── writing-evaluation/# 离线确定性评测
│   ├── plotpilot-adapter/# 可选外部 sidecar adapter
│   ├── context-engine/   # stub → GE-9 派生层
│   ├── research-engine/  # stub → GE-4 Web Research
│   ├── review-engine/    # stub → GE-9 审稿
│   ├── editor-schema/    # stub → GE-7 编辑器结构
│   ├── import-export/    # stub → GE-7 TXT/Markdown 导出
│   └── testing/          # 测试工具
├── docs/
│   ├── product/          # 产品文档
│   ├── architecture/     # 架构文档
│   └── development/      # 开发文档
└── ...
```

## 可用命令

| 命令                | 说明                                         |
| ------------------- | -------------------------------------------- |
| `pnpm dev`          | 启动开发服务器                               |
| `pnpm build`        | 构建所有包                                   |
| `pnpm package`      | 构建并打包 Electron 应用（macOS arm64）      |
| `pnpm lint`         | ESLint 检查                                  |
| `pnpm typecheck`    | TypeScript 类型检查                          |
| `pnpm test`         | 运行测试                                     |
| `pnpm format`       | 格式化代码                                   |
| `pnpm format:check` | 检查格式                                     |
| `pnpm check`        | 完整检查（格式 + lint + 类型 + 测试 + 构建） |

### 打包说明

`pnpm package` 使用 `@electron/packager` 生成未签名的本地 `.app` 产物，输出到 `apps/desktop/out/` 目录。

**限制**：

- 仅支持 macOS arm64（当前开发环境）
- 未配置 Apple 签名、Notarization、自动更新或发布
- 产物仅供本地测试，不可直接分发

## 安全模型

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- Renderer 不直接访问 Node.js、数据库、文件系统或 API Key
- Preload 只暴露最小、显式、带类型的 API
- API Key 存储在 macOS Keychain（不进入 SQLite 或日志）

## 模型配置

当前固定使用 MiMo V2.5 Pro（Anthropic-compatible）：

- Base URL: `https://token-plan-cn.xiaomimimo.com/anthropic`
- Model: `mimo-v2.5-pro`

Base URL 和 Model 为只读配置，不支持用户修改。

## 许可证

私有项目
