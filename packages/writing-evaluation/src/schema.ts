/**
 * @ai-novel/writing-evaluation - Schema Types
 *
 * 严格、封闭、带版本号的评测数据模型。
 * 全部字段只读。运行时验证见 validate.ts。
 *
 * 设计原则：
 * - 不信任 TypeScript 类型，JSON 输入一律运行时验证；
 * - 相同输入必须产生 byte-stable 输出；
 * - 指标可解释并提供 evidence；
 * - 启发式信号不冒充文章质量事实；
 * - 不提供单一“总质量分”。
 */

import type { CreationContractSections } from '@ai-novel/domain';

// ── 版本与工具标识 ────────────────────────────────────────────────

export const WRITING_EVALUATION_SCHEMA_VERSION = 1;

/** 当前评测工具版本。报告中的 toolVersion 由调用方注入，这里提供默认值。 */
export const DEFAULT_TOOL_VERSION = 'writing-evaluation@0.1.0';

export type WritingEvaluationLocale = 'zh-CN';

// ── 约束状态 ──────────────────────────────────────────────────────

export type ConstraintStatus = 'PASS' | 'FAIL' | 'NOT_EVALUATED';

// ── 场景简报 ──────────────────────────────────────────────────────

export interface EvaluationSceneBriefV1 {
  readonly sceneGoal: string;
  readonly participants: readonly string[];
  readonly location: string;
  readonly entryState: readonly string[];
  readonly exitState: readonly string[];
  readonly conflict: string;
  readonly requiredFacts: readonly string[];
  readonly forbiddenFacts: readonly string[];
  readonly targetLength: {
    readonly minCodePoints: number;
    readonly maxCodePoints: number;
  };
}

// ── 显式创作约束 ──────────────────────────────────────────────────

export interface RequiredPhraseConstraint {
  readonly kind: 'required-phrase';
  readonly constraintId: string;
  readonly phrase: string;
  readonly minOccurrences: number;
}

export interface ForbiddenPhraseConstraint {
  readonly kind: 'forbidden-phrase';
  readonly constraintId: string;
  readonly phrase: string;
}

export interface PhraseMaxCountConstraint {
  readonly kind: 'phrase-max-count';
  readonly constraintId: string;
  readonly phrase: string;
  readonly maxOccurrences: number;
}

export interface TextLengthRangeConstraint {
  readonly kind: 'text-length-range';
  readonly constraintId: string;
  readonly minCodePoints: number;
  readonly maxCodePoints: number;
}

export interface DialogueRatioRangeConstraint {
  readonly kind: 'dialogue-ratio-range';
  readonly constraintId: string;
  readonly minRatio: number;
  readonly maxRatio: number;
}

export interface ManualCriterionConstraint {
  readonly kind: 'manual-criterion';
  readonly constraintId: string;
  readonly title: string;
  readonly rubric: string;
}

/**
 * 封闭 union。新增约束类型必须在此扩展并同步 validate.ts / constraints.ts。
 * 不允许任意用户正则表达式执行。
 */
export type EvaluationConstraintV1 =
  | RequiredPhraseConstraint
  | ForbiddenPhraseConstraint
  | PhraseMaxCountConstraint
  | TextLengthRangeConstraint
  | DialogueRatioRangeConstraint
  | ManualCriterionConstraint;

// ── 候选文本 ──────────────────────────────────────────────────────

export interface WritingGenerationParameters {
  readonly temperature: number | null;
  readonly maxTokens: number | null;
  readonly seed: string | null;
}

export interface WritingCandidateV1 {
  readonly candidateId: string;
  readonly strategyId: string;
  readonly modelId: string;
  readonly promptVersion: string;
  readonly generationParameters: WritingGenerationParameters;
  readonly text: string;
}

// ── 期望指标关系（fixture 回归机制）───────────────────────────────

export type ExpectedRelationOperator = 'LT' | 'LTE' | 'GT' | 'GTE' | 'EQ';

export interface ExpectedMetricRelationV1 {
  readonly metricId: string;
  readonly leftCandidateId: string;
  readonly operator: ExpectedRelationOperator;
  readonly rightCandidateId: string;
}

// ── 评测用例与套件 ────────────────────────────────────────────────

export interface WritingEvaluationCaseV1 {
  readonly caseId: string;
  readonly title: string;
  readonly description: string;
  readonly contract: CreationContractSections;
  readonly sceneBrief: EvaluationSceneBriefV1;
  readonly constraints: readonly EvaluationConstraintV1[];
  readonly candidates: readonly WritingCandidateV1[];
  readonly expectedRelations?: readonly ExpectedMetricRelationV1[];
}

