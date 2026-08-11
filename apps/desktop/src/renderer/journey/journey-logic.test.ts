/**
 * 旅程展示阶段纯逻辑单测（B6 REWORK 复查 D-B6-10）：
 * stageIndex 排序、advanceMaxFrontierStage 单调性、reachedStagesUpTo 集合推导、
 * deriveViewStage 三条优先级规则（含 blueprint/manuscript 回落 research/idea）。
 */

import { describe, it, expect } from 'vitest';
import type { JourneyStage } from '../intake/intake-logic';
import type { GraphProgressProjectionDto, GraphRunSummaryDto } from '@ai-novel/contracts';
import {
  advanceMaxFrontierStage,
  deriveFrontierStage,
  deriveViewStage,
  isImplementedStage,
  reachedStagesUpTo,
  stageIndex,
} from './journey-logic';

describe('stageIndex', () => {
  it('按 idea < research < blueprint < manuscript 排序', () => {
    expect(stageIndex('idea')).toBe(0);
    expect(stageIndex('research')).toBe(1);
    expect(stageIndex('blueprint')).toBe(2);
    expect(stageIndex('manuscript')).toBe(3);
  });
});

describe('isImplementedStage', () => {
  it('idea/research/blueprint 已建 Region；manuscript 尚未建（GE-7 补齐）', () => {
    expect(isImplementedStage('idea')).toBe(true);
    expect(isImplementedStage('research')).toBe(true);
    expect(isImplementedStage('blueprint')).toBe(true);
    expect(isImplementedStage('manuscript')).toBe(false);
  });
});

describe('advanceMaxFrontierStage', () => {
  it('新 frontier 序号更大 → 前进', () => {
    expect(advanceMaxFrontierStage('idea', 'research')).toBe('research');
    expect(advanceMaxFrontierStage('research', 'blueprint')).toBe('blueprint');
  });

  it('新 frontier 序号相等或更小（如 escalation modify_requirements 回环）→ 保持不收缩', () => {
    expect(advanceMaxFrontierStage('blueprint', 'idea')).toBe('blueprint');
    expect(advanceMaxFrontierStage('research', 'research')).toBe('research');
    expect(advanceMaxFrontierStage('blueprint', 'research')).toBe('blueprint');
  });
});

describe('reachedStagesUpTo', () => {
  it('历史最远 frontier = idea → 仅 idea 已到达', () => {
    expect(reachedStagesUpTo('idea')).toEqual(new Set<JourneyStage>(['idea']));
  });

  it('历史最远 frontier = blueprint → idea/research/blueprint 已到达，manuscript 未到达', () => {
    const reached = reachedStagesUpTo('blueprint');
    expect(reached).toEqual(new Set<JourneyStage>(['idea', 'research', 'blueprint']));
    expect(reached.has('manuscript')).toBe(false);
  });

  it('历史最远 frontier = manuscript → 全部四阶段已到达', () => {
    expect(reachedStagesUpTo('manuscript')).toEqual(
      new Set<JourneyStage>(['idea', 'research', 'blueprint', 'manuscript']),
    );
  });
});

describe('deriveViewStage', () => {
  it('规则 1：用户显式点选已到达阶段 → 锁定该阶段（用户意图优先于 frontier）', () => {
    expect(
      deriveViewStage({
        frontierStage: 'blueprint',
        userSelectedStage: 'idea',
        reachedStages: reachedStagesUpTo('blueprint'),
      }),
    ).toBe('idea');
  });

  it('规则 1：用户点选未到达阶段 → 忽略选择，落回规则 2/3（不能选还没到的阶段）', () => {
    expect(
      deriveViewStage({
        frontierStage: 'research',
        userSelectedStage: 'blueprint',
        reachedStages: reachedStagesUpTo('research'),
      }),
    ).toBe('research');
  });

  it('规则 1：用户显式点选已到达但尚无 Region 的阶段（blueprint）→ 仍锁定（诚实占位反馈，不做二次回落）', () => {
    expect(
      deriveViewStage({
        frontierStage: 'blueprint',
        userSelectedStage: 'blueprint',
        reachedStages: reachedStagesUpTo('blueprint'),
      }),
    ).toBe('blueprint');
  });

  it('规则 2：无显式选择，frontierStage 已实现（idea/research）→ 直接跟随', () => {
    expect(
      deriveViewStage({
        frontierStage: 'idea',
        userSelectedStage: null,
        reachedStages: reachedStagesUpTo('idea'),
      }),
    ).toBe('idea');
    expect(
      deriveViewStage({
        frontierStage: 'research',
        userSelectedStage: null,
        reachedStages: reachedStagesUpTo('research'),
      }),
    ).toBe('research');
  });

  it('规则 2（B8）：frontierStage=blueprint 已是已实现阶段 → 直接展示 blueprint', () => {
    expect(
      deriveViewStage({
        frontierStage: 'blueprint',
        userSelectedStage: null,
        reachedStages: reachedStagesUpTo('blueprint'),
      }),
    ).toBe('blueprint');
  });

  it('规则 3：frontierStage=manuscript（尚未建 Region）→ 回落到不超过它的最近已实现阶段 blueprint', () => {
    expect(
      deriveViewStage({
        frontierStage: 'manuscript',
        userSelectedStage: null,
        reachedStages: reachedStagesUpTo('manuscript'),
      }),
    ).toBe('blueprint');
  });

  it('用户选择被新项目重置（userSelectedStage=null）后，viewStage 重新跟随 frontierStage', () => {
    // 场景：用户曾选中 idea 查看，随后切换项目——App 层应把 userSelectedStage 置 null，
    // reachedStages 也应随新项目重置为仅含新 frontierStage 以内的阶段。
    expect(
      deriveViewStage({
        frontierStage: 'idea',
        userSelectedStage: null,
        reachedStages: reachedStagesUpTo('idea'),
      }),
    ).toBe('idea');
  });
});

