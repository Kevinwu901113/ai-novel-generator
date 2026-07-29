# Grill 问题规划器后端 — 人工验收指南

本验收针对 **后端**（任务化问题规划器）。规划器没有 UI；通过开发调用、
IPC 入口或测试驱动验证。AI 只生成“问题计划提案”，正式问题必须由显式
接受操作创建。

## 前置条件

- 应用已启动，数据服务（Worker）就绪
- 至少一个已创建项目
- 已配置固定提供商（MiMo V2.5 Pro）API Key（`provider.saveApiKey`）
- 可通过开发工具/测试入口调用 IPC 或 worker 命令

## 关键入口

- `grill.requestQuestionPlan({ projectId, sessionId, expectedSessionVersion })`
  → `{ taskId, sessionId, baseSessionVersion }`
- `grill.listQuestionPlanProposals({ projectId, sessionId })`
- `grill.getQuestionPlanProposal({ projectId, sessionId, proposalId })`
- `grill.acceptQuestionPlanProposal({ projectId, sessionId, proposalId, expectedSessionVersion })`
  → 新创建的正式问题列表
- 任务状态：`task.get` / `task.list`

---

## 1. 创建项目与 Grill 会话

**操作：**

1. `project.create` 创建项目
2. `grill.createSession({ projectId, goal })` 创建会话
3. `grill.startSession({ projectId, sessionId, expectedVersion: 1 })` 启动会话（ACTIVE）

**预期结果：**

- 会话状态为 `ACTIVE`，`version` 变为 2

**失败记录：**

```
操作：___
实际结果：___
```

---

## 2. 配置提供商

**操作：**

1. `provider.saveApiKey({ apiKey })`
2. `provider.getState()`

**预期结果：**

- `hasApiKey: true`，`model` 与 `baseUrl` 为只读固定值

**失败记录：**

```
操作：___
实际结果：___
```

---

## 3. 提交规划任务并观察状态

**操作：**

1. 调用 `grill.requestQuestionPlan({ projectId, sessionId, expectedSessionVersion })`
2. 记录返回的 `taskId`
3. `task.get(projectId, taskId)` 查询状态

**预期结果：**

- 返回值仅含 `{ taskId, sessionId, baseSessionVersion }`，不含任何模型结果
- 任务经历 `PENDING → RUNNING → SUCCEEDED`
- TaskCenter 对该任务显示固定安全文本（“Grill 问题规划”/“规划任务结果已保存”）

**失败记录：**

```
操作：___
实际结果：___
```

---

## 4. 提案已创建但正式问题未变化

**操作：**

1. 任务 SUCCEEDED 后，`grill.listQuestionPlanProposals({ projectId, sessionId })`
2. `grill.listQuestions({ projectId, sessionId })`

**预期结果：**

- 出现一个状态为 `PROPOSED` 的提案，含 `baseSessionVersion`、`schemaVersion`、规范化 `questions`
- 正式问题列表 **没有** 因规划而新增（提案不会自动落地）
- `task.result` 仅含 `{ proposalId, questionCount, baseSessionVersion }`

**失败记录：**

```
操作：___
实际结果：___
```

---

## 5. 显式接受提案后正式问题出现

**操作：**

1. `grill.acceptQuestionPlanProposal({ projectId, sessionId, proposalId, expectedSessionVersion })`
   （`expectedSessionVersion` 必须等于当前会话版本与提案 `baseSessionVersion`）
2. `grill.listQuestions({ projectId, sessionId })`

**预期结果：**

- 返回新创建的正式问题（按拓扑顺序，依赖在前）
- 提案状态变为 `ACCEPTED`
- 会话 `version` 递增 1
- 计划内 `planned` 依赖被映射为正式问题 ID

**失败记录：**

```
操作：___
实际结果：___
```

---

## 6. 版本变化导致任务 stale

**操作：**

1. 提交规划任务后，在接受前对会话做一次会改变版本的操作（如 `grill.addQuestions`）
2. 再次提交规划任务（或在任务执行窗口内改变版本）

**预期结果：**

- 若 worker 调用模型前检测到版本不一致：任务置为 `STALE`，不调用模型，不创建提案
- 若模型返回后会话版本已变化：任务置为 `STALE`，丢弃结果，不保存提案
- 用旧 `baseSessionVersion` 接受提案返回稳定冲突错误（`GRILL_PLAN_PROPOSAL_NOT_ACCEPTABLE`）

**失败记录：**

```
操作：___
实际结果：___
```

---

## 7. 提供商未配置 / 缺少 API Key

**操作：**

1. 删除 API Key（`provider.deleteApiKey`）后提交规划任务

**预期结果：**

- 任务失败，错误码为 `API_KEY_REQUIRED`（未配置时为 `PROVIDER_NOT_CONFIGURED`）
- 失败发生在 claim 前，`attemptCount` 不增加

**失败记录：**

```
操作：___
实际结果：___
```

---

## 8. 模型返回非法 JSON

**操作：**

1. 使用测试替身让模型返回非 JSON / markdown 代码块 / 含额外文本 / 额外字段 / 错误 schemaVersion
2. 提交规划任务

**预期结果：**

- JSON 级失败：任务失败，错误码 `MODEL_RESPONSE_INVALID`
- schema 级失败：错误码 `GRILL_PLAN_SCHEMA_INVALID`
- 引用非法：`GRILL_PLAN_REFERENCE_INVALID`；存在循环：`GRILL_PLAN_CYCLE_DETECTED`
- 任何失败都 **不保存** 部分提案

**失败记录：**

```
操作：___
实际结果：___
```

---

## 9. 重启 Worker 后任务恢复语义

**操作：**

1. 在任务处于 `RUNNING` 时强制重启应用/Worker
2. 重新打开项目，查询该任务

**预期结果：**

- 遗留 `RUNNING` 任务被恢复为 `FAILED`，错误码 `TASK_INTERRUPTED`
- 其 `RUNNING` 调用被标记 `FAILED`，错误码 `INVOCATION_INTERRUPTED`
- 不自动重跑（避免重复消耗配额）

**失败记录：**

```
操作：___
实际结果：___
```

---

## 10. 数据库不含敏感/原始数据

**操作：**

1. 打开项目 `project.sqlite`
2. 检查 `tasks`、`model_invocations`、`grill_question_plan_proposals` 表内容

**预期结果：**

- 不存在原始 prompt（`model_invocations.prompt_hash` 为 64 位 SHA-256 hex）
- 不存在原始模型输出（提案仅存经验证的规范化 `questions_json`）
- 不存在 API Key、Authorization header、Keychain service/account
- `error_message` 不含绝对路径、stack 或 SQL

**失败记录：**

```
操作：___
实际结果：___
```

---

## 11. 并发去重

**操作：**

1. 对同一 `sessionId + expectedSessionVersion` 快速连续提交两次规划任务

**预期结果：**

- 第二次返回 `GRILL_PLAN_ALREADY_RUNNING`
- 数据库中同一 `dedupe_key` 至多一个 `PENDING/RUNNING` 任务
- 任务终结后，同 key 可重新创建

**失败记录：**

```
操作：___
实际结果：___
```
