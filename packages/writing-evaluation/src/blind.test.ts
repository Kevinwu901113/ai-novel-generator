/**
 * Blind review packet 测试。
 */

import { describe, expect, it } from 'vitest';
import { generateBlindPacket } from './blind.js';
import { getBaselineSuite } from './fixtures.js';
import { makeSuite } from './test-util.js';

function packetSuite() {
  return getBaselineSuite();
}

describe('determinism', () => {
  it('同 seed → 相同 aliases（mapping 一致）', () => {
    const a = generateBlindPacket(packetSuite(), { seed: 's1' });
    const b = generateBlindPacket(packetSuite(), { seed: 's1' });
    expect(JSON.stringify(a.mapping)).toBe(JSON.stringify(b.mapping));
    expect(JSON.stringify(a.packet)).toBe(JSON.stringify(b.packet));
  });

  it('不同 seed → mapping 不同但仍是合法顺序', () => {
    const a = generateBlindPacket(packetSuite(), { seed: 'seed-A' });
    const b = generateBlindPacket(packetSuite(), { seed: 'seed-B' });
    expect(JSON.stringify(a.mapping)).not.toBe(JSON.stringify(b.mapping));
    // 每个 case 的候选集合一致，只是 alias 分配可能不同
    for (const ac of a.mapping.entries) {
      const bc = b.mapping.entries.filter((e) => e.caseId === ac.caseId);
      expect(bc.length).toBeGreaterThan(0);
      const aIds = a.mapping.entries
        .filter((e) => e.caseId === ac.caseId)
        .map((e) => e.candidateId)
        .sort();
      const bIds = bc.map((e) => e.candidateId).sort();
      expect(aIds).toEqual(bIds);
    }
  });
});

describe('匿名性', () => {
  it('packet 不包含 candidateId / strategyId / modelId / promptVersion / generationParameters', () => {
    const { packet } = generateBlindPacket(packetSuite(), { seed: 's' });
    const json = JSON.stringify(packet);
    expect(json).not.toContain('candidateId');
    expect(json).not.toContain('strategyId');
    expect(json).not.toContain('modelId');
    expect(json).not.toContain('promptVersion');
    expect(json).not.toContain('generationParameters');
  });

  it('packet 包含候选文本与场景 brief', () => {
    const { packet } = generateBlindPacket(packetSuite(), { seed: 's' });
    const firstCase = packet.cases[0];
    expect(firstCase.candidates.length).toBe(2);
    expect(firstCase.candidates[0].text.length).toBeGreaterThan(0);
    expect(typeof firstCase.sceneBrief.sceneGoal).toBe('string');
  });

  it('manual criterion 进入 rubric', () => {
    const { packet } = generateBlindPacket(packetSuite(), { seed: 's' });
    for (const c of packet.cases) {
      expect(c.manualCriteria.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('alias 无碰撞：每个 case 内 alias 唯一', () => {
    const { packet } = generateBlindPacket(packetSuite(), { seed: 's' });
    for (const c of packet.cases) {
      const aliases = c.candidates.map((x) => x.alias);
      expect(new Set(aliases).size).toBe(aliases.length);
      expect(aliases).toEqual([...aliases].sort());
    }
  });
});

describe('private mapping', () => {
  it('mapping 覆盖全部候选，恰好一次', () => {
    const suite = packetSuite();
    const { mapping } = generateBlindPacket(suite, { seed: 's' });
    const totalCandidates = suite.cases.reduce((acc, c) => acc + c.candidates.length, 0);
    expect(mapping.entries.length).toBe(totalCandidates);
    const keys = mapping.entries.map((e) =>
      JSON.stringify([e.suiteId, e.caseId, e.alias, e.candidateId]),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('packet 与 mapping 是分离的两个对象', () => {
    const result = generateBlindPacket(packetSuite(), { seed: 's' });
    expect(result.packet).not.toBe(result.mapping);
    // mapping 含 candidateId，packet 不含 —— 二者不应合并
    expect(JSON.stringify(result.mapping)).toContain('candidateId');
  });

  it('packetId 稳定且随 seed 变化', () => {
    const a = generateBlindPacket(packetSuite(), { seed: 's' });
    const b = generateBlindPacket(packetSuite(), { seed: 'other' });
    expect(a.packet.packetId).not.toBe(b.packet.packetId);
  });
});

describe('单候选 case 边缘', () => {
  it('单候选映射为 alias A', () => {
    const suite = makeSuite();
    suite.cases[0].candidates = [suite.cases[0].candidates[0]];
    const { mapping } = generateBlindPacket(suite, { seed: 's' });
    expect(mapping.entries[0].alias).toBe('A');
  });
});
