/**
 * parseBlueprintGenerateV1 严格解析单元测试（B7，D-B7-6：解析边界覆盖）。
 * 执行链路（claim/envelope/补偿/原子性/失效拒绝）由
 * apps/worker/src/blueprint-e2e.integration.test.ts 覆盖。
 */

import { describe, it, expect } from 'vitest';
import {
  parseBlueprintGenerateV1,
  buildBlueprintGeneratePrompt,
  filterResearchForPrompt,
  classifyResearchInput,
  assertBlueprintDomainInvariants,
  BLUEPRINT_GENERATE_SYSTEM_PROMPT,
  type BlueprintResearchInput,
  type ParsedBlueprintGenerate,
} from './blueprint-generate.js';
import { TaskExecutionError } from './index.js';
import type { ResearchBundle } from '@ai-novel/research-engine';

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

  const NOT_CONDUCTED: BlueprintResearchInput = { status: 'not_conducted' };
  const ALL_EXCLUDED: BlueprintResearchInput = { status: 'all_excluded' };

  it('用户消息为确定性序列化（同输入同输出）', () => {
    const ctx = {
      idea: '晚清侦探故事',
      creationSpecSummary: { premise: 'p' },
      research: NOT_CONDUCTED,
      rewriteAttempt: 0,
    };
    expect(buildBlueprintGeneratePrompt(ctx)).toBe(buildBlueprintGeneratePrompt(ctx));
    expect(buildBlueprintGeneratePrompt(ctx)).toContain('晚清侦探故事');
  });

  it('D-B7-7：无调研时显式标注 conducted=false，不伪装成空调研', () => {
    const prompt = buildBlueprintGeneratePrompt({
      idea: 'x',
      creationSpecSummary: {},
      research: NOT_CONDUCTED,
      rewriteAttempt: 0,
    });
    expect(prompt).toContain('"conducted":false');
  });

  it('有调研时携带结论、事实笔记与问题来源', () => {
    const prompt = buildBlueprintGeneratePrompt({
      idea: 'x',
      creationSpecSummary: {},
      research: {
        status: 'available',
        context: {
          conclusion: '结论文本',
          factNotes: [{ text: '事实一', sourceUrls: ['https://a.example/1'] }],
          questions: [{ text: '问题一', sources: [{ url: 'https://a.example/1', title: 't' }] }],
        },
      },
      rewriteAttempt: 0,
    });
    expect(prompt).toContain('"conducted":true');
    expect(prompt).toContain('"availableAfterExclusion":true');
    expect(prompt).toContain('结论文本');
    expect(prompt).toContain('事实一');
    expect(prompt).toContain('https://a.example/1');
  });

  it('D-B7-13：全部来源被排除时标注 availableAfterExclusion=false + reason=all_sources_excluded，与未做调研措辞区分', () => {
    const prompt = buildBlueprintGeneratePrompt({
      idea: 'x',
      creationSpecSummary: {},
      research: ALL_EXCLUDED,
      rewriteAttempt: 0,
    });
    expect(prompt).toContain('"conducted":true');
    expect(prompt).toContain('"availableAfterExclusion":false');
    expect(prompt).toContain('"reason":"all_sources_excluded"');
    // 与"未做调研"的措辞可区分：conducted 值不同
    const notConductedPrompt = buildBlueprintGeneratePrompt({
      idea: 'x',
      creationSpecSummary: {},
      research: NOT_CONDUCTED,
      rewriteAttempt: 0,
    });
    expect(prompt).not.toBe(notConductedPrompt);
  });

  it('BLK-2 附带修复：调研执行过但一无所获（未获得任何来源，与排除无关）标注 reason=no_sources_gathered，不冒充"用户排除"', () => {
    const NO_SOURCES: BlueprintResearchInput = { status: 'no_sources_gathered' };
    const prompt = buildBlueprintGeneratePrompt({
      idea: 'x',
      creationSpecSummary: {},
      research: NO_SOURCES,
      rewriteAttempt: 0,
    });
    expect(prompt).toContain('"conducted":true');
    expect(prompt).toContain('"availableAfterExclusion":false');
    expect(prompt).toContain('"reason":"no_sources_gathered"');
    // 与"用户排除"态的措辞可区分：reason 值不同，两者不能是同一句话
    const allExcludedPrompt = buildBlueprintGeneratePrompt({
      idea: 'x',
      creationSpecSummary: {},
      research: ALL_EXCLUDED,
      rewriteAttempt: 0,
    });
    expect(prompt).not.toBe(allExcludedPrompt);
  });

  it('rewriteAttempt > 0 时提示"第 N 次改写"', () => {
    const prompt = buildBlueprintGeneratePrompt({
      idea: 'x',
      creationSpecSummary: {},
      research: NOT_CONDUCTED,
      rewriteAttempt: 2,
    });
    expect(prompt).toContain('第 2 次改写');
  });
});

