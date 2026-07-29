# 创作契约架构设计

> 状态：设计文档（M1-C0），尚未实现。
> 基线：5cefd6e (2026-07-29)

## 1. 目标

定义从 Grill 结果到权威创作规格的完整边界：

```
Grill answers/proposals
→ CreationContractProposal（AI 生成，不可变，非权威）
→ explicit review（用户提交 typed review patch）
→ immutable CreationContractVersion（权威版本，包含 sections + locks）
```

创作契约是项目创作意图的唯一权威来源。后续所有生成能力（大纲、章节、PlotPilot）必须消费已接受的 ContractVersion snapshot，不得自行推断创作意图。

## 2. 不变量

以下不变量在任何实现中不可违反：

1. **AI 永远不能直接更新当前创作契约**——AI 只生成 proposal
2. **Proposal 不可变**——AI 生成的 sectionsJson 和 sectionsHash 永远表示原始 AI 输出，任何代码路径不得修改已持久化 proposal
3. **用户修改通过显式 review intent 提交**——Renderer 提交 typed review operations，不修改 proposal
4. **用户显式接受后才创建权威版本**——没有自动接受路径
5. **已锁定字段不得被 AI proposal 静默覆盖**——lock 是硬约束
6. **用户输入和用户确认内容优先于模型建议**——provenance 中 USER_EDIT > AI_PROPOSAL
7. **所有 mutation 必须携带适用于其 aggregate 的 expected version/state/hash**——乐观并发控制
8. **接受、版本写入、current pointer 更新必须同一事务**——原子性
9. **Proposal 和 version 不存 prompt 明文**——只存 hash
10. **Renderer 不组装持久化 ContractVersion**——后端返回值是事实来源
11. **历史版本不可变**——已写入的 version 不可修改或删除
12. **Lock 状态属于 ContractVersion snapshot**——权威活跃锁集合从 version 读取
13. **不允许接受时静默丢弃用户编辑**——reviewPatch 中每个 operation 必须被应用或整个 accept 失败

## 3. V1 数据模型

### ContractBaselineRef

首次契约生成和后续生成共用的基线引用模型：

```typescript
interface ContractBaselineRef {
  contractVersionId: string | null;
  contractVersion: number | null;
  contractSnapshotHash: string | null;
}
```

**规则**：

- **首次生成**（项目无契约）：三个字段均为 null，lockedFieldPaths = []
- **存在当前契约时**：三个字段均非 null，且 versionId/version/hash 必须相互匹配
- **禁止部分 null**：id 有值但 hash 为 null、version 有值但 id 为 null 等不完整组合是验证错误
- 首次 proposal 的 `baseContractVersion = null`，不执行 current contract version stale 比较
- 首次生成仍执行 Grill session version stale 比较

### CreationContractProposal

AI 生成的契约草案，**不可变**，非权威。

| 字段                    | 类型              | 说明                                   |
| ----------------------- | ----------------- | -------------------------------------- |
| id                      | string (ULID)     | 主键                                   |
| projectId               | string            | 所属项目                               |
| taskId                  | string            | 生成此 proposal 的任务                 |
| invocationId            | string            | 关联的模型调用                         |
| status                  | ProposalStatus    | 当前状态                               |
| baseGrillSessionId      | string            | 基于哪个 Grill session                 |
| baseGrillSessionVersion | number            | 基于的 session 版本                    |
| baseContractVersion     | number \| null    | 基于的契约版本（首次为 null）          |
| schemaVersion           | number            | 契约 schema 版本（单调整数）           |
| sectionsJson            | string            | 规范化 JSON（canonical serialization） |
| sectionsHash            | string            | sectionsJson 的 SHA-256                |
| createdAt               | string (ISO 8601) | 创建时间                               |
| updatedAt               | string (ISO 8601) | 最后更新时间（仅 status 变更时更新）   |

**不可变性约束**：

- `sectionsJson` 和 `sectionsHash` 在 INSERT 后不可 UPDATE
- Renderer 不得直接修改已持久化 proposal
- 不存在 "update proposal sections" 的 API 或用例
- `updatedAt` 仅在 status 转换时变化

**ProposalStatus**：

| 状态       | 含义                     |
| ---------- | ------------------------ |
| PROPOSED   | 等待用户审核             |
| ACCEPTED   | 用户已接受，已创建版本   |
| REJECTED   | 用户已拒绝               |
| SUPERSEDED | 被更新的 proposal 取代   |
| STALE      | 基础数据已变化，不再有效 |

### CreationContractVersion

不可变的权威创作契约版本。包含 sections 和 lockedFieldPaths 的完整快照。

| 字段                       | 类型              | 说明                                                             |
| -------------------------- | ----------------- | ---------------------------------------------------------------- |
| id                         | string (ULID)     | 主键                                                             |
| projectId                  | string            | 所属项目                                                         |
| version                    | number            | 单调递增版本号（项目内唯一，从 1 开始）                          |
| schemaVersion              | number            | 契约 schema 版本（单调整数）                                     |
| sourceProposalId           | string \| null    | 来源 proposal（用户手动创建时为 null）                           |
| basedOnGrillSessionId      | string \| null    | 关联的 Grill session                                             |
| basedOnGrillSessionVersion | number \| null    | 关联的 session 版本                                              |
| sectionsJson               | string            | 规范化 JSON                                                      |
| lockedFieldPathsJson       | string            | 规范化 JSON 数组（canonical sorted unique set）                  |
| contractSnapshotHash       | string            | SHA-256(sections + lockedFieldPaths + schemaVersion)             |
| provenanceJson             | string            | 各字段来源追踪                                                   |
| createdAt                  | string (ISO 8601) | 创建时间                                                         |
| createdBy                  | string            | 创建者（'user' \| 'ai-proposal-accepted' \| 'lock' \| 'unlock'） |

**contractSnapshotHash 计算**：

```
input = canonicalSerialize({ sections, lockedFieldPaths, schemaVersion })
contractSnapshotHash = SHA-256(input)
```

