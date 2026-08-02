# Minimal Manuscript / Chapter Version 设计

> 状态：设计文档（architecture/design-only），尚未实现。
> 基线：`876580b492eea04fbda71425621160b7da9c3527`（PR #22 merge）
> 关联：`docs/architecture/creation-contract-design.md`、`docs/architecture/module-boundaries.md`、`docs/development/generation-quality-roadmap.md`

本文档冻结「真实稿件与章节版本管理」的领域语义、数据模型、并发边界和最小产品纵向切片。**这是 architecture/design-only PR**：不实现代码、数据库迁移、IPC、Renderer 或 AI 生成。后续实现按 §12 拆分为 MV1-A / MV1-B / MV1-C 三个 PR。

## 目录

1. 目标
2. 核心设计问题（14 问）
3. 初始架构假设裁决
4. 领域模型
5. 不变量
6. 持久化设计
7. 应用用例与接口边界
8. 最小产品纵向切片
9. UI 与冲突语义（未来最小 Renderer）
10. 与现有系统的边界
11. 并发、事务与恢复
12. 实施切片
13. 决策记录
14. 测试策略

---

## 1. 目标

定义从「本地项目」到「用户可编辑真实稿件」的完整边界，作为后续一切生成能力的根基：

```
Project
→ Manuscript（容器，稳定身份）
  → Chapter（稳定身份 + 排序节点）
    → ChapterVersion（不可变 标题 + 正文 快照）
      → current pointer（当前版本 CAS 推进）
```

本设计的最小能力不是「一个大文本字段」，而是一个可持续演进的稿件版本基础：单章粒度版本、不可变快照、显式保存、CAS 并发保护、完整 provenance，以及明确与 Creation Contract、Task Engine、Scene Planner、Story State 的边界。

**成功标准（§8）**：用户可在桌面 UI 打开稿件、创建章节、编辑标题和正文、显式保存为不可变版本、查看版本历史、把任意历史版本设为当前，且重启后数据仍在、所有操作严格限定在当前 project。

---

## 2. 核心设计问题（14 问）

| #   | 问题                                                   | 裁决                                                                                                                                  | 要点                                                                 |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | 一个 project 可以有几个 manuscript？                   | V1：至多一个 **active** manuscript；允许多个 **archived** manuscript                                                                  | `UNIQUE(project_id) WHERE status='active'` 部分唯一索引强制（§6.4）  |
| 2   | manuscript / chapter / chapter version 分别由谁拥有？  | Manuscript 属于 project；Chapter 属于 manuscript；ChapterVersion 属于 chapter                                                         | 全部通过复合主键 `(project_id, id)` 与复合外键在数据库层强制（§4）   |
| 3   | 版本粒度是整本稿件还是单章？                           | **单章**（ChapterVersion 是版本单元）                                                                                                 | Manuscript 不保存整本快照，正文只存在章节版本里（§6.2）              |
| 4   | chapter title 是否属于版本快照？                       | **是**。title 属于 ChapterVersion 快照，Chapter 行不存 title                                                                          | 修改标题 = 保存新版本（§4.3、§5）                                    |
| 5   | chapter order 是否属于版本内容？                       | **否**。order 是 Chapter 的排序字段，独立于正文版本                                                                                   | 重排不复制、不修改任何版本（§6.1、不变量 11）                        |
| 6   | current version 如何推进？                             | `chapters.current_version_id` 指针 + CAS（`expectedCurrentVersionId`）                                                                | 与 creation_contract 的 current pointer CAS 同构（§6.3、§11）        |
| 7   | 如何防止并发保存覆盖？                                 | CAS 谓词 `UPDATE ... WHERE current_version_id = expected`；失败 → `MANUSCRIPT_VERSION_CONFLICT`                                       | 冲突时整笔回滚，不产生孤儿版本（§11.2）                              |
| 8   | 用户保存 / AI 生成 / 定点重写如何记录 provenance？     | ChapterVersion 行自带 provenance：`sourceType` + `createdByTaskId` + `invocationId` + `creationContractVersionId` + `parentVersionId` | 不再需要独立 provenance 表（§4.3、§10）                              |
| 9   | Creation Contract version 如何与稿件版本关联？         | Manuscript 记录初始 contract 锚点；ChapterVersion 记录实际生成时使用的 contract version                                               | 历史版本不因 Contract 更新而变化（§10.1、不变量 14）                 |
| 10  | 删除 / 归档 / 恢复分别是什么语义？                     | 不 hard-delete；archive = 状态切到 `archived`（可逆）；restore = 切回 `active`；project 删除是文件级                                  | 版本 append-only，DB trigger 禁止 DELETE/UPDATE（§6.4、不变量 9/12） |
| 11  | Scene Planner 未来应关联什么？                         | **chapter**（稳定身份）+ `baseChapterVersionId`（生成时基线），不关联版本、不用独立计划版本                                           | 避免计划内容与实际正文版本失配（§10.3）                              |
| 12  | 如何避免一次正文修改复制整本稿件？                     | 版本粒度是单章；正文只存当前章节的新版本；Manuscript 无整本快照；order 独立                                                           | 一次保存只写一行 ChapterVersion + 一个指针更新（§6、§11.1）          |
| 13  | 如何避免 autosave 制造大量无意义版本？                 | V1 **不做 autosave 自动版本化**；只有显式「保存新版本」创建版本                                                                       | 未来 autosave 只进本地草稿 buffer，不落版本（§8、§13）               |
| 14  | 何时才算「Minimal Manuscript / Chapter Version」完成？ | MV1-B 合并后满足 §8 全部完成标准                                                                                                      | MV1-A/MV1-B/MV1-C 切片见 §12                                         |

---

## 3. 初始架构假设裁决

初始假设逐条标记。任何调整都给出明确理由。

| 初始假设                                                       | 裁决                            | 理由                                                                       |
| -------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| V1 每个 project 最多一个 active manuscript                     | **ACCEPTED**                    | 单稿模式满足 V1 产品需要；archived 可保留多个；未来多稿用部分唯一索引放开  |
| Manuscript 是容器，不保存整本正文快照                          | **ACCEPTED**                    | 避免任何正文修改复制整本；正文只存在于章节版本                             |
| Chapter 是稳定身份和排序节点                                   | **ACCEPTED**                    | order 独立于版本，重排不复制正文                                           |
| ChapterVersion 是不可变的标题 + 正文快照                       | **ACCEPTED**                    | title 属于版本快照（问题 4）；版本创建后不可修改                           |
| Chapter.currentVersionId 指向当前版本                          | **ACCEPTED**                    | 折叠指针进 Chapter 行，比独立映射表简单（§6.3）                            |
| 推进 currentVersion 使用 expectedCurrentVersionId 做 CAS       | **ACCEPTED**                    | 与既有 expectedVersion 乐观并发约定一致                                    |
| Chapter order 独立于正文版本，重排不复制正文                   | **ACCEPTED**                    | 排序字段在 Chapter 行                                                      |
| 所有正文版本永久保留，不 hard-delete                           | **ACCEPTED**                    | append-only + DB trigger 禁止 DELETE（§6.4）                               |
| V1 使用 UTF-8 plain text 或 Markdown，不引入富文本 AST         | **ACCEPTED**（选择 plain text） | content 存原始 UTF-8 字节；不做 Markdown 结构化解析；无富文本              |
| 用户显式「保存新版本」，V1 不做自动版本化 autosave             | **ACCEPTED**                    | autosave 制造无意义版本；V1 显式保存                                       |
| AI 未来只能创建新版本，不能原地修改现有版本                    | **ACCEPTED**                    | 版本不可变；AI 通过 createChapterVersion 产生新版本（§10.2）               |
| AI 生成版本必须记录 taskId、model invocation 或等价 provenance | **ACCEPTED**                    | sourceType + createdByTaskId + invocationId 落在版本行                     |
| 生成时使用的 Creation Contract version 必须可追溯              | **ACCEPTED**                    | ChapterVersion.creationContractVersionId；Manuscript 记录初始锚点（§10.1） |
| V1 不实现合并、分支编辑、协同编辑或多人实时同步                | **ACCEPTED**                    | 明确非目标（§8）                                                           |

无 REJECTED 项。

---

## 4. 领域模型

