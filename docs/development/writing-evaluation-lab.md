# Writing Evaluation Lab

> 定位：**离线、可复现、中文优先的文章质量评测实验基础设施**。
>
> 本工具是研究和回归工具，不是产品运行时依赖。测试通过只证明评测工具工作，**不证明文章质量提高**。

## 一、用途

在 Scene Planner、Draft Generator、Critic 和 Targeted Rewriter 出现之前，先建立可比较的测量与盲评基础设施。

- 固定创作题库（contract + scene brief + 约束 + 候选文本）；
- 多生成策略对比（strategy / model / promptVersion / 生成参数记录）；
- 第一批可解释自动指标（客观统计 + 启发式信号）；
- 显式创作约束检查；
- 候选文章匿名盲评包与 private mapping；
- 人工评分数据模型与聚合；
- 稳定 JSON / Markdown 报告；
- 指标关系回归测试（fixtures 的 expected relations）。

**为什么先做评测**：后续任何 prompt / pipeline / 参数改动，都需要一个可信、可复现的测量基线，否则只能凭感觉修改 prompt。评测先行的另一面是：**评测先行不提高文章质量本身**，它只是让“是否提高”这件事可以被回答。

## 二、核心设计原则

1. 评测输入和结果严格版本化（`schemaVersion`、`toolVersion`）。
2. 相同输入产生 byte-stable JSON report（同一 Clock）。
3. 指标可解释，并提供原始数值或 evidence。
4. 启发式信号不能冒充文章质量事实。
5. 不提供单一“总质量分”。
6. 自动指标不能代替人工盲评。
7. 不把“像不像 AI”作为检测器规避问题。
8. 不上传用户文本；不自动把用户文本写入 Git 仓库。
9. 默认不在 report 中复制完整 candidate text。
10. fixtures 必须为本项目原创文本，禁止复制已出版小说。
11. 测试通过只证明评测工具工作，不证明生成质量提高。

## 三、数据模型（Evaluation Suite V1）

```
WritingEvaluationSuiteV1
  schemaVersion: 1
  suiteId / title / description / locale: 'zh-CN'
  cases: WritingEvaluationCaseV1[]

WritingEvaluationCaseV1
  caseId / title / description
  contract: CreationContractSections        // 复用 Domain 的真实完整验证
  sceneBrief: EvaluationSceneBriefV1
  constraints: EvaluationConstraintV1[]
  candidates: WritingCandidateV1[]
  expectedRelations?: ExpectedMetricRelationV1[]

EvaluationSceneBriefV1
  sceneGoal / participants / location
  entryState / exitState
  conflict / requiredFacts / forbiddenFacts
  targetLength: { minCodePoints, maxCodePoints }

WritingCandidateV1
  candidateId / strategyId / modelId / promptVersion
  generationParameters: { temperature, maxTokens, seed }
  text
```

运行时验证（`validateSuite`）：

- exact keys；拒绝 inherited keys 与 extra keys；
- ID trim 后非空，长度按 Unicode code point 计算；
- suite / case / candidate ID 唯一；case 内 constraintId 唯一；
- safe integer、finite number；NFC 规范化；
- 文本规范化后不得为空；
- contract 走 `@ai-novel/domain` 的 `validateCreationContractSections` 完整验证；
- 解析不 mutation 输入；
- 错误消息稳定且不回显完整文章。

## 四、显式创作约束（Evaluation Constraint V1）

封闭 union，当前支持六种：

| kind                   | 字段                         | 说明                               |
| ---------------------- | ---------------------------- | ---------------------------------- |
| `required-phrase`      | phrase, minOccurrences       | 短语至少出现 N 次                  |
| `forbidden-phrase`     | phrase                       | 短语不得出现                       |
| `phrase-max-count`     | phrase, maxOccurrences       | 短语最多出现 N 次                  |
| `text-length-range`    | minCodePoints, maxCodePoints | 文本长度范围                       |
| `dialogue-ratio-range` | minRatio, maxRatio           | 对话占比范围                       |
| `manual-criterion`     | title, rubric                | 人工评估项，**始终 NOT_EVALUATED** |

