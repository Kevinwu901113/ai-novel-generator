/**
 * 显式创作约束评估。
 *
 * - manual-criterion 始终 NOT_EVALUATED，不得伪装成自动完成；
 * - 每个结果包含安全 explanation；
 * - phrase evidence 包含 paragraph/sentence index 和短 excerpt；
 * - 不默认返回整篇正文；
 * - 结果按 constraintId code-point 排序。
 */

import { codePointCompare } from '@ai-novel/domain';
import type { ConstraintEvidence, ConstraintResult, EvaluationConstraintV1 } from './schema.js';
import { findPhraseOccurrences, makeExcerpt } from './match.js';
import type { TextSegmentation } from './text.js';

/** 每个约束最多记录的 evidence 条数。 */
export const MAX_CONSTRAINT_EVIDENCE = 5;

function phraseEvidence(segmentation: TextSegmentation, phrase: string): ConstraintEvidence[] {
  return findPhraseOccurrences(segmentation, phrase)
    .slice(0, MAX_CONSTRAINT_EVIDENCE)
    .map((m) => ({
      paragraphIndex: m.paragraphIndex,
      sentenceIndex: m.sentenceIndex,
      excerpt: makeExcerpt(m.sentence, m.matchStart, m.matchEnd),
    }));
}

/** 评估单个约束。返回稳定结果。 */
export function evaluateConstraint(
  constraint: EvaluationConstraintV1,
  segmentation: TextSegmentation,
): ConstraintResult {
  switch (constraint.kind) {
    case 'required-phrase': {
      const matches = findPhraseOccurrences(segmentation, constraint.phrase);
      const count = matches.length;
      const passed = count >= constraint.minOccurrences;
      return {
        constraintId: constraint.constraintId,
        kind: constraint.kind,
        status: passed ? 'PASS' : 'FAIL',
        explanation: `短语「${constraint.phrase}」出现 ${count} 次，要求至少 ${constraint.minOccurrences} 次`,
        evidence: phraseEvidence(segmentation, constraint.phrase),
      };
    }
    case 'forbidden-phrase': {
      const matches = findPhraseOccurrences(segmentation, constraint.phrase);
      const count = matches.length;
      const passed = count === 0;
      return {
        constraintId: constraint.constraintId,
        kind: constraint.kind,
        status: passed ? 'PASS' : 'FAIL',
        explanation: `短语「${constraint.phrase}」出现 ${count} 次，要求 0 次`,
        evidence: phraseEvidence(segmentation, constraint.phrase),
      };
    }
    case 'phrase-max-count': {
      const matches = findPhraseOccurrences(segmentation, constraint.phrase);
      const count = matches.length;
      const passed = count <= constraint.maxOccurrences;
      return {
        constraintId: constraint.constraintId,
        kind: constraint.kind,
        status: passed ? 'PASS' : 'FAIL',
        explanation: `短语「${constraint.phrase}」出现 ${count} 次，要求不超过 ${constraint.maxOccurrences} 次`,
        evidence: phraseEvidence(segmentation, constraint.phrase),
      };
    }
    case 'text-length-range': {
      const length = segmentation.codePointCount;
      const passed = length >= constraint.minCodePoints && length <= constraint.maxCodePoints;
      return {
        constraintId: constraint.constraintId,
        kind: constraint.kind,
        status: passed ? 'PASS' : 'FAIL',
        explanation: `文本长度 ${length} code points，要求范围 [${constraint.minCodePoints}, ${constraint.maxCodePoints}]`,
        evidence: [],
      };
    }
    case 'dialogue-ratio-range': {
      const ratio = segmentation.dialogueCodePointRatio;
      const passed = ratio >= constraint.minRatio && ratio <= constraint.maxRatio;
      return {
        constraintId: constraint.constraintId,
        kind: constraint.kind,
        status: passed ? 'PASS' : 'FAIL',
        explanation: `对话占比 ${ratio.toFixed(4)}，要求范围 [${constraint.minRatio}, ${constraint.maxRatio}]`,
        evidence: [],
      };
    }
    case 'manual-criterion': {
      return {
        constraintId: constraint.constraintId,
        kind: constraint.kind,
        status: 'NOT_EVALUATED',
        explanation: `需人工评估：${constraint.title}`,
        evidence: [],
      };
    }
  }
}

/** 评估一组约束，并按 constraintId code-point 排序。 */
export function evaluateConstraints(
  constraints: readonly EvaluationConstraintV1[],
  segmentation: TextSegmentation,
): ConstraintResult[] {
  return constraints
    .map((c) => evaluateConstraint(c, segmentation))
    .sort((a, b) => codePointCompare(a.constraintId, b.constraintId));
}