> 领域模型放 `packages/domain`，纯 TS、零外部依赖。命名遵循既有约定：branded ID 工厂 `createXxxId`、`readonly` 字段、`string` 时间戳（ISO 8601 UTC）、闭合枚举、校验函数。ID 一律由调用方（Worker）注入，领域不生成 ID。

### 4.1 Manuscript

Manuscript 是 project 内的稿件容器。V1 每 project 至多一个 active，可存在多个 archived。

| 字段                      | 类型                               | 必填 | 说明                                                                                                               |
| ------------------------- | ---------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------ |
| id                        | `string`（branded `ManuscriptId`） | 是   | 复合主键 `(project_id, id)` 的一部分                                                                               |
| projectId                 | `string`                           | 是   | 所属项目；`project_metadata(id)` 外键                                                                              |
| title                     | `string`                           | 是   | trim 后非空；≤ 200 UTF-16 code units                                                                               |
| status                    | `'active' \| 'archived'`           | 是   | 闭合枚举；默认 `'active'`                                                                                          |
| creationContractVersionId | `string \| null`                   | 否   | **初始 contract 锚点**：getOrCreateManuscript 创建时记录当时的 current contract version；**永不自动更新**（§10.1） |
| createdAt / updatedAt     | `string`（ISO 8601 UTC）           | 是   | 创建/最后更新时间                                                                                                  |

**project 内唯一性**：部分唯一索引 `UNIQUE(project_id) WHERE status = 'active'`（§6.4）。**多个 archived manuscript**：允许。**空标题**：禁止（trim 非空）；创建时若未提供标题用默认 `'未命名稿件'`。

### 4.2 Chapter

Chapter 是 manuscript 内的稳定身份与排序节点，不保存正文、不保存标题。

| 字段                  | 类型                            | 必填 | 说明                                                                                                 |
| --------------------- | ------------------------------- | ---- | ---------------------------------------------------------------------------------------------------- |
| id                    | `string`（branded `ChapterId`） | 是   | 复合主键 `(project_id, id)`                                                                          |
| projectId             | `string`                        | 是   | 所属项目                                                                                             |
| manuscriptId          | `string`                        | 是   | 所属稿件；`manuscripts(project_id, id)` 复合外键                                                     |
| position              | `number`（正整数）              | 是   | 稀疏 rank；`UNIQUE(project_id, manuscript_id, position)`（§6.1）                                     |
| currentVersionId      | `string \| null`                | 否   | 当前版本指针；`null` = 空章节（尚无版本）；复合外键到 `chapter_versions(project_id, chapter_id, id)` |
| status                | `'active' \| 'archived'`        | 是   | 闭合枚举；默认 `'active'`                                                                            |
| createdAt / updatedAt | `string`                        | 是   | 创建/最后更新时间                                                                                    |

**稳定身份**：id 一经创建不可变，重排/改名/改版本均不改变 id。**空章节语义**：`currentVersionId = NULL`、无任何版本；列表展示占位标题（UI 渲染，不落库）；打开即空白编辑器；保存首个版本后才有标题与正文。**重排语义**：只更新 `position`，不触碰任何版本行（不变量 11）。

### 4.3 ChapterVersion

ChapterVersion 是不可变的「标题 + 正文」快照，同时携带 provenance。

| 字段                      | 类型                                                                 | 必填 | 说明                                                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                        | `string`（branded `ChapterVersionId`）                               | 是   | 复合主键 `(project_id, id)`                                                                                                                                         |
| projectId                 | `string`                                                             | 是   | 所属项目                                                                                                                                                            |
| chapterId                 | `string`                                                             | 是   | 所属章节；`chapters(project_id, id)` 复合外键                                                                                                                       |
| versionNumber             | `number`（正整数）                                                   | 是   | 章节内单调递增，从 1 开始；`UNIQUE(project_id, chapter_id, version_number)`                                                                                         |
| title                     | `string`                                                             | 是   | trim 后非空；≤ 200 UTF-16 code units                                                                                                                                |
| content                   | `string`                                                             | 是   | 原始 UTF-8 文本；允许空字符串；≤ 1,000,000 UTF-16 code units（§6.2）                                                                                                |
| contentHash               | `string`（SHA-256 hex）                                              | 是   | `sha256Utf8(content)`，即存储正文精确字节的摘要；`length = 64`                                                                                                      |
| parentVersionId           | `string \| null`                                                     | 否   | 血缘：保存时 chapter 的 current version（即 expectedCurrentVersionId 验证后的 current）；首个版本为 null；复合外键到 `chapter_versions(project_id, chapter_id, id)` |
| sourceType                | `'USER' \| 'AI_GENERATION' \| 'AI_REWRITE' \| 'IMPORT' \| 'RESTORE'` | 是   | 闭合枚举（见下）                                                                                                                                                    |
| createdByTaskId           | `string \| null`                                                     | 否   | 产生此版本的 AI task；`USER`/`IMPORT` 为 null；`AI_*` 必填；复合外键到 `tasks(project_id, id)`                                                                      |
| invocationId              | `string \| null`                                                     | 否   | 关联模型调用；`AI_*` 必填；复合外键到 `model_invocations(project_id, id)`                                                                                           |
| creationContractVersionId | `string \| null`                                                     | 否   | 生成时使用的 contract version；`AI_*` 必填、`USER`/`IMPORT` 可选；复合外键到 `creation_contract_versions(project_id, id)`                                           |
| createdAt                 | `string`                                                             | 是   | 创建时间（即保存时间）                                                                                                                                              |

**sourceType 规则**：

| sourceType      | 语义                         | createdByTaskId | invocationId | creationContractVersionId          |
| --------------- | ---------------------------- | --------------- | ------------ | ---------------------------------- |
| `USER`          | 用户显式保存                 | null            | null         | 可选（空章节/无契约场景可为 null） |
| `AI_GENERATION` | AI 整章生成                  | 必填            | 必填         | 必填                               |
| `AI_REWRITE`    | AI 定点重写                  | 必填            | 必填         | 必填                               |
| `IMPORT`        | 外部导入                     | null            | null         | 可选                               |
| `RESTORE`       | 未来备份恢复物化内容为新版本 | null            | null         | 可选                               |

> 注意：promoteChapterVersion（把历史版本设为 current）**不创建新版本**，因此不产生 `RESTORE` 版本。`RESTORE` 预留给未来「从备份恢复正文」的物化路径（§10、§13）。

**immutable 约束**：版本创建后不可 UPDATE、不可 DELETE（DB trigger 强制，§6.4）。`contentHash` 由 repository 写入前重算校验（与 `sha256Utf8` 现有约定一致），读取时可复核。

---

## 5. 不变量

以下不变量在任何实现中不可违反：

