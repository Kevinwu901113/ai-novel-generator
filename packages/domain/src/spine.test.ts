/**
 * @ai-novel/domain - Idea-to-Novel 可执行主链 Spine Domain tests
 *
 * 覆盖 STATE_A 契约冻结的领域规则：
 * - WorkflowStage 闭合枚举；
 * - ResearchMode / ResearchBundleStatus / GenerationRunStatus /
 *   GenerationStage / GenerationSourceType / BlueprintCharacterRole 闭合枚举；
 * - branded ID 工厂（空 / 空白 / 超长拒绝）；
 * - ResearchBundle / StoryBlueprint / GenerationRun 严格解析：
 *   exact keys（unknown 拒绝）、非法 ID、非法 URL、过长字符串、错误枚举、
 *   嵌套 source/note/chapter 校验。
 */

import { describe, it, expect } from 'vitest';
import {
  isValidWorkflowStage,
  parseWorkflowStage,
  isValidResearchMode,
  isValidResearchBundleStatus,
  isValidGenerationRunStatus,
  isValidGenerationStage,
  isValidGenerationSourceType,
  isValidBlueprintCharacterRole,
  createResearchBundleId,
  createStoryBlueprintId,
  createGenerationRunId,
  parseResearchBundle,
  parseStoryBlueprint,
  parseGenerationRun,
  parseResearchSource,
  parseBlueprintChapter,
  parseGenerationRunResult,
  SPINE_ID_MAX_LENGTH,
  SPINE_TITLE_MAX_LENGTH,
  SPINE_BODY_MAX_LENGTH,
  SPINE_URL_MAX_LENGTH,
} from './spine.js';

const TS = '2026-08-03T00:00:00.000Z';

const validResearchBundle = {
  id: 'rb-1',
  projectId: 'proj-1',
  creationSpecVersionId: 'spec-1',
  mode: 'LIGHT',
  status: 'READY',
  questions: [{ id: 'q1', text: '作品时代背景？' }],
  sources: [
    {
      id: 's1',
      url: 'https://example.com/article',
      canonicalUrl: 'https://example.com/article',
      title: '示例来源',
      fetchedAt: TS,
    },
  ],
  notes: [{ id: 'n1', text: '事实笔记', sourceIds: ['s1'] }],
  createdAt: TS,
  updatedAt: TS,
  finalizedAt: null,
};

const validStoryBlueprint = {
  id: 'bp-1',
  projectId: 'proj-1',
  creationSpecVersionId: 'spec-1',
  researchBundleId: 'rb-1',
  version: 1,
  premise: '一个失忆侦探调查一桩没有受害者的案件。',
  characters: [{ id: 'c1', name: '沈墨', role: 'PROTAGONIST', summary: '失忆侦探' }],
  world: '近未来滨海城市。',
  conflicts: ['真相与信任'],
  plotLines: [{ id: 'p1', title: '主线', summary: '案件推进' }],
  endingDirection: '真相揭晓',
  chapters: [
    { chapterId: 'ch1', order: 1, title: '第一章', goal: '引入案件', summary: '主角接到委托。' },
  ],
  createdAt: TS,
};

const validGenerationRun = {
  id: 'gr-1',
  projectId: 'proj-1',
  storyBlueprintId: 'bp-1',
  target: { blueprintChapterId: 'ch1', title: '第一章' },
  status: 'SUCCEEDED',
  stage: 'COMPLETE',
  progress: 1,
  result: {
    proposedTitle: '第一章',
    proposedContent: '正文内容……',
    sourceType: 'AI_GENERATION',
    committed: false,
    manuscriptId: null,
    chapterId: null,
    chapterVersionId: null,
  },
  error: null,
  createdAt: TS,
  startedAt: TS,
  completedAt: TS,
};

