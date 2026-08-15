/**
 * @ai-novel/writing-evaluation
 *
 * 离线、可复现、中文优先的文章质量评测实验基础设施。
 *
 * 本 package 提供纯函数质量指标：离线实验使用完整报告，产品运行时复用文本分段、
 * 重复与 AI 腔启发式信号作为保守质量门：
 * - 自身不打开 SQLite、不调用模型、不发送网络请求；
 * - 不上传用户文本；不自动把用户文本写入 Git 仓库；
 * - 测试通过只证明评测工具工作，不证明生成质量提高。
 */

// ── Schema 与类型 ─────────────────────────────────────────────────
export * from './schema.js';

// ── 验证 ──────────────────────────────────────────────────────────
export {
  validateSuite,
  validateBlindPacket,
  validatePrivateMapping,
  EvaluationValidationError,
  looksLikeSuite,
} from './validate.js';

// ── Canonical / Hash / Clock ──────────────────────────────────────
export { canonicalize, canonicalSerializeSuite } from './canonical.js';
export { sha256Hex, isLowercaseSha256Hex } from './hash.js';
export { systemClock, fixedClock, type Clock } from './clock.js';

// ── 文本 ──────────────────────────────────────────────────────────
export {
  normalizeText,
  codePointLength,
  hasSubstantiveContent,
  containsWhitespace,
  segmentText,
  type TextSegmentation,
} from './text.js';

// ── 指标 ──────────────────────────────────────────────────────────
export {
  computeBasicStats,
  computeSentenceLengthDistribution,
  computeParagraphLengthDistribution,
  computeRepetitionMetrics,
  duplicateSentenceRatio,
  repeatedSentenceOpenerRatio,
  repeatedCharacterNgramRatio,
  sentenceOpener,
  topRepeatedNgrams,
  topRepeatedSentenceOpeners,
} from './metrics.js';
export { computeDistribution } from './stats.js';
export {
  computeAiSmellSignals,
  DEFAULT_AI_SMELL_LEXICON,
  renderLexiconPattern,
  type AiSmellLexicon,
  type AiSmellLexiconEntry,
} from './ai-smell.js';
export {
  findPhraseOccurrences,
  findPairOccurrences,
  makeExcerpt,
  type PhraseMatch,
} from './match.js';

// ── 约束 ──────────────────────────────────────────────────────────
export { evaluateConstraint, evaluateConstraints } from './constraints.js';

// ── 评测主流程 ────────────────────────────────────────────────────
export { evaluateSuite, type EvaluateOptions } from './evaluate.js';

// ── 关系断言 ──────────────────────────────────────────────────────
export { checkExpectedRelations, resolveMetricValue, RELATION_EPSILON } from './relations.js';

// ── 盲评 ──────────────────────────────────────────────────────────
export { generateBlindPacket, type BlindPacketOptions } from './blind.js';

// ── 人工评分 ──────────────────────────────────────────────────────
export {
  validateRatings,
  aggregateRatings,
  RatingValidationError,
  type ValidateRatingsOptions,
  type AggregateRatingsOptions,
} from './rating.js';
export { computeRatingAgreement, type RatingAgreementResult } from './agreement.js';

// ── Markdown ──────────────────────────────────────────────────────
export { renderMarkdownReport, renderMarkdownRatingAggregation } from './markdown.js';

// ── CLI ───────────────────────────────────────────────────────────
export { parseCliArgs, runCli, CliUsageError, type ParsedCli, type CliDeps } from './cli.js';

// ── 未来生成策略端口 ──────────────────────────────────────────────
export {
  createFakeCandidateGenerator,
  type WritingCandidateGeneratorPort,
  type WritingGenerationExperimentInput,
} from './generator-port.js';

// ── 固定评测 fixtures ─────────────────────────────────────────────
export { getBaselineSuite } from './fixtures.js';
