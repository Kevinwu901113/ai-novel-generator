/**
 * parseSpecExtractV1 严格解析单元测试（B3 复查 Note-3：核心执行器的解析分支覆盖）。
 * 执行链路（claim/envelope/补偿/并发）由 apps/worker/src/intake-e2e.integration.test.ts 覆盖。
 */

import { describe, it, expect } from 'vitest';
import {
  parseSpecExtractV1,
  SPEC_EXTRACT_MAX_TOKENS,
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

  it('把单章 15000 字保存为结构化 chapterLength，并兼容旧 structure', () => {
    const structured = parseSpecExtractV1(
      valid({
        sections: {
          ...SECTIONS,
          targetLength: { unit: 'chapters', value: 1 },
          chapterLength: { targetCharacters: 15000 },
        },
      }),
    );
    expect(structured.sections.targetLength).toEqual({ unit: 'chapters', value: 1 });
    expect(structured.sections.chapterLength).toEqual({ targetCharacters: 15000 });

    const legacy = parseSpecExtractV1(
      valid({ sections: { ...SECTIONS, structure: '短篇，一章正文一万五千字' } }),
    );
    expect(legacy.sections.chapterLength).toEqual({ targetCharacters: 15000 });
  });

  it.each([
    ['非 JSON', 'not json {'],
    ['非对象', '42'],
    ['数组', '[]'],
  ])('拒绝：%s', (_label, text) => {
    expect(() => parseSpecExtractV1(text)).toThrow(TaskExecutionError);
  });

  it('兼容 JSON 代码围栏和简短前后说明', () => {
    expect(parseSpecExtractV1(`\n\`\`\`json\n${valid()}\n\`\`\`\n`).decision).toBe('ask_more');
    expect(parseSpecExtractV1(`整理结果如下：\n${valid()}\n请查收。`).decision).toBe('ask_more');
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
      'sections 未通过域校验：',
    );
  });

  it('规范化兼容模型的已知枚举与单项数组偏差，未知坏结构仍拒绝', () => {
    const sections = {
      ...SECTIONS,
      genre: '奇幻',
      tone: '冷峻',
      narrativePov: 'THIRD_PERSON_LIMITED',
      tense: 'FUTURE',
      protagonist: { characterKey: 'protag', name: '主角', traits: '寡言' },
      worldRules: { 房钱: '客人留下一段记忆', 移动: ['随客人移动', '目的未知'] },
      mustAvoid: '甜宠',
      structure: { format: '长篇连载', chapterLength: 3000 },
    };
    const parsed = parseSpecExtractV1(valid({ sections }));
    expect(parsed.sections.genre).toEqual(['奇幻']);
    expect(parsed.sections.narrativePov).toBe('THIRD_LIMITED');
    expect(parsed.sections.tense).toBe('PAST');
    expect(parsed.sections.protagonist.traits).toEqual(['寡言']);
    expect(parsed.sections.worldRules).toEqual([
      '房钱：客人留下一段记忆',
      '移动：随客人移动；目的未知',
    ]);
    expect(parsed.sections.mustAvoid).toEqual(['甜宠']);
    expect(parsed.sections.structure).toBe('format：长篇连载；每章约3000字');
    expect(() => parseSpecExtractV1(valid({ sections: { ...sections, premise: 123 } }))).toThrow(
      'sections 未通过域校验',
    );
  });

  it('兼容模型把字符串集合输出成主项/子项对象', () => {
    const parsed = parseSpecExtractV1(
      valid({
        sections: {
          ...SECTIONS,
          genre: {
            primary: { name: '历史' },
            secondary: [{ name: '悬疑' }, { name: '公路' }],
            confidence: 0.9,
          },
          tone: { main: '严肃', supporting: ['克制'] },
        },
      }),
    );

    expect(parsed.sections.genre).toEqual(['历史', '悬疑', '公路']);
    expect(parsed.sections.tone).toEqual(['严肃', '克制']);
  });

  it('不猜测布尔映射的字符串集合', () => {
    expect(() =>
      parseSpecExtractV1(valid({ sections: { ...SECTIONS, genre: { 历史: true, 悬疑: false } } })),
    ).toThrow('genre 必须是数组');
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
  it('为含推理额度的模型保留 8192 token，避免 JSON 在闭合前被截断', () => {
    expect(SPEC_EXTRACT_MAX_TOKENS).toBe(8192);
  });

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

  it('用户消息给出完整必填字段、枚举和禁止 null 规则', () => {
    const prompt = buildSpecExtractPrompt({ initialIdea: '想法', baselineSections: null, qa: [] });
    expect(prompt).toContain('narrativePov（FIRST|THIRD_LIMITED');
    expect(prompt).toContain('characterKey 只能用');
    expect(prompt).toContain('禁止输出 null');
    expect(prompt).toContain('不得输出未列出的字段');
    expect(prompt).toContain(
      'worldRules、mustInclude、mustAvoid、unresolvedQuestions 都必须是字符串数组',
    );
    expect(prompt).toContain('单章字数写入 chapterLength');
    expect(prompt).toContain('单章15000字');
    expect(prompt).toContain('structure 必须是一个字符串');
    expect(prompt).toContain('故事发生在未来不等于 FUTURE 时态');
    expect(prompt).toContain('chapterLength={"targetCharacters":15000}');
    expect(prompt).toContain('同一条回答里的其他信息');
  });
});