describe('WorkflowStage 闭合枚举', () => {
  it('接受全部合法阶段', () => {
    for (const stage of ['IDEA', 'RESEARCH', 'BLUEPRINT', 'GENERATION', 'MANUSCRIPT']) {
      expect(isValidWorkflowStage(stage)).toBe(true);
      expect(parseWorkflowStage(stage)).toBe(stage);
    }
  });

  it('拒绝非法阶段与非字符串', () => {
    expect(isValidWorkflowStage('PLANNING')).toBe(false);
    expect(isValidWorkflowStage('idea')).toBe(false);
    expect(isValidWorkflowStage('')).toBe(false);
    expect(isValidWorkflowStage(1)).toBe(false);
    expect(isValidWorkflowStage(null)).toBe(false);
    expect(() => parseWorkflowStage('PLANNING')).toThrow();
  });

  it('与 TaskStatus / ProjectStatus 语义独立（值不同）', () => {
    // WorkflowStage 不包含任务/项目状态的任何值
    for (const v of ['PENDING', 'RUNNING', 'SUCCEEDED', 'grill-me', 'drafting', 'completed']) {
      expect(isValidWorkflowStage(v)).toBe(false);
    }
  });
});

describe('其他闭合枚举', () => {
  it('ResearchMode / ResearchBundleStatus', () => {
    expect(isValidResearchMode('NONE')).toBe(true);
    expect(isValidResearchMode('LIGHT')).toBe(true);
    expect(isValidResearchMode('DEEP')).toBe(true);
    expect(isValidResearchMode('HEAVY')).toBe(false);
    expect(isValidResearchBundleStatus('IN_PROGRESS')).toBe(true);
    expect(isValidResearchBundleStatus('READY')).toBe(true);
    expect(isValidResearchBundleStatus('FINALIZED')).toBe(true);
    expect(isValidResearchBundleStatus('DONE')).toBe(false);
  });

  it('GenerationRunStatus / GenerationStage / GenerationSourceType', () => {
    expect(isValidGenerationRunStatus('PENDING')).toBe(true);
    expect(isValidGenerationRunStatus('RUNNING')).toBe(true);
    expect(isValidGenerationRunStatus('SUCCEEDED')).toBe(true);
    expect(isValidGenerationRunStatus('FAILED')).toBe(true);
    expect(isValidGenerationRunStatus('CANCELLED')).toBe(true);
    expect(isValidGenerationRunStatus('COMPLETED')).toBe(false);
    expect(isValidGenerationRunStatus('STALE')).toBe(false);

    expect(isValidGenerationStage('IDLE')).toBe(true);
    expect(isValidGenerationStage('SCENE_PLAN')).toBe(true);
    expect(isValidGenerationStage('DRAFTING')).toBe(true);
    expect(isValidGenerationStage('ASSEMBLING')).toBe(true);
    expect(isValidGenerationStage('CHECKING')).toBe(true);
    expect(isValidGenerationStage('REVISING')).toBe(true);
    expect(isValidGenerationStage('COMMITTING')).toBe(true);
    expect(isValidGenerationStage('COMPLETE')).toBe(true);
    expect(isValidGenerationStage('PLANNING')).toBe(false);

    expect(isValidGenerationSourceType('AI_GENERATION')).toBe(true);
    expect(isValidGenerationSourceType('AI_REWRITE')).toBe(true);
    expect(isValidGenerationSourceType('USER')).toBe(false);
  });

  it('BlueprintCharacterRole', () => {
    expect(isValidBlueprintCharacterRole('PROTAGONIST')).toBe(true);
    expect(isValidBlueprintCharacterRole('SUPPORTING')).toBe(true);
    expect(isValidBlueprintCharacterRole('ANTAGONIST')).toBe(true);
    expect(isValidBlueprintCharacterRole('OTHER')).toBe(true);
    expect(isValidBlueprintCharacterRole('HOST')).toBe(false);
  });
});

describe('branded ID 工厂', () => {
  it('合法 ID 创建成功', () => {
    expect(createResearchBundleId('rb-1')).toBe('rb-1');
    expect(createStoryBlueprintId('bp-1')).toBe('bp-1');
    expect(createGenerationRunId('gr-1')).toBe('gr-1');
  });

  it('空 / 空白 / 超长 ID 被拒', () => {
    expect(() => createResearchBundleId('')).toThrow();
    expect(() => createResearchBundleId('   ')).toThrow();
    expect(() => createResearchBundleId('x'.repeat(SPINE_ID_MAX_LENGTH + 1))).toThrow();
    expect(() => createStoryBlueprintId('  bp-1  ')).toThrow();
    expect(() => createGenerationRunId(123 as unknown as string)).toThrow();
  });
});

