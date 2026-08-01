# 当前状态

**文档基线日期**：2026-08-02
**Main SHA**：`4eab0c14a889647b7057e4688bd2e76b508a9ec9`
**基线事件**：PR #18 Writing Evaluation Lab Foundation 合并

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
| Creation Contract architecture design                     | M1-C0    | #12    |
| Creation Contract domain/contracts/database/application   | M1-C1    | #13    |
| Creation Contract Accept/Reject                           | M1-C1    | #14    |
| Creation Contract User Update/Lock/Unlock                 | M1-C1    | #15    |
| Creation Contract Draft task + Worker/Main/Preload bridge | M1-C2    | #17    |
| Writing Evaluation Lab foundation                         | GQ1      | #18    |

## 当前不能做的事

- 无 Contract Renderer，用户尚不能在 UI 请求、审核和接受 AI Contract Draft
- 无真实稿件和 Chapter Version
- 无真实文章生成 pipeline
- 无 Scene Planner / Draft Generator / Critics / Rewriter
- 无长篇连续性能力
- PlotPilot 仍只有 foundation（无 Worker RPC、无产品 UI）
- 无导出备份
- SecretStore 仍只支持 macOS
- 自动重试和通用任务队列

## 下一条产品纵向切片

M1-C0、M1-C1、M1-C2 已合并。后端已支持 Creation Contract proposal / version / accept / reject / user update / lock / unlock / draft task / process bridge。

**下一条产品纵向切片**：`M1-C3 Minimal Creation Contract Renderer`

用户尚不能在 UI 请求、审核和接受 AI Contract Draft。M1-C3 需要实现最小可用的 Renderer 界面，完成从 UI 触发到用户接受的完整链路。

**质量主线并行下一步**：`GQ2 Real Generation Experiment Runner`

Writing Evaluation Lab foundation 已合并，但仅证明评测工具可用，不构成文章生成质量提升证据。GQ2 需要接入真实模型生成、运行固定评测 suite、产出 candidate artifacts 和盲评数据。

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
