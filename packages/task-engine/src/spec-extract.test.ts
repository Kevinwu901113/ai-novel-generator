/**
 * parseSpecExtractV1 严格解析单元测试（B3 复查 Note-3：核心执行器的解析分支覆盖）。
 * 执行链路（claim/envelope/补偿/并发）由 apps/worker/src/intake-e2e.integration.test.ts 覆盖。
 */

import { describe, it, expect } from 'vitest';
import {
  parseSpecExtractV1,
  SPEC_EXTRACT_SYSTEM_PROMPT,
  buildSpecExtractPrompt,
} from './spec-extract.js';
import { TaskExecutionError } from './index.js';

const SECTIONS = {
  premise: '测试前提',
  genre: ['sci-fi'],
  tone: ['dark'],
  targetAudience: 'adults',
  narrativePov: 'FIRST',
  tense: 'PRESENT',
  protagonist: { characterKey: 'protag', name: '主角' },
};

const QUESTION = { topic: '篇幅', text: '短篇还是长篇？', rationale: '决定结构' };

function valid(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    decision: 'ask_more',
    sections: SECTIONS,
    nextQuestions: [QUESTION],
    ...overrides,
  });
}

describe('parseSpecExtractV1', () => {
  it('合法 ask_more：decision/sections/问题全解析', () => {
    const parsed = parseSpecExtractV1(valid());
    expect(parsed.decision).toBe('ask_more');
    expect(parsed.sections.premise).toBe('测试前提');
    expect(parsed.nextQuestions).toHaveLength(1);
    expect(parsed.nextQuestions[0].topic).toBe('篇幅');
  });

  it('合法 spec_complete：nextQuestions 必须为空', () => {
    const parsed = parseSpecExtractV1(valid({ decision: 'spec_complete', nextQuestions: [] }));
    expect(parsed.decision).toBe('spec_complete');
    expect(parsed.nextQuestions).toHaveLength(0);
  });

  it.each([
    ['非 JSON', 'not json {'],
    ['非对象', '42'],
    ['数组', '[]'],
  ])('拒绝：%s', (_label, text) => {
    expect(() => parseSpecExtractV1(text)).toThrow(TaskExecutionError);
  });

  it('拒绝：多余顶层字段', () => {
    expect(() => parseSpecExtractV1(valid({ extra: 1 }))).toThrow('顶层字段不符');
  });

  it('拒绝：缺少顶层字段', () => {
    const obj = JSON.parse(valid()) as Record<string, unknown>;
    delete obj.nextQuestions;
    expect(() => parseSpecExtractV1(JSON.stringify(obj))).toThrow('顶层字段不符');
  });

  it('拒绝：schemaVersion 不符', () => {
    expect(() => parseSpecExtractV1(valid({ schemaVersion: 2 }))).toThrow('schemaVersion 不符');
  });

  it('拒绝：decision 非法', () => {
    expect(() => parseSpecExtractV1(valid({ decision: 'maybe' }))).toThrow('decision 非法');
  });

  it('拒绝：sections 未过域校验', () => {
    expect(() => parseSpecExtractV1(valid({ sections: { premise: 123 } }))).toThrow(
      'sections 未通过域校验',
    );
  });

  it('拒绝：spec_complete 却带问题', () => {
    expect(() =>
      parseSpecExtractV1(valid({ decision: 'spec_complete', nextQuestions: [QUESTION] })),
    ).toThrow('必须为空');
  });

  it('拒绝：ask_more 问题数为 0 或超过 3', () => {
    expect(() => parseSpecExtractV1(valid({ nextQuestions: [] }))).toThrow('1..3');
    expect(() =>
      parseSpecExtractV1(valid({ nextQuestions: [QUESTION, QUESTION, QUESTION, QUESTION] })),
    ).toThrow('1..3');
  });

  it('拒绝：问题条目字段不符 / 内容越界', () => {
    expect(() => parseSpecExtractV1(valid({ nextQuestions: [{ topic: 't', text: 'x' }] }))).toThrow(
      '字段不符',
    );
    expect(() =>
      parseSpecExtractV1(
        valid({ nextQuestions: [{ topic: 't', text: 'x'.repeat(501), rationale: 'r' }] }),
      ),
    ).toThrow('越界');
    expect(() =>
      parseSpecExtractV1(valid({ nextQuestions: [{ topic: ' ', text: 'x', rationale: 'r' }] })),
    ).toThrow('越界');
  });
});

describe('prompt 构造', () => {
  it('系统提示声明顶层结构与问题规则', () => {
    expect(SPEC_EXTRACT_SYSTEM_PROMPT).toContain('schemaVersion');
    expect(SPEC_EXTRACT_SYSTEM_PROMPT).toContain('nextQuestions');
  });

  it('用户消息为确定性序列化（同输入同输出）', () => {
    const ctx = {
      initialIdea: '想法',
      baselineSections: null,
      qa: [{ question: 'q', topic: 't', status: 'ASKED', answer: 'a' }],
    };
    expect(buildSpecExtractPrompt(ctx)).toBe(buildSpecExtractPrompt(ctx));
    expect(buildSpecExtractPrompt(ctx)).toContain('想法');
  });
});