describe('filterResearchForPrompt（D-B7-13/BLK-1：来源排除消费点，整条剔除语义）', () => {
  // 关键：text 必须是可辨识的正文片段（而非 fn-xxx 这种标签），否则测不出"正文泄漏"
  // 这类 bug——旧实现只按 URL 裁剪 sourceUrls、text 原样透传，若 text 只是标签，
  // 断言"正文不出现"会因为标签碰巧没提到 URL 而自然通过，测不出真实缺陷。
  const ALL_EXCLUDED_TEXT =
    '据 https://ex.com/a 记载，光绪三十年冬季邮路因战事一度中断，史料仅此一处提及。';
  const PARTIAL_TEXT =
    '综合 https://ex.com/b 与 https://keep.com/c 两处记载，晚清邮政系统当年已覆盖沿海口岸，' +
    '设有专门的驿传班次。';
  const CLEAN_TEXT = '据 https://keep.com/d 记载，租界巡捕房档案完整保存至今，可查证具体案由。';

  function bundle(): Pick<ResearchBundle, 'conclusion' | 'factNotes' | 'questions'> {
    return {
      conclusion: '总体结论',
      factNotes: [
        { id: 'fn-all-excluded', text: ALL_EXCLUDED_TEXT, sourceUrls: ['https://ex.com/a'] },
        {
          id: 'fn-partial',
          text: PARTIAL_TEXT,
          sourceUrls: ['https://ex.com/b', 'https://keep.com/c'],
        },
        { id: 'fn-clean', text: CLEAN_TEXT, sourceUrls: ['https://keep.com/d'] },
      ],
      questions: [
        {
          id: 'q1',
          text: '问题一',
          sources: [
            { url: 'https://ex.com/a', title: 'A', fetchedAt: 'x', excerpt: '' },
            { url: 'https://keep.com/d', title: 'D', fetchedAt: 'x', excerpt: '' },
          ],
        },
        {
          id: 'q2',
          text: '问题二（来源将被全部排除）',
          sources: [{ url: 'https://ex.com/a', title: 'A', fetchedAt: 'x', excerpt: '' }],
        },
      ],
    };
  }

  const EXCLUDED = new Set(['https://ex.com/a', 'https://ex.com/b']);

  it('任一来源被排除即整条笔记剔除（含未被排除来源的正文内容）；未涉及排除来源的笔记完整保留', () => {
    const result = filterResearchForPrompt(bundle(), EXCLUDED);
    expect(result).not.toBeNull();
    const notes = result!.factNotes;
    // fn-all-excluded（单一来源被排除）与 fn-partial（两个来源之一被排除）都整条消失，
    // 只剩 fn-clean（完全未涉及排除来源）。
    expect(notes.map((n) => n.text)).toEqual([CLEAN_TEXT]);
    expect(notes.find((n) => n.text === CLEAN_TEXT)!.sourceUrls).toEqual(['https://keep.com/d']);
  });

  it('核心断言：被排除来源所在笔记的正文内容完全不出现——即使该笔记里还聚合了未被排除来源的内容', () => {
    const result = filterResearchForPrompt(bundle(), EXCLUDED);
    const allText = result!.factNotes.map((n) => n.text).join('\n');
    // fn-partial 整条被剔除，即便它同时聚合了未被排除来源 keep.com/c 的内容——
    // 因为 factNote.text 是多来源正文的聚合，无法按来源拆分（BLK-1 核心断言）。
    expect(allText).not.toContain('晚清邮政系统当年已覆盖沿海口岸');
    expect(allText).not.toContain('光绪三十年冬季邮路因战事一度中断');
    // 幸存笔记的正文应当完整保留
    expect(allText).toContain('租界巡捕房档案完整保存至今');
  });

  it('被排除的 URL 不出现在任何保留笔记的 sourceUrls 里', () => {
    const result = filterResearchForPrompt(bundle(), EXCLUDED);
    const allUrls = result!.factNotes.flatMap((n) => n.sourceUrls);
    expect(allUrls).not.toContain('https://ex.com/a');
    expect(allUrls).not.toContain('https://ex.com/b');
    // fn-partial 整条剔除，连它带着的未排除来源 keep.com/c 也一并从 prompt 视野中消失
    // （这是"聚合体不可拆分"语义下的代价，见函数注释）。
    expect(allUrls).not.toContain('https://keep.com/c');
  });

  it('questions[].sources 仍按来源逐条过滤（question 无聚合正文问题，不受整条剔除规则约束）；变空的问题本身保留（sources: []）', () => {
    const result = filterResearchForPrompt(bundle(), EXCLUDED);
    const questions = result!.questions;
    expect(questions).toHaveLength(2);
    const q1 = questions.find((q) => q.text === '问题一')!;
    expect(q1.sources.map((s) => s.url)).toEqual(['https://keep.com/d']);
    const q2 = questions.find((q) => q.text.startsWith('问题二'))!;
    expect(q2.sources).toEqual([]);
  });

  it('全部笔记都因排除而整条消失 → 返回 null（走无可用资料分支）', () => {
    const onlyExcludedBundle: Pick<ResearchBundle, 'conclusion' | 'factNotes' | 'questions'> = {
      conclusion: 'c',
      factNotes: [
        { id: 'fn-1', text: '据 https://ex.com/a 记载……', sourceUrls: ['https://ex.com/a'] },
      ],
      questions: [],
    };
    const result = filterResearchForPrompt(onlyExcludedBundle, new Set(['https://ex.com/a']));
    expect(result).toBeNull();
  });

  it('无任何排除时原样保留全部笔记与来源', () => {
    const result = filterResearchForPrompt(bundle(), new Set());
    expect(result!.factNotes).toHaveLength(3);
    expect(result!.questions.every((q) => q.sources.length > 0)).toBe(true);
  });
});

