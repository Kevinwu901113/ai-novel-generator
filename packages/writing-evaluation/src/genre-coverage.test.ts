/**
 * GQ2 题材覆盖套件测试。
 *
 * 这些断言钉住 GE-9 的扩充目的：gq1 基线不被改动，同时 gq2
 * 必须覆盖 4 种视角、3 种时态与至少 8 类题材。将来删 case 会立刻变红。
 */

import { describe, expect, it } from 'vitest';
import { GENRE_COVERAGE_SUITE, getBaselineSuite } from './fixtures.js';
import { validateSuite } from './validate.js';

const EXPECTED_BASELINE_CASE_IDS = [
  'restrained-reunion',
  'suspense-corridor',
  'two-voice-dialogue',
];

describe('GQ2 genre coverage suite', () => {
  it('gq1-baseline-v1 保持冻结：仍为 3 个 case 且 caseId 集合不变', () => {
    const baseline = getBaselineSuite();
    expect(baseline.suiteId).toBe('gq1-baseline-v1');
    expect(baseline.cases).toHaveLength(3);
    expect(baseline.cases.map((c) => c.caseId).sort()).toEqual(
      [...EXPECTED_BASELINE_CASE_IDS].sort(),
    );
  });

  it('新套件通过 validateSuite，且 suiteId 与 case 数正确', () => {
    expect(() => validateSuite(GENRE_COVERAGE_SUITE)).not.toThrow();
    expect(GENRE_COVERAGE_SUITE.suiteId).toBe('gq2-genre-coverage-v1');
    expect(GENRE_COVERAGE_SUITE.cases).toHaveLength(8);
  });

  it('8 个 case 的 caseId 唯一', () => {
    const ids = GENRE_COVERAGE_SUITE.cases.map((c) => c.caseId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('覆盖矩阵：4 种视角、3 种时态、去重题材至少 8 类', () => {
    const cases = GENRE_COVERAGE_SUITE.cases;

    expect(new Set(cases.map((c) => c.contract.narrativePov))).toEqual(
      new Set(['FIRST', 'THIRD_LIMITED', 'THIRD_OMNISCIENT', 'SECOND']),
    );
    expect(new Set(cases.map((c) => c.contract.tense))).toEqual(
      new Set(['PAST', 'PRESENT', 'MIXED']),
    );

    const genres = new Set(cases.flatMap((c) => c.contract.genre));
    expect(genres.size).toBeGreaterThanOrEqual(8);
  });
});