hash 同时覆盖 sections 内容、锁定字段集合和 schema 版本。后续生成只需指定 contractVersionId + contractSnapshotHash，不再从外部表拼装历史约束。

### CreationContractCurrentPointer

语义等价模型：每个项目至多一个 current version。

| 字段             | 类型              | 说明         |
| ---------------- | ----------------- | ------------ |
| projectId        | string (PK)       | 项目         |
| currentVersionId | string            | 当前版本 ID  |
| updatedAt        | string (ISO 8601) | 最后更新时间 |

current version number 从 version row 读取，不在 pointer 中冗余存储。

### ContractFieldProvenance

每个 section/field 的来源追踪（存储在 version 的 provenanceJson 中）：

| 字段              | 类型             | 说明                                         |
| ----------------- | ---------------- | -------------------------------------------- |
| sectionKey        | string           | 字段路径（如 "/protagonist/name"）           |
| source            | ProvenanceSource | 来源类型                                     |
| grillAnswerIds    | string[]         | 关联的 Grill 回答                            |
| grillProposalIds  | string[]         | 关联的 Grill proposal                        |
| aiTaskId          | string \| null   | AI 任务 ID                                   |
| modelInvocationId | string \| null   | 模型调用 ID                                  |
| sourceProposalId  | string \| null   | 来源 proposal ID                             |
| previousFieldHash | string \| null   | proposal 中该字段的 hash（USER_EDIT 时记录） |
| rationale         | string \| null   | AI 给出的理由（不含 prompt）                 |

**ProvenanceSource**：`GRILL_ANSWER` | `AI_PROPOSAL` | `USER_EDIT` | `PREVIOUS_VERSION` | `DEFAULT`

**USER_EDIT provenance 规则**：

- 保留 sourceProposalId（来自哪个 proposal）
- 标记 source = USER_EDIT
- 保留原始 AI task/invocation 来源（aiTaskId、modelInvocationId）
- 记录 previousFieldHash（proposal 中该字段的 hash，证明修改基于什么）

### ContractFieldLock（派生审计记录）

Lock/unlock 事件记录。**不是权威当前状态**——权威活跃锁集合属于 CreationContractVersion.lockedFieldPathsJson。

| 字段      | 类型              | 说明                                   |
| --------- | ----------------- | -------------------------------------- |
| id        | string (ULID)     | 主键                                   |
| projectId | string            | 所属项目                               |
| fieldPath | string            | 锁定字段路径（如 "/protagonist/name"） |
| action    | string            | 'LOCK' \| 'UNLOCK'                     |
| versionId | string            | 产生此事件的 ContractVersion ID        |
| createdAt | string (ISO 8601) | 事件时间                               |
| createdBy | string            | 操作者                                 |

此表是 append-only 审计日志，可从 version 历史完整重建。版本号通过 versionId 关联查询，不冗余存储。

## 4. V1 Typed Schema

V1 使用明确、有限的首版 section 定义，不使用 `Record<string, unknown>`。

### schemaVersion 策略

- `schemaVersion` 使用单调整数：1, 2, 3...
- 每次结构变化递增（无论新增可选字段还是修改必填字段）
- 兼容性由显式 compatibility/migration 表说明（实现时定义）
- 不使用 major/minor 或 semver

### Schema 定义

| Section Key          | 类型                | 必填 | 限制                                                          | 说明                    |
| -------------------- | ------------------- | ---- | ------------------------------------------------------------- | ----------------------- |
| premise              | scalar (string)     | 是   | ≤2000 字符，trim 后非空                                       | 核心前提/故事概念       |
| genre                | list (string[])     | 是   | 1–5 项，每项 ≤50 字符，trim 后非空                            | 类型标签                |
| tone                 | list (string[])     | 是   | 1–5 项，每项 ≤50 字符，trim 后非空                            | 基调标签                |
| themes               | list (string[])     | 否   | 0–10 项，每项 ≤100 字符，trim 后非空                          | 主题                    |
| targetAudience       | scalar (string)     | 是   | ≤200 字符，trim 后非空                                        | 目标读者                |
| narrativePov         | scalar (enum)       | 是   | FIRST \| THIRD_LIMITED \| THIRD_OMNISCIENT \| SECOND \| OTHER | 叙事视角                |
| tense                | scalar (enum)       | 是   | PAST \| PRESENT \| MIXED                                      | 时态                    |
| targetLength         | structured          | 否   | 见下                                                          | 目标长度                |
| structure            | scalar (string)     | 否   | ≤500 字符，trim 后非空                                        | 结构说明（三幕/多线等） |
| protagonist          | structured          | 是   | 见下                                                          | 主角                    |
| supportingCharacters | list (structured[]) | 否   | 0–20 项                                                       | 配角                    |
| relationships        | list (structured[]) | 否   | 0–30 项                                                       | 关系                    |
| worldRules           | list (string[])     | 否   | 0–20 项，每项 ≤300 字符，trim 后非空                          | 世界规则                |
| mustInclude          | list (string[])     | 否   | 0–20 项，每项 ≤200 字符，trim 后非空                          | 必须包含                |
| mustAvoid            | list (string[])     | 否   | 0–20 项，每项 ≤200 字符，trim 后非空                          | 必须避免                |
| contentBoundaries    | structured          | 否   | 见下                                                          | 内容边界                |
| unresolvedQuestions  | list (string[])     | 否   | 0–20 项，每项 ≤300 字符，trim 后非空                          | 未决问题                |

### targetLength 结构

| 字段  | 类型   | 必填 | 限制                                                              |
| ----- | ------ | ---- | ----------------------------------------------------------------- |
| unit  | enum   | 是   | 'words' \| 'chapters'（稳定枚举）                                 |
| value | number | 是   | 正整数，words ≤ 10000000，chapters ≤ 5000，禁止 NaN/浮点/Infinity |

### protagonist 结构

