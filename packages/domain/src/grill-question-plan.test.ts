/**
 * Grill 问题规划器领域测试：严格 schema 解析与完整依赖图环检测。
 */

import { describe, it, expect } from 'vitest';
import {
  parseQuestionPlanV1,
  validatePlanReferences,
  validateExistingGraphIntegrity,
  topologicalPlanOrder,
  GRILL_QUESTION_PLAN_SCHEMA_VERSION,
  type NormalizedQuestionPlan,
  type NormalizedPlanQuestion,
} from './grill-question-plan.js';

// ── 工具 ──────────────────────────────────────────────────────────

function validPlan(questions: unknown[]): string {
  return JSON.stringify({ schemaVersion: 1, questions });
}

function q(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'q1',
    topic: '主题',
    text: '问题文本',
    rationale: '理由',
    dependencies: [],
    ...overrides,
  };
}

function planQuestion(
  key: string,
  dependencies: NormalizedQuestionPlan['questions'][number]['dependencies'] = [],
): NormalizedPlanQuestion {
  return { key, topic: '主题', text: '文本', rationale: '', dependencies };
}

// ── Schema 测试 ───────────────────────────────────────────────────

describe('parseQuestionPlanV1 — 合法输入', () => {
  it('1. 合法单问题计划', () => {
    const result = parseQuestionPlanV1(validPlan([q()]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.schemaVersion).toBe(GRILL_QUESTION_PLAN_SCHEMA_VERSION);
      expect(result.plan.questions).toHaveLength(1);
      expect(result.plan.questions[0].key).toBe('q1');
    }
  });

  it('2. 合法多问题依赖计划', () => {
    const result = parseQuestionPlanV1(
      validPlan([
        q({ key: 'q0' }),
        q({
          key: 'q1',
          dependencies: [
            { kind: 'planned', questionKey: 'q0' },
            { kind: 'existing', questionId: 'existing-1' },
          ],
        }),
      ]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.questions).toHaveLength(2);
      expect(result.plan.questions[1].dependencies).toHaveLength(2);
    }
  });
});

describe('parseQuestionPlanV1 — 非法 JSON（MODEL_RESPONSE_INVALID 阶段）', () => {
  it('3. 非 JSON', () => {
    const result = parseQuestionPlanV1('这根本不是 JSON');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe('json');
    }
  });

  it('4. markdown fenced JSON', () => {
    const result = parseQuestionPlanV1('```json\n' + validPlan([q()]) + '\n```');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe('json');
  });

  it('5. JSON 前后有文本', () => {
    const result = parseQuestionPlanV1('计划如下：' + validPlan([q()]) + ' 谢谢');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe('json');
  });
});

