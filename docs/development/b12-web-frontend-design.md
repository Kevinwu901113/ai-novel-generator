# B12 — 前端迁移 apps/web 与 HTTP 客户端设计（2026-08-17）

> WebUI 迁移三批次之二（B11 server / **B12 前端** / B13 Electron 删除），总纲
> `decision-log.md` D11。上游：B11（apps/server + RPC_COMMANDS）。
> 本批结束时 Web 形态端到端可用；apps/desktop 收缩为待删空壳（B13 删除）。

## 1. 范围

- `git mv apps/desktop/src/renderer apps/web/src`（历史保留），React 组件 / hooks /
  App.css / accessibility / 19 个 .tsx 测试**零改动**迁移。
- 新增 `apps/web/src/desktop-client.ts`：`DesktopAPI` 的 HTTP 实现（`window.desktop`
  全局注入不变，95 个调用点与全部测试的 mock 方式零改动）。
- 新增 `apps/web/src/auth/TokenGate.tsx`：访问令牌录入门，包在 `<App/>` 外。
- 稿件导出改浏览器下载（原生保存对话框随 Electron 退役）。
- apps/server 接通静态托管；`smoke.mjs` 进 ubuntu CI（**macos-package job 本批移除**：
  desktop 的 renderer 迁出后打包链路已不可构建，按计划由 web 冒烟替代）。
- apps/desktop 收缩为 noop 空壳（build/typecheck noop + README 声明 B13 删除；
  main/preload 测试暂留作行为参照）。

## 2. 决策

### D-B12-1 保留 `window.desktop` 全局注入，不改显式 import

`main.tsx` 渲染前 `window.desktop = createDesktopClient()`。收益：renderer 95 个调用点、
19 个测试文件（自 mock `window.desktop`）、`renderer/types.ts` 声明全部零改动。
显式 import 方案改动面大且所有测试要重写 mock 方式，否决。

### D-B12-2 错误传播链与 Electron 路径字节级同构

原路径：main 抛 `Object.assign(new Error(encodeErrorCode(code, message)))` →
Electron IPC 序列化后 renderer 的 `safe-error.ts` 从 message 解码 code。
HTTP 客户端收到信封 `{error:{code,message}}` 后构造**同样编码规则**的 Error，
`safe-error.ts` 与全部错误码标签零改动继续工作。encodeErrorCode 本是为 IPC 丢
`.code` 属性打的补丁，HTTP 信封已结构化携带 code——清理这层双重编码登记为
TD-036（B13），本批不动，优先保证前端零改动。

### D-B12-3 token 客户端语义

- token 存 `localStorage['ai-novel.auth-token']`，每次请求时读（录入即生效）；
  随 `Authorization: Bearer` 发送（不走 cookie，免 CSRF）。
- HTTP 401 → 清 token + 派发 `ai-novel:auth-required` 事件 → TokenGate 回录入态。
- 网络失败：抛 `WORKER_UNAVAILABLE` 语义错误；**例外** `getDataServiceStatus()`
  返回 `{status:'disconnected'}`——复用 renderer 现成的 disconnected UI 分支
  （该状态在 in-process worker 下不再由服务端产生，语义转为「连不上服务端」）。

### D-B12-4 导出 = worker 渲染 + 浏览器下载

`ExportManuscriptResultDto` 重定义为 worker 的现有返回 `{fileName, content,
chapterCount}`（`saved`/`filePath` 属原生对话框语义，删除）。`useManuscript` 收到
结果后经 `download-file.ts`（Blob + `<a download>`，延迟 revoke 兼容 iOS Safari
异步读取）触发下载。「用户取消」分支消失——浏览器下载没有可靠的取消回执。

## 3. 工作流

- dev：终端 A `pnpm dev:server`（4870），终端 B `pnpm dev`（vite 5173，`/api` 代理）。
- 生产：`pnpm build && pnpm start`；server 静态托管 `apps/web/dist`
  （`AI_NOVEL_WEB_ROOT` 可覆盖）。
- vitest 的 react alias 从 apps/desktop 切到 apps/web；根 vitest include 模式不变，
  迁移后的 .tsx 测试自动被收进。

## 4. 测试与验收

- 先红后绿：ManuscriptPanel 导出断言（下载助手调用契约）/ desktop-client 单测
  （包装规则、Authorization 头、错误编码经 safe-error 还原、401 清 token、
  disconnected 回退）/ TokenGate 测试 / smoke.mjs。
- 既有 19 个 .tsx 测试零改动全绿（App 级可达性主防线）。
- `pnpm check` 全绿；ubuntu CI：quality + Web smoke。
- **真机验收**（负责人）：本机浏览器录 token 走全链（建项目→访谈→调研→蓝图→章节→
  导出下载）；`AI_NOVEL_HOST=0.0.0.0` 后 iPad/手机同 Wi-Fi 访问；**老数据**（数据根
  探测指向 `@ai-novel/desktop`，历史项目完整可开）；Mac + 移动端双端同开操作一轮
  （CAS 冲突路径兜底）。

## 5. 已知限制

- vite dev 环境无 CSP（React fast refresh 需要），生产 CSP 由 server header 下发。
- iPad Safari 的 Blob 下载交互（弹出下载面板）需真机确认；兜底方案 data URL。
- App.css 按桌面版设计，移动端响应式未系统审计（TD-035，B13 登记）。