| 字段         | 类型     | 必填 | 限制                                 |
| ------------ | -------- | ---- | ------------------------------------ |
| characterKey | string   | 是   | ≤50 字符，schema 内唯一，稳定引用键  |
| name         | string   | 是   | ≤100 字符，trim 后非空               |
| role         | string   | 否   | ≤200 字符                            |
| motivation   | string   | 否   | ≤500 字符                            |
| arc          | string   | 否   | ≤500 字符                            |
| traits       | string[] | 否   | 0–10 项，每项 ≤100 字符，trim 后非空 |

### supportingCharacters 项结构

| 字段         | 类型     | 必填 | 限制                                 |
| ------------ | -------- | ---- | ------------------------------------ |
| characterKey | string   | 是   | ≤50 字符，schema 内唯一，稳定引用键  |
| name         | string   | 是   | ≤100 字符，trim 后非空               |
| role         | string   | 否   | ≤200 字符                            |
| relationship | string   | 否   | ≤200 字符                            |
| traits       | string[] | 否   | 0–10 项，每项 ≤100 字符，trim 后非空 |

### relationships 项结构

| 字段             | 类型   | 必填 | 限制                                                  |
| ---------------- | ------ | ---- | ----------------------------------------------------- |
| relationshipKey  | string | 是   | ≤50 字符，schema 内唯一，稳定引用键                   |
| fromCharacterKey | string | 是   | 引用 protagonist/supportingCharacters 的 characterKey |
| toCharacterKey   | string | 是   | 引用 protagonist/supportingCharacters 的 characterKey |
| type             | string | 是   | ≤100 字符，trim 后非空                                |
| dynamic          | string | 否   | ≤300 字符                                             |

**角色引用规则**：

- 所有角色（protagonist + supportingCharacters）拥有稳定 `characterKey`
- relationships 拥有稳定 `relationshipKey`
- relationships 使用 `fromCharacterKey` / `toCharacterKey` 引用角色
- 不使用可重复、可修改的显示姓名作为引用键
- characterKey 和 relationshipKey 在 schema 内唯一，格式由验证函数约束（`[a-z0-9_-]{1,50}`）

### contentBoundaries 结构

| 字段              | 类型     | 必填 | 限制                                 |
| ----------------- | -------- | ---- | ------------------------------------ |
| rating            | string   | 否   | ≤50 字符                             |
| allowedContent    | string[] | 否   | 0–20 项，每项 ≤200 字符，trim 后非空 |
| prohibitedContent | string[] | 否   | 0–20 项，每项 ≤200 字符，trim 后非空 |
| notes             | string   | 否   | ≤500 字符                            |

### Optional 字段 canonical 规则

V1 采用以下唯一规则：

- **缺失 = 未提供**：optional 字段不存在于 JSON 中
- **不使用 null 表示缺失**：null 不是合法 optional 值
- **空字符串不合法**：所有字符串 trim 后不得为空（除非字段明确允许空）
- **空数组 = 显式无内容**：`[]` 表示用户/AI 明确表示"无此项"
- **缺失 vs 空数组语义不同**：缺失 = 未决定，`[]` = 已决定无内容

### Canonical Serialization

所有需要 hash 的 JSON 数据使用以下规范化序列化：

1. **Object key 排序**：递归按 Unicode code point 升序排列
2. **数组顺序有语义**：数组元素顺序保持不变（list 的顺序是内容的一部分）
3. **Unicode normalization**：所有字符串 NFC 规范化
4. **Number serialization**：使用 JSON 最短表示（无尾随零、无 `+`、无 leading zero）
5. **禁止 undefined**：序列化输入不得包含 undefined 值
6. **无多余空白**：紧凑格式（无空格、无换行）
7. **hash 输入必须包含 schemaVersion 和 lockedFieldPaths**

## 5. Provenance

每个 section/field 能追踪完整来源链：

- **Grill answer IDs**：哪些 Grill 回答影响了此字段
- **Grill proposal IDs**：哪些 Grill proposal 被接受后影响此字段
- **AI task ID**：生成此字段的 CREATION_CONTRACT_DRAFT 任务
- **Model invocation ID**：具体的模型调用记录
- **Source proposal ID**：来自哪个 CreationContractProposal
- **User edit**：用户通过 review operations 修改的字段标记 source = USER_EDIT
- **Previous contract version**：继承自前一版本的字段
- **Rationale**：AI 给出的理由（不含 prompt 明文）

**约束**：

- 不得把 prompt 明文写入 provenance
- Rationale 是 AI 输出的摘要，不是原始 prompt
- 用户编辑覆盖 AI 来源时：
  - 保留原始 AI task/invocation 来源
  - source 标记为 USER_EDIT
  - 记录 previousFieldHash（proposal 中该字段的 hash）
  - 不删除 AI 历史

## 6. Lock 语义

### 基本规则

- 用户可显式 lock/unlock 任意 field path
- **权威活跃锁集合属于 CreationContractVersion snapshot**（lockedFieldPathsJson）
- Lock/unlock 创建新的不可变 ContractVersion（sections 内容不变，lockedFieldPaths 改变）
- Lock/unlock 使用 expectedContractVersion（乐观并发控制）
- Current pointer 在同一事务更新
- provenance/audit 标记 createdBy = 'lock' 或 'unlock'

### lockedFieldPaths Canonical Set

lockedFieldPaths 是集合，不是有序业务列表。在 contractSnapshotHash 计算前必须：

1. 验证每个路径符合 V1 field path grammar（见第 9 节）
2. NFC normalize
3. 去重（重复 lock path 是验证错误）
4. 按 Unicode code point 升序排序
5. 序列化为 canonical JSON array

**约束**：

- 相同 sections/schema/lock set 必须产生相同 hash
- 不受 lock 操作历史顺序影响
- 重复 lock path 是验证错误（不是静默去重）
- Parent path 已锁时，拒绝冗余 descendant lock（V1 不允许）
- Unlock parent 后不存在 child lock（因为上述禁止规则，V1 不会出现此组合）

### Lock/Unlock 操作

**LockCreationContractField**：

