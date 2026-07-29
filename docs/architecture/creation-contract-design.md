# 创作契约架构设计

> 状态：设计文档（M1-C0），尚未实现。
> 基线：5cefd6e (2026-07-29)

## 1. 目标

定义从 Grill 结果到权威创作规格的完整边界：

```
Grill answers/proposals
→ CreationContractProposal（AI 生成，非权威）
→ explicit review（用户逐字段审核）
→ immutable CreationContractVersion（权威版本）
```

创作契约是项目创作意图的唯一权威来源。后续所有生成能力（大纲、章节、PlotPilot）必须消费已接受的 ContractVersion snapshot，不得自行推断创作意图。

## 2. 不变量

以下不变量在任何实现中不可违反：

1. **AI 永远不能直接更新当前创作契约**——AI 只生成 proposal
2. **Proposal 出现不代表契约已更新**——proposal 是建议，不是事实
3. **用户显式接受后才创建权威版本**——没有自动接受路径
4. **已锁定字段不得被 AI proposal 静默覆盖**——lock 是硬约束
5. **用户输入和用户确认内容优先于模型建议**——provenance 中 user > AI
6. **所有 mutation 使用 expectedVersion**——乐观并发控制
7. **接受、版本写入、current pointer 更新必须同一事务**——原子性
8. **Proposal 和 version 不存 prompt 明文**——只存 hash
9. **Renderer 不组装持久化 ContractVersion**——后端返回值是事实来源
10. **后端返回值是事实来源**——Renderer 使用返回值更新 UI
11. **历史版本不可变**——已写入的 version 不可修改或删除

## 3. V1 数据模型

### CreationContractProposal

AI 生成的契约草案，非权威。

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
| schemaVersion           | number            | 契约 schema 版本                       |
| sectionsJson            | string            | 规范化 JSON（canonical serialization） |
| sectionsHash            | string            | sectionsJson 的 SHA-256                |
| createdAt               | string (ISO 8601) | 创建时间                               |
| updatedAt               | string (ISO 8601) | 最后更新时间                           |

**ProposalStatus**：

| 状态       | 含义                     |
| ---------- | ------------------------ |
| PROPOSED   | 等待用户审核             |
| ACCEPTED   | 用户已接受，已创建版本   |
| REJECTED   | 用户已拒绝               |
| SUPERSEDED | 被更新的 proposal 取代   |
| STALE      | 基础数据已变化，不再有效 |

### CreationContractVersion

不可变的权威创作契约版本。

| 字段                       | 类型              | 说明                                       |
| -------------------------- | ----------------- | ------------------------------------------ |
| id                         | string (ULID)     | 主键                                       |
| projectId                  | string            | 所属项目                                   |
| version                    | number            | 单调递增版本号（项目内唯一）               |
| schemaVersion              | number            | 契约 schema 版本                           |
| sourceProposalId           | string \| null    | 来源 proposal（用户手动创建时为 null）     |
| basedOnGrillSessionId      | string \| null    | 关联的 Grill session                       |
| basedOnGrillSessionVersion | number \| null    | 关联的 session 版本                        |
| sectionsJson               | string            | 规范化 JSON                                |
| sectionsHash               | string            | SHA-256                                    |
| provenanceJson             | string            | 各字段来源追踪                             |
| createdAt                  | string (ISO 8601) | 创建时间                                   |
| createdBy                  | string            | 创建者（'user' \| 'ai-proposal-accepted'） |

### CreationContractCurrentPointer

语义等价模型：每个项目至多一个 current version。

| 字段             | 类型              | 说明         |
| ---------------- | ----------------- | ------------ |
| projectId        | string (PK)       | 项目         |
| currentVersionId | string            | 当前版本 ID  |
| currentVersion   | number            | 当前版本号   |
| updatedAt        | string (ISO 8601) | 最后更新时间 |

### ContractSection / ContractField

V1 使用 typed schema（见第 4 节），不使用任意 JSON。每个 section 是 schema 中定义的顶级字段，每个 field 是 section 内的具体值。

### ContractFieldProvenance