约束结果状态：`PASS` / `FAIL` / `NOT_EVALUATED`。

- `manual-criterion` 不得伪装成自动完成；
- 每个结果包含安全 explanation；
- phrase evidence 包含 paragraph/sentence index 与短 excerpt（默认 ≤ 40 code points），不返回整篇正文；
- 结果按 constraintId code-point 排序；
- **不执行任意用户正则表达式**。

## 五、中文文本规范化与分段/分句

`src/text.ts` 为纯函数，不 mutation 输入。

**段落规则**（已记录，测试覆盖）：

- NFC 规范化后，将 CRLF / CR 统一为 LF；
- 按 `\n` 切分逻辑行；
- 清除每行首尾空白；
- 每个非空逻辑行是一个段落；
- 连续空行不产生空段落；
- 不自动合并相邻行。

**句末识别**：

- 中文句末：`。 ！ ？`；ASCII 句末：`! ?`；
- 省略号：`……`（两个 U+2026）、单个 `…`、ASCII `...` 连续点；
- ASCII `.` 仅在“不是小数点”时作为句末（`digit.digit` 之间不切句）；
- 句子结尾后的闭合引号（`” 」 』` 以及处于英文引号内的 `"`）归入当前句；
- 连续句末标点归入当前句；
- 仅由标点/空白组成的片段不记为句子。

**引号**：支持 `“”` `「」` `『』` 与 ASCII 双引号；未闭合引号产生 warning；对话 code points = 从开引号到匹配闭引号（含引号）的 code points，未闭合区域不计入对话；**嵌套引号只统计最外层区域**，避免重复计数。

## 六、自动指标 V1

| 类别              | 指标                                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 基础统计          | codePointCount, paragraphCount, sentenceCount, dialogueCodePointRatio                                                                    |
| 句长分布          | min, max, mean, median, p90, standardDeviation, coefficientOfVariation                                                                   |
| 段落长度分布      | 同上                                                                                                                                     |
| 重复信号          | duplicateSentenceRatio, repeatedCharacterNgramRatio(n=2/3/4), repeatedSentenceOpenerRatio, topRepeatedNgrams, topRepeatedSentenceOpeners |
| AI-smell 词表信号 | 每词条 count / perThousandCodePoints / evidence；totalCount / totalPerThousandCodePoints                                                 |
| 均匀性信号        | sentenceLengthUniformitySignal = 句长 CV；paragraphLengthUniformitySignal = 段落长度 CV                                                  |

指标定义：

- `p90`：nearest-rank 法，升序取 `ceil(0.9*n)` 位置（1-based）；
- `standardDeviation`：总体标准差（除以 n）；
- `coefficientOfVariation` = std / mean（mean 为 0 时为 null）；
- 空分布：min/max/mean/median/p90/std/cv 全部为 null；单值：全部等于该值，std=cv=0；
- n-gram 规则：code-point 基础，不使用 UTF-16 index；跳过含空白窗口；跳过纯标点窗口；同分按 code-point 顺序排序；
- 句子开词 = 句子第一个实质字符（跳过前导引号/省略号/空白）；
- 重复比例 = `1 - 唯一项数 / 总数`。

**AI-smell 词表信号限制**：

- 出现这些词不等于文章差；
- 指标名称体现 heuristic / signal 定位；
- 不命名为 `AI_DETECTED`；不输出“人类概率”或“AI 概率”；
- 词表可配置（`AiSmellLexicon`），默认提供中文初始词表；
- 词条之间不互斥（`空气仿佛凝固` 会同时命中 `仿佛` 词条）。

## 七、无单一总分

本 package **不实现** `overallQualityScore`，也不做默认加权汇总成 0–100 分。原因：

- 不同题材目标不同（对话密度、句长节奏、信息揭示速度的目标值不同）；
- 各指标量纲不同；
- 启发式信号不是质量真值；
- 单一分数容易被优化和误导；
- 人工评分与自动指标应分开查看。

允许：每个指标单独展示；约束 PASS/FAIL；人工评分各维度均值；候选间指定指标关系；用户显式定义的实验比较。

