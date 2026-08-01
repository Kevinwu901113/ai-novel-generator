/**
 * Expected metric relations —— fixture 回归机制。
 *
 * 关系只验证工具能辨别预先设计的差异，不证明一般文章质量。
 * 浮点比较采用明确 epsilon。
 */

import type {
  CandidateReport,
  MetricId,
  RelationCheckResult,
  WritingEvaluationReportV1,
  WritingEvaluationSuiteV1,
} from './schema.js';

/** 浮点比较 epsilon。 */
export const RELATION_EPSILON = 1e-9;

function distributionValue(
  distribution: CandidateReport['distributionMetrics']['sentenceLength'],
  key: string,
): number | null {
  const value = distribution[key as keyof typeof distribution];
  return typeof value === 'number' ? value : null;
}

/**
 * 从 candidate report 解析指定指标数值。
 * 返回 null 表示该指标当前无法取值（如空分布）。
 */
export function resolveMetricValue(report: CandidateReport, metricId: string): number | null {
  const id = metricId as MetricId;
  switch (id) {
    case 'basic.codePointCount':
      return report.basicStats.codePointCount;
    case 'basic.paragraphCount':
      return report.basicStats.paragraphCount;
    case 'basic.sentenceCount':
      return report.basicStats.sentenceCount;
    case 'basic.dialogueCodePointRatio':
      return report.basicStats.dialogueCodePointRatio;
    case 'distribution.sentenceLength.min':
    case 'distribution.sentenceLength.max':
    case 'distribution.sentenceLength.mean':
    case 'distribution.sentenceLength.median':
    case 'distribution.sentenceLength.p90':
    case 'distribution.sentenceLength.standardDeviation':
    case 'distribution.sentenceLength.coefficientOfVariation':
      return distributionValue(
        report.distributionMetrics.sentenceLength,
        id.split('.').pop() ?? '',
      );
    case 'distribution.paragraphLength.min':
    case 'distribution.paragraphLength.max':
    case 'distribution.paragraphLength.mean':
    case 'distribution.paragraphLength.median':
    case 'distribution.paragraphLength.p90':
    case 'distribution.paragraphLength.standardDeviation':
    case 'distribution.paragraphLength.coefficientOfVariation':
      return distributionValue(
        report.distributionMetrics.paragraphLength,
        id.split('.').pop() ?? '',
      );
    case 'repetition.duplicateSentenceRatio':
      return report.repetitionMetrics.duplicateSentenceRatio;
    case 'repetition.repeatedCharacterNgramRatio.2':
      return report.repetitionMetrics.repeatedCharacterNgramRatio.n2;
    case 'repetition.repeatedCharacterNgramRatio.3':
      return report.repetitionMetrics.repeatedCharacterNgramRatio.n3;
    case 'repetition.repeatedCharacterNgramRatio.4':
      return report.repetitionMetrics.repeatedCharacterNgramRatio.n4;
    case 'repetition.repeatedSentenceOpenerRatio':
      return report.repetitionMetrics.repeatedSentenceOpenerRatio;
    case 'ai-smell.totalCount':
      return report.aiSmellSignals.totalCount;
    case 'ai-smell.totalPerThousandCodePoints':
      return report.aiSmellSignals.totalPerThousandCodePoints;
    default:
      return null;
  }
}

function compareValues(
  left: number,
  operator: 'LT' | 'LTE' | 'GT' | 'GTE' | 'EQ',
  right: number,
  epsilon: number,
): boolean {
  switch (operator) {
    case 'LT':
      return left < right - epsilon;
    case 'LTE':
      return left <= right + epsilon;
    case 'GT':
      return left > right + epsilon;
    case 'GTE':
      return left >= right - epsilon;
    case 'EQ':
      return Math.abs(left - right) <= epsilon;
  }
}

/**
 * 校验 suite 中所有 expected relations。
 * 返回包含 case/metric/candidate 信息的结果；不包含整篇正文。
 */
export function checkExpectedRelations(
  suite: WritingEvaluationSuiteV1,
  report: WritingEvaluationReportV1,
): RelationCheckResult[] {
  const results: RelationCheckResult[] = [];

  for (const c of suite.cases) {
    if (!c.expectedRelations || c.expectedRelations.length === 0) continue;

    const reportsByCandidate = new Map<string, CandidateReport>();
    for (const cr of report.candidateResults) reportsByCandidate.set(cr.candidateId, cr);

    for (const rel of c.expectedRelations) {
      const leftReport = reportsByCandidate.get(rel.leftCandidateId);
      const rightReport = reportsByCandidate.get(rel.rightCandidateId);
      if (!leftReport || !rightReport) {
        results.push({
          caseId: c.caseId,
          metricId: rel.metricId,
          leftCandidateId: rel.leftCandidateId,
          operator: rel.operator,
          rightCandidateId: rel.rightCandidateId,
          leftValue: Number.NaN,
          rightValue: Number.NaN,
          passed: false,
        });
        continue;
      }

      const leftValue = resolveMetricValue(leftReport, rel.metricId);
      const rightValue = resolveMetricValue(rightReport, rel.metricId);

      const passed =
        leftValue !== null &&
        rightValue !== null &&
        compareValues(leftValue, rel.operator, rightValue, RELATION_EPSILON);

      results.push({
        caseId: c.caseId,
        metricId: rel.metricId,
        leftCandidateId: rel.leftCandidateId,
        operator: rel.operator,
        rightCandidateId: rel.rightCandidateId,
        leftValue: leftValue ?? Number.NaN,
        rightValue: rightValue ?? Number.NaN,
        passed,
      });
    }
  }

  return results;
}
