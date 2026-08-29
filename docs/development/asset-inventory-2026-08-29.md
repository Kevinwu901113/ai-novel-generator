# 项目资产清点（2026-08-29，大改造前置）

> 本文档是一次**静态清点快照**，不是状态文档。仓库状态权威仍是
> `docs/development/current-project-state.md`——但该文档当前已落后代码六个批次（见 F1），
> 这也正是本次清点的第一项结论。
>
> 清点基线：`192f55f`（`claude/project-asset-inventory-2ojuxw`，工作区 clean）
> 清点方式：静态统计（未执行 `pnpm install` / `pnpm test`，node_modules 未安装）；
> 行数与命中数均为直接统计所得。

---

## 0. 一句话结论

这不是一个需要抢救的仓库。完整纵向链路（想法 → 调研 → 蓝图 → 章节生成 → 稿件 → 导出）
在 main 上真实可跑，GE-0…GE-8 全部落地，测试行数与源码行数持平。
改造要面对的不是废墟，是一座**地基牢固、但台账已经跟不上工地**的建筑。

## 1. 计量盘

| 项                   | 值                           |
| -------------------- | ---------------------------- |
| workspace 包         | 19（apps ×4 + packages ×15） |
| 源码行（非测试）     | 75,244                       |
| 测试行 / 文件 / 用例 | 75,686 / 175 / 3,172         |
| RPC 命令             | 82                           |
| SQLite migration     | v23                          |
| Markdown 文档        | 55 篇 / 13,102 行            |
| `any`                | 0 处                         |
| `eslint-disable`     | 1 处                         |
| `TODO` / `FIXME`     | 1 处                         |

## 2. 能力资产：链路已经通到哪

| 阶段 | 能力       | 状态                |
| ---- | ---------- | ------------------- |
| GE-3 | 想法访谈   | ✅ wiring + 产品 UI |
| GE-4 | 网络调研   | ✅ Tavily 真实链路  |
| GE-5 | 故事蓝图   | ✅ accept 原子闭环  |
| GE-6 | 章节生成   | ✅ 六节点 executor  |
| GE-7 | 稿件与导出 | ✅ CAS + TXT/MD     |
| GE-8 | 端到端验收 | ✅ product-e2e      |

**未进入任何状态文档的六批**：

- **B18–B21**：阅读优先排版、设置独立页、读写分离、信息密度
- **B22**：故事图谱六表 + 抽取管线（migration v22）
- **B23**：三路 RRF 图检索接入 `loadContext`（migration v23，含嵌入通道与因果截断）

**尚未开工**：GE-9 质量增强、B24 故事圣经 UI、B25 图核验 Critic、B26 长序列 A/B。

## 3. 代码资产分布

处置列为本次清点的**建议**，不是既定决策。

- **地基** = 改造应当保留并依赖
- **改造** = 主要施工面
- **清理** = 要么填实要么删掉
- **旁路** = 不在主链路上

| 包                               | 文件 | 行     | 职责                                                                          | 处置 |
| -------------------------------- | ---- | ------ | ----------------------------------------------------------------------------- | ---- |
| `packages/domain`                | 26   | 13,933 | 纯领域 + 双权威 Graph（`idea-to-novel-graph.ts`）。文档 L3 层权威，不可随手动 | 地基 |
| `packages/database`              | 39   | 25,182 | node:sqlite，app + project 双库，migration v1–v23。仓库最重的单个包           | 地基 |
| `packages/application`           | 70   | 23,453 | 用例层：GraphRunService / NodeRunner / Settlement / ArtifactResolver          | 地基 |
| `apps/worker`                    | 61   | 22,693 | 进程内库：dispatchCommand 82 命令 + 全部节点 executor + 启动恢复              | 改造 |
| `apps/web`                       | 112  | 22,523 | React 19 + Vite 7 + Tailwind v4 + shadcn/ui；四阶段旅程 Region                | 改造 |
| `packages/task-engine`           | 25   | 13,646 | 持久化任务：章节四类 / 蓝图 / 调研 / spec 抽取 / 图谱抽取与检索               | 地基 |
| `packages/writing-evaluation`    | 35   | 9,722  | 离线确定性评测装置，GE-9 质量基线。当前不在生成链路上                         | 旁路 |
| `packages/contracts`             | 10   | 7,550  | RPC 面 + DTO，web 与 server 共享。`index.ts` 单文件 4,575 行                  | 改造 |
| `apps/writing-experiment-runner` | 29   | 5,087  | LIVE 门控写作实验 CLI，独立于 WebUI 迁移                                      | 旁路 |
| `packages/plotpilot-adapter`     | 5    | 2,303  | 可选外部 sidecar；明确"不进入关键路径"，四条 TD 全部 OPEN 或 DEFERRED         | 清理 |
| `packages/model-gateway`         | 5    | 1,804  | anthropic-messages + openai-chat 双协议，两层路由，B23 新增 embeddings 通道   | 地基 |
| `packages/research-engine`       | 11   | 1,537  | Tavily provider + SafeWebFetch（DNS 复校验 / 重定向重校验 / 字节上限）        | 地基 |
| `apps/server`                    | 8    | 999    | hand-rolled node:http，零外部依赖，单一 `POST /api/rpc` + 静态托管            | 地基 |
| `packages/secret-store`          | 2    | 320    | 经 `/usr/bin/security` 读写 macOS Keychain。宿主锁定在已登录 GUI 会话         | 地基 |
| `packages/import-export`         | 2    | 146    | TXT / Markdown 纯函数渲染                                                     | 地基 |
| `packages/context-engine`        | 1    | 8      | 占位常量。上下文压缩实际已散落在 task-engine 的 `loadContext` 里              | 清理 |
| `packages/editor-schema`         | 1    | 8      | 占位常量。编辑器结构实际在 apps/web 稿件工作区                                | 清理 |
| `packages/review-engine`         | 1    | 8      | 占位常量。审稿能力实际在章节 executor 的自查环节                              | 清理 |
| `packages/testing`               | 1    | 8      | 占位常量。3,172 个用例没有一个用到它                                          | 清理 |

