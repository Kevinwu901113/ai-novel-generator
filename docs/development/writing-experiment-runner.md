# Writing Experiment Runner（真实生成实验）

> 定位：把已合并的 Writing Evaluation Lab 首次接入**真实模型 candidate**，建立
> `source suite → 真实生成 → output suite → evaluation → blind review` 的工程闭环。
>
> 本工具是研究和实验基础设施，不是产品运行时依赖。测试通过只证明 Runner 工程正确，
> **不证明文章质量提高**。Q1 只表示真实生成→评测→盲评 artifact 的工程闭环存在。
>
> 实施 PR：#21（`feat/gq2-real-generation-runner`）。GQ2 未合并时，路线文档只标 🟡。

## 一、架构

```
apps/writing-experiment-runner (@ai-novel/writing-experiment-runner, bin writing-experiment)
  ├── @ai-novel/writing-evaluation   （公开 API：validateSuite / evaluateSuite / generateBlindPacket / …）
  ├── @ai-novel/model-gateway        （invokeModel，deps 注入）
  ├── @ai-novel/secret-store         （唯一 macOS Keychain 实现；工厂返回 SecretStore port）
  └── @ai-novel/domain               （类型，与 writing-evaluation 一致）
```

- `@ai-novel/secret-store` 是仓库内唯一 `/usr/bin/security` 实现；Worker 只 re-export。
- `@ai-novel/writing-evaluation` **零改动**（依赖仍仅 `@ai-novel/domain`，边界测试守护）。
- Runner 不依赖产品数据库 / Worker / Electron；不写产品 SQLite。

## 二、命令

```bash
pnpm writing-experiment help
pnpm writing-experiment generate \
  --suite <source-suite.json> --output <dir> \
  [--strategy baseline-one-shot-v1] [--provider-id mimo-token-plan-cn] \
  [--temperature <n>] [--max-tokens <n>] [--max-cases <n>] [--force] [--dry-run] [--clock <iso>]
pnpm writing-experiment run \
  --suite <source-suite.json> --output <dir> --seed <seed> \
  [--strategy baseline-one-shot-v1] [--provider-id mimo-token-plan-cn] \
  [--temperature <n>] [--max-tokens <n>] [--force] [--clock <iso>]
```

- **generate**：真实模型生成 → `manifest.private.json` + `case-results.private.json` →（全成功且 FULL_SELECTION 时）generated output suite。不 evaluate / blind。
- **run**：generate（Q1 模式 = 全部 cases）+ **仅全部成功时** `evaluateSuite` → `evaluation.report.json/.md`、`generateBlindPacket` → `blind.packet.json` + `blind.mapping.private.json`。run **不接收 ratings、不 aggregate**；人工评分继续用现有 Writing Evaluation CLI：
  ```bash
  writing-evaluation validate <ratings.json> --type ratings --packet <blind.packet.json>
  writing-evaluation aggregate --packet <blind.packet.json> --mapping <blind.mapping.private.json> --ratings <ratings.json>
  ```
- **真实模型调用必须显式 `WRITING_EXPERIMENT_LIVE=1`**；否则安全拒绝。默认测试 / CI / `pnpm check` 永不联网、永不扣费。
- `--max-cases`：仅受控 smoke/调试。产生 `PARTIAL_SELECTION`、`satisfiesQ1=false`、不产出正式 output suite / evaluate / blind。
- `--dry-run`（generate）：验证 suite、构建 prompt、计算 promptHash 与预估 token，**零费用、无需 LIVE**。

## 三、Provider registry

代码内 allowlisted registry（`src/providers.ts`），唯一 V1 entry：

| 字段            | 值                                                   |
| --------------- | ---------------------------------------------------- |
| providerId      | `mimo-token-plan-cn`（默认）                         |
| baseUrl         | `https://token-plan-cn.xiaomimimo.com/anthropic`     |
| modelId         | `mimo-v2.5-pro`                                      |
| keychainService | `com.ai-novel-generator.provider.mimo-token-plan-cn` |
| keychainAccount | `api-key`                                            |

值镜像 product `FIXED_PROVIDER_PROFILE`。未知 provider ID 在**任何 IO / 网络 / 生成之前**前置拒绝。
禁止 `--api-key / --base-url / --model / --keychain-service / --keychain-account / --provider-file / --provider`——
不得让外部文件或 CLI 参数控制 secret selector 或网络端点。

## 四、Source / Output suite 语义

