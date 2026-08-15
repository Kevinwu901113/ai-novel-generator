/**
 * mergeOutputSuites 测试：A/B 盲评合并前置校验与解盲身份守恒。
 *
 * 本文件只用构造的 suite 对象，不发起任何真实模型调用。
 */

import { describe, expect, it } from 'vitest';
import {
  generateBlindPacket,
  getBaselineSuite,
  validateSuite,
  type WritingCandidateV1,
  type WritingEvaluationSuiteV1,
} from '@ai-novel/writing-evaluation';
import { buildOutputSuite, mergeOutputSuites, parseOutputSuiteId } from './suite-io.js';

function makeRunCandidate(
  strategyId: string,
  caseId: string,
  seed: string,
  text: string,
): WritingCandidateV1 {
  return {
    candidateId: `${strategyId}.${caseId}.tok-${seed}`,
    strategyId,
    modelId: 'fake-model',
    promptVersion: `${strategyId}.p1`,
    generationParameters: { temperature: 0.7, maxTokens: 8192, seed },
    text,
  };
}

function makeOutputSuite(
  strategyId: string,
  experimentId: string,
  seed: string,
  label: string,
): WritingEvaluationSuiteV1 {
  const source = getBaselineSuite();
  const candidatesByCase = new Map(
    source.cases.map((c) => [
      c.caseId,
      makeRunCandidate(strategyId, c.caseId, seed, `${label}-${c.caseId}-${seed}`),
    ]),
  );
  return buildOutputSuite(source, candidatesByCase, experimentId, strategyId);
}

function fourRunSuites(): WritingEvaluationSuiteV1[] {
  return [
    makeOutputSuite('baseline-one-shot-v1', 'exp-b1', 'seed-1', 'B1'),
    makeOutputSuite('antislop-v1', 'exp-a1', 'seed-1', 'A1'),
    makeOutputSuite('baseline-one-shot-v1', 'exp-b2', 'seed-2', 'B2'),
    makeOutputSuite('antislop-v1', 'exp-a2', 'seed-2', 'A2'),
  ];
}

function originByCandidateId(result: ReturnType<typeof mergeOutputSuites>) {
  return new Map(result.candidateOrigins.map((o) => [o.candidateId, o]));
}

describe('parseOutputSuiteId', () => {
  it('解析 buildOutputSuite 产出的 suiteId', () => {
    expect(parseOutputSuiteId('gq1-baseline-v1--baseline-one-shot-v1--exp-1')).toEqual({
      sourceSuiteId: 'gq1-baseline-v1',
      strategyId: 'baseline-one-shot-v1',
      experimentId: 'exp-1',
    });
  });

  it('拒绝非 output suiteId 形状', () => {
    expect(parseOutputSuiteId('gq1-baseline-v1')).toBeNull();
    expect(parseOutputSuiteId('gq1-baseline-v1--strategy')).toBeNull();
  });
});

