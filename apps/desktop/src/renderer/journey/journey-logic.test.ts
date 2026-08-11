/**
 * 旅程展示阶段纯逻辑单测（B6 REWORK 复查 D-B6-10）：
 * stageIndex 排序、advanceMaxFrontierStage 单调性、reachedStagesUpTo 集合推导、
 * deriveViewStage 三条优先级规则（含 blueprint/manuscript 回落 research/idea）。
 */

import { describe, it, expect } from 'vitest';
import type { JourneyStage } from '../intake/intake-logic';
import {
  advanceMaxFrontierStage,
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
  it('idea/research 已建 Region；blueprint/manuscript 尚未建（B7/B8 起补齐）', () => {
    expect(isImplementedStage('idea')).toBe(true);
    expect(isImplementedStage('research')).toBe(true);
    expect(isImplementedStage('blueprint')).toBe(false);
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

  it('规则 3：frontierStage=blueprint 且无显式选择 → 回落 research（核心 blocker 回归：调研内容仍可展示）', () => {
    expect(
      deriveViewStage({
        frontierStage: 'blueprint',
        userSelectedStage: null,
        reachedStages: reachedStagesUpTo('blueprint'),
      }),
    ).toBe('research');
  });

  it('规则 3：frontierStage=manuscript 且无显式选择 → 同样回落 research', () => {
    expect(
      deriveViewStage({
        frontierStage: 'manuscript',
        userSelectedStage: null,
        reachedStages: reachedStagesUpTo('manuscript'),
      }),
    ).toBe('research');
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