- **Source suite**：必须是合法且过 `validateSuite` 的 `WritingEvaluationSuiteV1`。Runner 只使用
  `suiteId / caseId / title / description / contract / sceneBrief / constraints`。
  source 原有 `candidates` 与 `expectedRelations` **不参与真实生成，也不复制进结果**。
- **Generated output suite**：仅当**所有选定 case 成功**且 `selectionMode === 'FULL_SELECTION'` 时构造：
  - fixtures 从 source 复制；`candidates` 只含本次真实生成候选（每 case 恰 1 个）；`expectedRelations` 省略；
  - 新 `suiteId = <source-suite-id>--<strategy-id>--<experiment-id>`；必须过 `validateSuite`；
  - `sourceSuite{id,hash}` 与 `outputSuite{id,hash}` 都记录进 manifest。
- 任一 full case 失败：不生成 output suite、不 evaluate、不 blind；发布 private partial-run 诊断快照（manifest + case-results + logs）；`runStatus` 非 `COMPLETE`；exit 非 0。

## 五、策略 baseline-one-shot-v1

```ts
{ strategyId: 'baseline-one-shot-v1', strategyVersion: '1',
  promptVersion: 'baseline-one-shot-v1.p1', defaultTemperature: 0.7,
  defaultMaxTokens: 1024, concurrency: 1, retries: 0 }
```

- Prompt 拆 system（稳定）+ user（逐 case）：角色与任务 / 禁止内容与行为 / 输出规则 /
  创作契约 / 场景简报 / 硬性约束 / 结尾指令。manual-criterion 不进入生成约束。
- 输出要求：仅正文、中文、不输出标题 / 说明 / 分析 / markdown fence、不自称 AI、保持契约事实。
- 结构层拒绝：空 / 纯空白 / 纯标点或零宽 / fence / 明显前缀说明（如“以下是正文”）/ 非字符串。
  长度略偏、required phrase 未满足、dialogue ratio 偏离、文学质量差**不在此预过滤**，交给 Evaluation Lab 测量。
- 默认 artifact 只记录 `promptVersion` + `promptHash`，不保存完整 prompt。

## 六、Manifest 与 Artifacts

`ExperimentManifestV1`（`manifest.private.json`）：schemaVersion / experimentId / toolVersion /
command / strategy / provider / generationParameters / sourceSuite / outputSuite / selectionMode /
selectedCaseIds / satisfiesQ1 / timing / runStatus / cases（含 usage / latencyMs / providerRequestId /
safeErrorCode）/ aggregate / artifactHashes / repository.commit / warnings。

**不变量**：

- `satisfiesQ1 === true` ⟺ `FULL_SELECTION && runStatus === 'COMPLETE'`；
- `outputSuite === null` ⟺ `runStatus !== 'COMPLETE'` 或 `PARTIAL_SELECTION`；
- evaluate/blind artifact 存在 ⟺ `command==='run' && COMPLETE && FULL_SELECTION`。

`runStatus`：`COMPLETE` / `PARTIAL_FAILURE` / `ABORTED` / `PARTIAL_SELECTION_SUCCEEDED` /
`PARTIAL_SELECTION_FAILED`。`--max-cases` 即使 subset 全成功也 `satisfiesQ1=false`。

输出目录（`artifacts/writing-experiments/<experiment>/`，已加入 `.gitignore`）：

- **Private**：`manifest.private.json`、`case-results.private.json`（成功 case 含 candidate 全文）、
  `candidates.private.json`（仅 full success）、`blind.mapping.private.json`、`logs.safe.jsonl`。
- **Shareable**：`evaluation.report.json` / `evaluation.report.md`（只含 textHash，不含正文）。
- **Blind**：`blind.packet.json`（匿名 alias，不含 candidateId/model/strategy 等身份字段）。

**绝不记录**：API Key / Authorization / provider raw error / 绝对路径 / 完整 prompt / candidate 全文内嵌到 manifest。

## 七、目录级原子发布

发布单元 = 整个实验输出目录：所有文件先写唯一 staging `<dir>.gq2-tmp-<run-id>/`；
预检 staging / backup 路径；无 `--force` 且 final 已存在则前置拒绝；`--force` 时 old final
rename 到 `<dir>.gq2-bak-<run-id>/`；staging rename 为 final；成功后删除 backup；失败 best-effort
恢复 backup 并清理残留 staging。错误不泄漏绝对路径。Ctrl-C 标 `ABORTED`（best-effort）。

## 八、安全

- API Key 只经 `@ai-novel/secret-store`（固定 service/account）读取；不打印、不进 CLI、不进 JSON / 日志 / 错误 / prompt hash。
- provider 错误码白名单 → 固定中文消息；provider raw errorMessage 绝不进入 artifact。
- 未知 provider ID 前置拒绝；无任意 base URL / model / Keychain 选择器。
- 无自动重试；concurrency = 1。

