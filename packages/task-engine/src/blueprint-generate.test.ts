/**
 * parseBlueprintGenerateV1 严格解析单元测试（B7，D-B7-6：解析边界覆盖）。
 * 执行链路（claim/envelope/补偿/原子性/失效拒绝）由
 * apps/worker/src/blueprint-e2e.integration.test.ts 覆盖。
 */

import { describe, it, expect } from 'vitest';
import {
  parseBlueprintGenerateV1,
  buildBlueprintGeneratePrompt,
  BLUEPRINT_GENERATE_SYSTEM_PROMPT,
} from './blueprint-generate.js';
import { TaskExecutionError } from './index.js';

const CHARACTER = { name: '侦探', role: '主角', description: '冷静自持' };
const PLOTLINE = { name: '主线', summary: '追查真凶' };
const CHAPTER = { title: '第一章', goal: '引出案件' };

function valid(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    premise: '侦探在雨夜调查悬案',
    characters: [CHARACTER],
    relationships: ['侦探——委托人'],
    world: '晚清上海滩',
    conflict: '真相被掩盖',
    ending: '真相大白',
    plotlines: [PLOTLINE],
    chapters: [CHAPTER],
    ...overrides,
  });
}

describe('parseBlueprintGenerateV1', () => {
  it('合法输出：全部字段解析', () => {
    const parsed = parseBlueprintGenerateV1(valid());
    expect(parsed.premise).toBe('侦探在雨夜调查悬案');
    expect(parsed.characters).toEqual([CHARACTER]);
    expect(parsed.relationships).toEqual(['侦探——委托人']);
    expect(parsed.world).toBe('晚清上海滩');
    expect(parsed.plotlines).toEqual([PLOTLINE]);
    expect(parsed.chapters).toEqual([CHAPTER]);
  });

  it('relationships 允许为空数组', () => {
    const parsed = parseBlueprintGenerateV1(valid({ relationships: [] }));
    expect(parsed.relationships).toEqual([]);
  });

  it.each([
    ['非 JSON', 'not json {'],
    ['非对象', '42'],
    ['数组', '[]'],
  ])('拒绝：%s', (_label, text) => {
    expect(() => parseBlueprintGenerateV1(text)).toThrow(TaskExecutionError);
  });

  it('拒绝：多余/缺失顶层字段', () => {
    expect(() => parseBlueprintGenerateV1(valid({ extra: 1 }))).toThrow('顶层字段不符');
    const obj = JSON.parse(valid()) as Record<string, unknown>;
    delete obj.ending;
    expect(() => parseBlueprintGenerateV1(JSON.stringify(obj))).toThrow('顶层字段不符');
  });

  it('拒绝：schemaVersion 不符', () => {
    expect(() => parseBlueprintGenerateV1(valid({ schemaVersion: 2 }))).toThrow(
      'schemaVersion 不符',
    );
  });

  it('拒绝：premise/world/conflict/ending 为空或越界', () => {
    expect(() => parseBlueprintGenerateV1(valid({ premise: '  ' }))).toThrow('premise 越界或为空');
    expect(() => parseBlueprintGenerateV1(valid({ world: 'w'.repeat(4001) }))).toThrow(
      'world 越界或为空',
    );
    expect(() => parseBlueprintGenerateV1(valid({ conflict: '' }))).toThrow('conflict 越界或为空');
    expect(() => parseBlueprintGenerateV1(valid({ ending: '' }))).toThrow('ending 越界或为空');
  });

  it('拒绝：characters 数量越界（0 个或 >50）', () => {
    expect(() => parseBlueprintGenerateV1(valid({ characters: [] }))).toThrow('1..50');
    expect(() =>
      parseBlueprintGenerateV1(valid({ characters: Array.from({ length: 51 }, () => CHARACTER) })),
    ).toThrow('1..50');
  });

  it('拒绝：character 条目字段不符 / 内容越界', () => {
    expect(() =>
      parseBlueprintGenerateV1(valid({ characters: [{ name: 'a', role: 'b' }] })),
    ).toThrow('字段不符');
    expect(() =>
      parseBlueprintGenerateV1(valid({ characters: [{ name: '', role: 'b', description: 'c' }] })),
    ).toThrow('越界或为空');
  });

  it('拒绝：relationships 超过 100 条', () => {
    expect(() =>
      parseBlueprintGenerateV1(
        valid({ relationships: Array.from({ length: 101 }, (_, i) => `r${i}`) }),
      ),
    ).toThrow('100');
  });

  it('拒绝：plotlines 数量越界（0 个或 >20）', () => {
    expect(() => parseBlueprintGenerateV1(valid({ plotlines: [] }))).toThrow('1..20');
    expect(() =>
      parseBlueprintGenerateV1(valid({ plotlines: Array.from({ length: 21 }, () => PLOTLINE) })),
    ).toThrow('1..20');
  });

  it('拒绝：plotline 条目字段不符 / 内容越界', () => {
    expect(() => parseBlueprintGenerateV1(valid({ plotlines: [{ name: 'x' }] }))).toThrow(
      '字段不符',
    );
    expect(() =>
      parseBlueprintGenerateV1(valid({ plotlines: [{ name: '', summary: 's' }] })),
    ).toThrow('越界或为空');
  });

  it('拒绝：chapters 数量越界（0 章或 >200）', () => {
    expect(() => parseBlueprintGenerateV1(valid({ chapters: [] }))).toThrow('1..200');
    expect(() =>
      parseBlueprintGenerateV1(valid({ chapters: Array.from({ length: 201 }, () => CHAPTER) })),
    ).toThrow('1..200');
  });

  it('拒绝：chapter 条目字段不符 / goal 超过 500 字', () => {
    expect(() => parseBlueprintGenerateV1(valid({ chapters: [{ title: 't' }] }))).toThrow(
      '字段不符',
    );
    expect(() =>
      parseBlueprintGenerateV1(valid({ chapters: [{ title: 't', goal: 'g'.repeat(501) }] })),
    ).toThrow('越界或为空');
  });
});