## 八、盲评包

`generateBlindPacket(suite, { seed })` 输出两个分离对象：

1. **blind packet**：suiteId、caseId、匿名 alias（A/B/C…）、候选文本、场景 brief、人工评分 rubric。**不包含** candidateId / strategyId / modelId / promptVersion / generationParameters。
2. **private mapping**：caseId → alias → candidateId。必须与评审者隔离，**不提交到 Git**。

排序：`SHA-256(seed + suiteId + caseId + candidateId)` 十六进制升序决定 alias。同 seed 稳定；不同 seed 可改变顺序；alias 无碰撞。

## 九、人工评分

`HumanRatingV1` 八个 1–5 整数维度：

`continueReading`, `expectationFit`, `characterCredibility`, `languageNaturalness`, `aiSmellAbsence`, `plotProgression`, `concision`, `continuity`

另有：`suiteId`, `caseId`, `candidateAlias`, `raterId`, `preferredRank`, `notes`。

验证：

- exact keys；1–5 整数；raterId 非空；notes code-point 上限（2000）；
- alias 必须存在于 blind packet；
- 同 rater/case/alias 不得重复；
- 同 (rater, case) 的 preferredRank 不得重复。

聚合输出：

- 每个 candidate/dimension 的 count / mean / median；
- preference rank 分布；
- pairwise wins（只统计同时给两个候选打分的 rater）；
- rater count；missing dimensions warning；
- **不计算默认 overall score**。

样本 ratings 只作为格式示例，不得描述为真实用户研究（聚合报告含此警告）。

## 十、CLI

```
writing-evaluation help
writing-evaluation validate <suite.json> [--type suite|ratings] [--packet <blind-packet.json>]
writing-evaluation evaluate <suite.json> [--output <report.json>] [--format json|markdown] [--clock <iso>] [--force]
writing-evaluation blind <suite.json> --seed <seed> [--packet-output <packet.json>] [--mapping-output <mapping.json>] [--force]
writing-evaluation aggregate --packet <packet.json> --mapping <mapping.json> --ratings <ratings.json> [--output <agg.json>] [--format json|markdown] [--clock <iso>] [--force]
```

约定：

- 不使用外部 CLI dependency；严格参数解析，unknown option / missing argument 失败；
- exit code：0 成功，非 0 校验或 IO 失败；
- 错误消息安全：不回显完整候选文本，不输出 absolute path 到公共错误；
- 无网络访问；默认不写文件，除非显式提供 output；不覆盖已有文件，除非显式 `--force`；
- UTF-8；JSON 为确定性 compact 输出；Markdown 稳定；
- Programmatic API（`evaluateSuite` / `validateSuite` / `generateBlindPacket` / `aggregateRatings`）与 CLI parser 分离。

## 十一、Markdown Report

顶部声明：此报告不是 AI 检测器；自动指标不代表文学质量；没有单一总分；人工盲评仍是质量判断核心。

至少展示：suite/case；candidate metadata（strategy/model/promptVersion/textHash，不含 prompt 原文）；自动指标覆盖范围；显式约束结果；句长/段落长度分布；重复信号；AI-smell 启发式计数；top evidence（短 excerpt）；警告；人工评分聚合（存在时）；未自动评估的质量维度。默认不嵌入完整文章正文。

## 十二、Baseline Fixtures

三个原创中文用例（`src/fixtures.ts`）：

1. `restrained-reunion`（克制的重逢）：restrained vs over-explained。预期：over-explained 的 AI-smell 词表命中更高。
2. `suspense-corridor`（悬疑走廊）：controlled reveal vs repetitive reveal。预期：repetitive 的重复句子 / 重复 n-gram / 开词重复更高。
3. `two-voice-dialogue`（双声对话）：distinct voices vs homogenized voices。自动指标只检查对话占比、显式词语约束与长度；**人物声音质量保留为 manual criterion，不伪造自动语义判断**。

全部文本为本项目原创，不复制已出版小说，不使用用户私人文本。每个候选足以产生有意义的统计。

## 十三、Expected Metric Relations（fixture 回归）

