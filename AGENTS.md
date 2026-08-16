# 开发代理规则

## 产品定位

中文优先、本地优先、BYOK 的 AI 小说创作代理：服务跑在自己的 Mac 上，浏览器访问，面向
成人向同人网文创作。

## 当前技术栈

- apps/server：hand-rolled `node:http`（零外部依赖，单一 `POST /api/rpc` 端点 + 静态托管）
- apps/web：React + TypeScript + Vite（浏览器运行）
- Node.js 24 + pnpm 11 workspace
- SQLite（node:sqlite 内置模块，本地优先）
- Vitest + ESLint + Prettier
- 访问令牌 + Host 白名单认证（局域网访问经 `AI_NOVEL_HOST=0.0.0.0` 显式放开）

## 数据库架构

- `app.sqlite`：应用级项目索引和提供商配置（`<数据根>/app.sqlite`）
- `project.sqlite`：单个项目正式数据（`<数据根>/projects/<id>/project.sqlite`）
- node:sqlite 封装在 `packages/database`，领域层和应用层不直接导入
- 服务进程（`@ai-novel/worker` 库，由 apps/server 进程内直调）是数据库唯一写入者
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
- `packages/contracts`：RPC 类型（RPC_COMMANDS / RPC_COMMAND_VALIDATORS / SERVER_COMMANDS），
  server 与 web 共享
- `apps/server`：Web 服务端（hand-rolled node:http），只做传输/认证/托管
- `apps/web`：前端（浏览器运行）
- `apps/worker`：`@ai-novel/worker` 库，`dispatchCommand`/`initialize` 供 server 进程内直调
- 其他 packages：独立功能模块

## 安全规则

- apps/web 只依赖 `@ai-novel/contracts`，只经 `window.desktop`（HTTP 客户端）与
  `POST /api/rpc` 通信；不得直接访问 Node.js、数据库、文件系统、API Key
- apps/server 只做传输/认证/静态托管/按 command 校验，禁止业务逻辑；业务命令一律经
  `dispatchCommand` 转发
- 所有 `/api/rpc` 请求需要 `Authorization: Bearer <token>`（localhost 不豁免）+ Host 白名单
- API Key 不进入项目备份，仍存 macOS Keychain

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
- 不在 apps/web 中直接调用 Node.js API
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