1. **项目隔离**：Manuscript、Chapter、ChapterVersion 不得跨 project 访问。复合主键 `(project_id, ...)` + 复合外键 + 应用层 projectId 校验三重强制；跨 project 访问返回对应 NOT_FOUND，不泄露存在性（§7、§13）。
2. **版本不可变**：ChapterVersion 创建后不可修改。DB trigger `BEFORE UPDATE`/`BEFORE DELETE` RAISE(ABORT)（§6.4）。
3. **指针同章约束**：`currentVersionId` 只能指向同一 Chapter 的版本。复合外键 `chapters(project_id, manuscript_id, current_version_id) → chapter_versions(project_id, chapter_id, id)` 在数据库层强制「同项目 + 同章」。
4. **CAS 推进**：current version 推进必须使用 CAS。谓词 `UPDATE chapters SET current_version_id = :new WHERE project_id = :p AND id = :c AND current_version_id = :expected`；首个版本用 `current_version_id IS NULL`。affected ≠ 1 → `MANUSCRIPT_VERSION_CONFLICT`。
5. **CAS 失败不得悄悄覆盖**：CAS 失败即整笔回滚（§11.2），绝不静默继续、绝不产生孤儿版本。
6. **version number 章节内唯一**：`UNIQUE(project_id, chapter_id, version_number)`；单调递增，从 1 开始。
7. **事务边界明确**：新版本创建 + current 推进在同一事务（createChapterVersion）；current 切换（promote）单独一个事务；全部 `BEGIN IMMEDIATE`（§11）。
8. **归档章节不可接收新版本**：`status='archived'` 的 chapter 对 createChapterVersion 返回 `MANUSCRIPT_STATE_CONFLICT`，必须先 restore。
9. **版本历史不得 hard-delete**：版本行 append-only；DB trigger 禁止 DELETE（§6.4）。
10. **排序唯一且稳定**：`position` 在 manuscript 内唯一；确定性排序 `ORDER BY position ASC, id ASC`（不变量 16）。
11. **重排不改版本内容**：updateChapterOrder 只更新 `position`，不得改变任何 ChapterVersion 内容或 hash。
12. **Project 删除/恢复级联明确**：V1 无逐行级联——删除语义 = archive；project 删除（未来）是文件级（删除整个 project.sqlite），恢复 = 恢复数据库文件备份；不依赖 FK ON DELETE CASCADE（现有 schema 无 ON DELETE 子句）。
13. **AI task 失败不得产生半成品 current version**：AI settle 使用与用户保存相同的原子 `createChapterVersion`（create + CAS promote 同一事务）；冲突 → task FAILED，不产生版本（§11.3）。
14. **Provenance 不得跨 project 引用**：`createdByTaskId`/`invocationId`/`creationContractVersionId` 全部用复合外键 `(project_id, ...)` 约束，禁止引用其他 project 的 task/invocation/contract version。
15. **空正文 / 最大长度 / Unicode 规范明确**：content 可为空字符串；title trim 后非空；title ≤ 200、content ≤ 1,000,000 UTF-16 code units；Unicode 不规范化（NFC/NFD 均不执行），精确字节保真（§6.2）。
16. **返回顺序确定性**：listChapters `ORDER BY position ASC, id ASC`；listChapterVersions `ORDER BY version_number DESC, id ASC`；archive 列表（未来）`ORDER BY updated_at DESC, id DESC`。每个列表的次要排序键永远是 id。
17. **稳定版本 ID 可被未来系统引用**：导出、Scene Plan、Story State Ledger 等未来系统必须引用不可变的 ChapterVersionId（§10.3、§10.4）。

---

## 6. 持久化设计

> 概念级 schema。实现时通过 project.sqlite 迁移机制添加 **migration version 7**（当前最高为 6），遵循既有约定：`CREATE TABLE IF NOT EXISTS`、STRICT、复合主键 `(project_id, id)`、复合外键、CHECK 约束、独立唯一索引、部分唯一索引、append-only trigger、`PRAGMA foreign_keys = ON`。**本 PR 不编写 migration。**

### 6.1 排序：连续整数 position vs 稀疏 position / rank

**方案 A：连续整数 position（1..N）**

- 插入中间章节：`UPDATE chapters SET position = position + 1 WHERE manuscript_id = ? AND position >= N`，O(N) 次写。
- 并发重排：单个事务内串行化；但后缀位移需要处理**瞬时唯一冲突**——SQLite 逐行校验唯一约束，位移中间态可能命中已存在的值（如 N→N+1 时 N+1 尚存），必须用负区间两段式或 drop/recreate 唯一索引规避，事务过程复杂、易错。
- 未来迁移成本：天然连续，无需迁移。

**方案 B：稀疏 position / rank（gap 稀疏整数 + midpoint + 显式 rebalance）** ← **V1 选择**

- 初始分配：首章 `position = 1024`；追加 `position = max + 1024`。
- 插入中间章节 / 单章重排：`position = floor((left + right) / 2)`（`gap >= 2` 时整数严格介于两者之间），**单行 UPDATE，O(1) 写，不触碰其他行**。
- 当 `gap <= 1`（两个相邻 position 之间无整数可插入）时触发 **rebalance**，procedure 固定为（单事务，无实现自由度）：
  1. `BEGIN IMMEDIATE`；
  2. 读取该 manuscript 全部 active 章节，按 `ORDER BY position ASC, id ASC` 得有序 id 列表；
  3. `DROP INDEX IF EXISTS uq_chapters_project_manuscript_position`；
  4. 对第 i 个 id（i 从 0 起）：`UPDATE chapters SET position = (i + 1) * 1024 WHERE project_id = ? AND id = ?`；
  5. `CREATE UNIQUE INDEX uq_chapters_project_manuscript_position ON chapters(project_id, manuscript_id, position)`；
  6. `COMMIT`（步骤 5 若因重复值失败则整体 ROLLBACK，约束完整性由该 CREATE 的失败暴露）。

  SQLite DDL 可事务化，DROP/CREATE 索引保证重排期间无瞬时唯一冲突，且重排后仍保留 GAP-1 的插入空间。

- 唯一性：`UNIQUE(project_id, manuscript_id, position)`；midpoint 构造保证与左右邻居互异，`gap==1` 才 rebalance。
- 并发重排：worker 是唯一写者，`BEGIN IMMEDIATE` 串行化；每次重排基于已提交状态重算邻居 midpoint，两次并发 move 收敛为最后应用者（重排是 last-write-wins 语义，§7、§11）。
- 未来迁移成本：稀疏是连续的超集，任何时刻可一次数据迁移压实为连续 1..N；显式且受限。

**选择理由**：V1 操作以「创建章节（通常追加）+ 偶发重排」为主；方案 B 对中间插入与重排是 O(1) 单行写，完全绕开方案 A 的瞬时唯一冲突与 O(N) 后缀位移；rebalance 是唯一且精确定义的兜底。章节数为人工尺度（数十级），rebalance 成本可忽略。

### 6.2 正文存储

- **SQLite TEXT 足够**。SQLite TEXT 上限 `SQLITE_MAX_LENGTH`（默认 1e9 字节）；V1 正文上限 1,000,000 UTF-16 code units（≈3MB UTF-8），远低于上限。
- **最大长度**：`title ≤ 200`、`content ≤ 1,000,000` UTF-16 code units。权威校验在 repository 层（JS `String.length`）；DB 层以 `CHECK(length(content) <= 1000000)` 作防御（SQLite `length()` 按字符计数，对 BMP 与 UTF-16 units 一致；对 astral 更宽松，故 DB 检查只拦截粗暴超限，不会误拒合法数据）。
- **content hash 算法**：`contentHash = sha256Utf8(content)`，即对存储正文的**精确 UTF-8 字节**做 SHA-256。repository 写入前重算校验（与 creation-contract-repositories 的 `sha256Utf8` 完全一致），读取时可复核。hash 只覆盖 content（title 是元数据；版本身份是 versionNumber）。
- **换行规范**：**保留用户原始换行与空白，不做任何规范化**（不 trim、不转 CRLF/LF）。用户写什么存什么。
- **Unicode**：**不规范化**（不执行 NFC/NFD），保留原始码点序列；hash 对精确字节计算，确定性成立。
- **压缩**：不需要。V1 文本量在 TEXT 上限内，WAL + SQLite 足够；引入压缩破坏「行内原文直读」且收益极低。REJECTED。
- **全文搜索**：不需要。FTS5 外置内容表列为未来 revisit（当前无检索产品需求；§8 非目标含「全文搜索」）。REJECTED for V1。
- **为何不引入 blob / 外部文件存储**：TEXT 保持「版本行 + 内容」的 SQLite 事务一致性，版本不可变 + 事务回滚天然覆盖正文；外部文件需要路径管理、孤儿清理、与 Worker 唯一写者约束冲突，破坏原子性。REJECTED for V1。

### 6.3 Current pointer

比较三种方案：

| 方案                                 | 说明                                               | 结论                                                                                                                                                                        |
| ------------------------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) `chapters.current_version_id` 列 | 指针折叠进 Chapter 行，nullable 表达空章节         | **V1 选择**                                                                                                                                                                 |
| (b) 通过 query 计算最新版本          | `MAX(version_number)`                              | REJECTED：promote 历史版本后 current ≠ 最新创建；无法表达「当前是旧版本」；多一次聚合查询                                                                                   |
| (c) 独立 current 映射表              | 每 chapter 一行 `(chapter_id, current_version_id)` | REJECTED：一个 chapter 只有一个指针，映射表相对 (a) 无增量能力，却多一张表；creation_contract 用独立表是因为 current 与 version 表分属不同聚合，这里指针天然属于 Chapter 行 |

**选择 (a) + CAS**：推进用 `UPDATE ... WHERE current_version_id = expected`（首版 `IS NULL`），与 creation_contract_current 的 CAS 谓词同构；`BEGIN IMMEDIATE` 内原子完成「插入版本 + 更新指针」。