每个 section/field 的来源追踪（存储在 version 的 provenanceJson 中）：

| 字段                     | 类型             | 说明                              |
| ------------------------ | ---------------- | --------------------------------- |
| sectionKey               | string           | 字段路径（如 "protagonist.name"） |
| source                   | ProvenanceSource | 来源类型                          |
| grillAnswerIds           | string[]         | 关联的 Grill 回答                 |
| grillProposalIds         | string[]         | 关联的 Grill proposal             |
| aiTaskId                 | string \| null   | AI 任务 ID                        |
| modelInvocationId        | string \| null   | 模型调用 ID                       |
| previousVersionFieldHash | string \| null   | 前一版本同字段 hash               |
| rationale                | string \| null   | AI 给出的理由（不含 prompt）      |
| userEdited               | boolean          | 用户是否手动编辑过                |

**ProvenanceSource**：`GRILL_ANSWER` | `AI_PROPOSAL` | `USER_EDIT` | `PREVIOUS_VERSION` | `DEFAULT`

### ContractFieldLock

字段锁定状态，正式数据，可审计。

| 字段              | 类型              | 说明                                  |
| ----------------- | ----------------- | ------------------------------------- |
| id                | string (ULID)     | 主键                                  |
| projectId         | string            | 所属项目                              |
| fieldPath         | string            | 锁定字段路径（如 "protagonist.name"） |
| lockedAt          | string (ISO 8601) | 锁定时间                              |
| lockedByVersion   | number            | 锁定时的契约版本                      |
| lockedBy          | string            | 操作者                                |
| unlockedAt        | string \| null    | 解锁时间（null = 仍锁定）             |
| unlockedByVersion | number \| null    | 解锁时的契约版本                      |

## 4. V1 Typed Schema

V1 使用明确、有限的首版 section 定义，不使用 `Record<string, unknown>`。

### Schema 定义

| Section Key          | 类型                | 必填 | 限制                                                          | 说明                    |
| -------------------- | ------------------- | ---- | ------------------------------------------------------------- | ----------------------- |
| premise              | scalar (string)     | 是   | ≤2000 字符                                                    | 核心前提/故事概念       |
| genre                | list (string[])     | 是   | 1–5 项，每项 ≤50 字符                                         | 类型标签                |
| tone                 | list (string[])     | 是   | 1–5 项，每项 ≤50 字符                                         | 基调标签                |
| themes               | list (string[])     | 否   | 0–10 项，每项 ≤100 字符                                       | 主题                    |
| targetAudience       | scalar (string)     | 是   | ≤200 字符                                                     | 目标读者                |
| narrativePov         | scalar (enum)       | 是   | FIRST \| THIRD_LIMITED \| THIRD-OMNISCIENT \| SECOND \| OTHER | 叙事视角                |
| tense                | scalar (enum)       | 是   | PAST \| PRESENT \| MIXED                                      | 时态                    |
| targetLength         | structured          | 否   | {unit: 'words'\|'chapters', value: number}                    | 目标长度                |
| structure            | scalar (string)     | 否   | ≤500 字符                                                     | 结构说明（三幕/多线等） |
| protagonist          | structured          | 是   | 见下                                                          | 主角                    |
| supportingCharacters | list (structured[]) | 否   | 0–20 项                                                       | 配角                    |
| relationships        | list (structured[]) | 否   | 0–30 项                                                       | 关系                    |
| worldRules           | list (string[])     | 否   | 0–20 项，每项 ≤300 字符                                       | 世界规则                |
| mustInclude          | list (string[])     | 否   | 0–20 项，每项 ≤200 字符                                       | 必须包含                |
| mustAvoid            | list (string[])     | 否   | 0–20 项，每项 ≤200 字符                                       | 必须避免                |
| contentBoundaries    | structured          | 否   | 见下                                                          | 内容边界                |
| unresolvedQuestions  | list (string[])     | 否   | 0–20 项，每项 ≤300 字符                                       | 未决问题                |

### protagonist 结构