describe('classifyResearchInput（BLK-2 附带修复：四态归类，not_conducted/no_sources_gathered/all_excluded/available）', () => {
  it('bundle 为 null → not_conducted（根本没做调研）', () => {
    expect(classifyResearchInput(null, new Set())).toEqual({ status: 'not_conducted' });
  });

  it('bundle 存在但一条事实笔记都没有（抓取全失败）→ no_sources_gathered，即使没有任何排除', () => {
    const emptyBundle: Pick<ResearchBundle, 'conclusion' | 'factNotes' | 'questions'> = {
      conclusion: '未获得可用来源',
      factNotes: [],
      questions: [{ id: 'q1', text: '问题一', sources: [] }],
    };
    // 核心断言：没有任何人排除任何来源（空 Set），也不能得出 all_excluded
    expect(classifyResearchInput(emptyBundle, new Set())).toEqual({
      status: 'no_sources_gathered',
    });
  });

  it('bundle 原本有事实笔记，因排除操作被清空 → all_excluded（与上一条区分开）', () => {
    const bundleWithNotes: Pick<ResearchBundle, 'conclusion' | 'factNotes' | 'questions'> = {
      conclusion: 'c',
      factNotes: [
        { id: 'fn-1', text: '据 https://ex.com/a 记载……', sourceUrls: ['https://ex.com/a'] },
      ],
      questions: [],
    };
    expect(classifyResearchInput(bundleWithNotes, new Set(['https://ex.com/a']))).toEqual({
      status: 'all_excluded',
    });
  });

  it('bundle 有可用事实笔记 → available，携带过滤后的 context', () => {
    const bundleWithNotes: Pick<ResearchBundle, 'conclusion' | 'factNotes' | 'questions'> = {
      conclusion: 'c',
      factNotes: [
        { id: 'fn-1', text: '据 https://keep.com/a 记载……', sourceUrls: ['https://keep.com/a'] },
      ],
      questions: [],
    };
    const result = classifyResearchInput(bundleWithNotes, new Set());
    expect(result.status).toBe('available');
  });
});

describe('assertBlueprintDomainInvariants（复查随行修复 note 2：域校验失败应映射为 MODEL_RESPONSE_INVALID）', () => {
  function validParsed(overrides: Partial<ParsedBlueprintGenerate> = {}): ParsedBlueprintGenerate {
    return {
      premise: '侦探在雨夜调查悬案',
      characters: [CHARACTER],
      relationships: ['侦探——委托人'],
      world: '晚清上海滩',
      conflict: '真相被掩盖',
      ending: '真相大白',
      plotlines: [PLOTLINE],
      chapters: [CHAPTER],
      ...overrides,
    };
  }

  it('合法内容不抛错', () => {
    expect(() =>
      assertBlueprintDomainInvariants(validParsed(), '2026-08-11T00:00:00.000Z'),
    ).not.toThrow();
  });

  // 注：parseBlueprintGenerateV1 对 premise/world/chapters 等内容字段的边界校验已经
  // 等于或严于 createStoryBlueprint 的对应检查，因此经由 parse 产出的合法 ParsedBlueprintGenerate
  // 不可能触发这里的失败——这是本函数在生产路径里事实上不可达的原因。以下用例绕开
  // parse、直接手工构造违反域不变量的输入（真实场景不可能出现，但用于锁定"一旦触发，
  // 错误码必须是 MODEL_RESPONSE_INVALID 而不是 TASK_EXECUTION_FAILED"这一契约，
  // 防止未来域校验规则变严格于 parse 边界时错误码悄悄跑偏）。
  it('chapters 为空数组（违反域不变量）→ 抛 TaskExecutionError(MODEL_RESPONSE_INVALID)', () => {
    const invalid = validParsed({ chapters: [] });
    expect(() => assertBlueprintDomainInvariants(invalid, '2026-08-11T00:00:00.000Z')).toThrow(
      TaskExecutionError,
    );
    try {
      assertBlueprintDomainInvariants(invalid, '2026-08-11T00:00:00.000Z');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TaskExecutionError);
      expect((err as TaskExecutionError).code).toBe('MODEL_RESPONSE_INVALID');
    }
  });

  it('premise 为空白（违反域不变量）→ 抛 TaskExecutionError(MODEL_RESPONSE_INVALID)', () => {
    const invalid = validParsed({ premise: '   ' });
    try {
      assertBlueprintDomainInvariants(invalid, '2026-08-11T00:00:00.000Z');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TaskExecutionError);
      expect((err as TaskExecutionError).code).toBe('MODEL_RESPONSE_INVALID');
    }
  });
});
