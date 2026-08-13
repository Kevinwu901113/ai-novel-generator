# GE-7 — MANUSCRIPT_COMMIT + 稿件工作区 + 导出（2026-08-13）

> 前置：GE-6 原退出条件已通过（B9 wiring + B10 UI，roadmap §15）。D9 的门禁至此解除。
> 上游设计：`b9-chapter-wiring-design.md`（候选修订链）、`b10-chapter-ui-design.md`（成稿阶段）。

## 1. 范围

- `MANUSCRIPT_COMMIT` 节点真实 executor：把用户接受的候选写入**权威稿件**；
- 稿件工作区：章节列表、正文编辑、保存（CAS + append-only）；
- 导出：TXT / Markdown（`packages/import-export` 从 stub 变为实现）；
- resolver 对 `manuscript` artifact 的底层存储校验（此前是空分支，注释里标着"属 GE-7"）。

## 2. 决策

### D-GE7-1 一个蓝图章节在稿件里始终是同一章

绑定表 `manuscript_chapter_links`（migration v19）在首次提交时建立。同一章被否决后
重新生成（新 chapter run）再次提交时，是往**同一章追加新版本**，而不是在稿件里多出
一章。没有这张表，"重新生成三次"就会得到三章重复内容。

### D-GE7-2 提交幂等（内容摘要判据）

sync executor 的副作用发生在 settlement 事务**之外**（RW-1 的结构：execute → settle）。
settlement 失败后重放时不得写出第二个版本。判据取内容摘要：该章当前版本的
`contentHash` 与候选正文一致即视为"这一版已提交过"，直接复用其 versionId 作为 artifact。
故 `recoveryPolicy: 'replayable'`。

### D-GE7-3 不静默覆盖用户正文

稿件只有两条写入路径，两条都是 **CAS + append-only**：

- `MANUSCRIPT_COMMIT`（AI 产出，经用户在候选 Gate 接受）；
- `manuscript.saveChapter`（用户手写）。

保存时必须回传加载时拿到的 `currentVersionId`；期间若有别的写入落地，服务端拒绝而不是
覆盖。UI 在冲突时**保留用户输入**（不丢字），并给出"放弃本地修改并重新加载"的明确出路。
旧版本一条不删——`chapter_versions` 是 append-only，current 指针只移动。

### D-GE7-4 AI 来源版本必须可追溯

manuscript 域要求 AI 来源版本带 task + invocation + creationSpec 版本
（`assertSourceTypeProvenance`）。候选行自 migration v19 起记录产出它的
task/invocation（`chapter-nodes.ts` 的最终事务里写入），提交时直接透传；缺失（v19
之前的旧行）时按 `IMPORT` 来源写入，**不伪造** task id。

### D-GE7-5 resolver 补齐 manuscript 的底层校验

此前 `productionArtifactResolver` 对 `manuscript` 只校验 provenance 行，注释里如实标着
"底层权威存储属于 GE-7"。本批次补齐：版本行必须存在、属于本项目、版本号与 artifact
version 一致（与 researchBundle / storyBlueprint 同一强度）。为此
`GraphRunTransactionRepositories` 增加 `chapterVersionReadRepo`。

### D-GE7-6 导出：worker 渲染，main 落盘

`packages/import-export` 提供纯函数（无 IO）；worker 按稿件顺序渲染文本；**落盘在 main**
（`dialog.showSaveDialog` + `fs.writeFile`）——渲染进程不碰文件系统（AGENTS.md 安全规则）。
用户取消保存对话框返回 `saved=false`，界面据此不报错。

Markdown 导出**不转义正文**：用户正文里的 `*`、`#` 是他的内容，擅自转义会改动作品。

## 3. 持久化（migration v19）

```text
chapter_candidates  += produced_by_task_id / produced_by_invocation_id（AI 溯源）
manuscript_chapter_links  蓝图章节 ↔ 稿件章节绑定（每项目每蓝图章节唯一）
```

只追加新版本号，未改历史 migration。

## 4. 测试证据

| 层                       | 文件                                                         | 覆盖                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 章节 E2E（+2）           | `apps/worker/src/chapter-e2e.integration.test.ts`            | accept → MANUSCRIPT_COMMIT → CHAPTER_READY，稿件里真有这一章且正文=被接受的候选、来源可追溯；重新生成再次提交 → 同一章追加版本、旧版本仍在 |
| 稿件 RPC（8，真 SQLite） | `apps/worker/src/manuscript-handlers.test.ts`                | 空稿件；列表与字数；CAS 基线；**过期基线保存被拒且版本数不变**；导出两格式跳过空章；空稿件拒绝导出；非法输入                               |
| 导出纯函数（6）          | `packages/import-export/src/index.test.ts`                   | TXT/Markdown 结构；正文标记字符不被转义；文件名安全化                                                                                      |
| 稿件 UI（4，jsdom）      | `apps/desktop/src/renderer/chapter/ManuscriptPanel.test.tsx` | 空稿件文案；编辑与保存回传 CAS 基线；冲突保留输入并给出路；导出成功/取消反馈                                                               |

`pnpm check` 全绿（3432 passed / 7 skipped）。

## 5. 不变量自查

1. 生成候选 ≠ 权威稿件：写入只发生在 MANUSCRIPT_COMMIT 与用户显式保存；
2. 不静默覆盖：两条写入路径都是 CAS + append-only，有专门的过期基线回归；
3. 无 graph_runs 直写；未改 domain 图定义；
4. 渲染进程不碰文件系统（导出落盘在 main）；
5. migration 只追加 v19。

## 6. 已知边界

- 稿件章节顺序目前只按提交先后（`createChapter` 追加）；按蓝图章节序重排属后续；
- 版本历史 UI（回看/回滚到某一版）未做：后端 `promoteChapterVersion` 已具备，见 TD-033。