describe('parseQuestionPlanV1 — schema 违规', () => {
  it('6. schemaVersion 错误', () => {
    const result = parseQuestionPlanV1(JSON.stringify({ schemaVersion: 2, questions: [q()] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('GRILL_PLAN_SCHEMA_INVALID');
      expect(result.stage).toBe('structure');
    }
  });

  it('7. 顶层额外字段', () => {
    const result = parseQuestionPlanV1(
      JSON.stringify({ schemaVersion: 1, questions: [q()], extra: true }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('GRILL_PLAN_SCHEMA_INVALID');
  });

  it('8. question 额外字段', () => {
    const result = parseQuestionPlanV1(validPlan([q({ hacker: 'x' })]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('GRILL_PLAN_SCHEMA_INVALID');
  });

  it('9. 空 questions', () => {
    const result = parseQuestionPlanV1(validPlan([]));
    expect(result.ok).toBe(false);
  });

  it('10. questions 超上限', () => {
    const many = Array.from({ length: 21 }, (_, i) => q({ key: `q${i}` }));
    const result = parseQuestionPlanV1(validPlan(many));
    expect(result.ok).toBe(false);
  });

  it('11. 空 text', () => {
    const result = parseQuestionPlanV1(validPlan([q({ text: '   ' })]));
    expect(result.ok).toBe(false);
  });

  it('12. text 超长', () => {
    const result = parseQuestionPlanV1(validPlan([q({ text: 'a'.repeat(2001) })]));
    expect(result.ok).toBe(false);
  });

  it('13. duplicate key', () => {
    const result = parseQuestionPlanV1(validPlan([q({ key: 'dup' }), q({ key: 'dup' })]));
    expect(result.ok).toBe(false);
  });

  it('14. duplicate dependency', () => {
    const result = parseQuestionPlanV1(
      validPlan([
        q({
          key: 'q1',
          dependencies: [
            { kind: 'existing', questionId: 'e1' },
            { kind: 'existing', questionId: 'e1' },
          ],
        }),
      ]),
    );
    expect(result.ok).toBe(false);
  });

  it('15. planned dependency 不存在', () => {
    const result = parseQuestionPlanV1(
      validPlan([q({ key: 'q1', dependencies: [{ kind: 'planned', questionKey: 'ghost' }] })]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('GRILL_PLAN_SCHEMA_INVALID');
  });
});

describe('validatePlanReferences — 引用完整性', () => {
  function parsedPlan(text: string): NormalizedQuestionPlan {
    const r = parseQuestionPlanV1(text);
    if (!r.ok) throw new Error('expected ok parse');
    return r.plan;
  }

  it('16. existing question 不存在', () => {
    const plan = parsedPlan(
      validPlan([q({ key: 'q1', dependencies: [{ kind: 'existing', questionId: 'missing' }] })]),
    );
    const result = validatePlanReferences(plan, new Set(['other']));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('GRILL_PLAN_REFERENCE_INVALID');
  });

  it('17. 跨 session question（不在本会话 ID 集合）', () => {
    const plan = parsedPlan(
      validPlan([q({ key: 'q1', dependencies: [{ kind: 'existing', questionId: 'sess2-q' }] })]),
    );
    const result = validatePlanReferences(plan, new Set(['sess1-q']));
    expect(result.ok).toBe(false);
  });

  it('18. 跨 project question（不在本会话 ID 集合）', () => {
    const plan = parsedPlan(
      validPlan([q({ key: 'q1', dependencies: [{ kind: 'existing', questionId: 'proj2-q' }] })]),
    );
    const result = validatePlanReferences(plan, new Set(['proj1-q']));
    expect(result.ok).toBe(false);
  });

  it('合法 existing 引用通过', () => {
    const plan = parsedPlan(
      validPlan([q({ key: 'q1', dependencies: [{ kind: 'existing', questionId: 'e1' }] })]),
    );
    const result = validatePlanReferences(plan, new Set(['e1']));
    expect(result.ok).toBe(true);
  });
});

// ── 图验证测试 ────────────────────────────────────────────────────

describe('topologicalPlanOrder — 完整环检测', () => {
  const empty = new Map<string, ReadonlyArray<string>>();

  it('19. self-cycle', () => {
    const plan: NormalizedQuestionPlan = {
      schemaVersion: 1,
      questions: [planQuestion('a', [{ kind: 'planned', questionKey: 'a' }])],
    };
    const result = topologicalPlanOrder(plan, empty);
    expect(result.ok).toBe(false);
  });

  it('20. two-node cycle', () => {
    const plan: NormalizedQuestionPlan = {
      schemaVersion: 1,
      questions: [
        planQuestion('a', [{ kind: 'planned', questionKey: 'b' }]),
        planQuestion('b', [{ kind: 'planned', questionKey: 'a' }]),
      ],
    };
    expect(topologicalPlanOrder(plan, empty).ok).toBe(false);
  });

  it('21. three-node cycle', () => {
    const plan: NormalizedQuestionPlan = {
      schemaVersion: 1,
      questions: [
        planQuestion('a', [{ kind: 'planned', questionKey: 'b' }]),
        planQuestion('b', [{ kind: 'planned', questionKey: 'c' }]),
        planQuestion('c', [{ kind: 'planned', questionKey: 'a' }]),
      ],
    };
    expect(topologicalPlanOrder(plan, empty).ok).toBe(false);
  });

  it('22. four-node cycle', () => {
    const plan: NormalizedQuestionPlan = {
      schemaVersion: 1,
      questions: [
        planQuestion('a', [{ kind: 'planned', questionKey: 'b' }]),
        planQuestion('b', [{ kind: 'planned', questionKey: 'c' }]),
        planQuestion('c', [{ kind: 'planned', questionKey: 'd' }]),
        planQuestion('d', [{ kind: 'planned', questionKey: 'a' }]),
      ],
    };
    expect(topologicalPlanOrder(plan, empty).ok).toBe(false);
  });

  it('23. existing + planned 混合图含环', () => {
    // 已有问题自身成环（A<->B），计划问题附加其上；全图检测应发现环。
    const existing = new Map<string, ReadonlyArray<string>>([
      ['A', ['B']],
      ['B', ['A']],
    ]);
    const plan: NormalizedQuestionPlan = {
      schemaVersion: 1,
      questions: [planQuestion('p', [{ kind: 'existing', questionId: 'A' }])],
    };
    expect(topologicalPlanOrder(plan, existing).ok).toBe(false);
  });

  it('24. disconnected graph 中的环', () => {
    const plan: NormalizedQuestionPlan = {
      schemaVersion: 1,
      questions: [
        planQuestion('ok1'),
        planQuestion('x', [{ kind: 'planned', questionKey: 'y' }]),
        planQuestion('y', [{ kind: 'planned', questionKey: 'x' }]),
      ],
    };
    expect(topologicalPlanOrder(plan, empty).ok).toBe(false);
  });

  it('25. 合法 DAG', () => {
    const plan: NormalizedQuestionPlan = {
      schemaVersion: 1,
      questions: [
        planQuestion('a'),
        planQuestion('b', [{ kind: 'planned', questionKey: 'a' }]),
        planQuestion('c', [{ kind: 'planned', questionKey: 'b' }]),
      ],
    };
    const result = topologicalPlanOrder(plan, empty);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plannedOrder.indexOf('a')).toBeLessThan(result.plannedOrder.indexOf('b'));
      expect(result.plannedOrder.indexOf('b')).toBeLessThan(result.plannedOrder.indexOf('c'));
    }
  });

  it('26. 多父节点合法 DAG', () => {
    const plan: NormalizedQuestionPlan = {
      schemaVersion: 1,
      questions: [
        planQuestion('a'),
        planQuestion('b'),
        planQuestion('c', [
          { kind: 'planned', questionKey: 'a' },
          { kind: 'planned', questionKey: 'b' },
        ]),
      ],
    };
    const result = topologicalPlanOrder(plan, empty);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plannedOrder.indexOf('a')).toBeLessThan(result.plannedOrder.indexOf('c'));
      expect(result.plannedOrder.indexOf('b')).toBeLessThan(result.plannedOrder.indexOf('c'));
    }
  });
});

// ── 已有问题图完整性验证 ──────────────────────────────────────────

describe('validateExistingGraphIntegrity', () => {
  it('合法图通过', () => {
    const deps = new Map<string, ReadonlyArray<string>>([
      ['q1', []],
      ['q2', ['q1']],
      ['q3', ['q1', 'q2']],
    ]);
    expect(validateExistingGraphIntegrity(deps)).toEqual({ ok: true });
  });

  it('空图通过', () => {
    expect(validateExistingGraphIntegrity(new Map())).toEqual({ ok: true });
  });

  it('自依赖拒绝', () => {
    const deps = new Map<string, ReadonlyArray<string>>([['q1', ['q1']]]);
    const result = validateExistingGraphIntegrity(deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('GRILL_PLAN_REFERENCE_INVALID');
      expect(result.message).toContain('依赖自己');
    }
  });

  it('重复依赖拒绝', () => {
    const deps = new Map<string, ReadonlyArray<string>>([
      ['q1', []],
      ['q2', ['q1', 'q1']],
    ]);
    const result = validateExistingGraphIntegrity(deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('GRILL_PLAN_REFERENCE_INVALID');
      expect(result.message).toContain('重复依赖');
    }
  });

  it('悬空引用拒绝（依赖不存在的问题）', () => {
    const deps = new Map<string, ReadonlyArray<string>>([['q1', ['ghost']]]);
    const result = validateExistingGraphIntegrity(deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('GRILL_PLAN_REFERENCE_INVALID');
      expect(result.message).toContain('不属于当前会话');
    }
  });
});