### 6.4 概念级表结构

#### manuscripts

```sql
CREATE TABLE manuscripts (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','archived')),
  creation_contract_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES project_metadata(id),
  FOREIGN KEY (project_id, creation_contract_version_id)
    REFERENCES creation_contract_versions(project_id, id)
) STRICT;

-- 每 project 至多一个 active manuscript
CREATE UNIQUE INDEX uq_manuscripts_project_active
  ON manuscripts(project_id) WHERE status = 'active';

CREATE INDEX idx_manuscripts_project_status_updated
  ON manuscripts(project_id, status, updated_at DESC);
```

#### chapters

```sql
CREATE TABLE chapters (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  manuscript_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position > 0),
  current_version_id TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, manuscript_id)
    REFERENCES manuscripts(project_id, id),
  FOREIGN KEY (project_id, manuscript_id, current_version_id)
    REFERENCES chapter_versions(project_id, chapter_id, id)
) STRICT;

CREATE UNIQUE INDEX uq_chapters_project_manuscript_position
  ON chapters(project_id, manuscript_id, position);
CREATE INDEX idx_chapters_project_manuscript_status
  ON chapters(project_id, manuscript_id, status, position);
```

> `position` 采用**稀疏正整数**：插入中间用 `floor((left+right)/2)`（`gap >= 2` 时为整数严格介于两者之间），`gap <= 1` 时触发 rebalance（§6.1）。保持与 codebase 一致的整数纪律（safe integer）。
>
> `chapters(project_id, manuscript_id, current_version_id)` 复合外键目标 `chapter_versions(project_id, chapter_id, id)` 需下表的复合唯一索引支持；SQLite 允许前向引用（运行时解析），同一迁移内建表顺序为 manuscripts → chapters → chapter_versions 后，运行时双向 FK 均生效。

#### chapter_versions

```sql
CREATE TABLE chapter_versions (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  content TEXT NOT NULL CHECK (length(content) <= 1000000),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  parent_version_id TEXT,
  source_type TEXT NOT NULL
    CHECK (source_type IN ('USER','AI_GENERATION','AI_REWRITE','IMPORT','RESTORE')),
  created_by_task_id TEXT,
  invocation_id TEXT,
  creation_contract_version_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, chapter_id, version_number),
  FOREIGN KEY (project_id, chapter_id)
    REFERENCES chapters(project_id, id),
  FOREIGN KEY (project_id, chapter_id, parent_version_id)
    REFERENCES chapter_versions(project_id, chapter_id, id),
  FOREIGN KEY (project_id, created_by_task_id)
    REFERENCES tasks(project_id, id),
  FOREIGN KEY (project_id, invocation_id)
    REFERENCES model_invocations(project_id, id),
  FOREIGN KEY (project_id, creation_contract_version_id)
    REFERENCES creation_contract_versions(project_id, id),
  CHECK (
    (source_type IN ('AI_GENERATION','AI_REWRITE') AND
       created_by_task_id IS NOT NULL AND invocation_id IS NOT NULL
       AND creation_contract_version_id IS NOT NULL)
    OR
    (source_type IN ('USER','IMPORT','RESTORE') AND
       created_by_task_id IS NULL AND invocation_id IS NULL)
  )
) STRICT;

-- 支撑 chapters.current_version_id 复合外键 + 血缘外键
CREATE UNIQUE INDEX uq_chapter_versions_project_chapter
  ON chapter_versions(project_id, chapter_id, id);

-- AI task 幂等：同一 task 至多产生一个版本
CREATE UNIQUE INDEX uq_chapter_versions_task
  ON chapter_versions(project_id, created_by_task_id)
  WHERE created_by_task_id IS NOT NULL;

CREATE INDEX idx_chapter_versions_project_chapter_number
  ON chapter_versions(project_id, chapter_id, version_number DESC);

-- 不可变性：禁止 UPDATE / DELETE
CREATE TRIGGER trg_chapter_versions_no_update
BEFORE UPDATE ON chapter_versions
BEGIN SELECT RAISE(ABORT, 'chapter_versions is append-only'); END;

CREATE TRIGGER trg_chapter_versions_no_delete
BEFORE DELETE ON chapter_versions
BEGIN SELECT RAISE(ABORT, 'chapter_versions is append-only'); END;
```

**约束说明**：

- 复合 PK `(project_id, id)` 保证项目隔离与唯一 id。
- 复合外键全部带 `project_id`，禁止跨 project 引用（不变量 1/14）。
- `uq_chapter_versions_task` 部分唯一索引是 AI settle 幂等与去重的最终并发保护（§11.3）。
- CHECK 强制 sourceType 与 provenance 字段的一致性（AI 必填三件套、非 AI 不得填 task/invocation）。
- 版本行无 `updated_at`（不可变）；无 `status`（不存在「草稿版本」，创建即权威快照）。

**archive 字段**：manuscripts/chapters 的 `status` 承担 archive 语义；chapter_versions 无 status（版本永不变更）。**级联策略**：所有 FK 无 `ON DELETE`（与现有 schema 一致）；V1 不逐行删除；project 删除为文件级（§5 不变量 12）。

---

## 7. 应用用例与接口边界

> 用例放 `packages/application`。遵循既有模式：`XxxDeps` 依赖对象（端口 + `idGenerator` + `clock` + `transaction`）、`XxxInput`/`XxxCommand` 输入、`XxxPublicData` 返回、事务端口 `ManuscriptTransactionPort.runInTransaction(repos => ...)`（BEGIN IMMEDIATE）、类型化错误类（`MANUSCRIPT_*` 前缀）、Renderer 不传 ID/时间戳（Worker 注入 `now`/`newVersionId` 等）。

**新增 ErrorCode**（加入 `packages/contracts` ErrorCode union）：

| code                          | 含义                                                      | 可恢复           |
| ----------------------------- | --------------------------------------------------------- | ---------------- |
| `MANUSCRIPT_NOT_FOUND`        | 稿件不存在或无权限（跨 project 也返回此码，不泄露存在性） | 否               |
| `MANUSCRIPT_STATE_CONFLICT`   | 归档/非活跃状态不允许此操作                               | 是（先恢复）     |
| `MANUSCRIPT_VERSION_CONFLICT` | current version CAS 失败（乐观并发冲突）                  | 是（刷新后重试） |
| `CHAPTER_NOT_FOUND`           | 章节不存在或无权限                                        | 否               |
| `CHAPTER_VERSION_NOT_FOUND`   | 版本不存在或无权限                                        | 否               |

复用 `VALIDATION_ERROR`、`INTERNAL_ERROR`。**跨 project 与 not-found 不区分**（与 grill/contract 现有行为一致，避免存在性泄露）。

### 7.1 最小读取用例

| 用例                       | 输入                                          | 返回                               | 说明                                                                                                                           |
| -------------------------- | --------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `getOrCreateManuscript`    | `{projectId, title?}`                         | `ManuscriptPublicData`             | 有 active 稿件则返回（忽略 title）；否则创建（title 缺省 `'未命名稿件'`）。单事务，部分唯一索引兜底并发（见 §7.2 Idempotency） |
| `getManuscript`            | `{projectId, manuscriptId}`                   | `ManuscriptPublicData`             | 不存在/跨 project → `MANUSCRIPT_NOT_FOUND`                                                                                     |
| `listChapters`             | `{projectId, manuscriptId, includeArchived?}` | `ChapterSummary[]`                 | `ORDER BY position ASC, id ASC`；默认不含 archived                                                                             |
| `getChapter`               | `{projectId, manuscriptId, chapterId}`        | `ChapterPublicData`                | 含 current 版本摘要与 `versionCount`                                                                                           |
| `getCurrentChapterVersion` | `{projectId, chapterId}`                      | `ChapterVersionPublicData \| null` | 空章节返回 null                                                                                                                |
| `listChapterVersions`      | `{projectId, chapterId}`                      | `ChapterVersionSummary[]`          | `ORDER BY version_number DESC, id ASC`；**不含 content**                                                                       |
| `getChapterVersion`        | `{projectId, chapterId, versionId}`           | `ChapterVersionPublicData`         | 含 content                                                                                                                     |

### 7.2 最小写入用例