## 九、可复现性

- **Input reproducibility（保证）**：sourceSuite hash / promptVersion+promptHash / provider/model /
  生成参数 / Runner commit / case 顺序全部记录。同 suite + 同 commit + 同参数 → 同 prompt bytes。
- **Serialization reproducibility（保证）**：对同一批已捕获的 candidate 数据（固定 text / clock / id / seed），
  manifest / output suite / report / blind 序列化 byte-stable。
- **Model-output determinism（不保证）**：真实模型两次请求可能输出不同文本；**不声称可 byte-identical 重跑**。

## 十、Q1 验收（真实生成）

1. 固定 source suite 过 `validateSuite`，记录 `sourceSuite{id,hash}`；
2. `selectionMode === 'FULL_SELECTION'`，`selectedCaseIds` 覆盖全部 cases；
3. 真实模型调用经 `model-gateway.invokeModel`（非 fake 路径），需显式 `WRITING_EXPERIMENT_LIVE=1`；
4. output suite 每 case 恰 1 个本次真实 candidate，source 占位 candidate 未混入；
5. manifest 记录 modelId / promptVersion / promptHash / 参数 / commit；
6. `candidates.private.json` 落盘且可过 `validateSuite`，`outputSuiteId` 符合 `<source>--<strategy>--<experiment>`；
7. `evaluation.report.json` 由 `evaluateSuite` 生成；
8. `blind.packet.json` 由 `generateBlindPacket` 生成并过 `validateBlindPacket`；
9. `blind.mapping.private.json` 生成、gitignored、不输出 stdout，过 `validatePrivateMapping`；
10. 人工评分链路可用（`writing-evaluation validate --type ratings` + `aggregate`）；
11. 无 secret 泄漏；
12. 任一 case FAILED → 非 `COMPLETE` + `satisfiesQ1=false` + 非零退出；
13. 文档同步更新；未合并 GQ2 只标 🟡；不声称质量提高。

## 十一、当前状态（2026-08-02）

- **代码 + fake E2E**：完成，`pnpm check` 全绿（离线门禁通过）。
- **Live smoke（受控，1 次真实调用）**：**已执行并成功**。
  `WRITING_EXPERIMENT_LIVE=1 generate --max-cases 1`（`mimo-token-plan-cn` / `mimo-v2.5-pro`，temp 0.7 / maxTokens 1024）：
  - 1 次 provider invoke，`PARTIAL_SELECTION`，`satisfiesQ1=false`，无 output suite / evaluation / blind；
  - case `restrained-reunion` SUCCEEDED（finishReason `end_turn`，input 645 / output 653 tokens，latency 8542ms）；
  - 只产生 private case-results + manifest + logs（gitignored 目录）。
- **Live full suite（受控，3 次真实调用）**：**已执行，`PARTIAL_FAILURE`（exit 2）**。
  `WRITING_EXPERIMENT_LIVE=1 run`（全 3 case，`--seed gq2-mimo-baseline-v1`）：
  - 3 次 provider invoke（每 case 恰 1 次，无重试），`FULL_SELECTION`，`satisfiesQ1=false`；
  - `restrained-reunion` / `suspense-corridor` → **FAILED `PROVIDER_RESPONSE_INVALID`**（finishReason `max_tokens`，usage null）；
  - `two-voice-dialogue` → SUCCEEDED（input 587 / output 779 tokens，latency 8155ms）；
  - 不生成 candidates / evaluation / blind；发布 private partial 诊断快照（manifest + case-results + logs）。
  - **观察**：MiMo V2.5 Pro 的 extended-thinking 在 `maxTokens=1024` 下可能耗尽输出预算，返回仅 thinking、无 text block 的响应 → gateway 判 `PROVIDER_RESPONSE_INVALID`。这是真实模型输出变异性，Runner 按设计如实记为失败（未伪装成功）。后续实验可在授权下评估提高 `--max-tokens` 或调整 provider thinking 参数。
- **总付费调用**：4 次（1 smoke + 3 full），无自动重试。
- **Q1**：**未达成**——full suite 未全成功，尚未以「全部 case 真实成功」演示闭环。**无质量提升结论。**
- **Keychain 状态**：2026-08-02 晚些时候用户已在固定 service/account 配置密钥；此前 `LIVE_BLOCKED_KEY_NOT_CONFIGURED` 已解除（`hasSecret`=true）。
