/**
 * Source / Output suite 语义测试。
 *
 * - source 自带的占位 candidates / expectedRelations 不复制进 output suite；
 * - output suite 每 case 恰 1 个本次生成候选、无 expectedRelations；
 * - suiteId = <source>--<strategy>--<experiment>；通过 validateSuite。
 */

import { describe, it, expect } from 'vitest';
import {
  canonicalSerializeSuite,
  getBaselineSuite,
  sha256Hex,
  validateSuite,
  type WritingCandidateV1,
} from '@ai-novel/writing-evaluation';
import { buildOutputSuite, outputSuiteHash, readSourceSuite } from './suite-io.js';
import { createFakeFs } from './test-util.js';

function generatedCandidate(caseId: string): WritingCandidateV1 {
  return {
    candidateId: `baseline-one-shot-v1.${caseId}.runToken`,
    strategyId: 'baseline-one-shot-v1',
    modelId: 'mimo-v2.5-pro',
    promptVersion: 'baseline-one-shot-v1.p1',
    generationParameters: { temperature: 0.7, maxTokens: 1024, seed: null },
    text: `这是 ${caseId} 的真实生成正文。`,
  };
}

describe('readSourceSuite', () => {
  it('读取并校验合法 source suite，计算 canonical hash', () => {
    const fs = createFakeFs();
    const suite = getBaselineSuite();
    fs.writeFile('/tmp/source.json', JSON.stringify(suite));
    const ref = readSourceSuite(fs.readFile, '/tmp/source.json');
    expect(ref.suite.suiteId).toBe('gq1-baseline-v1');
    expect(ref.suiteHash).toBe(sha256Hex(canonicalSerializeSuite(suite)));
    expect(ref.suite.cases).toHaveLength(3);
  });

  it('无效 JSON 报安全 IO 错误（不含绝对路径）', () => {
    const fs = createFakeFs();
    fs.writeFile('/tmp/source.json', 'not json');
    expect(() => readSourceSuite(fs.readFile, '/tmp/source.json')).toThrow(/JSON 格式错误/);
    expect(() => readSourceSuite(fs.readFile, '/tmp/source.json')).not.toThrow(/\/tmp/);
  });

  it('无效 suite（缺 candidates）报错', () => {
    const fs = createFakeFs();
    const bad = {
      schemaVersion: 1,
      suiteId: 'x',
      title: 'x',
      description: 'x',
      locale: 'zh-CN',
      cases: [],
    };
    fs.writeFile('/tmp/source.json', JSON.stringify(bad));
    expect(() => readSourceSuite(fs.readFile, '/tmp/source.json')).toThrow(/source suite 无效/);
  });
});

describe('buildOutputSuite', () => {
  it('source 占位 candidate / expectedRelations 不复制，只含本次生成候选', () => {
    const source = getBaselineSuite();
    const map = new Map(source.cases.map((c) => [c.caseId, generatedCandidate(c.caseId)]));
    const out = buildOutputSuite(source, map, 'exp-abc', 'baseline-one-shot-v1');
    expect(out.suiteId).toBe('gq1-baseline-v1--baseline-one-shot-v1--exp-abc');
    expect(out.cases).toHaveLength(3);
    for (let i = 0; i < source.cases.length; i += 1) {
      const srcCase = source.cases[i];
      const outCase = out.cases[i];
      expect(outCase.caseId).toBe(srcCase.caseId);
      expect(outCase.expectedRelations).toBeUndefined();
      expect(outCase.candidates).toHaveLength(1);
      expect(outCase.candidates[0].candidateId).toBe(
        `baseline-one-shot-v1.${srcCase.caseId}.runToken`,
      );
      // source 的占位候选（如 restrained / over-explained）绝不混入
      const sourceCandidateIds = new Set(srcCase.candidates.map((c) => c.candidateId));
      expect(sourceCandidateIds.has(outCase.candidates[0].candidateId)).toBe(false);
    }
  });

  it('output suite 通过 validateSuite，hash 一致', () => {
    const source = getBaselineSuite();
    const map = new Map(source.cases.map((c) => [c.caseId, generatedCandidate(c.caseId)]));
    const out = buildOutputSuite(source, map, 'exp-abc', 'baseline-one-shot-v1');
    const validated = validateSuite(out);
    expect(validated.suiteId).toBe(out.suiteId);
    expect(outputSuiteHash(out)).toBe(sha256Hex(canonicalSerializeSuite(validated)));
  });

  it('缺少候选时抛安全错误', () => {
    const source = getBaselineSuite();
    expect(() => buildOutputSuite(source, new Map(), 'exp-abc', 'baseline-one-shot-v1')).toThrow(
      /缺少本次生成的候选/,
    );
  });
});