| 用例                    | 输入（Renderer 面）                                                                                    | 返回                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `createChapter`         | `{projectId, manuscriptId, insertBeforeChapterId \| null}`                                             | `ChapterPublicData`                    |
| `createChapterVersion`  | `{projectId, chapterId, title, content, expectedCurrentVersionId \| null, creationContractVersionId?}` | `ChapterVersionPublicData`             |
| `promoteChapterVersion` | `{projectId, chapterId, versionId, expectedCurrentVersionId}`                                          | `ChapterVersionPublicData`             |
| `updateChapterOrder`    | `{projectId, manuscriptId, chapterId, insertBeforeChapterId \| null}`                                  | `ChapterSummary[]`（新顺序，事实来源） |
| `archiveChapter`        | `{projectId, chapterId, expectedCurrentVersionId \| null}`                                             | `ChapterPublicData`                    |
| `restoreChapter`        | `{projectId, chapterId, expectedCurrentVersionId \| null}`                                             | `ChapterPublicData`                    |
| `updateManuscriptTitle` | `{projectId, manuscriptId, title, expectedUpdatedAt}`                                                  | `ManuscriptPublicData`                 |

> Worker 注入 `now`、`newChapterId`、`newVersionId` 等生成字段；Renderer 输入不含这些字段（与 `RequestContractDraftInput` 先例一致，严格 validator 拒绝多余字段）。

#### 各写入操作规格

---

**`createChapter`**

- **Input**：`{projectId, manuscriptId, insertBeforeChapterId | null}`（Worker 注入 `newChapterId`、`now`）
- **Preconditions**：manuscript 存在且属于 project 且 `status='active'`；若提供 `insertBeforeChapterId`，该章节存在、属于同一 manuscript、`status='active'`。插入位置为 append（`null`）时 `position = max + 1024`；insert-before-first 时 `position = first.position - 1024`（≤ 0 则 rebalance）；insert-before-X 时 `position = midpoint(prev(X), X)`（gap==1 则 rebalance）。rebalance 在同一事务内完成（§6.1）。
- **Transaction**：单个 `BEGIN IMMEDIATE`；插入章节行（`current_version_id = NULL`、`status='active'`）；更新 manuscript.updatedAt；COMMIT。
- **Result**：`ChapterPublicData`（空章节，`currentVersionId = null`）。
- **Errors**：`MANUSCRIPT_NOT_FOUND`、`MANUSCRIPT_STATE_CONFLICT`（稿件 archived）、`CHAPTER_NOT_FOUND`（insertBefore 目标跨稿件/不存在）、`VALIDATION_ERROR`。
- **Idempotency**：非幂等（每次创建新章节）；UI 以 save-in-flight 锁防双击；`(project_id, id)` 主键保证并发同 id 插入不重复。

---

**`createChapterVersion`**（核心「保存新版本」）

- **Input**（Renderer 面）：`{projectId, chapterId, title, content, expectedCurrentVersionId | null, creationContractVersionId?}`。Worker 注入 `newVersionId`、`now`、`sourceType`（用户保存固定 `'USER'`；AI settle 路径注入 `'AI_GENERATION'`/`'AI_REWRITE'` 及 `createdByTaskId`/`invocationId`）。Renderer 不得传 `sourceType`——严格 validator 拒绝多余字段。
- **Preconditions**：chapter 存在、属于 project、`status='active'`（归档 → `MANUSCRIPT_STATE_CONFLICT`）；title trim 非空、长度 ≤ 200；content ≤ 1,000,000；`expectedCurrentVersionId` 与当前 current 匹配（首版要求当前为 null 且 expected 为 null）；`sourceType='AI_*'` 时必须注入 taskId/invocationId/contractVersionId（CHECK 兜底）。
- **Transaction**（单个 `BEGIN IMMEDIATE`）：
  1. 读 chapter（存在/归属/active）+ 读 current pointer；
  2. CAS 验证 `current_version_id = expectedCurrentVersionId`（首版 `IS NULL`）→ 失败抛 `MANUSCRIPT_VERSION_CONFLICT`；
  3. `versionNumber = current ? current.versionNumber + 1 : 1`；
  4. `parentVersionId = current?.id ?? null`（即被编辑的基线版本，promote 到历史版本后保存时血缘正确）；
  5. `contentHash = sha256Utf8(content)`；插入 chapter_versions 行；
  6. CAS 更新 `chapters.current_version_id = newVersionId`（同谓词，二重保护）；
  7. 更新 `chapters.updated_at`、`manuscripts.updated_at`；COMMIT。
- **Result**：`ChapterVersionPublicData`（含 content、contentHash、sourceType、provenance 字段）。
- **Errors**：`CHAPTER_NOT_FOUND`、`MANUSCRIPT_STATE_CONFLICT`（归档章节）、`MANUSCRIPT_VERSION_CONFLICT`（CAS）、`VALIDATION_ERROR`。
- **Idempotency**：**非幂等**（每次成功调用创建一个新版本）。重复防护：UI save-in-flight 锁（§9）；两个并发 save 指向同一基线时 CAS 只放行一个，另一个冲突回滚；`UNIQUE(project_id, chapter_id, version_number)` 兜底并发同号插入。AI 路径由 `uq_chapter_versions_task` 保证幂等（§11.3）。`clientRequestId` 去重机制显式列为未来 revisit（§13）——桌面单 worker + Renderer 串行保存下不需要。

---

**`promoteChapterVersion`**

- **Input**：`{projectId, chapterId, versionId, expectedCurrentVersionId | null}`
- **Preconditions**：chapter 存在/归属/active；目标 versionId 属于同一 chapter（跨章 → `CHAPTER_VERSION_NOT_FOUND`）；CAS 匹配。若 `versionId === current` → no-op 成功（幂等）。
- **Transaction**：单个 `BEGIN IMMEDIATE`；CAS `UPDATE chapters SET current_version_id = :versionId WHERE ... AND current_version_id = :expected`；更新 updatedAt；COMMIT。**不创建新版本**。
- **Result**：`ChapterVersionPublicData`（被设为 current 的版本）。
- **Errors**：`CHAPTER_NOT_FOUND`、`MANUSCRIPT_STATE_CONFLICT`、`CHAPTER_VERSION_NOT_FOUND`、`MANUSCRIPT_VERSION_CONFLICT`、`VALIDATION_ERROR`。
- **Idempotency**：幂等——重复 promote 同一已 current 版本返回成功。

---

**`updateChapterOrder`**

- **Input**：`{projectId, manuscriptId, chapterId, insertBeforeChapterId | null}`
- **Preconditions**：manuscript 存在/归属/active；目标章节与 insertBefore 目标同一 manuscript 且 active。
- **Transaction**：单个 `BEGIN IMMEDIATE`；计算目标 position（append / before-first / midpoint，gap==1 则 rebalance，§6.1）；更新该章节 `position`；更新 updatedAt；COMMIT。
- **Result**：`ChapterSummary[]`（完整新顺序，作为列表事实来源）。
- **Errors**：`MANUSCRIPT_NOT_FOUND`、`MANUSCRIPT_STATE_CONFLICT`、`CHAPTER_NOT_FOUND`、`VALIDATION_ERROR`。
- **Idempotency**：重复执行相同 move 收敛为 no-op（第二次目标即当前位置）；重排本身是 last-write-wins 语义，不携带 expectedVersion（单 worker 串行化下两次并发 move 都成功、后者覆盖前者），Renderer 以返回列表为准刷新（§9、§11）。

---

**`archiveChapter` / `restoreChapter`**

- **Input**：`{projectId, chapterId, expectedCurrentVersionId | null}`
- **Preconditions**：chapter 存在/归属；CAS 匹配当前指针。archive 要求 `status='active'`；restore 要求 `status='archived'`（已是目标状态 → no-op 成功）。
- **Transaction**：单个 `BEGIN IMMEDIATE`；CAS `UPDATE chapters SET status = :target WHERE ... AND current_version_id = :expected`（status 作为第二谓词）；更新 updatedAt；COMMIT。
- **Result**：`ChapterPublicData`。
- **Errors**：`CHAPTER_NOT_FOUND`、`MANUSCRIPT_VERSION_CONFLICT`、`VALIDATION_ERROR`。
- **Idempotency**：幂等——重复 archive 已归档章节返回成功；归档章节的 createChapterVersion/updateChapterOrder 返回 `MANUSCRIPT_STATE_CONFLICT`（不变量 8）。

