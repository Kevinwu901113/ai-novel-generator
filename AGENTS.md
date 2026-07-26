# 开发代理规则

## 产品定位

中文优先、本地优先、BYOK 的桌面 AI 小说创作代理，面向成人向同人网文创作。

## 当前技术栈

- Electron + React + TypeScript + Vite
- Node.js 24 + pnpm 11 workspace
- SQLite（本地优先）
- Vitest + ESLint + Prettier
- @electron/packager（打包）

## 模块边界

- `packages/domain`：纯领域模型，无外部依赖
- `packages/application`：用例层，不依赖 UI
- `packages/contracts`：IPC 类型，所有进程共享
- `apps/desktop`：Electron 应用（main/preload/renderer）
- 其他 packages：独立功能模块

## 安全规则

- Electron 必须 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`
- Renderer 不得直接访问 Node.js、数据库、文件系统、API Key
- Preload 只暴露最小 API，不暴露 `ipcRenderer`
- API Key 不进入项目备份

## 常用命令

```bash
pnpm dev          # 开发
pnpm build        # 构建
pnpm check        # 完整检查
pnpm test         # 测试
pnpm lint         # Lint
pnpm typecheck    # 类型检查
```

## 禁止事项

- 不使用 `any` 类型掩盖问题
- 不删除测试让检查通过
- 不关闭 ESLint 规则
- 不在 Renderer 中直接调用 Node.js API
- 不安装无直接用途的依赖

## 完成定义

- 代码通过 `pnpm check`
- 测试覆盖新功能
- 文档同步更新
- 无 TypeScript 错误
- 无 ESLint 警告

## 文档位置

- 产品需求：`docs/product/PRD.md`
- 架构文档：`docs/architecture/`
- 开发文档：`docs/development/`