describe('prompt 构造', () => {
  it('系统提示声明顶层结构与字段边界', () => {
    expect(BLUEPRINT_GENERATE_SYSTEM_PROMPT).toContain('schemaVersion');
    expect(BLUEPRINT_GENERATE_SYSTEM_PROMPT).toContain('chapters');
  });

  it('用户消息为确定性序列化（同输入同输出）', () => {
    const ctx = {
      idea: '晚清侦探故事',
      creationSpecSummary: { premise: 'p' },
      research: null,
      rewriteAttempt: 0,
    };
    expect(buildBlueprintGeneratePrompt(ctx)).toBe(buildBlueprintGeneratePrompt(ctx));
    expect(buildBlueprintGeneratePrompt(ctx)).toContain('晚清侦探故事');
  });

  it('D-B7-7：无调研时显式标注 conducted=false，不伪装成空调研', () => {
    const prompt = buildBlueprintGeneratePrompt({
      idea: 'x',
      creationSpecSummary: {},
      research: null,
      rewriteAttempt: 0,
    });
    expect(prompt).toContain('"conducted":false');
  });

  it('有调研时携带结论与事实笔记', () => {
    const prompt = buildBlueprintGeneratePrompt({
      idea: 'x',
      creationSpecSummary: {},
      research: { conclusion: '结论文本', factNotes: ['事实一'] },
      rewriteAttempt: 0,
    });
    expect(prompt).toContain('"conducted":true');
    expect(prompt).toContain('结论文本');
    expect(prompt).toContain('事实一');
  });

  it('rewriteAttempt > 0 时提示"第 N 次改写"', () => {
    const prompt = buildBlueprintGeneratePrompt({
      idea: 'x',
      creationSpecSummary: {},
      research: null,
      rewriteAttempt: 2,
    });
    expect(prompt).toContain('第 2 次改写');
  });
});