---

**`updateManuscriptTitle`**

- **Input**：`{projectId, manuscriptId, title, expectedUpdatedAt}`
- **Preconditions**：manuscript 存在/归属；title trim 非空、≤ 200；CAS 匹配 `updated_at = expectedUpdatedAt`。
- **Transaction**：单个 `BEGIN IMMEDIATE`；CAS `UPDATE manuscripts SET title = :title, updated_at = :now WHERE ... AND updated_at = :expectedUpdatedAt`；COMMIT。
- **Result**：`ManuscriptPublicData`。
- **Errors**：`MANUSCRIPT_NOT_FOUND`、`MANUSCRIPT_VERSION_CONFLICT`、`VALIDATION_ERROR`。
- **Idempotency**：非幂等（last-write-wins + CAS）。`expectedUpdatedAt` 是轻量时间戳 CAS，单用户桌面场景足够；若未来多窗口并发编辑稿件元数据成为常态，升级为单调 version 号（§13 revisit）。

---

### 7.3 接口边界要点

- **读用例分页与排序**：V1 listChapters/listChapterVersions 不提供服务端分页（章节/版本数量为人工尺度，显式保存不会爆炸）；排序确定性由不变量 16 保证。分页触发条件：单章节版本数 > 1000（§13 revisit）。
- **version 内容是否在 list 返回**：listChapterVersions **不含 content**（避免大正文进列表）；含 `{id, versionNumber, title, sourceType, createdAt, parentVersionId, creationContractVersionId, contentHash}`。content 仅 `getChapterVersion` 返回。
- **重复请求 / idempotency**：见各操作规格；核心防护是 CAS 串行化 + UI 锁 + `uq_chapter_versions_task`（AI 幂等）。
- **跨 project 与 not-found**：不区分，统一 NOT_FOUND（§7 开头）。

---

## 8. 最小产品纵向切片

「Minimal Manuscript / Chapter Version」的**完成标准**（MV1-B 合并后全部满足）：

- [ ] 用户可在桌面 UI 打开项目稿件。
- [ ] 项目不存在稿件时可创建初始稿件（getOrCreateManuscript）。
- [ ] 用户可创建章节（空章节，出现在确定顺序的列表中）。
- [ ] 用户可查看确定顺序的章节列表（position ASC, id ASC）。
- [ ] 用户可打开某章节的当前版本（空章节 → 空白编辑器）。
- [ ] 用户可编辑标题和正文。
- [ ] 显式保存会创建不可变的新版本（createChapterVersion）。
- [ ] 并发冲突不会覆盖其他版本（CAS + 整笔回滚）。
- [ ] 用户可查看版本历史（listChapterVersions）。
- [ ] 用户可切换/恢复某个历史版本为 current（promoteChapterVersion）。
- [ ] 应用重启后数据仍存在（project.sqlite 持久化）。
- [ ] 所有操作严格限定在当前 project（§5 不变量 1）。

**V1 明确不需要**：AI 正文生成、Scene Planner、大纲、批量章节生成、实时协作、自动保存、富文本、版本 diff UI、版本 merge、分支稿件、评论和审稿、导出、全文搜索、移动端。

> 完成标准只统计 MV1-A + MV1-B。**MV1-B 合并前不得把本能力标为 ✅**（roadmap 维护协议，§12、§18）。

---

## 9. UI 与冲突语义（未来最小 Renderer）

> 本 PR 不实现 UI；以下冻结 MV1-B Renderer 必须遵守的交互与冲突语义。

**布局**（复用现有三栏 `.workspace` 结构，center 面板新增稿件工作台）：

- **左侧章节列表**：`role="list"`，每项 `role="listitem"`；显示当前版本标题（空章节显示占位「未命名章节」）、归档角标、`aria-current="page"` 标记当前打开章节；重排用可访问的「上移/下移」按钮（V1 不做拖拽手势）。
- **章节标题**：输入框（`aria-label="章节标题"`）。
- **正文编辑区**：`<textarea>`，`aria-label="正文编辑"`；输入即标记 `dirty`。
- **显式「保存新版本」**：按钮；保存期间 `aria-busy="true"` 且 **disabled**（save-in-flight 锁）。
- **当前 version 信息**：`role="status"` 显示「当前版本 #N · 保存于 …」。
- **版本历史列表**：`role="list"`，每项显示版本号、标题、sourceType、时间；当前项标记 `aria-current`。
- **「设为当前版本」**：对非当前历史版本提供按钮（promoteChapterVersion）。
- **未保存修改提示**：标题/正文相对已加载版本有改动时，状态栏显示「有未保存的修改」`role="status"`。
- **离开页面确认**：存在未保存修改时，章节切换 / 关闭窗口需确认（`beforeunload` + 项目内导航守卫；**现有代码无此机制，MV1-B 需新增**）。
- **CAS 冲突提示**：`MANUSCRIPT_VERSION_CONFLICT` → 显示冲突横幅（`role="alert"`，文案如「稿件已在其他操作中更新，数据已自动刷新」），不自动重发 mutation。
- **冲突后 refresh/reload 行为**：冲突时保留本地未保存文本，`getCurrentChapterVersion` 刷新服务器 current version，**由用户决定重新保存为新版本或放弃**。
- **保存中 disabled 状态**：见上。
- **错误和成功 live-region**：错误经 `RendererErrorBoundary` + `safe-error` 映射；成功/失败反馈用 `role="status"` / `role="alert"`。
- **Keyboard 可访问性**：完整键盘导航（章节列表方向键、编辑区、历史列表），focus 管理复用 `useFocusOnMount`/`useRestoreFocus` 工具。

**明确**：

```text
V1 不提供自动合并。
发生 CAS 冲突时保留本地未保存文本，
刷新服务器 current version，
由用户决定重新保存为新版本或放弃。
```

---

## 10. 与现有系统的边界

### 10.1 Creation Contract（§13.1）

- **Manuscript 记录初始 contract version**：`manuscripts.creation_contract_version_id`（getOrCreateManuscript 创建时记录当时的 current contract version，可为 null；**永不自动更新**）。
- **ChapterVersion 记录实际生成时使用的 contract version**：`chapter_versions.creation_contract_version_id`；`AI_GENERATION`/`AI_REWRITE` 必填，`USER`/`IMPORT` 可选（用户手写不强制关联契约）。
- **Contract 更新不影响已有稿件版本**：既有 ChapterVersion 的 `creation_contract_version_id` 永不被改写。原则：**历史 ChapterVersion 不得因 Contract 更新而变化**（不变量 14 之外的组织原则，也是 creation-contract-design.md「稿件边界」的延续）。

### 10.2 Task Engine（§13.2）

未来 AI task（`CHAPTER_GENERATION` / `CHAPTER_REWRITE` 等新 taskType）必须：

- 产生新 ChapterVersion（`sourceType='AI_GENERATION'`/`AI_REWRITE'`），绝不原地修改现有版本；
- 成功后才允许推进 current——settle 使用与用户保存相同的原子 `createChapterVersion`（create + CAS promote 同一事务）；
- 失败或 cancel 不改变 current（冲突 → task FAILED，无版本产生）；
- 保存 task/provenance（`createdByTaskId`、`invocationId`、`creationContractVersionId` 全部落版本行；prompt 只存 hash，task.resultJson 只存安全摘要）；
- 支持重复 delivery / recovery——`uq_chapter_versions_task` 部分唯一索引保证幂等（§11.3）；
- 不得直接写 Renderer 状态（Renderer 只读后端返回的 `ChapterVersionPublicData`）。

本设计只定义边界，不实现 task。

### 10.3 Scene Planner（§13.3）

**推荐锚点：chapter**，并记录 `baseChapterVersionId`（计划生成时该章的 current version）。

- 锚定 **chapter 版本**：REJECTED——每次保存都使计划「过期」，计划随版本更替碎片化，无法稳定关联；
- 锚定 **独立计划版本**：REJECTED——计划生命周期简单，独立版本化过度设计；
- 锚定 **chapter + baseChapterVersionId**：V1 推荐——计划绑定稳定身份（跨版本更替存活），同时保留内容基线（检测计划与正文失配），与 `ContractBaselineRef` 哲学一致。`baseChapterVersionId` 变化 → 计划可标记「相对正文已过期」。

