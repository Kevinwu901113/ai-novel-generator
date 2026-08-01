/**
 * Blind Packet / Private Mapping 严格验证测试。
 */

import { describe, expect, it } from 'vitest';
import {
  EvaluationValidationError,
  validateBlindPacket,
  validatePrivateMapping,
} from './validate.js';
import { generateBlindPacket } from './blind.js';
import { getBaselineSuite } from './fixtures.js';
import { isValidBlindAlias } from './schema.js';

interface Base {
  suite: ReturnType<typeof getBaselineSuite>;
  packet: ReturnType<typeof generateBlindPacket>['packet'];
  mapping: ReturnType<typeof generateBlindPacket>['mapping'];
}

function base(): Base {
  const suite = getBaselineSuite();
  const { packet, mapping } = generateBlindPacket(suite, { seed: 'test-seed' });
  return { suite, packet, mapping };
}

function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function expectBlindError(input: unknown, pattern: RegExp): void {
  expect(() => validateBlindPacket(input)).toThrow(EvaluationValidationError);
  expect(() => validateBlindPacket(input)).toThrow(pattern);
}

function expectMappingError(input: unknown, packet: unknown, pattern: RegExp): void {
  expect(() => validatePrivateMapping(input, packet)).toThrow(EvaluationValidationError);
  expect(() => validatePrivateMapping(input, packet)).toThrow(pattern);
}

describe('validateBlindPacket — 合法 packet', () => {
  it('接受由 generateBlindPacket 生成的 packet', () => {
    const { packet } = base();
    expect(validateBlindPacket(packet).suiteId).toBe(packet.suiteId);
  });

  it('packet 不含身份字段', () => {
    const { packet } = base();
    const json = JSON.stringify(packet);
    expect(json).not.toContain('candidateId');
    expect(json).not.toContain('strategyId');
    expect(json).not.toContain('modelId');
    expect(json).not.toContain('promptVersion');
    expect(json).not.toContain('generationParameters');
  });
});

describe('validateBlindPacket — 非法 packet', () => {
  it('拒绝 extra key', () => {
    const { packet } = base();
    const input = cloneJson(packet) as Record<string, unknown>;
    input.extra = 1;
    expectBlindError(input, /未知字段/);
  });

  it('拒绝 custom prototype', () => {
    const { packet } = base();
    const proto = { inherited: 1 };
    const input = Object.assign(Object.create(proto), packet);
    expectBlindError(input, /inherited/);
  });

  it('拒绝非法 schemaVersion', () => {
    const { packet } = base();
    const input = cloneJson(packet) as Record<string, unknown>;
    input.schemaVersion = 2;
    expectBlindError(input, /schemaVersion/);
  });

  it('拒绝非法 locale', () => {
    const { packet } = base();
    const input = cloneJson(packet) as Record<string, unknown>;
    input.locale = 'en-US';
    expectBlindError(input, /locale/);
  });

  it('拒绝非法 packetId 格式', () => {
    const { packet } = base();
    const input = cloneJson(packet);
    input.packetId = 'not-a-hash';
    expectBlindError(input, /SHA-256/);
  });

  it('拒绝重复 caseId', () => {
    const { packet } = base();
    const input = cloneJson(packet);
    input.cases[1].caseId = input.cases[0].caseId;
    expectBlindError(input, /重复的 caseId/);
  });

  it('拒绝空 candidates', () => {
    const { packet } = base();
    const input = cloneJson(packet);
    input.cases[0].candidates = [];
    expectBlindError(input, /至少需要 1 个候选/);
  });

  it('拒绝重复 alias', () => {
    const { packet } = base();
    const input = cloneJson(packet);
    input.cases[0].candidates[1].alias = input.cases[0].candidates[0].alias;
    expectBlindError(input, /重复的 alias/);
  });

  it('拒绝非法 alias（AA / ZZ / 小写 / 数字）', () => {
    for (const bad of ['AA', 'ZZ', 'a', '1']) {
      const { packet } = base();
      const input = cloneJson(packet);
      input.cases[0].candidates[0].alias = bad;
      expectBlindError(input, /大写单字母/);
    }
  });

  it('拒绝空 alias', () => {
    const { packet } = base();
    const input = cloneJson(packet);
    input.cases[0].candidates[0].alias = '';
    expectBlindError(input, /不能为空|大写单字母/);
  });

  it('接受合法 alias（A / Z）', () => {
    const { packet } = base();
    const input = cloneJson(packet);
    input.cases[0].candidates[0].alias = 'A';
    input.cases[0].candidates[1].alias = 'Z';
    expect(validateBlindPacket(input).cases[0].candidates.map((c) => c.alias)).toEqual(['A', 'Z']);
  });

  it('拒绝身份字段泄漏（candidateId 等）', () => {
    const { packet } = base();
    const input = cloneJson(packet);
    (input.cases[0].candidates[0] as Record<string, unknown>).candidateId = 'secret-id';
    expectBlindError(input, /未知字段/);
    const input2 = cloneJson(packet);
    (input2.cases[0].candidates[0] as Record<string, unknown>).strategyId = 's1';
    expectBlindError(input2, /未知字段/);
  });

  it('拒绝仅零宽字符的候选文本', () => {
    const { packet } = base();
    const input = cloneJson(packet);
    input.cases[0].candidates[0].text = '​​';
    expectBlindError(input, /不能为空|实质内容/);
  });

  it('拒绝非法 sceneBrief（共享严格验证）', () => {
    const { packet } = base();
    const input = cloneJson(packet);
    (input.cases[0].sceneBrief as Record<string, unknown>).conflict = '   ';
    expectBlindError(input, /conflict/);
  });

  it('拒绝非法 manualCriteria（非 manual-criterion）', () => {
    const { packet } = base();
    const input = cloneJson(packet);
    input.cases[0].manualCriteria = [{ kind: 'forbidden-phrase', constraintId: 'x', phrase: '禁' }];
    expectBlindError(input, /manual-criterion/);
  });
});

