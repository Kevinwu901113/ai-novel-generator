# AI 小说创作代理

中文优先、本地优先、BYOK 的桌面 AI 小说创作代理，主要面向成人向同人网文创作。

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
│   ├── domain/           # 纯 TypeScript 领域模型
│   ├── application/      # 应用用例
│   ├── contracts/        # IPC 类型定义
│   ├── database/         # SQLite 持久化
│   ├── model-gateway/    # 多模型网关
│   ├── task-engine/      # 任务引擎
│   ├── context-engine/   # 上下文管理
│   ├── research-engine/  # 资料研究
│   ├── review-engine/    # 审稿引擎
│   ├── editor-schema/    # 编辑器结构
│   ├── import-export/    # 导入导出
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

## 许可证

私有项目