1. 读取当前 version（CAS expectedContractVersion）
2. 验证 fieldPath 符合 path grammar
3. 验证 fieldPath 不在当前 lockedFieldPaths 中（重复 → 错误）
4. 验证 fieldPath 不是已锁 path 的 descendant（冗余 → 错误）
5. 构造新 lockedFieldPaths = sorted unique(当前 + fieldPath)
6. sections 保持不变
7. 计算新 contractSnapshotHash
8. 插入新 ContractVersion（version + 1）
9. 更新 current pointer
10. 追加 lock event 审计记录
11. 同一事务提交

**UnlockCreationContractField**：

1. 读取当前 version（CAS expectedContractVersion）
2. 验证 fieldPath 在当前 lockedFieldPaths 中
3. 构造新 lockedFieldPaths = sorted unique(当前 - fieldPath)
4. sections 保持不变
5. 计算新 contractSnapshotHash
6. 插入新 ContractVersion（version + 1）
7. 更新 current pointer
8. 追加 unlock event 审计记录
9. 同一事务提交

### AI Proposal 与 Lock 的交互

- 模型 prompt 明确提供 locked fields 及其固定值
- 模型输出若改变 locked field：
  - strict validator 拒绝
  - task FAILED
  - 不持久化 proposal
  - 错误码：`CONTRACT_MODEL_LOCK_VIOLATION`
- 不创建"包含 locked-field 变更但等待用户接受"的 proposal
- Accept 阶段仍重新验证 locks（防止 proposal 生成后发生并发 lock 变化）
- Accept-time lock 冲突错误码：`CONTRACT_LOCK_CONFLICT`

### 用户修改 Locked Field

- 用户自己修改 locked field 时需要先显式 unlock
- Unlock 创建新版本（lockedFieldPaths 移除该字段）
- 然后用户通过 review operations 或 UpdateCreationContractByUser 修改字段
- 修改后可重新 lock

### 下游消费

- 后续大纲生成必须从 ContractVersion snapshot 读取 lockedFieldPaths
- PlotPilot 必须从 ContractVersion snapshot 读取 lockedFieldPaths
- 章节生成必须从 ContractVersion snapshot 读取 lockedFieldPaths
- 生成请求传递 contractVersionId + contractSnapshotHash
- 生成器必须尊重 lockedFieldPaths，不得在输出中违反锁定约束

### 审计

- `creation_contract_lock_events` 表是 append-only 审计日志
- 不是权威当前状态
- 可从 version 历史完整重建
- 如果保留 materialized active-lock index，必须明确：
  - 它是可重建派生数据
  - 不是 source of truth
  - 与 current pointer 在同一事务更新

## 7. Stale 和并发

### Proposal 记录

每个 proposal 至少记录：

- `baseGrillSessionVersion`：生成时的 Grill session 版本
- `baseContractVersion`：生成时的契约版本（首次为 null）

### 接受时验证

AcceptCreationContractProposal 必须验证：

| 检查项                            | 失败错误码                       |
| --------------------------------- | -------------------------------- |
| expectedProposalSectionsHash 匹配 | CONTRACT_PROPOSAL_STALE          |
| expectedGrillSessionVersion 匹配  | CONTRACT_PROPOSAL_STALE          |
| expectedContractVersion 匹配      | CONTRACT_VERSION_CONFLICT        |
| proposal status = PROPOSED        | CONTRACT_PROPOSAL_NOT_ACCEPTABLE |
| reviewPatch 不违反 locked fields  | CONTRACT_LOCK_CONFLICT           |
| project/session ownership         | CONTRACT_PROPOSAL_NOT_FOUND      |
| schemaVersion 支持                | CONTRACT_SCHEMA_UNSUPPORTED      |

### Reject CAS

RejectCreationContractProposal 必须使用 CAS：

```
输入：
  projectId
  proposalId
  expectedProposalSectionsHash

CAS 谓词：
  UPDATE creation_contract_proposals
  SET status = 'REJECTED', updated_at = ?
  WHERE project_id = ?
    AND id = ?
    AND status = 'PROPOSED'
    AND sections_hash = ?;

affected rows != 1 → CONTRACT_PROPOSAL_NOT_ACCEPTABLE
```

- Reject 不改变 sectionsJson/sectionsHash
- Reject 必须验证 sections_hash 匹配（防止对已过时内容执行 reject）

**并发测试要求**：

- Accept 与 Reject 竞争：只有一个成功
- 两个 Reject 竞争：只有一个成功
- Stale hash Reject：失败（CONTRACT_PROPOSAL_NOT_ACCEPTABLE）
- Reject 后 sectionsJson/sectionsHash 不变

### 错误语义

| 错误码                           | 含义                           | 可恢复              |
| -------------------------------- | ------------------------------ | ------------------- |
| CONTRACT_VERSION_CONFLICT        | 契约版本已变化                 | 是（刷新后重试）    |
| CONTRACT_PROPOSAL_STALE          | 基础数据已变化                 | 是（重新生成）      |
| CONTRACT_PROPOSAL_NOT_FOUND      | Proposal 不存在或无权限        | 否                  |
| CONTRACT_PROPOSAL_NOT_ACCEPTABLE | Proposal 状态/hash 不允许操作  | 否                  |
| CONTRACT_LOCK_CONFLICT           | Accept-time reviewPatch 违反锁 | 是（unlock 后重试） |
| CONTRACT_MODEL_LOCK_VIOLATION    | Generation-time 模型输出违反锁 | 否（需重新生成）    |
| CONTRACT_SCHEMA_UNSUPPORTED      | Schema 版本不支持              | 否（需升级）        |

**错误码分工**：

- `CONTRACT_MODEL_LOCK_VIOLATION`：generation-time，模型输出改变了 locked field，task FAILED，不持久化 proposal
- `CONTRACT_LOCK_CONFLICT`：accept-time race，proposal 生成后 lock 状态发生变化，reviewPatch 与当前锁冲突

所有错误码必须稳定、可测试、安全（不暴露内部细节）。

### expectedContractVersion 语义

- 空项目首次创建版本：`expectedContractVersion = null`（表示"当前无版本"）
- 所有后续操作：`expectedContractVersion = 当前版本号`（正整数）
- 全部用例统一使用此规则

