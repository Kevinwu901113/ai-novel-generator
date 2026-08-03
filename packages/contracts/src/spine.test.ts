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
  isValidCreateResearchFixtureInput,
  isValidGetCurrentStoryBlueprintInput,
  isValidCreateStoryBlueprintFixtureInput,
  isValidGetCurrentGenerationRunInput,
  isValidRunGenerationFixtureInput,
  isValidCreationSpecSnapshotDTO,
  type DesktopAPI,
  type ContractVersionPublicData,
  type WorkflowAPI,
  type ResearchAPI,
  type BlueprintAPI,
  type GenerationAPI,
  type ResearchBundlePublicData,
  type StoryBlueprintPublicData,
  type GenerationRunPublicData,
  type GetCurrentWorkflowInput,
  type CreateResearchFixtureInput,
  type CreateStoryBlueprintFixtureInput,
  type RunGenerationFixtureInput,
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

  it('result=null 时不允许其他结果字段混入', () => {
    expect(isValidGenerationRunPublicData({ ...validGenerationRun, result: null })).toBe(true);
    expect(isValidGenerationRunPublicData({ ...validGenerationRun, result: {} })).toBe(false);
  });
});

describe('Input DTO 严格校验', () => {
  const validGetCurrent: GetCurrentWorkflowInput = { projectId: 'proj-1' };
  const validCreateResearch: CreateResearchFixtureInput = {
    projectId: 'proj-1',
    creationSpecVersionId: 'spec-1',
  };
  const validCreateBlueprint: CreateStoryBlueprintFixtureInput = {
    projectId: 'proj-1',
    creationSpecVersionId: 'spec-1',
    researchBundleId: 'rb-1',
  };
  const validRunFixture: RunGenerationFixtureInput = {
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
      name: 'research.createFixture',
      valid: validCreateResearch,
      validator: isValidCreateResearchFixtureInput,
    },
    {
      name: 'blueprint.getCurrent',
      valid: validGetCurrent,
      validator: isValidGetCurrentStoryBlueprintInput,
    },
    {
      name: 'blueprint.createFixture',
      valid: validCreateBlueprint,
      validator: isValidCreateStoryBlueprintFixtureInput,
    },
    {
      name: 'generation.getCurrentRun',
      valid: validGetCurrent,
      validator: isValidGetCurrentGenerationRunInput,
    },
    {
      name: 'generation.runFixture',
      valid: validRunFixture,
      validator: isValidRunGenerationFixtureInput,
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

  it('createResearchFixture：mode 可选且必须闭合', () => {
    expect(isValidCreateResearchFixtureInput({ ...validCreateResearch, mode: 'DEEP' })).toBe(true);
    expect(isValidCreateResearchFixtureInput({ ...validCreateResearch, mode: 'HEAVY' })).toBe(
      false,
    );
    expect(isValidCreateResearchFixtureInput({ ...validCreateResearch, mode: undefined })).toBe(
      true,
    );
  });

  it('createResearchFixture：creationSpecVersionId 必填', () => {
    const { creationSpecVersionId: _c, ...missing } = validCreateResearch;
    void _c;
    expect(isValidCreateResearchFixtureInput(missing)).toBe(false);
  });

  it('createBlueprintFixture / runFixture：引用 ID 必填且非空', () => {
    expect(
      isValidCreateStoryBlueprintFixtureInput({ ...validCreateBlueprint, researchBundleId: '' }),
    ).toBe(false);
    expect(isValidRunGenerationFixtureInput({ ...validRunFixture, storyBlueprintId: ' ' })).toBe(
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

describe('DesktopAPI type parity 与 IPC 通道', () => {
  it('DesktopAPI 包含 workflow/research/blueprint/generation 命名空间', () => {
    const assertShape = (_api: DesktopAPI): void => {
      void _api;
    };
    const workflow: WorkflowAPI = { getCurrent: async () => 'IDEA' };
    const research: ResearchAPI = {
      getCurrent: async () => null,
      createFixture: async () => validResearchBundle,
    };
    const blueprint: BlueprintAPI = {
      getCurrent: async () => null,
      createFixture: async () => validStoryBlueprint,
    };
    const generation: GenerationAPI = {
      getCurrentRun: async () => null,
      runFixture: async () => validGenerationRun,
    };
    expect(typeof workflow.getCurrent).toBe('function');
    expect(typeof research.getCurrent).toBe('function');
    expect(typeof research.createFixture).toBe('function');
    expect(typeof blueprint.getCurrent).toBe('function');
    expect(typeof blueprint.createFixture).toBe('function');
    expect(typeof generation.getCurrentRun).toBe('function');
    expect(typeof generation.runFixture).toBe('function');
    assertShape({
      workflow,
      research,
      blueprint,
      generation,
    } as DesktopAPI);
  });

  it('spine 命名空间为可选 —— 未接线的 preload（无 spine 命名空间）仍满足 DesktopAPI', () => {
    // 编译期断言：workflow/research/blueprint/generation 在 DesktopAPI 上均为可选
    // （transport 接线 PR 之前，preload 不实现它们仍可通过类型检查）。
    type WorkflowOptional = undefined extends DesktopAPI['workflow'] ? true : false;
    type ResearchOptional = undefined extends DesktopAPI['research'] ? true : false;
    type BlueprintOptional = undefined extends DesktopAPI['blueprint'] ? true : false;
    type GenerationOptional = undefined extends DesktopAPI['generation'] ? true : false;
    const checks: [WorkflowOptional, ResearchOptional, BlueprintOptional, GenerationOptional] = [
      true,
      true,
      true,
      true,
    ];
    expect(checks).toEqual([true, true, true, true]);
  });

  it('IPC 频道包含全部 spine 通道（前缀正确、无接线）', () => {
    const channels = Object.values(IPC_CHANNELS);
    for (const ch of [
      'ipc:workflow-get-current',
      'ipc:research-get-current',
      'ipc:research-create-fixture',
      'ipc:blueprint-get-current',
      'ipc:blueprint-create-fixture',
      'ipc:generation-get-current-run',
      'ipc:generation-run-fixture',
    ]) {
      expect(channels).toContain(ch);
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