describe('mergeOutputSuites 前置校验', () => {
  it('sourceSuiteId 不一致 → 前置拒绝并指出差异', () => {
    const gq1 = makeOutputSuite('baseline-one-shot-v1', 'exp-1', 'seed-1', 'B1');
    const source = validateSuite({
      ...getBaselineSuite(),
      suiteId: 'gq2-genre-coverage-v1',
      cases: getBaselineSuite().cases,
    });
    const gq2 = buildOutputSuite(
      source,
      new Map(
        source.cases.map((c) => [
          c.caseId,
          makeRunCandidate('baseline-one-shot-v1', c.caseId, 'seed-2', 'X'),
        ]),
      ),
      'exp-2',
      'baseline-one-shot-v1',
    );
    expect(() => mergeOutputSuites([gq1, gq2])).toThrow(/sourceSuiteId 不一致/);
    expect(() => mergeOutputSuites([gq1, gq2])).toThrow(/gq2-genre-coverage-v1/);
  });

  it('caseId 集合不一致 → 前置拒绝并指出差异', () => {
    const full = makeOutputSuite('baseline-one-shot-v1', 'exp-1', 'seed-1', 'B1');
    const source = getBaselineSuite();
    const partialSource = validateSuite({
      ...source,
      cases: source.cases.slice(0, 2),
    });
    const partial = buildOutputSuite(
      partialSource,
      new Map(
        partialSource.cases.map((c) => [
          c.caseId,
          makeRunCandidate('baseline-one-shot-v1', c.caseId, 'seed-2', 'P'),
        ]),
      ),
      'exp-2',
      'baseline-one-shot-v1',
    );
    expect(() => mergeOutputSuites([full, partial])).toThrow(/caseId 集合不一致/);
    expect(() => mergeOutputSuites([full, partial])).toThrow(/缺少 caseId/);
  });

  it('候选数不平衡 → 拒绝并指名 case', () => {
    const source = validateSuite({
      ...getBaselineSuite(),
      cases: getBaselineSuite().cases.slice(0, 2),
    });
    const first = buildOutputSuite(
      source,
      new Map(
        source.cases.map((c) => [
          c.caseId,
          makeRunCandidate('baseline-one-shot-v1', c.caseId, 'seed-1', 'X'),
        ]),
      ),
      'exp-1',
      'baseline-one-shot-v1',
    );
    const second = buildOutputSuite(
      source,
      new Map(
        source.cases.map((c) => [
          c.caseId,
          makeRunCandidate('baseline-one-shot-v1', c.caseId, 'seed-2', 'Y'),
        ]),
      ),
      'exp-2',
      'baseline-one-shot-v1',
    );

    const secondRaw = JSON.parse(JSON.stringify(second)) as WritingEvaluationSuiteV1;
    const targetCase = secondRaw.cases[1];
    targetCase.candidates = [
      ...targetCase.candidates,
      {
        ...targetCase.candidates[0],
        candidateId: `extra.${targetCase.caseId}`,
        text: `extra text for ${targetCase.caseId}`,
      },
    ];
    const unbalanced = validateSuite(secondRaw);

    expect(() => mergeOutputSuites([first, unbalanced])).toThrow(/候选数不平衡/);
    expect(() => mergeOutputSuites([first, unbalanced])).toThrow(/caseId|case "/);
  });
});

describe('mergeOutputSuites 身份守恒与盲评', () => {
  it('合并后每 case 含 N 个候选，且原 suite 不被修改', () => {
    const suites = fourRunSuites();
    const before = suites.map((s) => JSON.stringify(s));
    const result = mergeOutputSuites(suites);
    expect(suites.map((s) => JSON.stringify(s))).toEqual(before);

    expect(result.suite.cases).toHaveLength(3);
    for (const c of result.suite.cases) {
      expect(c.candidates).toHaveLength(4);
    }
    expect(result.candidateOrigins).toHaveLength(12);
  });

  it('同 case 内不同策略候选确实混排，alias 不按策略输入顺序固定排列', () => {
    const result = mergeOutputSuites(fourRunSuites());
    const blind = generateBlindPacket(result.suite, { seed: 'ab-mixed' });
    const firstCase = blind.packet.cases[0];

    expect(firstCase.candidates).toHaveLength(4);

    const originByCandidate = originByCandidateId(result);
    const aliases = firstCase.candidates.map((c) => c.alias).sort();
    const strategySequence = aliases.map((alias) => {
      const entry = blind.mapping.entries.find(
        (e) => e.caseId === firstCase.caseId && e.alias === alias,
      );
      expect(entry).toBeDefined();
      const origin = originByCandidate.get(entry?.candidateId ?? '');
      expect(origin).toBeDefined();
      return origin?.strategyId ?? '';
    });

    const baselineGrouped = [
      'baseline-one-shot-v1',
      'baseline-one-shot-v1',
      'antislop-v1',
      'antislop-v1',
    ];
    const antislopGrouped = [
      'antislop-v1',
      'antislop-v1',
      'baseline-one-shot-v1',
      'baseline-one-shot-v1',
    ];
    expect(strategySequence).not.toEqual(baselineGrouped);
    expect(strategySequence).not.toEqual(antislopGrouped);

    // 每个策略在该 case 都恰好出现 2 次，说明同 case 内包含两个策略。
    expect(strategySequence.filter((s) => s === 'baseline-one-shot-v1')).toHaveLength(2);
    expect(strategySequence.filter((s) => s === 'antislop-v1')).toHaveLength(2);
  });

  it('解盲后能从 mapping + candidateOrigins 还原 strategyId 与 seed', () => {
    const result = mergeOutputSuites(fourRunSuites());
    const blind = generateBlindPacket(result.suite, { seed: 'ab-mixed' });
    const originByCandidate = originByCandidateId(result);

    for (const entry of blind.mapping.entries) {
      const origin = originByCandidate.get(entry.candidateId);
      expect(origin).toBeDefined();
      if (origin === undefined) continue;
      expect(origin.candidateId).toBe(entry.candidateId);
      expect(['baseline-one-shot-v1', 'antislop-v1']).toContain(origin.strategyId);
      expect(origin.promptVersion).toBe(`${origin.strategyId}.p1`);
      expect(['seed-1', 'seed-2']).toContain(origin.seed);
      expect(origin.originalCandidateId).toContain(origin.strategyId);
      expect(origin.originalCandidateId).toContain(origin.seed ?? '');
    }

    const baselineSeed2 = result.candidateOrigins.filter(
      (o) => o.strategyId === 'baseline-one-shot-v1' && o.seed === 'seed-2',
    );
    expect(baselineSeed2).toHaveLength(3);
  });

  it('输入顺序不同 → 合并结果相同', () => {
    const suites = fourRunSuites();
    const forward = mergeOutputSuites(suites);
    const reversed = mergeOutputSuites([...suites].reverse());
    expect(reversed).toEqual(forward);
  });
});
