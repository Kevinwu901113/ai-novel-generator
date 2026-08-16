# B11 — Web 服务端（apps/server）与 worker 库化设计（2026-08-17）

> WebUI 迁移三批次（B11 server / B12 前端迁移 / B13 Electron 删除）之一，决策总纲见
> `decision-log.md` D11（桌面壳退役转 WebUI）。
> 本批次 **Electron 应用完全不动**：server 暗上线，桌面版行为零变化。
> 下游：B12（renderer 迁 `apps/web` + HTTP 版 `window.desktop`）、B13（删除 Electron）。

## 1. 范围与形态

```
浏览器（B12 起）
  │  POST /api/rpc  {command, payload} + Authorization: Bearer <token>
  ▼
apps/server（本批新建，hand-rolled node:http，零外部依赖）
  │  认证 / Host 白名单 / 按 command 校验 / 静态托管（B12 接通）/ 安全 header
  ▼  进程内直调
@ai-novel/worker  dispatchCommand()（81 command 原样）+ initialize()（启动恢复语义不变）
  ▼
packages/*        全部零改动（secret-store 继续 macOS Keychain）
```

- **worker 当库用，不 fork 子进程**：worker 已是「可 import 的库 + 尾部 parentPort
  守卫段」，本批只加两个 `export`（`dispatchCommand` / `initialize`）与 initialize 的
  重入幂等（重试前先 close 旧 appDb）。单用户没有进程隔离收益，进程内直调消除
  RPC 序列化与生命周期管理整层。
- **单 RPC endpoint，不做 81 条 REST**：worker 信封 `{command, payload}` 原样上 HTTP；
  新增 command 不需要动 server。业务错误一律 HTTP 200 + 信封（对齐既有 renderer 错误
  处理）；HTTP 状态码只表达传输层问题（401/403/404/405/413/400）。
- **hand-rolled node:http**：本仓库生产运行时外部依赖为零（node:sqlite / 手写校验器 /
  不用模型 SDK），传输需求只有一个 POST + 静态文件，不为此引入框架。将来要
  SSE/WebSocket 推送再评估（届时记 decision-log）。

## 2. 决策

### D-B11-1 校验层从 main 进程搬进 contracts，服务端强制执行

原架构中全部输入校验在 Electron main 的 82 个 `ipcMain.handle`（worker 各 handler 的
校验密度不均，**research 域 handler 内部零校验**）。HTTP 化后这层必须在 server 强制，
否则局域网上任何拿到 token 的客户端可以把未校验 payload 直达 application 层。

落地：contracts 新增 `RPC_COMMANDS`（81 command 常量表）+ `RPC_COMMAND_VALIDATORS`
（command → 校验函数 | null）。校验的是 **worker dispatch 收到的 payload**（main 组装后
形状）；无 payload 的命令显式声明 `null`，服务端要求 payload 为 undefined/null。
parity 测试钉死「每个 command 必须显式声明」，新增命令漏声明会红。

### D-B11-2 认证：文件 token + Bearer 头 + Host 白名单；localhost 不豁免

- 首启生成 32 字节随机 token（base64url）写 `${dataRoot}/auth-token`（0600），
  启动日志打印。不入 Keychain：它保护的是局域网访问面而非高价值秘密，文件形态对
  换宿主/上云友好。
- 校验走 `Authorization: Bearer`（不走 cookie，天然免 CSRF），SHA-256 摘要后
  `timingSafeEqual`。
