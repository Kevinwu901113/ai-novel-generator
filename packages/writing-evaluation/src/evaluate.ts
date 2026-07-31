/**
 * 评测主流程：validate suite → 计算指标 → 构建报告。
 *
 * 报告保证：
 * - 同一 Clock + 同一输入 → byte-identical JSON；
 * - 数组稳定排序；
 * - 默认不包含完整 candidate text；
 * - 不保存 prompt、API Key、source file absolute path。
 */

import { codePointCompare } from '@ai-novel/domain';
import type {
  AiSmellSignals,
  CandidateReport,
  CaseReport,
  MetricCoverage,
  WritingCandidateV1,
  WritingEvaluationReportV1,
  WritingEvaluationSuiteV1,
} from './schema.js';
import { DEFAULT_TOOL_VERSION, WRITING_EVALUATION_SCHEMA_VERSION } from './schema.js';
import { validateSuite } from './validate.js';
import { canonicalSerializeSuite } from './canonical.js';
import { sha256Hex } from './hash.js';
import type { Clock } from './clock.js';
import { segmentText } from './text.js';
import {
  computeBasicStats,
  computeParagraphLengthDistribution,
  computeRepetitionMetrics,
  computeSentenceLengthDistribution,
} from './metrics.js';
import { computeAiSmellSignals, type AiSmellLexicon } from './ai-smell.js';
import { evaluateConstraints } from './constraints.js';

export const MAX_REPORT_AI_SMELL_EVIDENCE = 20;

export interface EvaluateOptions {
  readonly clock: Clock;
  readonly toolVersion?: string;
  readonly aiSmellLexicon?: AiSmellLexicon;
}

const METRIC_COVERAGE: MetricCoverage = {
  automatic: {
    length: true,
    distributions: true,
    repetition: true,
    lexiconSignals: true,
    explicitConstraints: true,
  },
  notImplementedOrManualOnly: [
    'character-credibility',
    'plot-quality',
    'subtext-quality',
    'semantic-continuity',
    'character-voice-distinctness',
    'literary-value',
    'continue-reading-desire',
  ],
};

function flattenAiSmellEvidence(signals: AiSmellSignals) {
  return signals.entries
    .flatMap((e) => e.evidence)
    .sort((a, b) => {
      const byLexicon = codePointCompare(a.lexiconId, b.lexiconId);
      if (byLexicon !== 0) return byLexicon;
      if (a.paragraphIndex !== b.paragraphIndex) {
        return a.paragraphIndex - b.paragraphIndex;
      }
      return (a.sentenceIndex ?? -1) - (b.sentenceIndex ?? -1);
    })
    .slice(0, MAX_REPORT_AI_SMELL_EVIDENCE);
}

function analyzeCandidate(
  suite: WritingEvaluationSuiteV1,
  caseIndex: number,
  candidate: WritingCandidateV1,
  options: EvaluateOptions,
): CandidateReport {
  const segmentation = segmentText(candidate.text);
  const warnings: string[] = [...segmentation.warnings];

  const caseRef = suite.cases[caseIndex];
  const target = caseRef.sceneBrief.targetLength;
  if (segmentation.codePointCount < target.minCodePoints) {
    warnings.push(
      `文本长度 ${segmentation.codePointCount} 低于场景目标下限 ${target.minCodePoints}`,
    );
  }
  if (segmentation.codePointCount > target.maxCodePoints) {
    warnings.push(
      `文本长度 ${segmentation.codePointCount} 超过场景目标上限 ${target.maxCodePoints}`,
    );
  }
  if (segmentation.sentences.length < 3) {
    warnings.push('句子数过少（<3），句长分布与重复指标统计意义弱');
  }
  if (segmentation.paragraphs.length < 2) {
    warnings.push('段落数过少（<2），段落长度分布统计意义弱');
  }

  const aiSmellSignals = computeAiSmellSignals(segmentation, options.aiSmellLexicon);

  return {
    candidateId: candidate.candidateId,
    strategyId: candidate.strategyId,
    modelId: candidate.modelId,
    promptVersion: candidate.promptVersion,
    generationParameters: candidate.generationParameters,
    textHash: sha256Hex(segmentation.normalizedText),
    basicStats: computeBasicStats(segmentation),
    distributionMetrics: {
      sentenceLength: computeSentenceLengthDistribution(segmentation),
      paragraphLength: computeParagraphLengthDistribution(segmentation),
    },
    repetitionMetrics: computeRepetitionMetrics(segmentation),
    aiSmellSignals,
    constraintResults: evaluateConstraints(caseRef.constraints, segmentation),
    evidence: {
      aiSmell: flattenAiSmellEvidence(aiSmellSignals),
    },
    warnings,
  };
}

/**
 * 评估一个 suite（接受原始 JSON，内部先运行时验证）。
 */
export function evaluateSuite(input: unknown, options: EvaluateOptions): WritingEvaluationReportV1 {
  const suite = validateSuite(input);
  const suiteHash = sha256Hex(canonicalSerializeSuite(suite));
  const generatedAt = options.clock.now();
  const toolVersion = options.toolVersion ?? DEFAULT_TOOL_VERSION;

  const caseResults: CaseReport[] = [];
  const candidateResults: CandidateReport[] = [];

  for (let ci = 0; ci < suite.cases.length; ci += 1) {
    const c = suite.cases[ci];
    const candidateIds: string[] = [];
    for (let ciCand = 0; ciCand < c.candidates.length; ciCand += 1) {
      const candidate = c.candidates[ciCand];
      const report = analyzeCandidate(suite, ci, candidate, options);
      candidateResults.push(report);
      candidateIds.push(candidate.candidateId);
    }
    caseResults.push({
      caseId: c.caseId,
      title: c.title,
      candidateIds,
    });
  }

  const warnings: string[] = [
    '本报告是评测工具的工程输出；自动指标不代表文学质量，也没有单一总分。',
    '人工盲评仍是质量判断的核心。',
  ];

  return {
    schemaVersion: WRITING_EVALUATION_SCHEMA_VERSION,
    suiteId: suite.suiteId,
    suiteHash,
    generatedAt,
    toolVersion,
    caseResults,
    candidateResults,
    metricCoverage: METRIC_COVERAGE,
    warnings,
  };
}