| 字段       | 类型     | 必填 | 限制      |
| ---------- | -------- | ---- | --------- |
| name       | string   | 是   | ≤100 字符 |
| role       | string   | 否   | ≤200 字符 |
| motivation | string   | 否   | ≤500 字符 |
| arc        | string   | 否   | ≤500 字符 |
| traits     | string[] | 否   | 0–10 项   |

### supportingCharacters 项结构

| 字段         | 类型   | 必填 | 限制      |
| ------------ | ------ | ---- | --------- |
| name         | string | 是   | ≤100 字符 |
| role         | string | 否   | ≤200 字符 |
| relationship | string | 否   | ≤200 字符 |

### relationships 项结构

| 字段    | 类型   | 必填 | 限制       |
| ------- | ------ | ---- | ---------- |
| from    | string | 是   | 角色名引用 |
| to      | string | 是   | 角色名引用 |
| type    | string | 是   | ≤100 字符  |
| dynamic | string | 否   | ≤300 字符  |

### contentBoundaries 结构

| 字段              | 类型     | 必填 | 限制      |
| ----------------- | -------- | ---- | --------- |
| rating            | string   | 否   | ≤50 字符  |
| allowedContent    | string[] | 否   | 0–20 项   |
| prohibitedContent | string[] | 否   | 0–20 项   |
| notes             | string   | 否   | ≤500 字符 |

### Schema 版本升级策略

- `schemaVersion` 从 1 开始
- 新增可选字段：minor 升级，旧版本数据兼容
- 修改必填字段或类型：major 升级，需要迁移
- 未知字段：验证时拒绝（strict mode），不静默忽略
- 迁移：读取旧版本时按 schemaVersion 应用转换函数

## 5. Provenance

每个 section/field 能追踪完整来源链：

- **Grill answer IDs**：哪些 Grill 回答影响了此字段
- **Grill proposal IDs**：哪些 Grill proposal 被接受后影响此字段
- **AI task ID**：生成此字段的 CREATION_CONTRACT_DRAFT 任务
- **Model invocation ID**：具体的模型调用记录
- **User edit**：用户是否手动编辑过（userEdited: true）
- **Previous contract version**：继承自前一版本的字段
- **Rationale**：AI 给出的理由（不含 prompt 明文）

**约束**：

- 不得把 prompt 明文写入 provenance
- Rationale 是 AI 输出的摘要，不是原始 prompt
- 用户编辑覆盖 AI 来源时，保留 AI 来源历史但标记 userEdited: true

## 6. Lock 语义

### 基本规则

- 用户可显式 lock/unlock 任意 field path
- Lock 状态是正式数据（creation_contract_field_locks 表），不是 Renderer local state
- Lock/unlock 本身创建审计事件（记录在 lock 表的 lockedAt/unlockedAt）

### AI Proposal 与 Lock 的交互

- AI proposal 可指出与 lock 冲突（在 proposal metadata 中标注）
- AI proposal 不能修改 locked field 的值
- 接受包含 locked-field 变更的 proposal 必须拒绝（CONTRACT_LOCK_CONFLICT）
- Stale proposal 不得绕过锁

### 用户修改 Locked Field

- 用户自己修改 locked field 时需要显式 unlock 或专用 override intent
- Override intent 必须携带 expectedVersion 和明确的 fieldPath
- Override 创建新版本，provenance 标记为 USER_EDIT

### 下游消费

- 后续大纲生成必须读取锁定字段
- PlotPilot 必须读取锁定字段
- 章节生成必须读取锁定字段
- 锁定字段在生成 prompt 中标记为不可变更约束

## 7. Stale 和并发

### Proposal 记录

每个 proposal 至少记录：

- `baseGrillSessionVersion`：生成时的 Grill session 版本
- `baseContractVersion`：生成时的契约版本（首次为 null）

### 接受时验证

AcceptCreationContractProposal 必须验证：

