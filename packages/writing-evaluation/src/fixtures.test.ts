/**
 * H. Baseline fixtures 测试。
 */

import { describe, expect, it } from 'vitest';
import { getBaselineSuite } from './fixtures.js';
import { evaluateSuite } from './evaluate.js';
import { checkExpectedRelations } from './relations.js';
import { generateBlindPacket } from './blind.js';
import { aggregateRatings, validateRatings } from './rating.js';
import { renderMarkdownReport, renderMarkdownRatingAggregation } from './markdown.js';
import { segmentText } from './text.js';
import { fixedClockIso } from './test-util.js';

const CLOCK = { now: () => fixedClockIso() };

describe('fixture 结构', () => {
  it('全部 fixtures 通过运行时验证', () => {
    const suite = getBaselineSuite();
    expect(suite.cases).toHaveLength(3);
    const totalCandidates = suite.cases.reduce((acc, c) => acc + c.candidates.length, 0);
    expect(totalCandidates).toBe(6);
  });

  it('每个候选都有足够统计意义的文本', () => {
    const suite = getBaselineSuite();
    for (const c of suite.cases) {
      for (const cand of c.candidates) {
        const seg = segmentText(cand.text);
        expect(seg.codePointCount).toBeGreaterThanOrEqual(150);
        expect(seg.sentences.length).toBeGreaterThanOrEqual(5);
        expect(seg.paragraphs.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('每个 case 至少包含一个 manual-criterion 约束', () => {
    const suite = getBaselineSuite();
    for (const c of suite.cases) {
      expect(c.constraints.some((x) => x.kind === 'manual-criterion')).toBe(true);
    }
  });
});

describe('expected metric relations', () => {
  it('全部关系成立（回归）', () => {
    const suite = getBaselineSuite();
    const report = evaluateSuite(suite, { clock: CLOCK });
    const results = checkExpectedRelations(suite, report);
    expect(results.length).toBeGreaterThanOrEqual(7);
    const failed = results.filter((r) => !r.passed);
    expect(failed).toEqual([]);
  });

  it('关系只覆盖自动指标，不含人工维度', () => {
    const suite = getBaselineSuite();
    for (const c of suite.cases) {
      for (const rel of c.expectedRelations ?? []) {
        expect(rel.metricId.startsWith('manual')).toBe(false);
      }
    }
  });
});

describe('markdown report', () => {
  it('包含顶部声明', () => {
    const report = evaluateSuite(getBaselineSuite(), { clock: CLOCK });
    const md = renderMarkdownReport(report);
    expect(md).toContain('本报告不是 AI 检测器');
    expect(md).toContain('没有单一总分');
    expect(md).toContain('人工盲评仍是质量判断的核心');
    expect(md).toContain('suiteHash');
  });

  it('包含约束结果与指标覆盖范围', () => {
    const report = evaluateSuite(getBaselineSuite(), { clock: CLOCK });
    const md = renderMarkdownReport(report);
    expect(md).toContain('显式约束结果');
    expect(md).toContain('尚未自动评估的质量维度');
    expect(md).toContain('重复信号');
  });

  it('默认不嵌入完整正文', () => {
    const report = evaluateSuite(getBaselineSuite(), { clock: CLOCK });
    const md = renderMarkdownReport(report);
    expect(md).not.toContain('把伞往沈澈那边斜了一点');
  });

  it('两次渲染 byte-identical', () => {
    const report = evaluateSuite(getBaselineSuite(), { clock: CLOCK });
    expect(renderMarkdownReport(report)).toBe(renderMarkdownReport(report));
  });
});

describe('blind packet + sample ratings', () => {
  it('blind packet 验证通过', () => {
    const suite = getBaselineSuite();
    const { packet, mapping } = generateBlindPacket(suite, { seed: 'fixture-seed' });
    expect(packet.cases).toHaveLength(3);
    for (const c of packet.cases) {
      expect(c.candidates.map((x) => x.alias)).toEqual(['A', 'B']);
    }
    expect(mapping.entries.length).toBe(6);
  });

  it('sample ratings 只作为格式示例，不冒充真实用户研究', () => {
    const suite = getBaselineSuite();
    const { packet, mapping } = generateBlindPacket(suite, { seed: 'fixture-seed' });
    const ratings = packet.cases.flatMap((c) =>
      c.candidates.map((cand, i) => ({
        schemaVersion: 1,
        suiteId: packet.suiteId,
        caseId: c.caseId,
        candidateAlias: cand.alias,
        raterId: `sample-rater-${i + 1}`,
        preferredRank: i + 1,
        notes: '',
        continueReading: 4,
        expectationFit: 3,
        characterCredibility: 4,
        languageNaturalness: 3,
        aiSmellAbsence: 3,
        plotProgression: 4,
        concision: 3,
        continuity: 4,
      })),
    );
    expect(() => validateRatings(ratings, { packet })).not.toThrow();
    const agg = aggregateRatings({ packet, ratings, mapping, clock: CLOCK });
    expect(agg.warnings.some((w) => w.includes('示例'))).toBe(true);
    const md = renderMarkdownRatingAggregation(agg);
    expect(md).toContain('不代表真实用户研究');
  });
});