describe('parseResearchBundle', () => {
  it('合法对象解析成功', () => {
    const bundle = parseResearchBundle(validResearchBundle);
    expect(bundle.id).toBe('rb-1');
    expect(bundle.creationSpecVersionId).toBe('spec-1');
    expect(bundle.sources[0].url).toBe('https://example.com/article');
    expect(bundle.notes[0].sourceIds).toEqual(['s1']);
  });

  it('unknown field 拒绝', () => {
    expect(() => parseResearchBundle({ ...validResearchBundle, extra: 1 })).toThrow();
  });

  it('missing field 拒绝', () => {
    const { finalizedAt: _finalizedAt, ...missing } = validResearchBundle;
    void _finalizedAt;
    expect(() => parseResearchBundle(missing)).toThrow();
  });

  it('错误枚举拒绝', () => {
    expect(() => parseResearchBundle({ ...validResearchBundle, mode: 'HEAVY' })).toThrow();
    expect(() => parseResearchBundle({ ...validResearchBundle, status: 'DONE' })).toThrow();
  });

  it('非法 ID 拒绝', () => {
    expect(() => parseResearchBundle({ ...validResearchBundle, projectId: '  ' })).toThrow();
    expect(() =>
      parseResearchBundle({
        ...validResearchBundle,
        projectId: 'p'.repeat(SPINE_ID_MAX_LENGTH + 1),
      }),
    ).toThrow();
  });

  it('非法 URL 拒绝', () => {
    expect(() =>
      parseResearchBundle({
        ...validResearchBundle,
        sources: [{ ...validResearchBundle.sources[0], url: 'ftp://example.com/x' }],
      }),
    ).toThrow();
  });

  it('过长字符串拒绝', () => {
    expect(() =>
      parseResearchBundle({
        ...validResearchBundle,
        notes: [{ ...validResearchBundle.notes[0], text: 'x'.repeat(SPINE_BODY_MAX_LENGTH + 1) }],
      }),
    ).toThrow();
    expect(() =>
      parseResearchBundle({
        ...validResearchBundle,
        sources: [
          { ...validResearchBundle.sources[0], title: 'x'.repeat(SPINE_TITLE_MAX_LENGTH + 1) },
        ],
      }),
    ).toThrow();
  });

  it('嵌套 source / note 校验', () => {
    expect(() =>
      parseResearchBundle({
        ...validResearchBundle,
        notes: [{ ...validResearchBundle.notes[0], sourceIds: [''] }],
      }),
    ).toThrow();
    expect(() =>
      parseResearchBundle({
        ...validResearchBundle,
        sources: [{ ...validResearchBundle.sources[0], unknown: 1 }],
      }),
    ).toThrow();
    expect(() =>
      parseResearchBundle({
        ...validResearchBundle,
        sources: [{ ...validResearchBundle.sources[0], fetchedAt: '' }],
      }),
    ).toThrow();
  });

  it('finalizedAt 必须显式为 null 或时间戳（不允许缺省）', () => {
    expect(parseResearchBundle({ ...validResearchBundle, finalizedAt: TS }).finalizedAt).toBe(TS);
    const { finalizedAt: _f, ...noFinalizedAt } = validResearchBundle;
    void _f;
    expect(() => parseResearchBundle(noFinalizedAt)).toThrow();
  });
});