### Current Pointer CAS Predicate

`expectedContractVersion` 落实为数据库 CAS 的具体语义：

**存在当前版本时**（expectedContractVersion 非 null）：

1. Application 根据 expectedContractVersion 查询 expected version row，获取 expectedCurrentVersionId
2. 事务使用 `BEGIN IMMEDIATE`
3. 更新 pointer：

```sql
UPDATE creation_contract_current
SET current_version_id = ?, updated_at = ?
WHERE project_id = ?
  AND current_version_id = ?;
-- 最后一个参数为 expectedCurrentVersionId
```

4. `affected rows != 1` → `CONTRACT_VERSION_CONFLICT`，回滚事务

**首次创建时**（expectedContractVersion = null）：

1. 事务使用 `BEGIN IMMEDIATE`
2. 插入 pointer：

```sql
INSERT INTO creation_contract_current (project_id, current_version_id, updated_at)
VALUES (?, ?, ?);
```

3. PK 冲突证明存在并发 current pointer 创建 → `CONTRACT_VERSION_CONFLICT`，回滚事务

## 8. 持久化设计

### 表设计（project.sqlite）

#### creation_contract_proposals

```sql
CREATE TABLE creation_contract_proposals (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PROPOSED'
    CHECK (status IN ('PROPOSED','ACCEPTED','REJECTED','SUPERSEDED','STALE')),
  base_grill_session_id TEXT NOT NULL,
  base_grill_session_version INTEGER NOT NULL CHECK (base_grill_session_version > 0),
  base_contract_version INTEGER,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  sections_json TEXT NOT NULL,
  sections_hash TEXT NOT NULL CHECK (length(sections_hash) = 64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (invocation_id) REFERENCES model_invocations(id)
) STRICT;
```

#### creation_contract_versions

```sql
CREATE TABLE creation_contract_versions (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  source_proposal_id TEXT,
  based_on_grill_session_id TEXT,
  based_on_grill_session_version INTEGER,
  sections_json TEXT NOT NULL,
  locked_field_paths_json TEXT NOT NULL DEFAULT '[]',
  contract_snapshot_hash TEXT NOT NULL CHECK (length(contract_snapshot_hash) = 64),
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
    CHECK (created_by IN ('user','ai-proposal-accepted','lock','unlock')),
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, version),
  FOREIGN KEY (project_id, source_proposal_id)
    REFERENCES creation_contract_proposals(project_id, id)
) STRICT;
```

**约束说明**：

- `UNIQUE(project_id, id)`：通过复合 PK 实现
- `UNIQUE(project_id, version)`：项目内版本号唯一
- `CHECK(version > 0)`：版本号正整数
- `CHECK(schema_version > 0)`：schema 版本正整数
- `CHECK(created_by IN (...))`：创建者枚举
- `CHECK(length(...hash) = 64)`：长度检查（见 hash 验证层说明）
- 复合 FK `(project_id, source_proposal_id)` → proposals：确保 version 不能引用其他项目的 proposal

#### creation_contract_current

```sql
CREATE TABLE creation_contract_current (
  project_id TEXT NOT NULL PRIMARY KEY,
  current_version_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id, current_version_id)
    REFERENCES creation_contract_versions(project_id, id)
) STRICT;
```

**设计决策**：

- 只存 `project_id`、`current_version_id`、`updated_at`
- 不存储冗余 `current_version` 数字——从 version row 读取
- 复合 FK `(project_id, current_version_id)` 确保 pointer 不指向其他项目的 version

#### creation_contract_lock_events

```sql
CREATE TABLE creation_contract_lock_events (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  field_path TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('LOCK','UNLOCK')),
  version_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, version_id)
    REFERENCES creation_contract_versions(project_id, id)
) STRICT;
```

Append-only 审计日志。不是权威当前状态。可从 version 历史完整重建。版本号通过 version_id JOIN 查询，不冗余存储。

### SHA-256 Hash 验证层

V1 采用分层验证策略：

- **SQLite 层**：仅做 `length(hash) = 64` 检查（防止明显无效数据）
- **Domain/Repository 层**：写入前验证 lowercase SHA-256 hex（`/^[0-9a-f]{64}$/`）
- **读取时**：可复核 hash 与内容一致性（defense-in-depth，非必须路径）

`sections_hash` 和 `contract_snapshot_hash` 使用同一验证规范。

### Accept 事务

AcceptCreationContractProposal 的原子事务步骤：

1. `BEGIN IMMEDIATE`
2. CAS 验证 current pointer（见第 7 节 CAS predicate）
3. CAS 更新 proposal status（`WHERE status = 'PROPOSED' AND sections_hash = ?`）
4. 加载原始 proposal sections
5. 应用 typed review operations
6. 验证 schema（strict）
7. 验证 locks（operations 不违反当前 lockedFieldPaths）
8. 生成 provenance
9. 计算 contractSnapshotHash
10. 插入 creation_contract_versions
11. 更新 creation_contract_current
12. 同一事务提交，任一步失败全部回滚

### 约束和事务

- 所有表使用 STRICT mode
- Foreign keys 启用
- JSON 字段使用 canonical serialization（key 排序、NFC、无多余空白）
- contractSnapshotHash 在写入前计算，读取时可验证完整性
- 不保存 secret 或 prompt 明文
- Source proposal ownership 通过复合 FK 在数据库层保证

### Migration Compatibility

- 新表通过 project.sqlite 迁移机制添加
- 迁移幂等（IF NOT EXISTS）
- 旧项目无契约数据时 current pointer 不存在（正常状态）

## 9. 应用层用例

### Stable Field Path Grammar

V1 使用 JSON Pointer 风格路径语法：

```
/sectionKey
/sectionKey/fieldKey
/collectionSection/{stableKey}/fieldKey
```

**路径示例**：

```
/premise
/genre
/protagonist/name
/protagonist/traits
/supportingCharacters/{characterKey}/role
/supportingCharacters/{characterKey}/traits
/relationships/{relationshipKey}/type
/relationships/{relationshipKey}/dynamic
/contentBoundaries/allowedContent
/targetLength/value
```