### 10.4 Story State 与 Summary（§13.4）

未来摘要、事实提取、Ledger 条目必须引用**稳定 ChapterVersionId**（提取来源版本）+ `chapterId`（关联章节），**永不引用 current pointer**（pointer 会变化）。「当前摘要」也在提取时记录当时的 `currentVersionId`。这样 current 变化后历史追溯仍然有效（不变量 17）。

---

## 11. 并发、事务与恢复

### 11.1 正常保存（§14.1）

```
读取 current version A（客户端加载）
用户编辑（客户端本地）
提交 createChapterVersion(expectedCurrentVersionId = A.id)
事务（BEGIN IMMEDIATE）：
  CAS 验证 current_version_id == A.id          → 失败抛 MANUSCRIPT_VERSION_CONFLICT
  versionNumber = A.versionNumber + 1
  parentVersionId = A.id
  contentHash = sha256Utf8(content)
  INSERT chapter_versions(B)                    → B 行
  UPDATE chapters SET current_version_id = B.id（同 CAS 谓词，二重保护）
  UPDATE chapters.updated_at, manuscripts.updated_at
  COMMIT
返回 ChapterVersionPublicData(B)
```

### 11.2 并发冲突（§14.2）

```
客户端1读取 A         客户端2读取 A
客户端1 create(B) 并 A→B 成功
客户端2 create(C) 并 A→C → CAS 失败
```

**选择：整笔 rollback，不产生 C**（选项 A）。

理由：

- 保留 orphan C 会让历史出现「从未成为 current」的版本行，污染版本号单调性与血缘链，读侧必须区分「历史 superseded」与「孤儿失败产物」，放大实现自由度；
- CAS 失败已告知客户端冲突，客户端保留本地文本、刷新后重试即可，不需要后端保留任何中间态；
- 不变量 5「CAS 失败不得悄悄覆盖」与不变量 9「历史不 hard-delete」共同指向：要么全成、要么全无，版本行只代表成功的保存。

测试要求：并发两写仅一个成功；失败方无任何行残留；成功后 `versionNumber` 连续。

### 11.3 AI task 恢复（§14.3）

settle 语义（MV1-C）：

1. **task 成功但进程在 commit 前崩溃**：settle 是单个 `BEGIN IMMEDIATE` 事务（create + CAS promote 原子）。崩溃于 COMMIT 前 → 无任何写入；恢复时从已持久化的 `task.resultJson`（含生成正文与元数据）**重放 settle，不重调模型**。
2. **「version 已创建但 current 未推进」**：由于 create + promote 在**同一事务**，该状态**在构造上不可能出现**；唯一非 current 的版本是正常 superseded 的历史版本。若未来产品要「AI 产出待用户审核的未 promote 版本」（review-gate），那是一个显式产品决策，需引入 `promoteOnSuccess` 标志或独立的 create-without-promote 能力——见 §13 Open Questions，不阻塞本设计。
3. **重复 task 执行 / idempotency**：`uq_chapter_versions_task`（`UNIQUE(project_id, created_by_task_id) WHERE created_by_task_id IS NOT NULL`）是最终并发保护。第二次 settle 的 INSERT 命中唯一约束 → 视为已应用，返回既有版本并按其记录意图处理 promote（CAS 到目标或确认已 current）；**绝不产生重复版本**。
4. **如何避免重复版本**：唯一约束（DB 层，非先查后插）+ 单事务原子 + task.resultJson 幂等重放。与 creation_contract_draft 的 proposal 幂等模式同构（该模式用 `uq_cc_proposals_task`）。
5. **settle CAS 冲突**（生成期间用户已推进 current）：settle 的 `createChapterVersion` CAS 失败 → 事务回滚、不产生版本、task FAILED（错误码映射 `MANUSCRIPT_VERSION_CONFLICT` 的安全文案）。宁可失败重跑，绝不覆盖用户更新内容。
6. **recovery 接入**：复用 worker 启动序列的 runner-kernel 模式（`recoverPendingChapterTasks`），`RUNNING` task 由 `reconcileTasks` 统一置 `TASK_INTERRUPTED`/`INVOCATION_INTERRUPTED`（现有机制，无需变更）。

---

## 12. 实施切片

后续实现最多拆成三个主要 PR。设计可调整，但每个切片完成后必须在 roadmap 记录真实能力状态。

### MV1-A — Domain / Contracts / Database / Application

- **Scope**：领域类型与校验（Manuscript/Chapter/ChapterVersion、闭合枚举、branded ID、validator）；概念 schema 的 migration（version 7）；repository 实现（ManuscriptTransactionPort + 各 repo）；application 全部读写用例（§7）；CAS、事务、rebalance 语义；完整单元/集成测试。
- **Non-goals**：AI task；IPC；Renderer；不宣称产品能力完成。
- **Dependencies**：creation-contract C1 foundation（已合并）；grill foundation（已合并）。
- **Changed modules**：`packages/domain`、`packages/contracts`（ErrorCode/DTO/validator）、`packages/database`（migration v7 + repositories）、`packages/application`（use cases + ports + errors）。
- **Acceptance tests**：§14 中「后端」全部矩阵项（项目隔离、单稿、章节 create/list/order、版本不可变、CAS 成功/冲突、事务回滚、版本历史、promote 历史版本、archive/restore、跨章/跨 project 引用拒绝、确定性排序、大 Unicode 正文、restart 持久化、migration upgrade）。
- **Merge gate**：`pnpm check` 通过；`git diff --check` 干净。
- **Capability status after merge**：仍 ⬜（backend foundation 不构成产品能力）。

### MV1-B — IPC + Minimal Manuscript Renderer

- **Scope**：typed IPC（DesktopAPI.manuscript 组 + IPC_CHANNELS + 错误码映射）；preload 暴露 `window.desktop.manuscript.*`；Main `ipcMain.handle → forwardToWorker`；最小章节列表与编辑器、显式保存新版本、版本历史、promote、冲突横幅与保留未保存文本、离开确认、可访问性；backend E2E 与 Renderer 测试。
- **Non-goals**：AI task；diff UI；拖拽重排（用上移/下移按钮）；自动保存。
- **Dependencies**：MV1-A；accessibility foundation（已合并）。
- **Changed modules**：`packages/contracts`、`apps/desktop`（main/preload/renderer）、`apps/worker`（manuscript command dispatch + runner 不涉及）。
- **Acceptance tests**：§14 中「Renderer」矩阵项（未保存提示、冲突保留、可访问性）+ backend E2E 全链路。
- **Merge gate**：`pnpm check` 通过；手动验收 §8 完成标准清单全绿。
- **Capability status after merge**：✅ **Minimal Manuscript / Chapter Version**（此时才允许把 roadmap 标记为 ✅；不得提前）。

### MV1-C — AI Task Bridge

- **Scope**：`CHAPTER_GENERATION`/`CHAPTER_REWRITE` 任务类型；task 输出创建 ChapterVersion；provenance（taskId/invocationId/contractVersionId）；成功后 CAS 推进；失败不改变 current；recovery/idempotency（§11.3）。
- **Non-goals**：Scene Planner；整本生成；审稿；不涉及当前最小用户手写纵向切片。
- **Dependencies**：MV1-A（版本原语）；contract draft bridge 模式（已合并的 C2，作为 task 模式参照）。
- **Changed modules**：`packages/task-engine`、`apps/worker`（runner + reconcile）、`packages/application`（任务请求用例）、`packages/contracts`。
- **Acceptance tests**：§14 中「task」矩阵项（成功创建版本、CAS 冲突 task FAILED、崩溃重放幂等、重复执行不产生重复版本、失败不改变 current）。
- **Merge gate**：`pnpm check` 通过；离线 E2E（mock provider）。
- **Capability status after merge**：新增能力「AI 章节生成桥」；该切片**不阻塞** Minimal Manuscript / Chapter Version 的 ✅，可与 Scene Planner 协调或在其后。

---

## 13. 决策记录

### Decision Summary