| 检查项                           | 失败错误码                       |
| -------------------------------- | -------------------------------- |
| expectedGrillSessionVersion 匹配 | CONTRACT_PROPOSAL_STALE          |
| expectedContractVersion 匹配     | CONTRACT_VERSION_CONFLICT        |
| proposal status = PROPOSED       | CONTRACT_PROPOSAL_NOT_ACCEPTABLE |
| 无 locked field 冲突             | CONTRACT_LOCK_CONFLICT           |
| project/session ownership        | CONTRACT_PROPOSAL_NOT_FOUND      |
| schemaVersion 支持               | CONTRACT_SCHEMA_UNSUPPORTED      |

### 错误语义

| 错误码                           | 含义                    | 可恢复              |
| -------------------------------- | ----------------------- | ------------------- |
| CONTRACT_VERSION_CONFLICT        | 契约版本已变化          | 是（刷新后重试）    |
| CONTRACT_PROPOSAL_STALE          | 基础数据已变化          | 是（重新生成）      |
| CONTRACT_PROPOSAL_NOT_FOUND      | Proposal 不存在或无权限 | 否                  |
| CONTRACT_PROPOSAL_NOT_ACCEPTABLE | Proposal 状态不允许接受 | 否                  |
| CONTRACT_LOCK_CONFLICT           | 包含锁定字段变更        | 是（unlock 后重试） |
| CONTRACT_SCHEMA_UNSUPPORTED      | Schema 版本不支持       | 否（需升级）        |

所有错误码必须稳定、可测试、安全（不暴露内部细节）。

## 8. 持久化设计

### 表设计（project.sqlite）

#### creation_contract_proposals

```sql
CREATE TABLE creation_contract_proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PROPOSED'
    CHECK (status IN ('PROPOSED','ACCEPTED','REJECTED','SUPERSEDED','STALE')),
  base_grill_session_id TEXT NOT NULL,
  base_grill_session_version INTEGER NOT NULL,
  base_contract_version INTEGER,
  schema_version INTEGER NOT NULL,
  sections_json TEXT NOT NULL,
  sections_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (invocation_id) REFERENCES model_invocations(id)
) STRICT;
```

#### creation_contract_versions

```sql
CREATE TABLE creation_contract_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  source_proposal_id TEXT,
  based_on_grill_session_id TEXT,
  based_on_grill_session_version INTEGER,
  sections_json TEXT NOT NULL,
  sections_hash TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  FOREIGN KEY (source_proposal_id) REFERENCES creation_contract_proposals(id)
) STRICT;

CREATE UNIQUE INDEX idx_contract_version_unique
  ON creation_contract_versions(project_id, version);
```

#### creation_contract_current

```sql
CREATE TABLE creation_contract_current (
  project_id TEXT PRIMARY KEY,
  current_version_id TEXT NOT NULL,
  current_version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (current_version_id) REFERENCES creation_contract_versions(id)
) STRICT;
```

一项目一个 current version（PK = project_id）。

#### creation_contract_field_locks

```sql
CREATE TABLE creation_contract_field_locks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  field_path TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  locked_by_version INTEGER NOT NULL,
  locked_by TEXT NOT NULL,
  unlocked_at TEXT,
  unlocked_by_version INTEGER
) STRICT;

CREATE UNIQUE INDEX idx_active_lock_unique
  ON creation_contract_field_locks(project_id, field_path)
  WHERE unlocked_at IS NULL;
```

Partial unique index 确保同一字段同时只有一个活跃锁。

### 约束和事务

- 所有表使用 STRICT mode
- Foreign keys 启用
- Proposal accept 的原子事务：
  1. 验证 proposal status = PROPOSED
  2. 验证版本和锁
  3. 插入 creation_contract_versions
  4. 更新 creation_contract_current
  5. 更新 proposal status = ACCEPTED
  6. 同一事务提交
- JSON 字段使用 canonical serialization（key 排序、无多余空白）
- sections_hash 在写入前计算，读取时可验证完整性
- 不保存 secret 或 prompt 明文

### Migration Compatibility

- 新表通过 project.sqlite 迁移机制添加
- 迁移幂等（IF NOT EXISTS）
- 旧项目无契约数据时 current pointer 不存在（正常状态）

## 9. 应用层用例

