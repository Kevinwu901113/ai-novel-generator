# B13 — Electron 删除与收口（2026-08-17）

> WebUI 迁移三批次之三（B11 server / B12 前端 / **B13 删除收口**），总纲 `decision-log.md`
> D11。上游：B12（Web 形态端到端可用，含真机验收）。本批次后仓库不再含任何 Electron
> 运行时代码与依赖。

## 1. 删除清单（全部落地）

| 项                                                | 说明                                                                                                                                                                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/` 整目录                            | main/preload/scripts/tsconfig×3/vite.config/.npmignore/package.json 及 4 个测试（grill-ipc / smoke-test-isolation / worker-client / ipc-channel-parity——HTTP 面的等价守卫已由 B11 的 rpc-command-parity 与 server 集成测试接替） |
| 根 `index.js`                                     | 僵尸 preload 编译残留（曾被 electron-packager 收进包）                                                                                                                                                                           |
| `apps/worker/scripts/bundle.mjs` + esbuild devDep | asar 专用单文件 bundle；worker build 收缩为纯 tsc                                                                                                                                                                                |
| worker parentPort 通信段                          | `sendToParent`/`handleMessage`/`shutdown`/启动守卫/`ReadyMessage`/`declare const process` hack（销 TD-002）；worker 现为纯库                                                                                                     |
| contracts `IPC_CHANNELS`                          | 79 条 `ipc:*` 常量；命令面唯一来源改为 `RPC_COMMANDS`（contract-api.test 的频道断言同步改写为命令断言）                                                                                                                          |
| `pnpm-workspace.yaml` electron 白名单             | esbuild 保留（仍是 vite 传递依赖）；`pnpm-lock.yaml` 重锁后仅剩 `electron-to-chromium`（browserslist 数据包，与 Electron 运行时无关）                                                                                            |
| CI `macos-package` job                            | 已于 B12 随打包链路不可构建先行移除（web 冒烟接替）；本批确认无 ELECTRON_MIRROR 残留                                                                                                                                             |

grep 收口：`ipcRenderer|contextBridge|parentPort|electron-packager|from 'electron'` 在
apps/、packages/ 源码中清零；仅存的 "Electron" 字样是历史解释性注释（错误码编码层的
由来、worker 库化说明）与既往批次设计文档（日期化历史记录，不改写）。

## 2. 文档收口

- `README.md` / `AGENTS.md`：技术栈、启动方式、安全模型改述为 Web 形态。
- `docs/architecture/system-overview.md` / `module-boundaries.md`：进程模型重画
  （浏览器 → apps/server → worker 库 → packages）；新增 apps/server（只做传输/认证/托管，
  禁业务逻辑）与 apps/web（只依赖 contracts）边界条目。
- `docs/development/current-project-state.md`：版本 +1，能力矩阵证据路径批量替换。
- `docs/development/live-run-guide.md`：启动方式改写。
- `decision-log.md`：D11；`tech-debt.md`：销 TD-001/002/004、改写 TD-005、
  新增 TD-034（明文 HTTP）/TD-035（移动端响应式）/TD-036（错误码编码层遗留）。

## 3. 验收

- `pnpm check` 全绿；lock 无 electron 包；CI 仅 ubuntu（quality + Web smoke）。
- 三个 app：server（传输）/ web（前端）/ writing-experiment-runner（GE-9 CLI，未受影响）。
- 产品 E2E（apps/worker/src/product-e2e.integration.test.ts）全程未动、全程绿。
