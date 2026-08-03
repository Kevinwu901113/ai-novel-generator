/**
 * @ai-novel/contracts - Idea-to-Novel 可执行主链 Spine Contracts tests
 *
 * 覆盖 STATE_A 契约冻结的 Renderer 面：
 * - 闭合枚举 value guards；
 * - ResearchBundle / StoryBlueprint / GenerationRun Public DTO 严格校验
 *   （unknown field 拒绝、嵌套 source/note/chapter 校验、URL/枚举/长度）；
 * - 7 个 Input DTO 严格校验（exact keys、ID、mode、prototype 注入拒绝）；
 * - CreationSpecSnapshotDTO 复用现有 Creation Contract snapshot 校验器；
 * - DesktopAPI 命名空间 type parity 与 IPC 通道完整。
 */

import { describe, it, expect } from 'vitest';
import {
  IPC_CHANNELS,
  isWorkflowStageValue,
  isResearchModeValue,
  isResearchBundleStatusValue,
  isGenerationRunStatusValue,
  isGenerationStageValue,
  isGenerationSourceTypeValue,
  isBlueprintCharacterRoleValue,
  isValidResearchBundlePublicData,
  isValidStoryBlueprintPublicData,
  isValidGenerationRunPublicData,
  isValidResearchSourcePublicData,
  isValidBlueprintChapterPublicData,
  isValidGetCurrentWorkflowInput,
  isValidGetCurrentResearchBundleInput,
  isValidStartResearchInput,
  isValidGetCurrentStoryBlueprintInput,
  isValidGenerateStoryBlueprintInput,
  isValidGetCurrentGenerationRunInput,
  isValidStartGenerationInput,
  isValidCreationSpecSnapshotDTO,
  type DesktopAPI,
  type SpineAPI,
  type ContractVersionPublicData,
  type WorkflowAPI,
  type ResearchAPI,
  type BlueprintAPI,
  type GenerationAPI,
  type ResearchBundlePublicData,
  type StoryBlueprintPublicData,
  type GenerationRunPublicData,
  type GetCurrentWorkflowInput,
  type StartResearchInput,
  type GenerateStoryBlueprintInput,
  type StartGenerationInput,
} from './index.js';

const TS = '2026-08-03T00:00:00.000Z';