**规则**：

- Scalar/struct 字段使用固定路径段
- Collection 成员使用稳定 key（characterKey、relationshipKey），不使用数组 index
- 路径段 NFC 规范化
- 验证函数拒绝未知路径、无效 key 格式

### Typed Review Operations

最终 contracts 类型是闭合、可穷举的 operation union。Renderer/DesktopAPI 使用解析后的 typed DTO，不使用任意 `string + unknown`。

```typescript
type ContractPatchOperation =
  | SetScalarFieldOperation
  | SetStringListFieldOperation
  | SetStructuredFieldOperation
  | RemoveOptionalFieldOperation
  | UpsertCharacterOperation
  | RemoveCharacterOperation
  | UpsertRelationshipOperation
  | RemoveRelationshipOperation;
```

**Operation 定义**：

| Operation                    | kind                  | 目标                                       | 值类型                    |
| ---------------------------- | --------------------- | ------------------------------------------ | ------------------------- |
| SetScalarFieldOperation      | 'set-scalar'          | 固定 scalar 路径                           | typed scalar value        |
| SetStringListFieldOperation  | 'set-string-list'     | 固定 string[] 路径                         | string[]                  |
| SetStructuredFieldOperation  | 'set-structured'      | 固定 structured 路径（targetLength 等）    | typed structured value    |
| RemoveOptionalFieldOperation | 'remove-field'        | 固定 optional 路径                         | —                         |
| UpsertCharacterOperation     | 'upsert-character'    | protagonist 或 /supportingCharacters/{key} | typed character object    |
| RemoveCharacterOperation     | 'remove-character'    | /supportingCharacters/{characterKey}       | —                         |
| UpsertRelationshipOperation  | 'upsert-relationship' | /relationships/{relationshipKey}           | typed relationship object |
| RemoveRelationshipOperation  | 'remove-relationship' | /relationships/{relationshipKey}           | —                         |

每个 operation 使用稳定 `kind` 判别器和受限字段路径/实体 key。

**Patch Validation 规则**：

- 禁止重复 operation target（同一路径出现两次 → 验证错误）
- 禁止同一 target 同时 set 和 remove
- 禁止 parent/child 冲突（如同时 set `/protagonist` 和 set `/protagonist/name`）
- 禁止修改 required field 为缺失（remove required → 验证错误）
- 禁止未知 path（不在 V1 grammar 中 → 验证错误）
- 禁止修改 locked path 或其后代（→ CONTRACT_LOCK_CONFLICT）
- 禁止操作不存在的 characterKey/relationshipKey（除非 operation 是 upsert）
- Operation 应用顺序固定且 deterministic（按 kind 优先级 + path 字典序）
- 任一 operation 无效则整个 accept 失败，不允许部分应用

**解析流程**：

- Renderer 构造 typed operations（UI 层类型安全）
- DesktopAPI/IPC 传输 closed typed DTO
- Backend 接收后重新验证（不信任客户端）
- 解析后必须为 closed typed operation union，不使用 `unknown`

### AcceptCreationContractProposal 输入

```typescript
interface AcceptCreationContractProposalInput {
  projectId: string;
  proposalId: string;
  expectedProposalSectionsHash: string;
  expectedGrillSessionVersion: number;
  expectedContractVersion: number | null;
  operations: ReadonlyArray<ContractPatchOperation>;
}
```

空 operations 数组表示原样接受 AI 输出。

### RejectCreationContractProposal 输入

```typescript
interface RejectCreationContractProposalInput {
  projectId: string;
  proposalId: string;
  expectedProposalSectionsHash: string;
}
```

### 用例列表

| 用例                            | 类型     | expectedVersion/state/hash         | 返回                              |
| ------------------------------- | -------- | ---------------------------------- | --------------------------------- |
| RequestCreationContractProposal | mutation | session version                    | taskId                            |
| ListCreationContractProposals   | query    | —                                  | ProposalPublicData[]              |
| GetCreationContractProposal     | query    | —                                  | ProposalPublicData                |
| AcceptCreationContractProposal  | mutation | contract + session + proposal hash | ContractVersionPublicData         |
| RejectCreationContractProposal  | mutation | proposal hash + status = PROPOSED  | ProposalPublicData                |
| GetCurrentCreationContract      | query    | —                                  | ContractVersionPublicData \| null |
| ListCreationContractVersions    | query    | —                                  | ContractVersionSummary[]          |
| LockCreationContractField       | mutation | contract version                   | ContractVersionPublicData         |
| UnlockCreationContractField     | mutation | contract version                   | ContractVersionPublicData         |
| UpdateCreationContractByUser    | mutation | contract version                   | ContractVersionPublicData         |

**关键约束**：

- 每个 mutation 携带适用于其 aggregate 的 expected version/state/hash
- 返回值是事实来源，Renderer 使用返回值更新 UI
- AcceptCreationContractProposal 返回完整的 ContractVersionPublicData
- Lock/Unlock 返回新创建的 ContractVersionPublicData（sections 不变，lockedFieldPaths 改变）
- UpdateCreationContractByUser 允许用户直接编辑（不经过 AI），创建新版本
- Renderer 提交的是 typed review operations（审核意图），不是持久化 ContractVersion

### Backend Accept 流程

1. 加载原始 proposal（验证 sectionsHash 匹配 expectedProposalSectionsHash）
2. 验证 proposal status = PROPOSED（CAS）
3. 应用 typed operations 到 proposal sections（deterministic order）
4. 验证合并后 sections 的 schema（strict mode）
5. 验证 locks（operations 不违反当前 lockedFieldPaths 或其后代）
6. 生成 provenance（USER_EDIT 字段标记来源）
7. 构造并持久化 ContractVersion
8. 返回完整 ContractVersionPublicData

## 10. Task 与模型调用

### 任务类型

`CREATION_CONTRACT_DRAFT`

### 执行流程

