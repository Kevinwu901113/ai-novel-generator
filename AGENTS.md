# 开发代理规则

## 产品定位

中文优先、本地优先、BYOK 的桌面 AI 小说创作代理，面向成人向同人网文创作。

## 当前技术栈

- Electron 43.2.0 + React + TypeScript + Vite
- Node.js 24 + pnpm 11 workspace
- SQLite（node:sqlite 内置模块，本地优先）
- Vitest + ESLint + Prettier
- @electron/packager（打包）

## 数据库架构

- `app.sqlite`：应用级项目索引和提供商配置（`<userData>/app.sqlite`）
- `project.sqlite`：单个项目正式数据（`<userData>/projects/<id>/project.sqlite`）
- node:sqlite 封装在 `packages/database`，领域层和应用层不直接导入
- Utility Process 是数据库唯一写入者
- 所有时间使用 UTC ISO 8601

## 模型配置

按 D6（2026-08-05，见 `docs/development/decision-log.md`）支持多 provider 配置，只做最小形态：

- 协议适配层：`anthropic-messages` + `openai-chat`（覆盖 OpenAI 兼容端点）
- Provider Profile：`{ id, label, protocol, baseUrl, model, secretRef }`，持久化于 app.sqlite
- 现有 MiMo V2.5 Pro 作为一个 `anthropic-messages` profile 继续可用
- 路由只有两层：全局默认 provider + 按任务类型可选覆盖
- 不做负载均衡、自动 fallback、流式、复杂路由 DAG
- API Key 存 macOS Keychain，每 profile 一个 key 槽位
- app.sqlite provider_profiles 只存非敏感配置（Key 不入库、不进项目备份）

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
