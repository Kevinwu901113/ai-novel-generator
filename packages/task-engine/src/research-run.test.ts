/**
 * RESEARCH_RUN 解析与 prompt 单测（B5）。执行链路的集成覆盖见
 * apps/worker/src/research-e2e.integration.test.ts。
 */

import { describe, it, expect } from 'vitest';
import {
  buildResearchPlanPrompt,
  parseResearchPlanV1,
  RESEARCH_PLAN_SYSTEM_PROMPT,
} from './research-run.js';

describe('parseResearchPlanV1', () => {
  it('合法输出：1..5 个问题', () => {
    const questions = parseResearchPlanV1(
      JSON.stringify({ schemaVersion: 1, questions: [{ text: '问题一' }, { text: '问题二' }] }),
    );
    expect(questions).toEqual(['问题一', '问题二']);
  });

  it('兼容 JSON 代码围栏和简短前后说明', () => {
    const json = JSON.stringify({ schemaVersion: 1, questions: [{ text: '问题一' }] });
    expect(parseResearchPlanV1(`\`\`\`json\n${json}\n\`\`\``)).toEqual(['问题一']);
    expect(parseResearchPlanV1(`问题计划如下：\n${json}\n请查收。`)).toEqual(['问题一']);
  });

  it('拒绝：非 JSON / 非对象 / 顶层字段不符 / schemaVersion 不符', () => {
    expect(() => parseResearchPlanV1('not json')).toThrow(/JSON/);
    expect(() => parseResearchPlanV1('[]')).toThrow(/对象/);
    expect(() =>
      parseResearchPlanV1(JSON.stringify({ schemaVersion: 1, questions: [], extra: 1 })),
    ).toThrow(/顶层字段/);
    expect(() =>
      parseResearchPlanV1(JSON.stringify({ schemaVersion: 2, questions: [{ text: 'x' }] })),
    ).toThrow(/schemaVersion/);
  });

  it('拒绝：数量越界（0 或 >5）与条目形状/内容非法', () => {
    expect(() => parseResearchPlanV1(JSON.stringify({ schemaVersion: 1, questions: [] }))).toThrow(
      /1\.\.5/,
    );
    expect(() =>
      parseResearchPlanV1(
        JSON.stringify({
          schemaVersion: 1,
          questions: Array.from({ length: 6 }, (_, i) => ({ text: `q${i}` })),
        }),
      ),
    ).toThrow(/1\.\.5/);
    expect(() =>
      parseResearchPlanV1(JSON.stringify({ schemaVersion: 1, questions: [{ text: 'x', y: 1 }] })),
    ).toThrow(/字段不符/);
    expect(() =>
      parseResearchPlanV1(JSON.stringify({ schemaVersion: 1, questions: [{ text: '  ' }] })),
    ).toThrow(/越界或为空/);
    expect(() =>
      parseResearchPlanV1(
        JSON.stringify({ schemaVersion: 1, questions: [{ text: 'a'.repeat(301) }] }),
      ),
    ).toThrow(/越界或为空/);
  });
});

describe('buildResearchPlanPrompt', () => {
  it('确定性序列化：含想法/摘要/深度；prompt 文本不含密钥类内容', () => {
    const prompt = buildResearchPlanPrompt({
      idea: '晚清侦探故事',
      creationSpecSummary: '前提；类型: mystery',
      depth: 'deep',
    });
    expect(prompt).toContain('晚清侦探故事');
    expect(prompt).toContain('deep');
    expect(RESEARCH_PLAN_SYSTEM_PROMPT).toContain('JSON');
  });
});