1. **Task 先落库**：创建 PENDING 任务，记录 inputVersionJson（含 ContractBaselineRef）
2. **CAS claim**：PENDING → RUNNING + attempt_count++
3. **Provider 动态路由**：从 inputVersionJson 中的 providerProfileId 解析 provider
4. **Prompt 构建**：从 Grill session 数据构建 prompt（不持久化），包含 locked fields 及固定值
5. **Prompt hash**：SHA-256 存入 invocation
6. **模型调用**：通过 model-gateway invokeModel
7. **严格 JSON schema validation**：拒绝非 JSON、markdown 包裹、额外字段
8. **Lock validation**：验证模型输出不改变 locked fields（违反 → CONTRACT_MODEL_LOCK_VIOLATION → task FAILED）
9. **Stale 检测**：调用前后校验 session version 和 contract baseline
10. **Proposal 持久化**：验证通过后写入 creation_contract_proposals
11. **原子提交**：proposal + invocation success + task complete 同事务
12. **Recovery**：启动时扫描 PENDING/RUNNING 任务，RUNNING → FAILED
13. **Model invocation audit**：完整记录 token 使用、延迟、错误

### Generation task input 持久化

task inputVersionJson 必须包含：

```typescript
interface CreationContractDraftTaskInput {
  sessionId: string;
  sessionVersion: number;
  baseline: ContractBaselineRef;
  lockedFieldPaths: string[];
  providerProfileId: string;
  schemaVersion: number;
}
```

**首次生成**：`baseline` 三个字段均为 null，`lockedFieldPaths = []`。
**存在契约时**：`baseline` 三个字段均非 null，`lockedFieldPaths` 来自该 version snapshot。

### Stale 检测规则

- **Grill session version**：始终检测（调用前后）
- **Contract baseline**：
  - 首次生成（baseline.contractVersionId = null）：不执行 contract version stale 比较
  - 存在基线时：验证当前 current version 仍匹配 baseline（否则 STALE）

### 约束

- Proposal-only：任务完成后 proposal 状态为 PROPOSED，不自动 accept
- 不自动接受：没有任何代码路径将 proposal 自动转为 version
- Prompt 不持久化：只存 hash
- API Key 不进入日志/数据库/错误
- 模型输出违反 lock → task FAILED，不持久化 proposal

## 11. Renderer 工作流

### 用户流程

1. **请求契约草案**：用户在 Grill 完成后点击"生成创作契约"
2. **显示任务状态**：Task Activity Center 显示 CREATION_CONTRACT_DRAFT 进度
3. **Proposal 审核**：
   - 显示 proposal 各 section 内容（只读原始 AI 输出）
   - 与当前契约版本对比（如有）
   - Locked field 标识（锁图标 + 不可编辑）
   - AI rationale 展示
4. **用户编辑（typed operations）**：
   - 用户在 UI 上修改字段值
   - 修改不写回 proposal（proposal 不可变）
   - 修改构造为 typed ContractPatchOperation
   - 修改作为 operations 数组随 accept 一起提交
5. **显式接受**：用户点击"接受"，提交 AcceptCreationContractProposalInput（含 operations + expectedVersions）
6. **Version history**：查看历史版本列表和详情
7. **Lock/Unlock**：用户可锁定/解锁字段（创建新版本）
8. **Stale/conflict 处理**：
   - CONTRACT_VERSION_CONFLICT → 提示刷新
   - CONTRACT_PROPOSAL_STALE → 提示重新生成
   - CONTRACT_LOCK_CONFLICT → 提示解锁或移除冲突字段
9. **Keyboard/focus**：完整键盘导航，focus 管理
10. **Safe errors**：所有错误经过 RendererErrorBoundary + safe-error 映射

### 约束

- 不设计自动接受
- Renderer 不组装 ContractVersion 对象
- Renderer 不修改已持久化 proposal
- 接受操作提交 typed operations（审核意图），不是完整 ContractVersion
- 后端返回完整 ContractVersionPublicData
- 不允许接受时静默丢弃用户编辑

## 12. 与 PlotPilot 和稿件的边界

### PlotPilot 边界

- PlotPilot 不能成为创作契约 source of truth
- PlotPilot 只消费已接受 ContractVersion snapshot
- ContractVersionId 和 contractSnapshotHash 随生成请求传递
- PlotPilot 不能修改 ContractVersion
- PlotPilot 输出（章节文本）不是契约的一部分

### 稿件边界

- Contract 更新不会静默改写已有稿件
- 后续需要显式 ChangeSet 来追踪契约变更对稿件的影响
- 没有 ManuscriptRevision 模型前不接章节生成产品流程
- 稿件版本引用生成时的 ContractVersionId（可追溯）

### 生成请求传递

```
GenerateChapterRequest {
  contractVersionId: string
  contractSnapshotHash: string
  ...
}
```

生成器从 contractSnapshotHash 对应的 version 中读取 sections 和 lockedFieldPaths。不需要单独传递 lockedFields 列表——snapshot 已包含。

## 13. 实施切片

### M1-C1：authoritative contract foundation

**范围**：

- domain：typed ContractSection schema、验证函数、ProposalStatus 状态机、canonical serialization、field path grammar
- contracts：Contract DTO（closed typed operation union）、IPC channels、错误码
- database：4 张表迁移（proposals、versions、current、lock_events）、repository 实现
- application 用例：
  - AcceptCreationContractProposal（含 typed operations 应用）
  - RejectCreationContractProposal（CAS with sections_hash）
  - GetCurrentCreationContract
  - ListCreationContractVersions
  - GetCreationContractProposal
  - ListCreationContractProposals
  - UpdateCreationContractByUser（直接用户创建/编辑）
  - LockCreationContractField（创建新 version）
  - UnlockCreationContractField（创建新 version）
- Lock/unlock 创建新 version 的完整语义
- Proposal supersede 规则
- 数据库事务和 CAS（含 current pointer CAS predicate）
- ContractBaselineRef 验证（null/非 null 完整性）

**明确不做**：

- AI task（CREATION_CONTRACT_DRAFT）
- Worker runner
- Main/Preload IPC
- Renderer UI
- PlotPilot 集成

