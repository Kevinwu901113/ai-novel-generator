# 当前状态

**文档基线日期**：2026-07-30
**Main SHA**：`7df3ac5640f1c3f5ba6fcf46ffe563ca19ac0717`
**基线事件**：PR #11 (AI question-plan Renderer) 合并

---

## 已完成能力

| 能力                                                      | 切片     | PR     |
| --------------------------------------------------------- | -------- | ------ |
| 本地项目创建、列表、打开、SQLite 持久化                   | M1-A     | —      |
| Provider 配置、macOS Keychain、连接测试                   | M1-B1    | #1     |
| 持久化任务、模型调用审计、CAS claim、启动恢复             | M1-B2    | #2     |
| Task Activity Center（任务列表/详情/统计）                | M1-B2.5  | #6     |
| Renderer safety boundary（ErrorBoundary + safe-error）    | M1-S1    | #7     |
| Renderer accessibility（LiveRegion、focus 管理）          | M1-S2    | #10    |
| Grill 领域模型、持久化、IPC 全链路                        | M2-A1    | #3     |
| Grill 桌面工作台（session/question/answer/proposal）      | M2-A1.5  | #4, #5 |
| AI question-plan backend（GRILL_QUESTION_PLAN 任务）      | M2-A2-BE | #9     |
| AI question-plan Renderer（触发、审核、显式接受）         | M2-A2-FE | #11    |
| PlotPilot sidecar foundation（adapter + lifecycle + SSE） | —        | #8     |

## 当前不能做的事

- 创作契约（无 domain、无数据库表、无 UI）
- 正文编辑和稿件版本
- 大纲与章节生成
- PlotPilot 产品级接入（无 Worker RPC、无产品 UI）
- 导入、导出、备份
- 跨平台 SecretStore（仅 macOS）
- 自动重试和通用任务队列

## 下一条产品纵向切片

```
Grill answers/proposals
→ CreationContractProposal（AI 生成）
→ 用户审核（逐字段对比、锁定标识）
→ 用户显式接受
→ CreationContractVersion（不可变权威版本）
→ 字段锁定
→ 后续大纲与稿件版本消费 ContractVersion snapshot
```

切片拆分：

1. **M1-C1**：domain / contracts / database / application
2. **M1-C2**：CREATION_CONTRACT_DRAFT task + model proposal + Worker IPC
3. **M1-C3**：Renderer（请求、对比、接受、版本历史）
4. **M1-C4**：hardening / manual acceptance

## 暂缓事项

- PlotPilot Worker RPC / 产品 UI（等创作契约和稿件版本建立）
- 正文生成（等稿件版本模型）
- 连续性管理（M4）
- 审稿（M5）
- 导出备份（M7）

## 核心不可破坏约束

1. Renderer 无 Node、文件系统、SQLite、secret 权限
2. Worker / Utility Process 是 SQLite 唯一写入者
3. AI 输出始终是 proposal，用户显式接受才创建权威数据
4. 所有 mutation 使用 expectedVersion（乐观并发控制）
5. Prompt 不持久化，API Key 不进入日志/数据库/错误
6. 错误经过 safe boundary，不暴露内部路径/堆栈/SQL
7. 用户确认的本地数据始终是 source of truth
