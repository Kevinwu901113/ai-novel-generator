# AI 小说创作代理

中文优先、本地优先、BYOK 的 AI 小说创作代理：服务跑在自己的 Mac 上，浏览器访问，数据与
API Key 不离开本机，支持从创意、研究、蓝图到章节生成的结构化创作流程，适用于同人及其他中文网文题材。

## 产品方向与路线

- 产品方向（最高权威）：[`PRODUCT_DIRECTION.md`](PRODUCT_DIRECTION.md)
- 产品 1.0 纵向切片规格：[`docs/product/idea-to-novel-v1.md`](docs/product/idea-to-novel-v1.md)
- **统一路线（GE-0..GE-9）**：[`docs/development/graph-engineering-roadmap.md`](docs/development/graph-engineering-roadmap.md)
- **当前状态（唯一状态文档）**：[`docs/development/current-project-state.md`](docs/development/current-project-state.md)
- 模块边界：[`docs/architecture/module-boundaries.md`](docs/architecture/module-boundaries.md)

流程权威是两张 Graph（[`packages/domain/src/idea-to-novel-graph.ts`](packages/domain/src/idea-to-novel-graph.ts)）：
IdeaToNovelProjectGraphV1 + ChapterGenerationGraphV1。

## 技术栈

- **服务端**：apps/server，hand-rolled `node:http`（零外部依赖，单一 `POST /api/rpc`
  端点 + 静态托管 apps/web 构建产物）+ Node.js 24；访问令牌认证
- **前端**：React 19 + TypeScript + Vite 7（apps/web，浏览器运行）
- **数据库**：SQLite（node:sqlite 内置模块，本地优先）
- **包管理**：pnpm 11 workspace（monorepo）
- **测试**：Vitest
- **代码质量**：ESLint + Prettier

## 快速开始

```bash
# 安装依赖
pnpm install

# 开发模式（两个终端）
pnpm dev:server   # 终端 A：apps/server，默认监听 127.0.0.1:4870
pnpm dev          # 终端 B：apps/web，Vite 5173，/api 代理到 4870

# 生产模式
pnpm build
pnpm start        # 启动 apps/server，托管 apps/web 构建产物，默认 127.0.0.1:4870

# 代码检查
pnpm check
```

浏览器打开对应地址后（dev 模式 `http://127.0.0.1:5173/`，生产模式
`http://127.0.0.1:4870/`），首次访问会要求录入**访问令牌**——令牌在服务启动日志里打印
（`[server] 访问令牌（页面首次打开时录入）：...`），也落在 `${数据根}/auth-token` 文件里，
录入后存浏览器 `localStorage`，同一浏览器无需重复录入。

## 项目结构

```
ai-novel-generator/
├── apps/
│   ├── server/            # Web 服务端：hand-rolled node:http，单一 POST /api/rpc 端点
│   │   └── src/           # 认证（token + Host 白名单）/ 数据根解析 / 静态托管 / CLI 入口
│   ├── web/               # 前端（浏览器运行）：React 组件 + desktop-client.ts（HTTP 版
│   │   └── src/           # window.desktop）+ TokenGate（访问令牌录入门）
│   ├── worker/            # @ai-novel/worker：dispatchCommand（81 命令）库，供 server 进程内直调
│   └── writing-experiment-runner/ # GE-9 质量实验 CLI（未受 WebUI 迁移影响）
├── packages/
│   ├── domain/           # 纯领域模型 + 两张权威 Graph（idea-to-novel-graph.ts）
