# AI 小说创作代理

中文优先、本地优先、BYOK 的 AI 小说创作代理：服务跑在自己的 Mac 上，浏览器访问，数据与
API Key 不离开本机，主要面向成人向同人网文创作。

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
│   ├── application/      # 应用用例（含 GE-1 GraphRunService）
│   ├── contracts/        # IPC 类型定义（DesktopAPI）
│   ├── database/         # SQLite 持久化（migration v1–v13）
│   ├── model-gateway/    # 模型网关（多 provider：invokeModel / testConnection）
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
| `pnpm dev`          | 启动前端开发服务器（apps/web，Vite 5173）    |
| `pnpm dev:server`   | 启动 Web 服务端开发模式（apps/server，4870） |
| `pnpm build`        | 构建所有包                                   |
| `pnpm start`        | 生产模式启动 apps/server（托管前端构建产物） |
| `pnpm lint`         | ESLint 检查                                  |
| `pnpm typecheck`    | TypeScript 类型检查                          |
| `pnpm test`         | 运行测试                                     |
| `pnpm format`       | 格式化代码                                   |
| `pnpm format:check` | 检查格式                                     |
| `pnpm check`        | 完整检查（格式 + lint + 类型 + 测试 + 构建） |

### 运行与访问

- **本机访问**：默认绑定 `127.0.0.1:4870`，只有当前这台 Mac 能连；这是最安全的默认值。
- **局域网访问（手机/iPad 等多设备）**：设置 `AI_NOVEL_HOST=0.0.0.0` 后启动，服务日志会
  打印局域网地址（如 `http://192.168.x.x:4870/`），同一 Wi-Fi 下的其他设备可直接访问，
  仍需录入访问令牌。
- **无 TLS 风险披露**（详见 `docs/development/tech-debt.md` TD-034）：本服务不做 TLS，
  局域网访问是明文 HTTP，同一网络内的其他设备理论上可嗅探 token 与稿件内容。缓解建议：
  - 只在可信的家庭 Wi-Fi 下放开 `0.0.0.0`，不可信网络（咖啡馆、公司网络）不要放开；
  - Provider API Key 的录入建议在本机 `127.0.0.1` 完成，不要在局域网设备上录入；
  - 需要在可信网络之外访问（例如真正的外网），用 Tailscale 等零信任内网工具组网，
    不要直接把 `0.0.0.0` 暴露给公网。
- **Keychain 运行须知**：`packages/secret-store` 通过 `/usr/bin/security` 读写 macOS
  Keychain，这要求服务进程运行在一个已登录的 GUI 会话的终端里（例如 Terminal.app、
  iTerm）。如果改用 `launchd` 常驻或通过 `ssh` 远程启动，可能会遇到 Keychain 锁定或
  无法弹出授权对话框；这类场景暂无官方方案，建议仍在本机终端里手动启动服务。

## 安全模型

- **同源 + CSP**：apps/web 与 apps/server 同源（生产模式由 server 直接托管构建产物），
  server 下发 CSP 等安全响应头；开发模式下 Vite 单独走 `/api` 代理到 4870。
- **访问令牌 + Host 白名单**：所有 `/api/rpc` 请求需要 `Authorization: Bearer <token>`
  （localhost 不豁免），并校验 Host 头（限本机地址/局域网地址）防 DNS rebinding；
  token 首启生成，落盘 `${数据根}/auth-token`（权限 0600）。
- **API Key 仍在 macOS Keychain**：不入 SQLite、不进日志、不经浏览器往返回显。
- **浏览器端不碰文件系统/数据库**：apps/web 只经 `window.desktop`（HTTP 客户端）与
  `POST /api/rpc` 通信；Node.js、SQLite、Keychain 全部只存在于 apps/server 进程内。

## 模型配置

按 D6（2026-08-05，见 `docs/development/decision-log.md`）支持多 provider 配置，只做最小形态：

- 协议适配：`anthropic-messages` + `openai-chat`（覆盖 OpenAI 兼容端点）
- Provider Profile：`{ id, label, protocol, baseUrl, model, secretRef }`，非敏感配置存 app.sqlite
- 路由两层：全局默认 provider + 按任务类型可选覆盖
- API Key 存 macOS Keychain（每 profile 一个槽位），不入库、不进日志
- 不做负载均衡、自动 fallback、流式
- 原 MiMo V2.5 Pro 作为一个 `anthropic-messages` profile 继续可用

## 许可证

私有项目