```ts
{
  metricId: string; // 必须是 METRIC_IDS 注册表内的指标
  leftCandidateId: string;
  operator: 'LT' | 'LTE' | 'GT' | 'GTE' | 'EQ';
  rightCandidateId: string;
}
```

`checkExpectedRelations(suite, report)` 校验 baseline 全部关系成立。关系失败提供 case/metric/candidate 信息，不含整篇正文。浮点比较采用明确 epsilon（`1e-9`）。**关系只验证工具能辨别预先设计的差异，不证明一般文章质量。**

## 十四、隐私与 artifact policy

- 真实用户文本和报告只保存在本地；
- 默认推荐输出到项目外或 ignored directory（`.writing-evaluation-results/`、`writing-evaluation-results/` 已加入 `.gitignore`）；
- 不得提交 private mapping；
- 不得提交真实用户 ratings；
- 不得上传任何文本；
- 该工具不读取 Keychain，不调用网络，不打开 SQLite。

## 十五、如何新增 metric

1. 在 `schema.ts` 的 `METRIC_IDS` 注册稳定 ID；
2. 在指标模块（如 `metrics.ts`）实现计算；
3. 在 `evaluate.ts` 的 candidate report 中填充；
4. 在 `relations.ts` 的 `resolveMetricValue` 中实现取值；
5. 在 Markdown report 中展示（可选）；
6. 补充测试并更新本文档。

## 十六、如何新增 fixture

1. 在 `src/fixtures.ts` 新增 case：契约、场景 brief、约束、候选文本、expected relations；
2. 所有文本必须原创；
3. 每个候选足以产生有意义的统计；
4. expected relations 只断言你能稳定控制的差异；
5. `fixtures.test.ts` 会自动验证所有关系成立。

## 十七、如何接入未来 generator adapter

```ts
interface WritingCandidateGeneratorPort {
  generate(input: WritingGenerationExperimentInput): Promise<WritingCandidateV1>;
}
```

本 PR 只用 fake generator 测试（`createFakeCandidateGenerator`）。接口保持小而通用，不提前冻结 Scene Planner 或生产 Generation API。真实 adapter 需要：接收 experiment input → 生成候选 → 纳入 suite 后走现有评测链路。**禁止**在本 package 内直接调用 model-gateway。

## 十八、当前明确不能评估的内容

以下能力尚未实现，也不会被自动指标冒充：

- 人物可信度、情节质量、潜台词质量；
- 语义连续性；
- 人物声音真实区分度；
- 文学价值；
- 是否想继续读；
- 长篇信息一致性（事实账本 / 伏笔 / 时间线冲突）。

这些维度只通过 `manual-criterion` 进入人工盲评。

## 十九、边界

- 本 package 是 Node-only 开发工具包；
- 依赖仅 `@ai-novel/domain` + Node 24 built-ins + 现有 dev dependencies；
- 禁止依赖 application / database / task-engine / model-gateway / Electron / React / PlotPilot / 外部 NLP 库 / 外部分词服务 / 任何网络服务；
- 不打开 SQLite、不调用模型、不读取 Keychain、不发送网络请求、不接入 Worker、不添加 IPC、不修改 DesktopAPI、不添加 Renderer。

## 二十、测试与质量门禁

- 测试矩阵：schema validation、unicode & segmentation、metrics、constraints、determinism、human ratings、CLI、baseline fixtures、dependency boundary；
- 测试通过只证明评测工具工作，**不证明生成质量提高**；
- 质量门禁包括：`pnpm check`（format/lint/build/typecheck/test）、package-specific CLI smoke、Keychain 回归、artifact-free package 与 desktop smoke。

## 二十一、已知限制

- AI-smell 词表是启发式信号，可能误报（如角色有意使用套话）；
- 对话占比依赖引号配对，未闭合引号会低估对话；
- 句子切分对不规范标点（如连续感叹号）是启发式的；
- n-gram 忽略跨空白窗口，长句内部重复可能被低估；
- 所有自动指标都只能支持“假设生成”的实验结论，不能直接外推到真实小说质量。