| 用例                            | 类型     | expectedVersion                    | 返回                              |
| ------------------------------- | -------- | ---------------------------------- | --------------------------------- |
| RequestCreationContractProposal | mutation | session version                    | taskId                            |
| ListCreationContractProposals   | query    | —                                  | ProposalPublicData[]              |
| GetCreationContractProposal     | query    | —                                  | ProposalPublicData                |
| AcceptCreationContractProposal  | mutation | contract version + session version | ContractVersionPublicData         |
| RejectCreationContractProposal  | mutation | —                                  | ProposalPublicData                |
| GetCurrentCreationContract      | query    | —                                  | ContractVersionPublicData \| null |
| ListCreationContractVersions    | query    | —                                  | ContractVersionSummary[]          |
| LockCreationContractField       | mutation | contract version                   | LockPublicData                    |
| UnlockCreationContractField     | mutation | contract version                   | LockPublicData                    |
| UpdateCreationContractByUser    | mutation | contract version                   | ContractVersionPublicData         |

**关键约束**：

- 每个 mutation 的 expectedVersion 是乐观并发控制的核心
- 返回值是事实来源，Renderer 使用返回值更新 UI
- AcceptCreationContractProposal 返回完整的 ContractVersionPublicData
- UpdateCreationContractByUser 允许用户直接编辑（不经过 AI），创建新版本

## 10. Task 与模型调用

### 任务类型

`CREATION_CONTRACT_DRAFT`

### 执行流程

1. **Task 先落库**：创建 PENDING 任务，记录 inputVersionJson（sessionId、sessionVersion、contractVersion、providerProfileId、schemaVersion）
2. **CAS claim**：PENDING → RUNNING + attempt_count++
3. **Provider 动态路由**：从 inputVersionJson 中的 providerProfileId 解析 provider
4. **Prompt 构建**：从 Grill session 数据构建 prompt（不持久化）
5. **Prompt hash**：SHA-256 存入 invocation
6. **模型调用**：通过 model-gateway invokeModel
7. **严格 JSON schema validation**：拒绝非 JSON、markdown 包裹、额外字段
8. **Stale 检测**：调用前后校验 session version 和 contract version
9. **Proposal 持久化**：验证通过后写入 creation_contract_proposals
10. **原子提交**：proposal + invocation success + task complete 同事务
11. **Recovery**：启动时扫描 PENDING/RUNNING 任务，RUNNING → FAILED
12. **Model invocation audit**：完整记录 token 使用、延迟、错误

### 约束

- Proposal-only：任务完成后 proposal 状态为 PROPOSED，不自动 accept
- 不自动接受：没有任何代码路径将 proposal 自动转为 version
- Prompt 不持久化：只存 hash
- API Key 不进入日志/数据库/错误

## 11. Renderer 工作流

### 用户流程

1. **请求契约草案**：用户在 Grill 完成后点击"生成创作契约"
2. **显示任务状态**：Task Activity Center 显示 CREATION_CONTRACT_DRAFT 进度
3. **Proposal 审核**：
   - 显示 proposal 各 section 内容
   - 与当前契约版本对比（如有）
   - Locked field 标识（锁图标 + 不可编辑）
   - AI rationale 展示
4. **用户逐字段编辑**：在 proposal 上直接修改（修改后标记为 user-edited）
5. **显式接受**：用户点击"接受"，携带 expectedVersion
6. **Version history**：查看历史版本列表和详情
7. **Stale/conflict 处理**：
   - CONTRACT_VERSION_CONFLICT → 提示刷新
   - CONTRACT_PROPOSAL_STALE → 提示重新生成
   - CONTRACT_LOCK_CONFLICT → 提示解锁或移除冲突字段
8. **Keyboard/focus**：完整键盘导航，focus 管理
9. **Safe errors**：所有错误经过 RendererErrorBoundary + safe-error 映射

### 约束

- 不设计自动接受
- Renderer 不组装 ContractVersion 对象
- 接受操作只发送 proposalId + expectedVersion
- 后端返回完整 ContractVersionPublicData

## 12. 与 PlotPilot 和稿件的边界

### PlotPilot 边界