export interface WritingEvaluationSuiteV1 {
  readonly schemaVersion: 1;
  readonly suiteId: string;
  readonly title: string;
  readonly description: string;
  readonly locale: WritingEvaluationLocale;
  readonly cases: readonly WritingEvaluationCaseV1[];
}

// ── 指标 ID 注册表 ────────────────────────────────────────────────

/**
 * 指标 ID 是关系断言和 markdown 报告中使用的稳定字符串键。
 * 新增指标必须在此注册，并在 resolveMetricValue 中实现取值。
 */
export const METRIC_IDS = [
  'basic.codePointCount',
  'basic.paragraphCount',
  'basic.sentenceCount',
  'basic.dialogueCodePointRatio',
  'distribution.sentenceLength.min',
  'distribution.sentenceLength.max',
  'distribution.sentenceLength.mean',
  'distribution.sentenceLength.median',
  'distribution.sentenceLength.p90',
  'distribution.sentenceLength.standardDeviation',
  'distribution.sentenceLength.coefficientOfVariation',
  'distribution.paragraphLength.min',
  'distribution.paragraphLength.max',
  'distribution.paragraphLength.mean',
  'distribution.paragraphLength.median',
  'distribution.paragraphLength.p90',
  'distribution.paragraphLength.standardDeviation',
  'distribution.paragraphLength.coefficientOfVariation',
  'repetition.duplicateSentenceRatio',
  'repetition.repeatedCharacterNgramRatio.2',
  'repetition.repeatedCharacterNgramRatio.3',
  'repetition.repeatedCharacterNgramRatio.4',
  'repetition.repeatedSentenceOpenerRatio',
  'ai-smell.totalCount',
  'ai-smell.totalPerThousandCodePoints',
] as const;

export type MetricId = (typeof METRIC_IDS)[number];

// ── 指标结果类型 ──────────────────────────────────────────────────

export interface BasicStats {
  readonly codePointCount: number;
  readonly paragraphCount: number;
  readonly sentenceCount: number;
  readonly dialogueCodePointRatio: number;
}

export interface DistributionStats {
  readonly min: number | null;
  readonly max: number | null;
  readonly mean: number | null;
  readonly median: number | null;
  readonly p90: number | null;
  readonly standardDeviation: number | null;
  readonly coefficientOfVariation: number | null;
}

export interface RepeatedNgram {
  readonly n: number;
  readonly ngram: string;
  readonly count: number;
}

export interface RepeatedOpener {
  readonly opener: string;
  readonly count: number;
}

export interface RepetitionMetrics {
  readonly duplicateSentenceRatio: number;
  readonly repeatedCharacterNgramRatio: {
    readonly n2: number;
    readonly n3: number;
    readonly n4: number;
  };
  readonly repeatedSentenceOpenerRatio: number;
  readonly topRepeatedNgrams: readonly RepeatedNgram[];
  readonly topRepeatedSentenceOpeners: readonly RepeatedOpener[];
}

export interface AiSmellEvidence {
  readonly lexiconId: string;
  readonly paragraphIndex: number;
  readonly sentenceIndex: number | null;
  readonly excerpt: string;
}

export interface AiSmellEntrySignal {
  readonly lexiconId: string;
  /** 渲染后的匹配模式：普通词条显示 phrase，成对词条显示 "A……B" */
  readonly pattern: string;
  readonly count: number;
  readonly perThousandCodePoints: number;
  readonly evidence: readonly AiSmellEvidence[];
}

export interface AiSmellSignals {
  readonly lexiconVersion: string;
  readonly entries: readonly AiSmellEntrySignal[];
  readonly totalCount: number;
  readonly totalPerThousandCodePoints: number;
}

// ── 约束结果 ──────────────────────────────────────────────────────

export interface ConstraintEvidence {
  readonly paragraphIndex: number;
  readonly sentenceIndex: number | null;
  /** 短 excerpt，默认不超过 MAX_EXCERPT_CODE_POINTS */
  readonly excerpt: string;
}

export interface ConstraintResult {
  readonly constraintId: string;
  readonly kind: EvaluationConstraintV1['kind'];
  readonly status: ConstraintStatus;
  /** 安全 explanation，不包含完整正文 */
  readonly explanation: string;
  readonly evidence: readonly ConstraintEvidence[];
}

// ── 报告 ──────────────────────────────────────────────────────────

export interface MetricCoverage {
  readonly automatic: {
    readonly length: boolean;
    readonly distributions: boolean;
    readonly repetition: boolean;
    readonly lexiconSignals: boolean;
    readonly explicitConstraints: boolean;
  };
  /** 尚未实现或只能人工评估的质量维度 */
  readonly notImplementedOrManualOnly: readonly string[];
}

