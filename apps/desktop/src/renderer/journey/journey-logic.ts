/**
 * 旅程展示阶段纯逻辑（B6 REWORK 复查 D-B6-10，设计见 docs/development/b6-research-ui-design.md）。
 *
 * 背景（blocker）：Graph 的 sync 节点会在同一状态快照内连续推进——deep 全链调研
 * 成功后，RESEARCH_VALIDATE 已 succeeded、BLUEPRINT_GENERATE 已 active，往往从来
 * 没有一次可观测的 poll 快照让 frontier 停留在 research。若中栏挂载哪个 Region
 * 单纯follow frontierStage（旧 D-B6-7 行为），调研刚有结果的那一刻，ResearchRegion
 * 就已经被换回 IntakeRegion——用户永远看不到调研结果。
 *
 * 修复：把"推进阶段"（frontierStage，Graph 真实位置，JourneyNav 用它标示进度）与
 * "展示阶段"（viewStage，决定中栏挂载哪个 Region）拆开，见 deriveViewStage。
 */

import { JOURNEY_STAGES, type JourneyStage } from '../intake/intake-logic';

const STAGE_INDEX = new Map<JourneyStage, number>(JOURNEY_STAGES.map((s, i) => [s.id, i]));

/** 阶段在四阶段旅程中的序号（idea=0 … manuscript=3） */
export function stageIndex(stage: JourneyStage): number {
  return STAGE_INDEX.get(stage) ?? 0;
}

/**
 * 当前已建 Region 的阶段。blueprint/manuscript 尚无 Region（B7/B8 起补齐）——
 * frontier 落在这两个阶段时，deriveViewStage 的默认路径（无显式用户选择）需要
 * 回落到已实现阶段，不能挂载一个不存在的 Region。
 */
const IMPLEMENTED_STAGES: ReadonlySet<JourneyStage> = new Set(['idea', 'research']);

export function isImplementedStage(stage: JourneyStage): boolean {
  return IMPLEMENTED_STAGES.has(stage);
}

/**
 * 单调推进"历史最远 frontier"：仅当新 frontier 序号更大时前进；frontier 因
 * escalation（如 modify_requirements 回环到 clarify）回退时不收缩——已到达过的
 * 阶段应保持可回看。
 */
export function advanceMaxFrontierStage(current: JourneyStage, next: JourneyStage): JourneyStage {
  return stageIndex(next) > stageIndex(current) ? next : current;
}

/**
 * 由"历史最远 frontier"推导已到达阶段集合（JourneyNav 可点击回看范围）。
 * 序号 <= 历史最远 frontier 的阶段均视为已到达（含当前）。
 */
export function reachedStagesUpTo(maxFrontierStage: JourneyStage): ReadonlySet<JourneyStage> {
  const maxIndex = stageIndex(maxFrontierStage);
  return new Set(JOURNEY_STAGES.filter((_, i) => i <= maxIndex).map((s) => s.id));
}

export interface ViewStageInput {
  /** 推进阶段：Graph 真实位置的最新投影 */
  readonly frontierStage: JourneyStage;
  /** 用户在 JourneyNav 上显式点选的阶段；未点选或已被新项目重置时为 null */
  readonly userSelectedStage: JourneyStage | null;
  /** 已到达阶段集合（reachedStagesUpTo 的结果） */
  readonly reachedStages: ReadonlySet<JourneyStage>;
}

/**
 * 展示阶段（决定中栏挂载哪个 Region）。优先级，命中即返回：
 *
 * 1. 用户显式点选的阶段——只要该阶段已到达过，就锁定展示（用户意图优先，即使
 *    该阶段尚无 Region：blueprint/manuscript 会展示 IntakeRegion 的
 *    beyond-intake 占位文案，这是对用户主动操作的诚实反馈，不做二次回落）；
 * 2. 否则默认跟随 frontierStage，前提是该阶段已有 Region 实现；
 * 3. frontierStage 指向尚未建 Region 的阶段（当前为 blueprint/manuscript）——
 *    回落到 research。之所以不需要再读一次 researchDecision 来判断"调研是否有
 *    内容"：Graph 结构保证——frontier 能越过 research 阶段（到达
 *    BLUEPRINT_GENERATE 及之后）之前，RESEARCH_DECISION 必然已产出结果（图的
 *    条件边要求 research_decision outcome 存在才能前进）。用 frontierStage 相对
 *    research 的序号位置作为"调研已有可展示内容"的结构性代理信号，避免 App 端
 *    为解决启动时机问题（ResearchRegion 尚未挂载、无法读到 researchDecision）
 *    额外发起一次性探测请求或维持第二条轮询循环（与 D-B6-7 单轮询循环的约束
 *    冲突）。frontierStage 序号仍小于 research（即 'idea'）时，回落到 idea。
 */
export function deriveViewStage(input: ViewStageInput): JourneyStage {
  const { frontierStage, userSelectedStage, reachedStages } = input;
  if (userSelectedStage !== null && reachedStages.has(userSelectedStage)) {
    return userSelectedStage;
  }
  if (isImplementedStage(frontierStage)) {
    return frontierStage;
  }
  return stageIndex(frontierStage) >= stageIndex('research') ? 'research' : 'idea';
}