- PlotPilot 不能成为创作契约 source of truth
- PlotPilot 只消费已接受 ContractVersion snapshot
- ContractVersionId 和 sectionsHash 随生成请求传递
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
  contractSectionsHash: string
  lockedFields: string[]
  ...
}
```

生成器必须尊重 lockedFields，不得在输出中违反锁定约束。

## 13. 实施切片

### M1-C1：domain / contracts / database / application

**范围**：

- domain：ContractSection schema、验证函数、ProposalStatus 状态机
- contracts：Contract DTO、IPC channels、错误码
- database：4 张表迁移、repository 实现
- application：10 个用例（不含 AI 生成）

**明确不做**：

- AI proposal 生成
- Renderer UI
- PlotPilot 集成

**验收标准**：

- 所有用例单元测试通过
- 数据库迁移幂等
- CAS 并发测试通过
- Lock 语义测试通过
- `pnpm check` 通过

**关键测试**：

- Accept 原子事务（成功/失败回滚）
- Lock conflict 拒绝
- Stale proposal 拒绝
- Version 单调递增
- Schema validation 拒绝未知字段
- Provenance 完整性

### M1-C2：task runner / model proposal / Worker IPC

**范围**：

- task-engine：executeCreationContractDraft
- Worker：contract command dispatch、后台 runner
- IPC：contract.* channels
- Preload：contract API 暴露

**明确不做**：

- Renderer UI
- 自动接受
- PlotPilot 集成

**验收标准**：

- 任务执行完整链路测试（mock provider）
- Stale 检测测试
- 严格 JSON 解析测试
- Settlement 测试
- Recovery 测试
- `pnpm check` 通过

**关键测试**：

- 模型返回无效 JSON → FAILED
- Session version 变化 → STALE
- Lock conflict → FAILED
- Proposal 持久化 + task complete 原子性
- 启动恢复 PENDING 任务

### M1-C3：Renderer

**范围**：

- 请求契约草案 UI
- Proposal 审核（对比、编辑、接受/拒绝）
- Locked field 标识
- Version history
- Stale/conflict 处理
- Keyboard/focus/accessibility

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
- Lock 标识和交互
- 版本对比渲染
- Error boundary 触发

### M1-C4：hardening / manual acceptance

**范围**：

- UpdateCreationContractByUser（不经过 AI 的直接编辑）
- Lock/unlock 审计
- Proposal supersede 逻辑
- 端到端集成测试
- 性能验证

**明确不做**：

- 新 section 类型
- PlotPilot 集成
- 稿件版本

**验收标准**：

- 用户可直接创建/编辑契约
- Lock 审计完整
- 并发压力测试通过
- `pnpm check` 通过

## 14. 未决决策

| 问题                                    | 选项                                | 推荐默认值                          | 状态   |
| --------------------------------------- | ----------------------------------- | ----------------------------------- | ------ |
| Lock 粒度：section 级还是 field path 级 | A: section 级 B: field path 级      | B（field path 级，更精确）          | 待确认 |
| User direct edit 是否每次创建版本       | A: 每次创建 B: 批量保存             | A（每次创建，保证审计完整性）       | 待确认 |
| Proposal 对比粒度                       | A: section 级 diff B: field 级 diff | B（field 级，用户审核更精确）       | 待确认 |
| Provenance 正规化程度                   | A: JSON 内嵌 B: 独立表              | A（V1 内嵌，V2 按需正规化）         | 待确认 |
| unresolvedQuestions 是否属于契约正文    | A: 正文 section B: 元数据           | A（正文 section，可被后续生成消费） | 待确认 |
| Schema migration 策略                   | A: 读取时转换 B: 写入时迁移         | A（读取时转换，历史版本保持原样）   | 待确认 |
| Proposal 过期策略                       | A: 手动 STALE B: 自动过期           | A（V1 手动，V2 考虑自动）           | 待确认 |
| 多 Grill session 对同一契约的影响       | A: 只关联最新 B: 可关联多个         | A（V1 只关联最新 session）          | 待确认 |

所有推荐默认值标记为待确认，需要在 M1-C1 实现前裁决。