export interface CaseReport {
  readonly caseId: string;
  readonly title: string;
  readonly candidateIds: readonly string[];
}

export interface CandidateEvidence {
  readonly aiSmell: readonly AiSmellEvidence[];
}

export interface CandidateReport {
  readonly candidateId: string;
  readonly strategyId: string;
  readonly modelId: string;
  readonly promptVersion: string;
  readonly generationParameters: WritingGenerationParameters;
  readonly textHash: string;
  readonly basicStats: BasicStats;
  readonly distributionMetrics: {
    readonly sentenceLength: DistributionStats;
    readonly paragraphLength: DistributionStats;
  };
  readonly repetitionMetrics: RepetitionMetrics;
  readonly aiSmellSignals: AiSmellSignals;
  readonly constraintResults: readonly ConstraintResult[];
  readonly evidence: CandidateEvidence;
  readonly warnings: readonly string[];
}

export interface WritingEvaluationReportV1 {
  readonly schemaVersion: 1;
  readonly suiteId: string;
  readonly suiteHash: string;
  readonly generatedAt: string;
  readonly toolVersion: string;
  readonly caseResults: readonly CaseReport[];
  readonly candidateResults: readonly CandidateReport[];
  readonly metricCoverage: MetricCoverage;
  readonly warnings: readonly string[];
}

// ── 关系断言结果 ──────────────────────────────────────────────────

export interface RelationCheckResult {
  readonly caseId: string;
  readonly metricId: string;
  readonly leftCandidateId: string;
  readonly operator: ExpectedRelationOperator;
  readonly rightCandidateId: string;
  readonly leftValue: number;
  readonly rightValue: number;
  readonly passed: boolean;
}

// ── 盲评 ──────────────────────────────────────────────────────────

export interface BlindCaseCandidate {
  readonly alias: string;
  readonly text: string;
}

export interface BlindCasePacket {
  readonly caseId: string;
  readonly title: string;
  readonly sceneBrief: EvaluationSceneBriefV1;
  readonly manualCriteria: readonly ManualCriterionConstraint[];
  readonly candidates: readonly BlindCaseCandidate[];
}

export interface BlindPacketV1 {
  readonly schemaVersion: 1;
  readonly locale: WritingEvaluationLocale;
  readonly suiteId: string;
  readonly packetId: string;
  readonly cases: readonly BlindCasePacket[];
}

export interface PrivateMappingEntry {
  readonly suiteId: string;
  readonly caseId: string;
  readonly alias: string;
  readonly candidateId: string;
}

export interface PrivateMappingV1 {
  readonly schemaVersion: 1;
  readonly suiteId: string;
  readonly seed: string;
  readonly entries: readonly PrivateMappingEntry[];
}

// ── 人工评分 ──────────────────────────────────────────────────────

export const HUMAN_RATING_DIMENSIONS = [
  'continueReading',
  'expectationFit',
  'characterCredibility',
  'languageNaturalness',
  'aiSmellAbsence',
  'plotProgression',
  'concision',
  'continuity',
] as const;

export type HumanRatingDimension = (typeof HUMAN_RATING_DIMENSIONS)[number];

// ── 盲评 alias 共享规则 ────────────────────────────────────────────

/**
 * 盲评 alias 规则：大写单字母 A-Z。
 * 与 generateBlindPacket 的 MAX_ALIASES=26 一致；BlindPacket validator 与
 * HumanRating validator 必须共用此规则，不得维护第二套 regex。
 */
export const BLIND_ALIAS_RE = /^[A-Z]$/;

export function isValidBlindAlias(alias: string): boolean {
  return BLIND_ALIAS_RE.test(alias);
}

export const BLIND_ALIAS_ERROR = '必须是大写单字母 A-Z（如 A、B、C，最多 26 个候选）';

export interface HumanRatingV1 {
  readonly schemaVersion: 1;
  readonly suiteId: string;
  readonly caseId: string;
  readonly candidateAlias: string;
  readonly raterId: string;
  readonly preferredRank: number;
  readonly notes: string;
  /**
   * 8 个质量维度：1–5 整数表示已评；null 表示未评。
   * validateRatings 接受字段缺失或显式 null，并统一规范化为 null。
   */
  readonly continueReading: number | null;
  readonly expectationFit: number | null;
  readonly characterCredibility: number | null;
  readonly languageNaturalness: number | null;
  readonly aiSmellAbsence: number | null;
  readonly plotProgression: number | null;
  readonly concision: number | null;
  readonly continuity: number | null;
}

export interface DimensionAggregate {
  /** 已评条数：null（未评）不参与 mean/median，也不计入 count。 */
  readonly count: number;
  readonly mean: number | null;
  readonly median: number | null;
}