const validResearchBundle: ResearchBundlePublicData = {
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

const validStoryBlueprint: StoryBlueprintPublicData = {
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

const validGenerationRun: GenerationRunPublicData = {
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

describe('闭合枚举 value guards', () => {
  it('WorkflowStage', () => {
    expect(isWorkflowStageValue('IDEA')).toBe(true);
    expect(isWorkflowStageValue('MANUSCRIPT')).toBe(true);
    expect(isWorkflowStageValue('drafting')).toBe(false);
    expect(isWorkflowStageValue('PENDING')).toBe(false);
  });

  it('ResearchMode / ResearchBundleStatus', () => {
    expect(isResearchModeValue('NONE')).toBe(true);
    expect(isResearchModeValue('DEEP')).toBe(true);
    expect(isResearchModeValue('HEAVY')).toBe(false);
    expect(isResearchBundleStatusValue('FINALIZED')).toBe(true);
    expect(isResearchBundleStatusValue('DONE')).toBe(false);
  });

  it('GenerationRunStatus / GenerationStage / GenerationSourceType', () => {
    expect(isGenerationRunStatusValue('PENDING')).toBe(true);
    expect(isGenerationRunStatusValue('STALE')).toBe(false);
    expect(isGenerationStageValue('COMMITTING')).toBe(true);
    expect(isGenerationStageValue('PLANNING')).toBe(false);
    expect(isGenerationSourceTypeValue('AI_GENERATION')).toBe(true);
    expect(isGenerationSourceTypeValue('USER')).toBe(false);
  });

  it('BlueprintCharacterRole', () => {
    expect(isBlueprintCharacterRoleValue('PROTAGONIST')).toBe(true);
    expect(isBlueprintCharacterRoleValue('HOST')).toBe(false);
  });
});

describe('isValidResearchBundlePublicData', () => {
  it('合法通过', () => {
    expect(isValidResearchBundlePublicData(validResearchBundle)).toBe(true);
  });

  it('unknown field 拒绝', () => {
    expect(isValidResearchBundlePublicData({ ...validResearchBundle, extra: 1 })).toBe(false);
  });

  it('缺失字段拒绝', () => {
    const { finalizedAt: _f, ...missing } = validResearchBundle;
    void _f;
    expect(isValidResearchBundlePublicData(missing)).toBe(false);
  });

  it('错误枚举拒绝', () => {
    expect(isValidResearchBundlePublicData({ ...validResearchBundle, mode: 'HEAVY' })).toBe(false);
    expect(isValidResearchBundlePublicData({ ...validResearchBundle, status: 'DONE' })).toBe(false);
  });

  it('非法 URL 拒绝（嵌套 source）', () => {
    expect(
      isValidResearchBundlePublicData({
        ...validResearchBundle,
        sources: [{ ...validResearchBundle.sources[0], url: 'ftp://example.com/x' }],
      }),
    ).toBe(false);
  });

  it('过长字符串拒绝', () => {
    expect(
      isValidResearchBundlePublicData({
        ...validResearchBundle,
        notes: [{ ...validResearchBundle.notes[0], text: 'x'.repeat(20_001) }],
      }),
    ).toBe(false);
  });

  it('嵌套 source / note 校验', () => {
    expect(
      isValidResearchBundlePublicData({
        ...validResearchBundle,
        notes: [{ ...validResearchBundle.notes[0], sourceIds: [''] }],
      }),
    ).toBe(false);
    expect(
      isValidResearchBundlePublicData({
        ...validResearchBundle,
        sources: [{ ...validResearchBundle.sources[0], title: '' }],
      }),
    ).toBe(false);
    expect(
      isValidResearchBundlePublicData({
        ...validResearchBundle,
        sources: [{ ...validResearchBundle.sources[0], unknown: 1 }],
      }),
    ).toBe(false);
  });

  it('finalizedAt 严格 null 语义', () => {
    expect(isValidResearchBundlePublicData({ ...validResearchBundle, finalizedAt: TS })).toBe(true);
    expect(isValidResearchBundlePublicData({ ...validResearchBundle, finalizedAt: 0 })).toBe(false);
    expect(isValidResearchBundlePublicData({ ...validResearchBundle, finalizedAt: '' })).toBe(
      false,
    );
  });
});

describe('isValidStoryBlueprintPublicData', () => {
  it('合法通过', () => {
    expect(isValidStoryBlueprintPublicData(validStoryBlueprint)).toBe(true);
  });

  it('unknown / missing field 拒绝', () => {
    expect(isValidStoryBlueprintPublicData({ ...validStoryBlueprint, extra: 1 })).toBe(false);
    const { premise: _p, ...missing } = validStoryBlueprint;
    void _p;
    expect(isValidStoryBlueprintPublicData(missing)).toBe(false);
  });

  it('version / order / progress 数值校验', () => {
    expect(isValidStoryBlueprintPublicData({ ...validStoryBlueprint, version: 0 })).toBe(false);
    expect(
      isValidStoryBlueprintPublicData({
        ...validStoryBlueprint,
        chapters: [{ ...validStoryBlueprint.chapters[0], order: 0 }],
      }),
    ).toBe(false);
  });

  it('人物角色闭合枚举', () => {
    expect(
      isValidStoryBlueprintPublicData({
        ...validStoryBlueprint,
        characters: [{ ...validStoryBlueprint.characters[0], role: 'HOST' }],
      }),
    ).toBe(false);
  });

  it('嵌套 chapter / plotLine 校验', () => {
    expect(
      isValidStoryBlueprintPublicData({
        ...validStoryBlueprint,
        chapters: [{ ...validStoryBlueprint.chapters[0], goal: '' }],
      }),
    ).toBe(false);
    expect(
      isValidStoryBlueprintPublicData({
        ...validStoryBlueprint,
        plotLines: [{ ...validStoryBlueprint.plotLines[0], title: '' }],
      }),
    ).toBe(false);
  });
});

describe('isValidGenerationRunPublicData', () => {
  it('合法完成态 / 未开始态通过', () => {
    expect(isValidGenerationRunPublicData(validGenerationRun)).toBe(true);
    expect(
      isValidGenerationRunPublicData({
        ...validGenerationRun,
        status: 'PENDING',
        stage: 'IDLE',
        progress: 0,
        result: null,
        error: null,
        startedAt: null,
        completedAt: null,
      }),
    ).toBe(true);
  });

  it('status / stage / sourceType 错误枚举拒绝', () => {
    expect(isValidGenerationRunPublicData({ ...validGenerationRun, status: 'COMPLETED' })).toBe(
      false,
    );
    expect(isValidGenerationRunPublicData({ ...validGenerationRun, stage: 'PLANNING' })).toBe(
      false,
    );
    expect(
      isValidGenerationRunPublicData({
        ...validGenerationRun,
        result: { ...validGenerationRun.result, sourceType: 'USER' },
      }),
    ).toBe(false);
  });

  it('progress 范围拒绝', () => {
    expect(isValidGenerationRunPublicData({ ...validGenerationRun, progress: -0.1 })).toBe(false);
    expect(isValidGenerationRunPublicData({ ...validGenerationRun, progress: 1.1 })).toBe(false);
    expect(isValidGenerationRunPublicData({ ...validGenerationRun, progress: Number.NaN })).toBe(
      false,
    );
  });

  it('result 嵌套校验', () => {
    expect(
      isValidGenerationRunPublicData({
        ...validGenerationRun,
        result: { ...validGenerationRun.result, committed: 'yes' },
      }),
    ).toBe(false);
    expect(
      isValidGenerationRunPublicData({
        ...validGenerationRun,
        result: { ...validGenerationRun.result, proposedContent: '' },
      }),
    ).toBe(false);
    expect(
      isValidGenerationRunPublicData({
        ...validGenerationRun,
        result: { ...validGenerationRun.result, manuscriptId: ' ' },
      }),
    ).toBe(false);
  });

  it('result 判别联合：committed=true 合法分支通过', () => {
    expect(
      isValidGenerationRunPublicData({
        ...validGenerationRun,
        result: {
          proposedTitle: '第一章',
          proposedContent: '正文……',
          sourceType: 'AI_GENERATION',
          committed: true,
          manuscriptId: 'm1',
          chapterId: 'c1',
          chapterVersionId: 'v1',
        },
      }),
    ).toBe(true);
  });

  it('result 判别联合：两个非法交叉组合拒绝', () => {
    // committed=true 但 manuscriptId 为 null
    expect(
      isValidGenerationRunPublicData({
        ...validGenerationRun,
        result: {
          proposedTitle: 't',
          proposedContent: 'c',
          sourceType: 'AI_GENERATION',
          committed: true,
          manuscriptId: null,
          chapterId: 'c1',
          chapterVersionId: 'v1',
        },
      }),
    ).toBe(false);
    // committed=false 但携带了 id
    expect(
      isValidGenerationRunPublicData({
        ...validGenerationRun,
        result: {
          proposedTitle: 't',
          proposedContent: 'c',
          sourceType: 'AI_GENERATION',
          committed: false,
          manuscriptId: 'm1',
          chapterId: 'c1',
          chapterVersionId: 'v1',
        },
      }),
    ).toBe(false);
    // committed=true 但缺 chapterVersionId
    expect(
      isValidGenerationRunPublicData({
        ...validGenerationRun,
        result: {
          proposedTitle: 't',
          proposedContent: 'c',
          sourceType: 'AI_GENERATION',
          committed: true,
          manuscriptId: 'm1',
          chapterId: 'c1',
          chapterVersionId: null,
        },
      }),
    ).toBe(false);
  });

  it('result=null 时不允许其他结果字段混入', () => {
    expect(isValidGenerationRunPublicData({ ...validGenerationRun, result: null })).toBe(true);
    expect(isValidGenerationRunPublicData({ ...validGenerationRun, result: {} })).toBe(false);
  });
});

describe('Input DTO 严格校验', () => {
  const validGetCurrent: GetCurrentWorkflowInput = { projectId: 'proj-1' };
  const validStartResearch: StartResearchInput = {
    projectId: 'proj-1',
    creationSpecVersionId: 'spec-1',
  };
  const validGenerateBlueprint: GenerateStoryBlueprintInput = {
    projectId: 'proj-1',
    creationSpecVersionId: 'spec-1',
    researchBundleId: 'rb-1',
  };
  const validStartGeneration: StartGenerationInput = {
    projectId: 'proj-1',
    storyBlueprintId: 'bp-1',
  };

  const cases: Array<{ name: string; valid: unknown; validator: (d: unknown) => boolean }> = [
    {
      name: 'workflow.getCurrent',
      valid: validGetCurrent,
      validator: isValidGetCurrentWorkflowInput,
    },
    {
      name: 'research.getCurrent',
      valid: validGetCurrent,
      validator: isValidGetCurrentResearchBundleInput,
    },
    {
      name: 'research.start',
      valid: validStartResearch,
      validator: isValidStartResearchInput,
    },
    {
      name: 'blueprint.getCurrent',
      valid: validGetCurrent,
      validator: isValidGetCurrentStoryBlueprintInput,
    },
    {
      name: 'blueprint.generate',
      valid: validGenerateBlueprint,
      validator: isValidGenerateStoryBlueprintInput,
    },
    {
      name: 'generation.getCurrentRun',
      valid: validGetCurrent,
      validator: isValidGetCurrentGenerationRunInput,
    },
    {
      name: 'generation.start',
      valid: validStartGeneration,
      validator: isValidStartGenerationInput,
    },
  ];

  for (const c of cases) {
    describe(c.name, () => {
      it('合法输入通过', () => {
        expect(c.validator(c.valid)).toBe(true);
      });

      it('extra key 拒绝（含 now / id 注入）', () => {
        expect(c.validator({ ...(c.valid as object), extra: 1 })).toBe(false);
        expect(c.validator({ ...(c.valid as object), now: TS })).toBe(false);
      });

      it('missing key 拒绝', () => {
        expect(c.validator({})).toBe(false);
      });

      it('非法 ID 拒绝（空白 / 超长）', () => {
        expect(c.validator({ ...(c.valid as object), projectId: '  ' })).toBe(false);
        expect(c.validator({ ...(c.valid as object), projectId: 'x'.repeat(129) })).toBe(false);
      });

      it('继承的 allowed key 拒绝（prototype 注入）', () => {
        const polluted = Object.create({ projectId: 'inherited' });
        Object.assign(polluted, c.valid as Record<string, unknown>);
        expect(c.validator(polluted)).toBe(false);
      });

      it('null prototype plain record 通过', () => {
        const plain: Record<string, unknown> = Object.create(null);
        Object.assign(plain, c.valid as Record<string, unknown>);
        expect(c.validator(plain)).toBe(true);
      });

      it('class instance 拒绝', () => {
        expect(
          c.validator(
            new (class Input {
              projectId = 'proj-1';
            })(),
          ),
        ).toBe(false);
      });

      it('array 拒绝', () => {
        expect(c.validator([c.valid])).toBe(false);
      });
    });
  }

  it('research.start：mode 可选且必须闭合', () => {
    expect(isValidStartResearchInput({ ...validStartResearch, mode: 'DEEP' })).toBe(true);
    expect(isValidStartResearchInput({ ...validStartResearch, mode: 'HEAVY' })).toBe(false);
    expect(isValidStartResearchInput({ ...validStartResearch, mode: undefined })).toBe(true);
  });

  it('research.start：creationSpecVersionId 必填', () => {
    const { creationSpecVersionId: _c, ...missing } = validStartResearch;
    void _c;
    expect(isValidStartResearchInput(missing)).toBe(false);
  });

  it('blueprint.generate / generation.start：引用 ID 必填且非空', () => {
    expect(
      isValidGenerateStoryBlueprintInput({ ...validGenerateBlueprint, researchBundleId: '' }),
    ).toBe(false);
    expect(isValidStartGenerationInput({ ...validStartGeneration, storyBlueprintId: ' ' })).toBe(
      false,
    );
  });
});

describe('CreationSpecSnapshotDTO 复用现有 Creation Contract snapshot', () => {
  const validContractVersion: ContractVersionPublicData = {
    id: 'v1',
    projectId: 'proj-1',
    version: 1,
    schemaVersion: 1,
    sourceProposalId: null,
    basedOnGrillSessionId: null,
    basedOnGrillSessionVersion: null,
    sections: {
      premise: 'p',
      genre: ['x'],
      tone: ['y'],
      targetAudience: 'a',
      narrativePov: 'FIRST',
      tense: 'PAST',
      protagonist: { characterKey: 'k', name: 'n' },
    },
    lockedFieldPaths: [],
    contractSnapshotHash: 'a'.repeat(64),
    provenance: [],
    createdAt: TS,
    createdBy: 'user',
  };

  it('isValidCreationSpecSnapshotDTO 就是现有 snapshot 校验器（别名，非新模型）', () => {
    expect(isValidCreationSpecSnapshotDTO(validContractVersion)).toBe(true);
  });

  it('非法 snapshot 同样拒绝（hash 非 lowercase 64-hex）', () => {
    expect(
      isValidCreationSpecSnapshotDTO({ ...validContractVersion, contractSnapshotHash: 'XYZ' }),
    ).toBe(false);
  });
});

describe('SpineAPI 聚合 / DesktopAPI 形状 / IPC 通道', () => {
  it('SpineAPI 是必填聚合，方法使用实现无关的中性动词', () => {
    const assertShape = (_api: SpineAPI): void => {
      void _api;
    };
    const workflow: WorkflowAPI = { getCurrent: async () => 'IDEA' };
    const research: ResearchAPI = {
      getCurrent: async () => null,
      start: async () => validResearchBundle,
    };
    const blueprint: BlueprintAPI = {
      getCurrent: async () => null,
      generate: async () => validStoryBlueprint,
    };
    const generation: GenerationAPI = {
      getCurrentRun: async () => null,
      start: async () => validGenerationRun,
    };
    expect(typeof workflow.getCurrent).toBe('function');
    expect(typeof research.getCurrent).toBe('function');
    expect(typeof research.start).toBe('function');
    expect(typeof blueprint.getCurrent).toBe('function');
    expect(typeof blueprint.generate).toBe('function');
    expect(typeof generation.getCurrentRun).toBe('function');
    expect(typeof generation.start).toBe('function');
    // SpineAPI 聚合必须要求全部四个命名空间（必填）
    assertShape({ workflow, research, blueprint, generation });
  });

  it('SpineAPI 命名空间必填（transport 接线 PR 前作为独立聚合导出）', () => {
    // 编译期断言：SpineAPI 的四个属性均不含 undefined
    type WorkflowRequired = undefined extends SpineAPI['workflow'] ? false : true;
    type ResearchRequired = undefined extends SpineAPI['research'] ? false : true;
    type BlueprintRequired = undefined extends SpineAPI['blueprint'] ? false : true;
    type GenerationRequired = undefined extends SpineAPI['generation'] ? false : true;
    const checks: [WorkflowRequired, ResearchRequired, BlueprintRequired, GenerationRequired] = [
      true,
      true,
      true,
      true,
    ];
    expect(checks).toEqual([true, true, true, true]);
  });

  it('DesktopAPI 保持当前真实形状，不含 Spine API（未接线前不污染公共类型）', () => {
    // 编译期断言：DesktopAPI 不暴露 workflow/research/blueprint/generation
    type WorkflowAbsent = 'workflow' extends keyof DesktopAPI ? false : true;
    type ResearchAbsent = 'research' extends keyof DesktopAPI ? false : true;
    type BlueprintAbsent = 'blueprint' extends keyof DesktopAPI ? false : true;
    type GenerationAbsent = 'generation' extends keyof DesktopAPI ? false : true;
    const checks: [WorkflowAbsent, ResearchAbsent, BlueprintAbsent, GenerationAbsent] = [
      true,
      true,
      true,
      true,
    ];
    expect(checks).toEqual([true, true, true, true]);
  });

  it('IPC 频道包含全部 spine 通道（前缀正确、中性命名、无接线）', () => {
    const channels = Object.values(IPC_CHANNELS);
    for (const ch of [
      'ipc:workflow-get-current',
      'ipc:research-get-current',
      'ipc:research-start',
      'ipc:blueprint-get-current',
      'ipc:blueprint-generate',
      'ipc:generation-get-current-run',
      'ipc:generation-start',
    ]) {
      expect(channels).toContain(ch);
    }
  });

  it('IPC 频道不包含 fixture 术语', () => {
    const channels = Object.values(IPC_CHANNELS);
    for (const ch of channels) {
      expect(ch).not.toMatch(/fixture/);
    }
  });

  it('IPC 频道唯一', () => {
    const channels = Object.values(IPC_CHANNELS);
    expect(new Set(channels).size).toBe(channels.length);
  });
});

describe('DTO 辅助校验器（嵌套）', () => {
  it('isValidResearchSourcePublicData 独立可用', () => {
    expect(isValidResearchSourcePublicData(validResearchBundle.sources[0])).toBe(true);
    expect(isValidResearchSourcePublicData({ ...validResearchBundle.sources[0], url: 'bad' })).toBe(
      false,
    );
  });

  it('isValidBlueprintChapterPublicData 独立可用', () => {
    expect(isValidBlueprintChapterPublicData(validStoryBlueprint.chapters[0])).toBe(true);
    expect(
      isValidBlueprintChapterPublicData({ ...validStoryBlueprint.chapters[0], order: -1 }),
    ).toBe(false);
  });
});

describe('URL 严格校验（空 host / 端口范围）', () => {
  const sourceWithUrl = (url: string): unknown => ({
    ...validResearchBundle.sources[0],
    url,
  });

  it('拒绝空 host 与端口（authority 只有 :port）', () => {
    for (const bad of ['http://:80', 'https://:443/path', 'http://:65535/']) {
      expect(isValidResearchSourcePublicData(sourceWithUrl(bad))).toBe(false);
    }
  });

  it('拒绝空 IPv6 字面量与非法括号', () => {
    for (const bad of ['http://[]', 'https://[]/x', 'http://foo[bar]/x']) {
      expect(isValidResearchSourcePublicData(sourceWithUrl(bad))).toBe(false);
    }
  });

  it('拒绝越界 / 非法端口', () => {
    for (const bad of [
      'http://example.com:99999',
      'http://example.com:0',
      'http://example.com:65536',
      'http://example.com:',
      'http://example.com:abc',
      'http://2001:db8::1/',
    ]) {
      expect(isValidResearchSourcePublicData(sourceWithUrl(bad))).toBe(false);
    }
  });

  it('接受合法端口边界与 IPv6 字面量', () => {
    for (const good of [
      'http://example.com:1/a',
      'https://example.com:65535/a',
      'http://[2001:db8::1]/a',
      'http://[2001:db8::1]:8080/a',
    ]) {
      expect(isValidResearchSourcePublicData(sourceWithUrl(good))).toBe(true);
    }
  });
});