> 文件数与行数均含测试。

## 4. 改造前必须先看的七件事

按"会不会让改造决策出错"排序，不是按修起来的难度。

### F1 — 状态文档已经落后代码六个批次

`docs/development/current-project-state.md` 自称"仓库唯一状态文档"，但停在版本 10 /
2026-08-17：基线写 `2814f8d`、migration 写 `v1–v19`、GE-9 写"待开始"。实际 main 已到
`192f55f`、`v23`，B18–B23 六批全部落地。

**先做这件事。** 任何以它为输入的改造规划都会漏掉故事图谱这一整层——六张表、抽取管线、
三路 RRF 检索。

### F2 — 分层倒置：数据层反向依赖用例层

- `packages/database`：10 处以上 `import ... from '@ai-novel/application'`（端口类型）
- `packages/secret-store`：依赖 application 只为一个 `SecretStore` 类型
- `packages/task-engine`：**值导入**（`resolveProviderForTask`、`ContractDataCorruptionError`）

AGENTS.md 声明的边界是"domain 无外部依赖、application 不依赖 UI"，但从未约束反向。

**建议**：把端口 / 接口类型下沉到 `domain` 或独立 `ports` 包。纯类型搬家，不改行为，
可全程保持绿灯——适合作为改造的第一刀。

### F3 — 四个巨型单文件是所有改动的必经之路

| 文件                                        | 行    | 角色                    |
| ------------------------------------------- | ----- | ----------------------- |
| `packages/contracts/src/index.ts`           | 4,575 | 契约面全集              |
| `packages/database/src/project-database.ts` | 2,439 | schema + migration 全集 |
| `apps/worker/src/index.ts`                  | 2,271 | 命令分发全集            |
| `packages/domain/src/creation-contract.ts`  | 1,888 | CreationSpec 领域模型   |

前三个意味着：任何新能力都要同时改这三处。

**建议**：contracts 按命名空间拆（grill / contract / manuscript / research / chapter /
graph / storyGraph），migration 按版本拆文件，dispatch 按域拆表。同样不改行为。

### F4 — 代码词汇与产品词汇分家

产品说 **Idea Intake** 和 **CreationSpec**，代码写 `grill` 和 `creation-contract`：
共 40 个文件、31,924 行，占 82 个 RPC 命令中的 33 个（grill 23 + contract 10）。

好消息是这确实只剩改名——PRODUCT_DIRECTION 要求废弃的**审批门禁与字段锁已经删干净**
（全仓 `fieldLock` / `approval` 零命中），底座被 intake 与 spec 抽取正常复用。

**建议**：单独一批做机械改名（含表名 migration），别和行为改造混在一起。

### F5 — 长任务系统缺两块地基：重试与调度

TD-007（无自动重试）、TD-008（无任务队列自动调度）都从项目早期 OPEN 到现在，当前靠
worker 内的 runner 泵加启动恢复兜底。链路越长（GE-9、B26 长序列 A/B），这两块的缺失
越致命。

**建议**：如果改造目标包含"更长的自动生成链路"，这是前置项而不是优化项。

### F6 — 技术债台账 36 条，约 20 条 OPEN

值得单独点名的四条：

- **TD-005**：Keychain 把服务进程锁死在 macOS 已登录 GUI 会话（launchd 或 ssh 启动会出问题）
- **TD-034**：局域网访问是明文 HTTP，无 TLS（D11 显式接受的风险）
- **TD-036**：错误码靠编码进 message 字符串跨 RPC 传输
- **TD-003**：数据库测试依赖 node:sqlite 运行时

**建议**：TD-005 与 TD-034 决定了"服务能跑在哪"——如果改造涉及部署形态变化，先裁决这两条。

### F7 — 源码里有裸 NUL 字节

`packages/task-engine/src/story-graph-retrieval.ts` 直接用 NUL 字面量作复合键分隔符，
导致 `file` 判它为 `data`、`grep` 报 "binary file matches"。功能上没问题，但它对所有
基于 grep 的工具链隐身——包括改造期间的批量搜索与替换。

**建议**：改成 Unicode 转义写法或换个可打印分隔符。一行的事。

## 5. 建议的改造顺序

前三步都不改行为，可以全程 `pnpm check` 绿灯，用来在动真格之前把地基摆正。

1. **补台账** —— 把 current-project-state 推到 v23 / B23，把故事图谱层写进能力矩阵。
   否则后面每一个决策都建立在过期事实上。
2. **正分层** —— 端口类型下沉，消除 database / secret-store / task-engine 反向依赖
   application。纯类型搬家。
3. **拆巨石** —— contracts 按命名空间拆、migration 按版本拆、dispatch 按域拆。改造期间
   所有人都要碰这三个文件。
4. **统词汇** —— grill / creation-contract 改名为 intake / spec，含表名 migration。
   单独一批，机械操作。
5. **清空壳** —— 四个 8 行占位包要么填实要么删掉，不留第三种状态；plotpilot-adapter
   同样裁决去留。
6. **再谈新能力** —— GE-9 质量增强 / B24 故事圣经 UI / B25 图核验 Critic。若目标含更长
   的自动链路，先补 TD-007 与 TD-008。

## 6. 清点范围

`apps/{server,web,worker,writing-experiment-runner}` · `packages` ×15 · `docs` ×51 ·
`.github/workflows/ci.yml` · 根级配置与 `*.md`。