describe('deriveFrontierStage（D-B8-2/D-B8-3：阶段派生上提到 App）', () => {
  const RUN: GraphRunSummaryDto = {
    runId: 'run-1',
    graphId: 'idea-to-novel-project-v1',
    graphVersion: '1',
    kind: 'project',
    terminalStatus: null,
    createdAt: '2026-08-11T00:00:00.000Z',
  };

  function progress(
    activeNodes: GraphProgressProjectionDto['activeNodes'],
  ): GraphProgressProjectionDto {
    return { activeNodes, possibleNextNodes: [] };
  }

  it('无 run → idea', () => {
    expect(
      deriveFrontierStage({
        run: null,
        progress: null,
        hasBlueprintArtifact: false,
        hasResearchArtifact: false,
      }),
    ).toBe('idea');
  });

  // D-B8-3 的核心：终态 activeNodes 恒空，只能按已产出 artifact 回推，
  // 否则已就绪项目冷启动后阶段回落 idea、蓝图永远回不去。
  it('终态 + 有蓝图 artifact → blueprint（三终态皆然）', () => {
    for (const status of ['completed', 'blocked', 'cancelled'] as const) {
      expect(
        deriveFrontierStage({
          run: { ...RUN, terminalStatus: status },
          progress: progress([]),
          hasBlueprintArtifact: true,
          hasResearchArtifact: true,
        }),
      ).toBe('blueprint');
    }
  });

  it('终态 + 无蓝图但有调研 artifact → research', () => {
    expect(
      deriveFrontierStage({
        run: { ...RUN, terminalStatus: 'cancelled' },
        progress: progress([]),
        hasBlueprintArtifact: false,
        hasResearchArtifact: true,
      }),
    ).toBe('research');
  });

  it('终态 + 无任何 artifact → idea', () => {
    expect(
      deriveFrontierStage({
        run: { ...RUN, terminalStatus: 'blocked' },
        progress: progress([]),
        hasBlueprintArtifact: false,
        hasResearchArtifact: false,
      }),
    ).toBe('idea');
  });

  it('非终态：waiting_for_human 节点优先于其他 active 节点', () => {
    expect(
      deriveFrontierStage({
        run: RUN,
        progress: progress([
          { nodeId: 'RESEARCH_EXECUTE', stage: 'research', status: 'active' },
          { nodeId: 'BLUEPRINT_USER_GATE', stage: 'blueprint', status: 'waiting_for_human' },
        ]),
        hasBlueprintArtifact: true,
        hasResearchArtifact: true,
      }),
    ).toBe('blueprint');
  });

  it('非终态：无 progress / 无 active 节点 → null（保留上一次已知阶段，不回退闪烁）', () => {
    expect(
      deriveFrontierStage({
        run: RUN,
        progress: null,
        hasBlueprintArtifact: false,
        hasResearchArtifact: false,
      }),
    ).toBe(null);
    expect(
      deriveFrontierStage({
        run: RUN,
        progress: progress([]),
        hasBlueprintArtifact: false,
        hasResearchArtifact: false,
      }),
    ).toBe(null);
  });

  it('非终态：artifact 标记不影响活跃节点的判定', () => {
    expect(
      deriveFrontierStage({
        run: RUN,
        progress: progress([{ nodeId: 'COLLECT_ANSWER', stage: 'clarify', status: 'active' }]),
        hasBlueprintArtifact: true,
        hasResearchArtifact: true,
      }),
    ).toBe('idea');
  });
});