describe('parseStoryBlueprint', () => {
  it('合法对象解析成功', () => {
    const blueprint = parseStoryBlueprint(validStoryBlueprint);
    expect(blueprint.version).toBe(1);
    expect(blueprint.characters[0].role).toBe('PROTAGONIST');
    expect(blueprint.chapters[0].order).toBe(1);
  });

  it('unknown / missing field 拒绝', () => {
    expect(() => parseStoryBlueprint({ ...validStoryBlueprint, extra: 1 })).toThrow();
    const { chapters: _chapters, ...missing } = validStoryBlueprint;
    void _chapters;
    expect(() => parseStoryBlueprint(missing)).toThrow();
  });

  it('version / order 必须为正安全整数', () => {
    expect(() => parseStoryBlueprint({ ...validStoryBlueprint, version: 0 })).toThrow();
    expect(() => parseStoryBlueprint({ ...validStoryBlueprint, version: 1.5 })).toThrow();
    expect(() => parseStoryBlueprint({ ...validStoryBlueprint, version: Number.NaN })).toThrow();
    expect(() =>
      parseStoryBlueprint({
        ...validStoryBlueprint,
        chapters: [{ ...validStoryBlueprint.chapters[0], order: 0 }],
      }),
    ).toThrow();
  });

  it('人物角色闭合枚举', () => {
    expect(() =>
      parseStoryBlueprint({
        ...validStoryBlueprint,
        characters: [{ ...validStoryBlueprint.characters[0], role: 'HOST' }],
      }),
    ).toThrow();
  });

  it('嵌套 chapter 校验（unknown / 非法字段）', () => {
    expect(() =>
      parseStoryBlueprint({
        ...validStoryBlueprint,
        chapters: [{ ...validStoryBlueprint.chapters[0], extra: 1 }],
      }),
    ).toThrow();
    expect(() =>
      parseStoryBlueprint({
        ...validStoryBlueprint,
        chapters: [{ ...validStoryBlueprint.chapters[0], title: '' }],
      }),
    ).toThrow();
  });

  it('conflicts 字符串列表元素必须非空且 ≤ 标题长度', () => {
    expect(() => parseStoryBlueprint({ ...validStoryBlueprint, conflicts: [''] })).toThrow();
    expect(() =>
      parseStoryBlueprint({
        ...validStoryBlueprint,
        conflicts: ['x'.repeat(SPINE_TITLE_MAX_LENGTH + 1)],
      }),
    ).toThrow();
  });
});

describe('parseGenerationRun', () => {
  it('合法完成态对象解析成功', () => {
    const run = parseGenerationRun(validGenerationRun);
    expect(run.status).toBe('SUCCEEDED');
    expect(run.stage).toBe('COMPLETE');
    expect(run.progress).toBe(1);
    expect(run.result?.committed).toBe(false);
    expect(run.result?.manuscriptId).toBeNull();
  });

  it('合法未开始态（result=null）解析成功', () => {
    const run = parseGenerationRun({
      ...validGenerationRun,
      status: 'PENDING',
      stage: 'IDLE',
      progress: 0,
      result: null,
      error: null,
      startedAt: null,
      completedAt: null,
    });
    expect(run.result).toBeNull();
    expect(run.error).toBeNull();
  });

  it('unknown / missing field 拒绝', () => {
    expect(() => parseGenerationRun({ ...validGenerationRun, extra: 1 })).toThrow();
    const { target: _target, ...missing } = validGenerationRun;
    void _target;
    expect(() => parseGenerationRun(missing)).toThrow();
  });

  it('status / stage / sourceType 错误枚举拒绝', () => {
    expect(() => parseGenerationRun({ ...validGenerationRun, status: 'COMPLETED' })).toThrow();
    expect(() => parseGenerationRun({ ...validGenerationRun, stage: 'PLANNING' })).toThrow();
    expect(() =>
      parseGenerationRun({
        ...validGenerationRun,
        result: { ...validGenerationRun.result, sourceType: 'USER' },
      }),
    ).toThrow();
  });

  it('progress 必须为 0..1 有限数字', () => {
    expect(() => parseGenerationRun({ ...validGenerationRun, progress: -0.1 })).toThrow();
    expect(() => parseGenerationRun({ ...validGenerationRun, progress: 1.1 })).toThrow();
    expect(() => parseGenerationRun({ ...validGenerationRun, progress: Number.NaN })).toThrow();
    expect(() => parseGenerationRun({ ...validGenerationRun, progress: '1' })).toThrow();
  });

  it('result 嵌套校验（proposedTitle / proposedContent / committed / 目标 id）', () => {
    expect(() =>
      parseGenerationRun({
        ...validGenerationRun,
        result: { ...validGenerationRun.result, proposedTitle: '' },
      }),
    ).toThrow();
    expect(() =>
      parseGenerationRun({
        ...validGenerationRun,
        result: { ...validGenerationRun.result, proposedContent: '' },
      }),
    ).toThrow();
    expect(() =>
      parseGenerationRun({
        ...validGenerationRun,
        result: { ...validGenerationRun.result, committed: 'yes' },
      }),
    ).toThrow();
    expect(() =>
      parseGenerationRun({
        ...validGenerationRun,
        result: { ...validGenerationRun.result, manuscriptId: ' ' },
      }),
    ).toThrow();
  });

  it('result 缺失字段拒绝', () => {
    const { proposedTitle: _pt, ...missingResult } = validGenerationRun.result;
    void _pt;
    expect(() => parseGenerationRun({ ...validGenerationRun, result: missingResult })).toThrow();
  });
});