export interface CandidateRatingAggregate {
  readonly caseId: string;
  readonly alias: string;
  /** 提供 private mapping 时解析出的真实 candidateId，否则为 null */
  readonly candidateId: string | null;
  readonly dimensions: Record<HumanRatingDimension, DimensionAggregate>;
  /** rank -> 获得该排名的 rater 数量 */
  readonly rankDistribution: Record<number, number>;
  readonly raterCount: number;
}

export interface PairwiseWin {
  readonly caseId: string;
  /** 对局双方 alias（按 code-point 排序，稳定） */
  readonly aliasA: string;
  readonly aliasB: string;
  /** aliasA 胜过 aliasB 的次数 */
  readonly aliasAWins: number;
  /** aliasB 胜过 aliasA 的次数 */
  readonly aliasBWins: number;
  readonly ties: number;
}

// ── 评分者间一致性 ────────────────────────────────────────────────

export interface DimensionAgreement {
  /**
   * 该维度的 Krippendorff's alpha（ordinal difference）。
   * 评分者少于 2 位，或该维度没有任何 (case, candidate) 被至少 2 位评分者共同给出该维度评分时为 null。
   */
  readonly alpha: number | null;
  /** 完全一致率：可成对比较的两两评分中，两位评分者给出同一分的比例。 */
  readonly exactAgreementRate: number | null;
  /** ±1 内一致率：可成对比较的两两评分中，两位评分者分差 ≤ 1 的比例。 */
  readonly withinOneAgreementRate: number | null;
  /** 参与该维度计算的可比较评分对数量（同一 (case, candidate) 内的两两评分对）。 */
  readonly comparablePairCount: number;
  /** 参与该维度计算的 rating 条数。 */
  readonly ratingCount: number;
  /** 参与该维度计算的评分者数。 */
  readonly raterCount: number;
  /** 参与该维度计算的 case 数。 */
  readonly caseCount: number;
  /** 参与该维度计算的候选数（(case, candidate) 单元数）。 */
  readonly candidateCount: number;
}

export interface RatingAgreementSample {
  /** 参与一致性计算的 rating 条数（被至少 2 位评分者共同覆盖的 (case, candidate) 内的评分）。 */
  readonly ratingCount: number;
  readonly raterCount: number;
  readonly caseCount: number;
  readonly candidateCount: number;
  /** 同一 (case, candidate) 内可比较的评分者对数量（不按 8 个维度重复计算）。 */
  readonly comparablePairCount: number;
  /** 未参与一致性计算的 rating 条数（所在 (case, candidate) 只有 1 位评分者）。 */
  readonly excludedRatingCount: number;
  readonly excludedRaterCount: number;
  readonly excludedCaseCount: number;
  readonly excludedCandidateCount: number;
}

export interface RatingAgreementBlock {
  readonly method: 'krippendorff-alpha';
  readonly metric: 'ordinal';
  /** 为什么选用该指标；报告中必须可读。 */
  readonly rationale: string;
  readonly overallAlpha: number | null;
  readonly dimensions: Record<HumanRatingDimension, DimensionAgreement>;
  readonly sample: RatingAgreementSample;
}

export interface RatingAggregationReport {
  readonly schemaVersion: 1;
  readonly suiteId: string;
  readonly generatedAt: string;
  readonly toolVersion: string;
  readonly candidateAggregates: readonly CandidateRatingAggregate[];
  readonly pairwiseWins: readonly PairwiseWin[];
  readonly raterCount: number;
  readonly agreement: RatingAgreementBlock;
  /**
   * 某 (case, rater) 未覆盖该 case 内全部 alias 的记录（格式 "caseId/raterId"）。
   * 维度级未评通过各 dimension 的 count/null 与 agreement 暴露，
   * 不属于 missingRatingCoverage。
   */
  readonly missingRatingCoverage: readonly string[];
  readonly warnings: readonly string[];
}

// ── 未来 generator 端口 ───────────────────────────────────────────

export interface WritingGenerationExperimentInput {
  readonly suiteId: string;
  readonly caseId: string;
  readonly sceneBrief: EvaluationSceneBriefV1;
  readonly contract: CreationContractSections;
  readonly constraints: readonly EvaluationConstraintV1[];
}

/**
 * 纯接口：为后续接入真实生成策略预留。
 * 本 PR 只用 fake generator 测试；不提供 model-gateway adapter。
 * 保持小而通用，不提前冻结 Scene Planner 或生产 Generation API。
 */
export interface WritingCandidateGeneratorPort {
  generate(input: WritingGenerationExperimentInput): Promise<WritingCandidateV1>;
}