| Decision               | Chosen option                                                                           | Alternatives rejected               | Reason                                                               | Future revisit trigger            |
| ---------------------- | --------------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------- | --------------------------------- |
| Manuscript cardinality | 每 project 至多一个 active + 多个 archived（partial unique index）                      | 多 active；一稿多本                 | V1 单稿满足产品；archived 可留多本；部分唯一索引是后续放开的最小代价 | 多稿/多卷产品需求                 |
| Version granularity    | 单章 ChapterVersion                                                                     | 整本快照                            | 避免一次正文修改复制整本；正文只存在于章节版本                       | 整本导出/快照需求                 |
| Title versioning       | title 属于 ChapterVersion 快照                                                          | title 存 Chapter 行                 | 改标题 = 保存新版本，与正文改动一致的版本语义                        | 标题独立于正文修订的需求          |
| Current pointer        | `chapters.current_version_id` 列                                                        | 计算 MAX(version)；独立映射表       | promote 历史版本需要显式指针；指针天然属于 Chapter 行                | current 多指针/分支模型           |
| CAS                    | `UPDATE ... WHERE current_version_id = expected`（首版 `IS NULL`）                      | 无 CAS；版本号 CAS                  | 与既有 expectedVersion 约定一致；指针 CAS 覆盖 promote 与 create     | 多人/多窗口协作                   |
| Save transaction       | create + promote 同一 `BEGIN IMMEDIATE` 事务                                            | 分两步提交                          | 全成或全无；不产生孤儿版本                                           | review-gate 的 AI 未 promote 版本 |
| Conflict result        | 整笔 rollback，不产生 C                                                                 | 保留 orphan C 不设 current          | 历史无孤儿；版本号单调；实现自由度最小                               | —                                 |
| Chapter ordering       | 稀疏整数 rank + midpoint + 显式 rebalance（GAP=1024）                                   | 连续整数 position                   | 中间插入/重排 O(1) 单行写；绕开连续方案的瞬时唯一冲突                | 批量/并发重排需求出现             |
| Archive/delete         | soft archive（status）+ append-only；无 hard-delete；project 删除文件级                 | 物理删除；ON DELETE CASCADE         | 版本历史永久保留；恢复可逆                                           | 导出/清理需求                     |
| Content format         | UTF-8 plain text（原始字节，不规范化、不压缩、无 FTS）                                  | Markdown AST；富文本；blob/外部文件 | TEXT 事务一致性 + 字节保真；V1 无富文本/检索需求                     | 富文本、全文搜索                  |
| Provenance             | 版本行内嵌 sourceType + taskId + invocationId + contractVersionId + parentVersionId     | 独立 provenance 表                  | 一行自带完整来源；无冗余查询                                         | 复杂血缘图查询                    |
| Contract linkage       | Manuscript 记初始锚点；ChapterVersion 记生成时 contract version；历史不随 Contract 更新 | Contract 更新级联改写版本           | 历史版本不可变；可追溯性在版本行                                     | —                                 |
| Scene Plan anchor      | chapter + baseChapterVersionId                                                          | 锚定版本；独立计划版本              | 稳定身份 + 内容基线                                                  | 计划跨版本复用需求                |
| Implementation slicing | MV1-A / MV1-B / MV1-C                                                                   | 单 PR；UI 先行                      | 边界清晰；backend foundation 不算产品能力                            | —                                 |
| Manuscript title CAS   | `expectedUpdatedAt` 时间戳 CAS                                                          | 单调 version 号                     | 元数据变更罕见；轻量足够                                             | 多窗口并发元数据编辑              |

### Open Questions

以下问题**不阻塞 MV1-A**，但必须给默认决定 + revisit 触发，不得留给实现 Agent 自由发挥：

| 问题                                                    | 默认决定                                                                        | Revisit trigger                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------- |
| AI 产出是否要「未 promote 待审核版本」（review-gate）？ | MV1-C 默认原子 create+promote，冲突则 task FAILED；review-gate 列为未来产品决策 | 产品要求「AI 输出先审后生效」时 |
| createChapterVersion 是否需要对相同内容去重？           | 不自动去重；用户显式保存即建版本                                                | 无意义版本增多                  |
| listChapters/listChapterVersions 是否需要分页？         | V1 不分页，确定性全量                                                           | 单章版本数 > 1000               |
| `clientRequestId` 幂等键？                              | V1 不做；CAS + UI 锁 + task 唯一索引已覆盖                                      | 多窗口/断网重试场景出现         |
| 批量导入章节（IMPORT sourceType）？                     | 保留枚举，V1 不实现导入用例                                                     | 导入需求                        |
| 稿件级 archive（archive 整个 manuscript）？             | 保留 `manuscripts.status='archived'` 语义，V1 不实现用例                        | 归档整稿需求                    |
| 导出/备份？                                             | 明确非目标                                                                      | 导出需求（roadmap M7）          |

真正阻塞 MV1-A 的未决问题：**零**。

---

## 14. 测试策略

测试矩阵（MV1-A/MV1-B/MV1-C 落点见「切片」列）：

| 测试项                              | 覆盖                                                                                   | 切片  |
| ----------------------------------- | -------------------------------------------------------------------------------------- | ----- |
| Project isolation                   | 跨 project 读写 manuscript/chapter/version 返回 NOT_FOUND；复合 FK 拒绝跨 project 引用 | MV1-A |
| One manuscript per project          | 第二个 active manuscript 插入失败；getOrCreate 并发只建一个                            | MV1-A |
| Chapter create/list/order           | 追加、insert-before-first、insert-middle、append 顺序确定；list 确定性排序             | MV1-A |
| Version immutability                | 创建后 UPDATE/DELETE 被 trigger 拒绝；hash 与内容一致                                  | MV1-A |
| CAS success                         | 正常保存版本号连续、指针推进、parent 正确                                              | MV1-A |
| CAS conflict                        | 并发两写仅一个成功；失败方无行残留；错误码 MANUSCRIPT_VERSION_CONFLICT                 | MV1-A |
| Transaction rollback                | createChapterVersion 任一步失败整笔回滚（无版本行、无指针变化）                        | MV1-A |
| Version history                     | listChapterVersions 确定性排序（version_number DESC, id ASC）、不含 content            | MV1-A |
| Promote historical version          | 设为 current 后 current = 历史版本；再保存血缘 parent = 该历史版本；promote 幂等       | MV1-A |
| Archive/restore                     | 归档章节不可接收新版本/重排；restore 后恢复；重复 archive no-op                        | MV1-A |
| Invalid cross-chapter version       | promote 或 current 指向其他章节版本 → 拒绝（复合 FK + 应用校验）                       | MV1-A |
| Invalid cross-project task/contract | AI provenance 引用其他 project 的 task/invocation/contract → FK 拒绝                   | MV1-A |
| Deterministic ordering              | 相同数据下 list 输出字节级一致；次要排序键 id 生效                                     | MV1-A |
| Large Unicode content               | 多字节/astral/组合字符正文 round-trip 保真；hash 确定；长度上限边界                    | MV1-A |
| Restart persistence                 | 关闭重开后 manuscript/chapter/version 完整                                             | MV1-A |
| Migration upgrade                   | v6 → v7 幂等迁移；旧项目打开正常；重新打开不重复迁移                                   | MV1-A |
| Renderer unsaved changes            | dirty 标记、离开确认触发、切换章节提示                                                 | MV1-B |
| Renderer conflict preservation      | CAS 冲突保留本地文本、刷新 current、用户决定重存/放弃                                  | MV1-B |
| Accessibility                       | 章节列表/编辑器/历史列表键盘可达；live-region 成功/失败反馈；focus 管理                | MV1-B |
| Task success                        | AI task settle 创建版本 + 推进 current 原子完成                                        | MV1-C |
| Task failure/recovery               | settle CAS 冲突 → task FAILED 不改 current；崩溃重放幂等；重复执行不产生重复版本       | MV1-C |
| Idempotency (task)                  | `uq_chapter_versions_task` 阻止同 task 双版本                                          | MV1-C |

---

## 附：与 roadmap 的关系

能力状态按 `docs/development/generation-quality-roadmap.md` 维护：

- 本设计 PR 合并后，`Minimal Manuscript / Chapter Version` 标为 🟡（design PR 进行中，实现未开始）；
- MV1-A 合并后仍 🟡（backend foundation 不构成产品能力）；
- **仅 MV1-B 合并后**标 ✅；
- 任何进度记录不得声称数据库、UI 或稿件产品能力已完成，除非对应切片真实合并。
