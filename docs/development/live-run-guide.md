# 真实模型实跑指南（2026-08-13）

> 到 GE-8 为止，所有 E2E 用的都是**脚本化模型输出**——验证的是接线与状态机。
> 真实 provider 下的行为（严格 JSON 遵循度、长正文是否撞输出上限、中文质量、耗时与
> 计费）只能实跑。本文给出两条路径。
>
> **Key 纪律**：API key 一律由你本人录入，不进仓库、不写配置文件；
> 命令行方式只从环境变量读，进程结束即消失。

## 路径 A：在应用里跑（真人视角，推荐先走这条）

安装依赖后二选一：

**开发模式（两个终端）**：

```bash
pnpm dev:server   # 终端 A：apps/server，默认监听 127.0.0.1:4870
```

```bash
pnpm dev          # 终端 B：apps/web，Vite 5173，/api 代理到 4870
```

浏览器打开 `http://127.0.0.1:5173/`。

**生产模式**：

```bash
pnpm build
pnpm start        # apps/server 托管 apps/web 构建产物，默认 127.0.0.1:4870
```

浏览器打开 `http://127.0.0.1:4870/`。

不管走哪条路径，服务启动日志都会打印**访问令牌**（形如
`[server] 访问令牌（页面首次打开时录入）：...`）；浏览器首次访问会被 TokenGate 拦下，
把这个令牌粘贴进去即可，同一浏览器之后无需重复录入（存在 `localStorage`）。

应用里的顺序：

1. 右栏 **模型提供商**：新增一个 profile（协议二选一——`openai-chat` 覆盖 DeepSeek /
   OpenAI 兼容端点，`anthropic-messages` 覆盖 Claude 兼容端点），填 Base URL、模型名，
   录入 API Key（存 macOS Keychain），点"测试连接"确认通；
2. 右栏 **联网搜索**（可选）：录入 Tavily key。不录入也能跑——纯幻想题材会被判
   `无需调研`，历史/现实题材则会停在调研阶段等 key；
3. 新建项目 → 填名称与初始想法 → 按界面走：访谈（追问/回答）→ 创作要求 → 调研 →
   蓝图（接受）→ 成稿·生成（选一章开始生成）→ 候选确认（采用 / 按意见改写 / 重写）→
   成稿·稿件（编辑正文、查看版本历史、导出 TXT/Markdown，经浏览器下载）。

## 路径 B：一条命令跑完整链（无界面，出诊断）

`apps/worker/src/product-live.gated.test.ts`：默认 skip，给齐环境变量才运行。
它会真实调用模型走完"想法 → 追问 → 蓝图 → 一章正文 → 采用 → 导出"，并打印每个任务的
耗时、状态、产物摘要，以及候选正文前 400 字与三个 Critic 的判定。

```bash
MODEL_LIVE=1 MODEL_BASE_URL=https://api.deepseek.com MODEL_NAME=deepseek-chat MODEL_PROTOCOL=openai-chat MODEL_API_KEY=sk-xxx pnpm exec vitest run apps/worker/src/product-live.gated.test.ts
```

想连调研一起跑，再加 `TAVILY_API_KEY=tvly-xxx`（题材会自动换成历史类以触发调研）。

`MODEL_PROTOCOL` 取 `openai-chat` 或 `anthropic-messages`；超时上限 30 分钟。

## 实跑时重点看什么

| 关注点         | 看哪里                                 | 已知风险                                                                  |
| -------------- | -------------------------------------- | ------------------------------------------------------------------------- |
| 严格 JSON 遵循 | 诊断里 `MODEL_RESPONSE_INVALID` 错误码 | 弱指令遵循的模型可能加代码围栏或解释文字，会被严格解析判失败              |
| 正文长度       | 候选正文去空白 Unicode 字符数          | 单段仍有 8192 token 上限；长章节按约 3200 字切片，逐段检查截断            |
| 审查可用性     | 三个 Critic 的 verdict 与问题清单      | 全 pass 说明 Critic 没起作用；全 needs_rewrite 会烧完改写预算             |
| 中文质量       | 打印的正文前 400 字                    | 质量基线里 AI 味 2.67 / 语言自然度 3.33 是已知最差项                      |
| 计费与耗时     | 每个任务的 ms + provider 账单          | 普通章 = 1 plan + 1 draft + 3 critic；长章的 draft/rewrite 为多次内部调用 |

当前门禁还会断言：3000 字目标的最终正文必须在 2700–3300 字之间，且不命中确定性中文质量门。
单章 15000 字的多调用与单候选语义由 `chapter-e2e.integration.test.ts` 用真实 SQLite 覆盖；付费真实模型
长章仍需按 `docs/development/ai-writing-quality.md` 的 A/B 方案单独实跑。

实跑发现的问题按老规矩登记到 `tech-debt.md`，能当场修的随批次修。
