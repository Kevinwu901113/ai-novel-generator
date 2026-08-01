/**
 * E. Determinism 与报告结构测试。
 */

import { describe, expect, it } from 'vitest';
import { evaluateSuite } from './evaluate.js';
import { checkExpectedRelations } from './relations.js';
import { cloneJson, makeSuite } from './test-util.js';
import { getBaselineSuite } from './fixtures.js';

const CLOCK = { now: () => '2026-08-01T00:00:00.000Z' };

describe('byte-stable JSON', () => {
  it('相同 suite + 相同 Clock → 两次 JSON 完全一致', () => {
    const suite = getBaselineSuite();
    const a = JSON.stringify(evaluateSuite(suite, { clock: CLOCK }));
    const b = JSON.stringify(evaluateSuite(suite, { clock: CLOCK }));
    expect(a).toBe(b);
  });

  it('suite 序列化顺序变化不影响结果（per-candidate）', () => {
    const suite = getBaselineSuite();
    const report = evaluateSuite(suite, { clock: CLOCK });
    const shuffled = cloneJson(suite);
    for (const c of shuffled.cases) {
      c.candidates = [...c.candidates].reverse();
    }
    const report2 = evaluateSuite(shuffled, { clock: CLOCK });
    // 每个 candidate 的结果应该相同（按 candidateId 定位）
    for (const cr of report.candidateResults) {
      const cr2 = report2.candidateResults.find((r) => r.candidateId === cr.candidateId);
      expect(JSON.stringify(cr)).toBe(JSON.stringify(cr2));
    }
  });

  it('generatedAt 来自 Clock', () => {
    const report = evaluateSuite(getBaselineSuite(), { clock: CLOCK });
    expect(report.generatedAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('suiteHash 稳定', () => {
    const a = evaluateSuite(getBaselineSuite(), { clock: CLOCK });
    const b = evaluateSuite(getBaselineSuite(), { clock: CLOCK });
    expect(a.suiteHash).toBe(b.suiteHash);
    expect(a.suiteHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('textHash 为 lowercase SHA-256', () => {
    const report = evaluateSuite(getBaselineSuite(), { clock: CLOCK });
    for (const cr of report.candidateResults) {
      expect(cr.textHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('报告结构', () => {
  it('包含要求的顶层字段', () => {
    const report = evaluateSuite(getBaselineSuite(), { clock: CLOCK });
    expect(report.schemaVersion).toBe(1);
    expect(report.suiteId).toBe('gq1-baseline-v1');
    expect(typeof report.suiteHash).toBe('string');
    expect(typeof report.generatedAt).toBe('string');
    expect(typeof report.toolVersion).toBe('string');
    expect(Array.isArray(report.caseResults)).toBe(true);
    expect(Array.isArray(report.candidateResults)).toBe(true);
    expect(typeof report.metricCoverage).toBe('object');
    expect(Array.isArray(report.warnings)).toBe(true);
  });

  it('candidate result 包含所有必需字段', () => {
    const report = evaluateSuite(getBaselineSuite(), { clock: CLOCK });
    const cr = report.candidateResults[0];
    expect(typeof cr.textHash).toBe('string');
    expect(typeof cr.basicStats).toBe('object');
    expect(typeof cr.distributionMetrics.sentenceLength).toBe('object');
    expect(typeof cr.distributionMetrics.paragraphLength).toBe('object');
    expect(typeof cr.repetitionMetrics).toBe('object');
    expect(typeof cr.aiSmellSignals).toBe('object');
    expect(Array.isArray(cr.constraintResults)).toBe(true);
    expect(typeof cr.evidence).toBe('object');
    expect(Array.isArray(cr.warnings)).toBe(true);
  });

  it('metricCoverage 明确区分 automatic 与 manualOnly', () => {
    const report = evaluateSuite(getBaselineSuite(), { clock: CLOCK });
    const coverage = report.metricCoverage;
    expect(coverage.automatic.length).toBe(true);
    expect(coverage.automatic.distributions).toBe(true);
    expect(coverage.automatic.repetition).toBe(true);
    expect(coverage.automatic.lexiconSignals).toBe(true);
    expect(coverage.automatic.explicitConstraints).toBe(true);
    expect(coverage.notImplementedOrManualOnly.length).toBeGreaterThanOrEqual(7);
  });

  it('报告不包含完整 candidate text', () => {
    const report = evaluateSuite(getBaselineSuite(), { clock: CLOCK });
    const json = JSON.stringify(report);
    // 不包含“全文”字段名与 prompt 字段名
    expect(json).not.toContain('"text"');
    expect(json).not.toContain('"prompt"');
    // 不嵌入 fixture 候选正文的长片段
    expect(json).not.toContain('把伞往沈澈那边斜了一点');
    expect(json).not.toContain('不要回头，因为走廊尽头的东西还在动');
    expect(json).not.toContain('你看起来不会带钱包吧');
  });

  it('不包含 overall score / 概率输出', () => {
    const report = evaluateSuite(getBaselineSuite(), { clock: CLOCK });
    const json = JSON.stringify(report);
    expect(json).not.toContain('overallQualityScore');
    expect(json).not.toContain('overallScore');
    expect(json).not.toContain('humanProbability');
    expect(json).not.toContain('aiProbability');
  });

  it('约束结果按 constraintId 排序', () => {
    const report = evaluateSuite(getBaselineSuite(), { clock: CLOCK });
    for (const cr of report.candidateResults) {
      const ids = cr.constraintResults.map((r) => r.constraintId);
      expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    }
  });

  it('aiSmell entries 按 lexiconId 排序', () => {
    const report = evaluateSuite(getBaselineSuite(), { clock: CLOCK });
    for (const cr of report.candidateResults) {
      const ids = cr.aiSmellSignals.entries.map((e) => e.lexiconId);
      expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    }
  });

  it('AI-smell evidence 提供短 excerpt', () => {
    const report = evaluateSuite(getBaselineSuite(), { clock: CLOCK });
    const over = report.candidateResults.find((r) => r.candidateId === 'over-explained');
    expect(over).toBeDefined();
    expect(over!.aiSmellSignals.totalCount).toBeGreaterThan(0);
    expect(over!.evidence.aiSmell.length).toBeGreaterThan(0);
    for (const ev of over!.evidence.aiSmell) {
      expect(ev.excerpt.length).toBeLessThanOrEqual(40);
    }
  });

  it('heuristic 指标不冒充检测器', () => {
    const report = evaluateSuite(getBaselineSuite(), { clock: CLOCK });
    const json = JSON.stringify(report);
    expect(json).not.toContain('AI_DETECTED');
    expect(json).not.toContain('aiDetected');
  });
});

describe('expected relations 回归', () => {
  it('baseline 全部 expected relations 成立', () => {
    const suite = getBaselineSuite();
    const report = evaluateSuite(suite, { clock: CLOCK });
    const results = checkExpectedRelations(suite, report);
    expect(results.length).toBeGreaterThanOrEqual(7);
    for (const r of results) {
      expect(
        r.passed,
        `${r.caseId}/${r.metricId} ${r.leftCandidateId} ${r.operator} ${r.rightCandidateId} (${r.leftValue} vs ${r.rightValue})`,
      ).toBe(true);
    }
  });

  it('关系失败提供 case/metric/candidate 信息，不含正文', () => {
    const suite = getBaselineSuite();
    const report = evaluateSuite(suite, { clock: CLOCK });
    const results = checkExpectedRelations(suite, report);
    for (const r of results) {
      const json = JSON.stringify(r);
      expect(json).not.toContain('"text"');
      expect(r.caseId.length).toBeGreaterThan(0);
      expect(r.metricId.length).toBeGreaterThan(0);
    }
  });
});

describe('warnings', () => {
  it('报告顶部包含声明性警告', () => {
    const report = evaluateSuite(makeSuite(), { clock: CLOCK });
    expect(report.warnings.some((w) => w.includes('没有单一总分'))).toBe(true);
    expect(report.warnings.some((w) => w.includes('人工盲评'))).toBe(true);
  });

  it('句子过少产生候选警告', () => {
    const suite = makeSuite({ cases: [cloneJson(makeSuite().cases[0])] });
    suite.cases[0].candidates[0].text = '你好。';
    const report = evaluateSuite(suite, { clock: CLOCK });
    expect(report.candidateResults[0].warnings.some((w) => w.includes('句子数过少'))).toBe(true);
  });
});
