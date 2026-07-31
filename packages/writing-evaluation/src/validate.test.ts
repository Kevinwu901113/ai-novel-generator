/**
 * A. Schema validation 测试矩阵。
 */

import { describe, expect, it } from 'vitest';
import { EvaluationValidationError, validateSuite } from './validate.js';
import { cloneJson, makeCase, makeSuite } from './test-util.js';

function expectValidationError(input: unknown, pattern: RegExp): void {
  expect(() => validateSuite(input)).toThrow(EvaluationValidationError);
  expect(() => validateSuite(input)).toThrow(pattern);
}

describe('validateSuite — valid suite', () => {
  it('接受最小合法 suite', () => {
    const suite = validateSuite(makeSuite());
    expect(suite.suiteId).toBe('test-suite');
    expect(suite.schemaVersion).toBe(1);
  });

  it('接受包含完整场景/约束/期望关系的 suite', () => {
    const input = makeSuite({
      cases: [
        makeCase({
          caseId: 'case-full',
          constraints: [
            {
              kind: 'required-phrase',
              constraintId: 'constraint.req',
              phrase: '你好',
              minOccurrences: 1,
            },
            {
              kind: 'manual-criterion',
              constraintId: 'constraint.manual',
              title: '声音',
              rubric: '能否分辨角色',
            },
          ],
          candidates: [
            { ...cloneJson(makeCase().candidates[0]) },
            { ...cloneJson(makeCase().candidates[1]) },
          ],
          expectedRelations: [
            {
              metricId: 'basic.codePointCount',
              leftCandidateId: 'c1',
              operator: 'LT',
              rightCandidateId: 'c2',
            },
          ],
        }),
      ],
    });
    const suite = validateSuite(input);
    expect(suite.cases[0].constraints).toHaveLength(2);
    expect(suite.cases[0].expectedRelations).toHaveLength(1);
  });

  it('不 mutation 输入对象', () => {
    const input = makeSuite();
    const snapshot = JSON.stringify(input);
    validateSuite(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('validateSuite — extra / inherited keys', () => {
  it('拒绝 top-level extra key', () => {
    const input = cloneJson(makeSuite());
    (input as Record<string, unknown>).extra = 1;
    expectValidationError(input, /未知字段/);
  });

  it('拒绝 case 内的 extra key', () => {
    const input = cloneJson(makeSuite());
    (input.cases[0] as unknown as Record<string, unknown>).surprise = true;
    expectValidationError(input, /未知字段/);
  });

  it('拒绝候选内的 extra key', () => {
    const input = cloneJson(makeSuite());
    (input.cases[0].candidates[0] as unknown as Record<string, unknown>).bonus = 1;
    expectValidationError(input, /未知字段/);
  });

  it('拒绝带 inherited enumerable key 的对象', () => {
    const proto = { inheritedKey: 1 };
    const obj = Object.assign(Object.create(proto), makeSuite());
    expectValidationError(obj, /inherited/);
  });
});

describe('validateSuite — schema version', () => {
  it('拒绝非法 schemaVersion', () => {
    const input = cloneJson(makeSuite());
    (input as unknown as Record<string, unknown>).schemaVersion = 2;
    expectValidationError(input, /schemaVersion/);
  });

  it('拒绝缺失 schemaVersion', () => {
    const input = cloneJson(makeSuite());
    delete (input as unknown as Record<string, unknown>).schemaVersion;
    expectValidationError(input, /schemaVersion/);
  });
});

describe('validateSuite — ID 唯一性', () => {
  it('拒绝重复 caseId', () => {
    const input = makeSuite({
      cases: [
        makeCase({ caseId: 'dup' }),
        makeCase({ caseId: 'dup', candidates: [makeSuite().cases[0].candidates[1]] }),
      ],
    });
    expectValidationError(input, /重复的 caseId/);
  });

  it('拒绝重复 candidateId（跨用例全局唯一）', () => {
    const input = makeSuite({
      cases: [
        makeCase({ candidates: [makeSuite().cases[0].candidates[0]] }),
        makeCase({ caseId: 'case-b', candidates: [makeSuite().cases[0].candidates[0]] }),
      ],
    });
    expectValidationError(input, /重复的 candidateId/);
  });

  it('拒绝重复 constraintId', () => {
    const input = makeSuite({
      cases: [
        makeCase({
          constraints: [
            { kind: 'forbidden-phrase', constraintId: 'x', phrase: '禁止' },
            { kind: 'forbidden-phrase', constraintId: 'x', phrase: '也禁止' },
          ],
        }),
      ],
    });
    expectValidationError(input, /重复的 constraintId/);
  });
});

describe('validateSuite — ID / 文本规范', () => {
  it('拒绝空 candidateId', () => {
    const input = cloneJson(makeSuite());
    input.cases[0].candidates[0].candidateId = '   ';
    expectValidationError(input, /candidateId/);
  });

  it('拒绝空文本', () => {
    const input = cloneJson(makeSuite());
    input.cases[0].candidates[0].text = '   \n  ';
    expectValidationError(input, /text/);
  });

  it('ID 长度按 code points 计算（emoji 不溢出）', () => {
    const input = cloneJson(makeSuite());
    input.cases[0].candidates[0].candidateId = 'a'.repeat(199) + '👋';
    expect(() => validateSuite(input)).not.toThrow();
  });

  it('拒绝超过长度上限的 ID', () => {
    const input = cloneJson(makeSuite());
    input.cases[0].candidates[0].candidateId = 'x'.repeat(201);
    expectValidationError(input, /不能超过/);
  });

  it('拒绝仅由零宽字符组成的 ID', () => {
    const input = cloneJson(makeSuite());
    input.cases[0].candidates[0].candidateId = '​​';
    expectValidationError(input, /不能为空/);
  });

  it('拒绝仅由纯标点组成的 ID', () => {
    const input = cloneJson(makeSuite());
    input.cases[0].candidates[0].candidateId = '!!!';
    expectValidationError(input, /不能为空/);
  });

  it('文本进行 NFC 规范化', () => {
    const input = cloneJson(makeSuite());
    input.cases[0].candidates[0].text = 'ä'; // a + combining diaeresis
    const suite = validateSuite(input);
    expect(suite.cases[0].candidates[0].text).toBe('ä');
  });

  it('拒绝超长 notes 上限的场景字段', () => {
    const input = cloneJson(makeSuite());
    input.cases[0].sceneBrief.location = 'x'.repeat(301);
    expectValidationError(input, /不能超过/);
  });
});

describe('validateSuite — scene brief', () => {
  it('拒绝缺失 sceneBrief 必需字段', () => {
    const input = cloneJson(makeSuite());
    delete (input.cases[0].sceneBrief as unknown as Record<string, unknown>).conflict;
    expectValidationError(input, /conflict/);
  });

  it('拒绝 targetLength min > max', () => {
    const input = cloneJson(makeSuite());
    input.cases[0].sceneBrief.targetLength = { minCodePoints: 10, maxCodePoints: 5 };
    expectValidationError(input, /minCodePoints/);
  });
});

describe('validateSuite — contract', () => {
  it('使用 Domain 的真实完整验证：拒绝非法 contract', () => {
    const input = cloneJson(makeSuite());
    (input.cases[0].contract as unknown as Record<string, unknown>).premise = '   ';
    expectValidationError(input, /premise/);
  });

  it('拒绝 contract 中未知 section', () => {
    const input = cloneJson(makeSuite());
    (input.cases[0].contract as unknown as Record<string, unknown>).fakeSection = 'x';
    expectValidationError(input, /未知/);
  });
});

describe('validateSuite — constraints', () => {
  it('拒绝未知约束类型', () => {
    const input = makeSuite({
      cases: [makeCase({ constraints: [{ kind: 'regexp', constraintId: 'x' }] })],
    });
    expectValidationError(input, /未知约束类型/);
  });

  it('拒绝 required-phrase 的非法 minOccurrences', () => {
    const input = makeSuite({
      cases: [
        makeCase({
          constraints: [
            { kind: 'required-phrase', constraintId: 'r', phrase: '好', minOccurrences: 0 },
          ],
        }),
      ],
    });
    expectValidationError(input, /minOccurrences/);
  });

  it('拒绝 dialogue-ratio-range 越界比例', () => {
    const input = makeSuite({
      cases: [
        makeCase({
          constraints: [
            { kind: 'dialogue-ratio-range', constraintId: 'd', minRatio: -0.1, maxRatio: 0.5 },
          ],
        }),
      ],
    });
    expectValidationError(input, /比例/);
  });

  it('拒绝缺少 constraintId', () => {
    const input = makeSuite({
      cases: [makeCase({ constraints: [{ kind: 'forbidden-phrase', phrase: '禁' }] })],
    });
    expectValidationError(input, /constraintId/);
  });
});

describe('validateSuite — expected relations', () => {
  it('拒绝引用未知候选', () => {
    const input = makeSuite({
      cases: [
        makeCase({
          expectedRelations: [
            {
              metricId: 'basic.codePointCount',
              leftCandidateId: 'ghost',
              operator: 'GT',
              rightCandidateId: 'c1',
            },
          ],
        }),
      ],
    });
    expectValidationError(input, /引用未知候选/);
  });

  it('拒绝未知指标', () => {
    const input = makeSuite({
      cases: [
        makeCase({
          expectedRelations: [
            {
              metricId: 'not.a.metric',
              leftCandidateId: 'c1',
              operator: 'GT',
              rightCandidateId: 'c2',
            },
          ],
        }),
      ],
    });
    expectValidationError(input, /未知指标/);
  });

  it('拒绝 left == right', () => {
    const input = makeSuite({
      cases: [
        makeCase({
          expectedRelations: [
            {
              metricId: 'basic.codePointCount',
              leftCandidateId: 'c1',
              operator: 'EQ',
              rightCandidateId: 'c1',
            },
          ],
        }),
      ],
    });
    expectValidationError(input, /不能等于/);
  });
});

describe('validateSuite — generation parameters', () => {
  it('接受 null 参数', () => {
    const input = cloneJson(makeSuite());
    input.cases[0].candidates[0].generationParameters = {
      temperature: null,
      maxTokens: null,
      seed: null,
    };
    expect(() => validateSuite(input)).not.toThrow();
  });

  it('拒绝 NaN temperature', () => {
    const input = cloneJson(makeSuite());
    input.cases[0].candidates[0].generationParameters.temperature = Number.NaN;
    expectValidationError(input, /temperature/);
  });

  it('拒绝非整数 maxTokens', () => {
    const input = cloneJson(makeSuite());
    input.cases[0].candidates[0].generationParameters.maxTokens = 100.5;
    expectValidationError(input, /maxTokens/);
  });

  it('拒绝 generationParameters 内 extra key', () => {
    const input = cloneJson(makeSuite());
    (input.cases[0].candidates[0].generationParameters as unknown as Record<string, unknown>).topP =
      1;
    expectValidationError(input, /未知字段/);
  });
});

describe('validateSuite — 空套件', () => {
  it('拒绝空 cases', () => {
    const input = cloneJson(makeSuite());
    input.cases = [];
    expectValidationError(input, /至少需要 1 个用例/);
  });

  it('拒绝空 candidates', () => {
    const input = cloneJson(makeSuite());
    input.cases[0].candidates = [];
    expectValidationError(input, /至少需要 1 个候选/);
  });

  it('拒绝错误 locale', () => {
    const input = cloneJson(makeSuite());
    (input as unknown as Record<string, unknown>).locale = 'en-US';
    expectValidationError(input, /locale/);
  });
});
