# 数据模型

> 本文档是数据模型的**简明索引**。**DB migration 是数据模型的唯一事实来源**：
> `packages/database/src/app-database.ts`（`APP_MIGRATIONS`）与 `packages/database/src/project-database.ts`
> （`PROJECT_MIGRATIONS`）。领域模型见 `packages/domain/src/*.ts`。
> 流程权威是 L3 Graph Definitions（`packages/domain/src/idea-to-novel-graph.ts`）；run 状态持久化见 GE-1（migration v8）。

## 1. 数据库分层

- **app.sqlite**：应用级索引与配置，`<userData>/app.sqlite`。
- **project.sqlite**：单个项目正式数据，`<userData>/projects/<project-id>/project.sqlite`。
- project.sqlite 是项目正式数据来源；app.sqlite 仅用于项目列表与快速定位。
- Utility Process 是数据库唯一写入者；同步 SQLite 调用只在 Worker/Utility Process 运行。
- 所有时间使用 UTC ISO 8601。

## 2. Migration 清单

### APP_MIGRATIONS（app.sqlite）

| v   | 内容                                        |
| --- | ------------------------------------------- |
| v1  | `schema_migrations`、`projects`（项目索引） |
| v2  | `project_creations`（创建阶段跟踪）         |
| v3  | `provider_profiles`                         |
| v4  | 重建 `provider_profiles`（CHECK 约束）      |

### PROJECT_MIGRATIONS（project.sqlite）

| v   | 内容                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------- |
| v1  | `schema_migrations`、`project_metadata`                                                                                     |
| v2  | `tasks` + `model_invocations`（token/usage/latency、CHECK、UNIQUE(task_id, attempt_number)）                                |
| v3  | `grill_sessions`、`grill_questions`、`grill_answers`、`grill_inference_proposals`                                           |
| v4  | 重建 `tasks`（加 `GRILL_QUESTION_PLAN`、`dedupe_key` + 部分唯一索引）；`grill_question_plan_proposals`                      |
| v5  | 父表复合唯一索引；creation-contract 表（`creation_contract_proposals` / `_versions` / `_current` / `_lock_events`）+ 触发器 |
| v6  | 重建 `tasks`（加 `CREATION_CONTRACT_DRAFT`）；`uq_cc_proposals_task` / `uq_cc_proposals_invocation`                         |
| v7  | `manuscripts`、`chapters`、`chapter_versions`（STRICT、复合 PK/FK、部分唯一 active-manuscript、append-only 触发器）         |
| v8  | **GE-1**：`graph_runs`（统一 run 状态，kind 判别）+ `graph_run_commands`（幂等日志）                                        |
| v9  | **GE-4**：`research_bundles`（ResearchBundle 版本化：问题计划/来源/事实笔记/结论）                                          |

## 3. 权威对象与存储

| 权威对象                                       | 用户侧名称               | 存储                                                      | 状态                              |
| ---------------------------------------------- | ------------------------ | --------------------------------------------------------- | --------------------------------- |
| Project                                        | 项目                     | app.sqlite `projects` + project.sqlite `project_metadata` | ✅                                |
| Grill Session / Question / Answer              | Idea Intake（GE-3 改名） | project.sqlite `grill_*`                                  | ✅（GE-3 适配）                   |
| CreationSpec（来自 Creation Contract）         | 创作要求                 | project.sqlite `creation_contract_*`                      | ✅（GE-3 冻结 CreationSpec 形态） |
| Manuscript / Chapter / ChapterVersion          | 稿件                     | project.sqlite v7                                         | ✅ 后端                           |
| Graph Run（ProjectRun / ChapterGenerationRun） | 生成记录                 | project.sqlite v8（GE-1）                                 | GE-1                              |
| ResearchBundle                                 | 调研资料包               | GE-4 新 migration                                         | GE-4                              |
| StoryBlueprint                                 | 故事蓝图                 | GE-5 新 migration                                         | GE-5                              |

## 4. 安全与写入约束

- API Key 不进入任何 SQLite（macOS Keychain：`com.ai-novel-generator.provider.mimo-token-plan-cn`）。
- prompt 不持久化；只存 SHA-256 hash。
- STRICT 表、WAL、foreign_keys、busy_timeout；所有 mutation 走 BEGIN IMMEDIATE 事务。
- 用户手写正文不得被静默覆盖（CAS / 不可变版本 / 显式写入）。
- Graph run 状态变化只能经 Domain transition（见 `module-boundaries.md` §0）。