- **localhost 不豁免**：豁免等于把攻击面交给「浏览器同源模型 + DNS rebinding」组合；
  统一要求 token，每浏览器只录一次。另做 Host 白名单（localhost/环回/*.local/本机地址）
  直接防 DNS rebinding。
- 默认绑定 `127.0.0.1:4870`；`AI_NOVEL_HOST=0.0.0.0` 显式放开局域网。**不做 TLS**，
  风险披露与缓解见 tech-debt TD-034（B13 登记）。静态资源不鉴权（应用壳 JS/HTML 属
  可接受披露；数据全部在 RPC 面之后）。

### D-B11-3 数据根解析：env 优先，探测老桌面版数据，只读原位绝不搬迁

顺序：`AI_NOVEL_DATA_ROOT` → Electron userData 双候选探测（dev 形态
`~/Library/Application Support/@ai-novel/desktop`、打包形态 `…/AI 小说创作代理`，按
`app.sqlite` 存在性判定，双双存在取 mtime 较新者并警告）→ 全新目录
（macOS `…/ai-novel`，其它平台 `~/.ai-novel`）。启动日志响亮打印探测结果。
数据根错配的表现是「项目全丢」，故绝不自动搬迁，宁可让用户显式设 env。
（负责人机器实测：dev 形态目录存在且含 app.sqlite + projects/，打包形态目录不存在。）

### D-B11-4 readiness 语义平移：三个 app.* 命令由 server 本地处理

原 main 本地 handler（`ipc:health-check` / `ipc:data-service-status` /
`ipc:data-service-retry`）平移为 `SERVER_COMMANDS`（`app.healthCheck` /
`app.dataServiceStatus` / `app.dataServiceRetry`），仍走同一个 `/api/rpc` 端点——全站
一条认证路径，不需要单独的 status 端点。语义：

- HTTP 监听即刻开始（status 可查），`initialize()`（含全部启动恢复）resolve 前为
  `starting`，业务命令一律 `WORKER_UNAVAILABLE` 信封；
- `app.dataServiceRetry` 非阻塞触发重新初始化并返回即时状态（renderer 随后轮询），
  与原 `retryWorker` 一致；initialize 已幂等（重入先 close 旧 appDb）；
- `disconnected` 状态在 in-process 下不再产生（contracts 类型与 UI 分支保留不删）。

## 3. 改动清单

| 文件                                         | 内容                                                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `apps/worker/src/index.ts`                   | export `dispatchCommand` / `initialize` / 信封类型；initialize 重入幂等                                          |
| `packages/contracts/src/index.ts`            | 新增 `RPC_COMMANDS` / `SERVER_COMMANDS` / `RpcValidator` / `RPC_COMMAND_VALIDATORS`（IPC_CHANNELS 暂留，B13 删） |
| `apps/server/src/data-root.ts`               | D-B11-3 数据根解析                                                                                               |
| `apps/server/src/auth.ts`                    | token 生成/校验、Host 白名单、本机地址枚举                                                                       |
| `apps/server/src/rpc.ts`                     | 信封处理：server 本地命令 + readiness 门 + 校验 + dispatch                                                       |
| `apps/server/src/http-server.ts`             | node:http 传输：路由/静态（含穿越防护）/安全 header/体积上限                                                     |
| `apps/server/src/app.ts`                     | `startServer()` 组装（普通 import 零副作用，供集成测试）                                                         |
| `apps/server/src/index.ts`                   | CLI 入口：数据根解析日志、访问指引、信号处理                                                                     |
| `apps/server/src/rpc-command-parity.test.ts` | worker case 标签 ↔ RPC_COMMANDS 双向 + validator 全覆盖守卫                                                      |
| `apps/server/src/server.integration.test.ts` | 真 http.Server + 真 initialize 的端到端（见 §4）                                                                 |

## 4. 测试与验收

- **parity 守卫**（先红后绿）：正则抽取 worker `dispatchCommand` 的 81 个 case 标签，
  与 `RPC_COMMANDS` 双向比对 + 锚点断言防解析器退化；`RPC_COMMAND_VALIDATORS` 键集 =
  command 全集；`SERVER_COMMANDS` 与 `RPC_COMMANDS` 无交集。
- **集成测试**（先红后绿，ubuntu 可跑，不触 Keychain）：临时数据根起真服务——
  401（无/错 token）/ 403（Host 伪造）/ healthCheck / starting→ready /
  project.create→list 真链路 / 未知命令 / 非法 payload / **research 域坏 payload 必须
  被挡** / 无 payload 命令拒绝多余 payload / 静态托管 header（CSP/nosniff/缓存策略）/
  路径穿越 404 / 初始化失败→WORKER_UNAVAILABLE→修复→retry→ready。
- 验收：`pnpm check` 全绿且桌面版行为零变化；本机 curl 手工走通一轮；数据根探测日志
  正确。

## 5. 已知限制（有意接受）

- **同步 SQLite 阻塞事件循环**：`DatabaseSync` + 启动恢复/大事务期间 HTTP 会顿一下；
  单用户形态可接受，多用户是另一个产品。
- **无 TLS**：局域网明文（B13 登记 TD-034）；仅静态壳不鉴权。
- **无推送**：沿用 renderer 轮询模型（后端本就零推送）；升级 SSE 属后续独立决策。
- **Keychain 依赖 GUI 会话**：launchd/ssh 常驻场景 `/usr/bin/security` 可能遇 keychain
  锁定；README 运行须知说明，不改代码。