**验收标准**：

- 所有用例单元测试通过
- 数据库迁移幂等
- CAS 并发测试通过
- Lock 语义测试通过（lock/unlock 创建新 version）
- Typed operations 应用和验证测试通过
- `pnpm check` 通过

**关键测试**：

- Accept 原子事务（成功/失败回滚）
- Typed operations 应用后 schema 验证
- Operations 违反 lock → CONTRACT_LOCK_CONFLICT
- Accept 与 Reject 竞争（只有一个成功）
- 两个 Reject 竞争（只有一个成功）
- Stale hash Reject 失败
- Stale proposal 拒绝
- Version 单调递增
- Schema validation 拒绝未知字段
- Provenance 完整性（USER_EDIT 保留 AI 来源）
- Lock/unlock 创建新 version，sections 不变
- contractSnapshotHash 正确性和 determinism（相同输入 → 相同 hash）
- lockedFieldPaths 排序去重
- 空项目 expectedContractVersion = null（INSERT pointer，PK 冲突检测）
- 首次 baseline 全 null 验证
- 部分 null baseline 拒绝
- 重复 lock path 拒绝
- Descendant lock 拒绝
- 重复 operation target 拒绝
- Parent/child operation 冲突拒绝

### M1-C2：AI task and process bridge

**范围**：

- task-engine：executeCreationContractDraft（CREATION_CONTRACT_DRAFT 任务类型）
- RequestCreationContractProposal 用例
- ContractBaselineRef 在 task input 中的验证
- Worker：contract command dispatch、后台 runner
- Main IPC broker：contract.* channels
- Preload：contract DesktopAPI 暴露
- Recovery 和 settlement
- Provider/model invocation
- Lock validation（generation-time CONTRACT_MODEL_LOCK_VIOLATION）
- Stale 检测（首次 vs 存在基线）

**明确不做**：

- Renderer UI
- 自动接受
- PlotPilot 集成

**验收标准**：

- 任务执行完整链路测试（mock provider）
- Stale 检测测试（含首次 baseline = null）
- 严格 JSON 解析测试
- Lock violation → task FAILED 测试
- Settlement 测试
- Recovery 测试
- `pnpm check` 通过

**关键测试**：

- 模型返回无效 JSON → FAILED
- 模型输出改变 locked field → CONTRACT_MODEL_LOCK_VIOLATION → FAILED
- Session version 变化 → STALE
- 首次生成无 contract stale 比较
- Proposal 持久化 + task complete 原子性
- 启动恢复 PENDING 任务

### M1-C3：Renderer

**范围**：

- 请求契约草案 UI
- 任务状态显示
- Immutable proposal 审核（只读原始 AI 输出）
- Typed review operations 编辑界面
- Accept/reject（提交 typed operations）
- Current version 显示
- Version history
- Lock/unlock 交互
- Stale/conflict 处理
- Accessibility / safe errors

**明确不做**：

- 正式产品视觉设计
- PlotPilot UI
- 稿件编辑

**验收标准**：

- 完整用户流程可走通
- 错误安全映射
- 键盘可操作
- `pnpm check` 通过

**关键测试**：

- 接受流程（成功/冲突/stale）
- Typed operations 编辑和提交
- Lock 标识和交互
- 版本对比渲染
- Error boundary 触发

### M1-C4：hardening

**范围**：

- Real provider optional E2E（可选标记，CI 按需运行）
- Restart/recovery 完整链路
- Concurrency pressure tests
- Migration compatibility 验证
- Manual acceptance（手动验收流程）
- Performance 验证
- Security review

**明确不做**：

- 新 section 类型
- PlotPilot 集成
- 稿件版本

**验收标准**：

- 并发压力测试通过
- Recovery 链路完整
- 迁移兼容
- `pnpm check` 通过

## 14. 决策记录

### V1 已裁决决策

以下决策已被主体设计依赖，M1-C1 实现时必须遵循：

| 决策                             | 裁决                                                        |
| -------------------------------- | ----------------------------------------------------------- |
| Lock 粒度                        | field path 级                                               |
| User direct edit 版本策略        | 每次成功保存创建新 version                                  |
| Provenance 存储                  | V1 内嵌 canonical JSON（provenanceJson）                    |
| unresolvedQuestions 归属         | V1 属于契约 typed section（可被后续生成消费）               |
| Schema migration 策略            | 历史 version 不改写，读取时显式转换                         |
| Proposal stale 判定              | 基于 Grill/Contract baseline mismatch，不采用时间自动过期   |
| 多 Grill session                 | 单个 proposal 只关联一个明确 session baseline               |
| Proposal 原始内容                | 不可变                                                      |
| schemaVersion 格式               | 单调整数                                                    |
| expectedContractVersion 首次语义 | null（表示"当前无版本"）                                    |
| lockedFieldPaths 语义            | canonical sorted unique set                                 |
| Parent/child lock                | V1 拒绝冗余 descendant lock                                 |
| Field path 语法                  | JSON Pointer 风格，collection 用 stable key                 |
| Review patch 模型                | closed typed operation union                                |
| Hash 验证层                      | SQLite 长度检查 + domain/repository 层 hex 格式验证         |
| Lock event 审计                  | append-only，不冗余存储 version_number                      |
| Current pointer CAS              | UPDATE WHERE current_version_id = expected（首次用 INSERT） |

### 真正未决的后续决策

以下不阻塞 M1-C1，可在后续迭代中裁决：

| 问题                            | 选项                       | 备注                 |
| ------------------------------- | -------------------------- | -------------------- |
| Renderer diff 的最终视觉粒度    | section 级 vs field 级高亮 | C3 实现时决定        |
| V2 是否正规化 provenance        | 继续内嵌 vs 独立表         | 按性能和查询需求评估 |
| V2 是否支持多 session synthesis | 只关联最新 vs 可关联多个   | 产品需求驱动         |
| V2 是否支持自动过期策略         | 手动 STALE vs 时间自动过期 | 运营需求驱动         |
