/**
 * D. 约束评估测试矩阵。
 */

import { describe, expect, it } from 'vitest';
import { evaluateConstraint, evaluateConstraints } from './constraints.js';
import { segmentText } from './text.js';
import type { EvaluationConstraintV1 } from './schema.js';

const TEXT = '他站在站台等车。站台很冷。他裹紧了外套，心里想：不要在雨里站太久。';

function seg(): ReturnType<typeof segmentText> {
  return segmentText(TEXT);
}

describe('约束类型', () => {
  it('required-phrase：满足 → PASS', () => {
    const c: EvaluationConstraintV1 = {
      kind: 'required-phrase',
      constraintId: 'r1',
      phrase: '站台',
      minOccurrences: 2,
    };
    const result = evaluateConstraint(c, seg());
    expect(result.status).toBe('PASS');
    expect(result.explanation).toContain('站台');
    expect(result.evidence.length).toBeGreaterThanOrEqual(2);
  });

  it('required-phrase：不满足 → FAIL', () => {
    const c: EvaluationConstraintV1 = {
      kind: 'required-phrase',
      constraintId: 'r1',
      phrase: '车站',
      minOccurrences: 1,
    };
    expect(evaluateConstraint(c, seg()).status).toBe('FAIL');
  });

  it('forbidden-phrase：未出现 → PASS', () => {
    const c: EvaluationConstraintV1 = {
      kind: 'forbidden-phrase',
      constraintId: 'f1',
      phrase: '禁止词',
    };
    expect(evaluateConstraint(c, seg()).status).toBe('PASS');
  });

  it('forbidden-phrase：出现 → FAIL', () => {
    const c: EvaluationConstraintV1 = {
      kind: 'forbidden-phrase',
      constraintId: 'f1',
      phrase: '站台',
    };
    const result = evaluateConstraint(c, seg());
    expect(result.status).toBe('FAIL');
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it('phrase-max-count：超限 → FAIL', () => {
    const c: EvaluationConstraintV1 = {
      kind: 'phrase-max-count',
      constraintId: 'm1',
      phrase: '站台',
      maxOccurrences: 1,
    };
    expect(evaluateConstraint(c, seg()).status).toBe('FAIL');
  });

  it('phrase-max-count：未超限 → PASS', () => {
    const c: EvaluationConstraintV1 = {
      kind: 'phrase-max-count',
      constraintId: 'm1',
      phrase: '站台',
      maxOccurrences: 3,
    };
    expect(evaluateConstraint(c, seg()).status).toBe('PASS');
  });

  it('text-length-range', () => {
    const length = seg().codePointCount;
    const ok: EvaluationConstraintV1 = {
      kind: 'text-length-range',
      constraintId: 'l1',
      minCodePoints: length,
      maxCodePoints: length,
    };
    expect(evaluateConstraint(ok, seg()).status).toBe('PASS');
    const fail: EvaluationConstraintV1 = {
      kind: 'text-length-range',
      constraintId: 'l2',
      minCodePoints: length + 1,
      maxCodePoints: length + 10,
    };
    expect(evaluateConstraint(fail, seg()).status).toBe('FAIL');
  });

  it('dialogue-ratio-range', () => {
    const dialogue = segmentText('“来了。”他点头。');
    const ok: EvaluationConstraintV1 = {
      kind: 'dialogue-ratio-range',
      constraintId: 'd1',
      minRatio: 0.3,
      maxRatio: 0.6,
    };
    expect(evaluateConstraint(ok, dialogue).status).toBe('PASS');
    const fail: EvaluationConstraintV1 = {
      kind: 'dialogue-ratio-range',
      constraintId: 'd2',
      minRatio: 0.9,
      maxRatio: 1,
    };
    expect(evaluateConstraint(fail, dialogue).status).toBe('FAIL');
  });

  it('manual-criterion 始终 NOT_EVALUATED', () => {
    const c: EvaluationConstraintV1 = {
      kind: 'manual-criterion',
      constraintId: 'manual1',
      title: '人物可信度',
      rubric: '人物是否可信',
    };
    const result = evaluateConstraint(c, seg());
    expect(result.status).toBe('NOT_EVALUATED');
    expect(result.explanation).toContain('需人工评估');
  });
});

describe('evidence', () => {
  it('phrase evidence 包含 paragraph / sentence index 与短 excerpt', () => {
    const c: EvaluationConstraintV1 = {
      kind: 'forbidden-phrase',
      constraintId: 'f1',
      phrase: '站台',
    };
    const result = evaluateConstraint(c, seg());
    expect(result.evidence.length).toBeGreaterThan(0);
    const ev = result.evidence[0];
    expect(typeof ev.paragraphIndex).toBe('number');
    expect(typeof ev.sentenceIndex).toBe('number');
    expect(ev.excerpt.length).toBeGreaterThan(0);
    expect(ev.excerpt.length).toBeLessThanOrEqual(40);
  });

  it('不默认返回整篇正文', () => {
    const c: EvaluationConstraintV1 = {
      kind: 'required-phrase',
      constraintId: 'r1',
      phrase: '站台',
      minOccurrences: 1,
    };
    const result = evaluateConstraint(c, seg());
    for (const ev of result.evidence) {
      expect(ev.excerpt.length).toBeLessThanOrEqual(40);
    }
  });
});

describe('evaluateConstraints', () => {
  it('按 constraintId code-point 排序', () => {
    const constraints: EvaluationConstraintV1[] = [
      { kind: 'required-phrase', constraintId: 'b', phrase: '站台', minOccurrences: 1 },
      { kind: 'forbidden-phrase', constraintId: 'a', phrase: '禁止' },
      { kind: 'manual-criterion', constraintId: 'c', title: 't', rubric: 'r' },
    ];
    const results = evaluateConstraints(constraints, seg());
    expect(results.map((r) => r.constraintId)).toEqual(['a', 'b', 'c']);
  });

  it('稳定排序：相同输入两次相同', () => {
    const constraints: EvaluationConstraintV1[] = [
      { kind: 'forbidden-phrase', constraintId: 'z', phrase: '禁止' },
      { kind: 'required-phrase', constraintId: 'a', phrase: '站台', minOccurrences: 1 },
    ];
    const s = seg();
    expect(JSON.stringify(evaluateConstraints(constraints, s))).toBe(
      JSON.stringify(evaluateConstraints(constraints, s)),
    );
  });
});