describe('isValidBlindAlias — 共享单字母规则', () => {
  it('A、Z 通过', () => {
    expect(isValidBlindAlias('A')).toBe(true);
    expect(isValidBlindAlias('Z')).toBe(true);
  });

  it('AA、ZZ、小写、数字、空字符串失败', () => {
    for (const bad of ['AA', 'ZZ', 'a', '1', '', 'AB']) {
      expect(isValidBlindAlias(bad)).toBe(false);
    }
  });
});

describe('validatePrivateMapping — 合法 mapping', () => {
  it('接受与 packet 匹配的 mapping', () => {
    const { packet, mapping } = base();
    const validated = validatePrivateMapping(mapping, packet);
    expect(validated.suiteId).toBe(packet.suiteId);
    expect(validated.entries.length).toBe(mapping.entries.length);
  });

  it('每个 packet case/alias 恰好对应一个 entry', () => {
    const { packet, mapping } = base();
    const validated = validatePrivateMapping(mapping, packet);
    const totalPairs = packet.cases.reduce((acc, c) => acc + c.candidates.length, 0);
    expect(validated.entries.length).toBe(totalPairs);
  });
});

describe('validatePrivateMapping — 非法 mapping', () => {
  it('拒绝 foreign suiteId', () => {
    const { packet, mapping } = base();
    const input = cloneJson(mapping);
    input.suiteId = 'foreign-suite';
    expectMappingError(input, packet, /suiteId/);
  });

  it('拒绝错误 seed（packetId 不匹配）', () => {
    const { packet, mapping } = base();
    const input = cloneJson(mapping);
    input.seed = 'different-seed';
    expectMappingError(input, packet, /不匹配/);
  });

  it('拒绝错误 packetId', () => {
    const { packet, mapping } = base();
    const badPacket = cloneJson(packet);
    badPacket.packetId = '0'.repeat(64);
    expectMappingError(mapping, badPacket, /不匹配/);
  });

  it('拒绝 unknown case', () => {
    const { packet, mapping } = base();
    const input = cloneJson(mapping);
    input.entries[0].caseId = 'ghost-case';
    expectMappingError(input, packet, /不存在于 blind packet/);
  });

  it('拒绝 unknown alias', () => {
    const { packet, mapping } = base();
    const input = cloneJson(mapping);
    input.entries[0].alias = 'Z';
    expectMappingError(input, packet, /不存在于 blind packet/);
  });

  it('拒绝重复的 case/alias 组合', () => {
    const { packet, mapping } = base();
    const input = cloneJson(mapping);
    input.entries.push(cloneJson(input.entries[0]));
    expectMappingError(input, packet, /重复的 case\/alias/);
  });

  it('拒绝重复 candidateId', () => {
    const { packet, mapping } = base();
    const input = cloneJson(mapping);
    input.entries[1].candidateId = input.entries[0].candidateId;
    expectMappingError(input, packet, /重复的 candidateId/);
  });

  it('拒绝缺失 entry', () => {
    const { packet, mapping } = base();
    const input = cloneJson(mapping);
    input.entries = input.entries.slice(1);
    expectMappingError(input, packet, /必须且只能覆盖/);
  });

  it('拒绝 extra entry', () => {
    const { packet, mapping } = base();
    const input = cloneJson(mapping);
    input.entries.push({
      suiteId: packet.suiteId,
      caseId: 'does-not-exist',
      alias: 'A',
      candidateId: 'made-up',
    });
    expectMappingError(input, packet, /不存在于 blind packet/);
  });

  it('拒绝 custom prototype', () => {
    const { packet, mapping } = base();
    const proto = { inherited: 1 };
    const input = Object.assign(Object.create(proto), mapping);
    expectMappingError(input, packet, /inherited/);
  });

  it('拒绝 mapping extra key', () => {
    const { packet, mapping } = base();
    const input = cloneJson(mapping) as Record<string, unknown>;
    input.extra = true;
    expectMappingError(input, packet, /未知字段/);
  });

  it('拒绝 entry extra key', () => {
    const { packet, mapping } = base();
    const input = cloneJson(mapping);
    (input.entries[0] as Record<string, unknown>).extra = 1;
    expectMappingError(input, packet, /未知字段/);
  });
});