describe('parseResearchSource（URL 严格校验）', () => {
  it('接受合法 http / https URL', () => {
    expect(
      parseResearchSource({
        id: 's1',
        url: 'https://example.com/a',
        canonicalUrl: 'http://example.com/a',
        title: 't',
        fetchedAt: TS,
      }).url,
    ).toBe('https://example.com/a');
  });

  it('拒绝非 http(s) 协议', () => {
    for (const bad of ['ftp://example.com/a', 'file:///etc/passwd', 'javascript:alert(1)']) {
      expect(() =>
        parseResearchSource({
          id: 's1',
          url: bad,
          canonicalUrl: 'https://example.com/a',
          title: 't',
          fetchedAt: TS,
        }),
      ).toThrow();
    }
  });

  it('拒绝 URL credentials', () => {
    expect(() =>
      parseResearchSource({
        id: 's1',
        url: 'https://user:pass@example.com/a',
        canonicalUrl: 'https://example.com/a',
        title: 't',
        fetchedAt: TS,
      }),
    ).toThrow();
  });

  it('拒绝空白字符（首尾与内部）', () => {
    expect(() =>
      parseResearchSource({
        id: 's1',
        url: ' https://example.com/a',
        canonicalUrl: 'https://example.com/a',
        title: 't',
        fetchedAt: TS,
      }),
    ).toThrow();
    expect(() =>
      parseResearchSource({
        id: 's1',
        url: 'https://exa mple.com/a',
        canonicalUrl: 'https://example.com/a',
        title: 't',
        fetchedAt: TS,
      }),
    ).toThrow();
  });

  it('拒绝缺少 host 与非法端口', () => {
    for (const bad of [
      'https://',
      'https:///a',
      'https://example.com:abc/a',
      'https://example.com:',
    ]) {
      expect(() =>
        parseResearchSource({
          id: 's1',
          url: bad,
          canonicalUrl: 'https://example.com/a',
          title: 't',
          fetchedAt: TS,
        }),
      ).toThrow();
    }
  });

  it('拒绝超长 URL', () => {
    expect(() =>
      parseResearchSource({
        id: 's1',
        url: `https://example.com/${'a'.repeat(SPINE_URL_MAX_LENGTH)}`,
        canonicalUrl: 'https://example.com/a',
        title: 't',
        fetchedAt: TS,
      }),
    ).toThrow();
  });
});

describe('嵌套解析函数', () => {
  it('parseBlueprintChapter', () => {
    expect(
      parseBlueprintChapter({
        chapterId: 'ch1',
        order: 1,
        title: '第一章',
        goal: 'g',
        summary: 's',
      }).chapterId,
    ).toBe('ch1');
    expect(() =>
      parseBlueprintChapter({ chapterId: 'ch1', order: 1, title: '', goal: 'g', summary: 's' }),
    ).toThrow();
  });

  it('parseGenerationRunResult', () => {
    expect(parseGenerationRunResult(validGenerationRun.result).proposedTitle).toBe('第一章');
    expect(() =>
      parseGenerationRunResult({
        ...validGenerationRun.result,
        chapterId: null,
        manuscriptId: 'm1',
      }),
    ).not.toThrow();
    expect(() => parseGenerationRunResult(null as unknown as Record<string, unknown>)).toThrow();
  });
});
