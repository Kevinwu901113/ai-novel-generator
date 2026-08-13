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

import type { GraphProgressProjectionDto, GraphRunSummaryDto } from '@ai-novel/contracts';
import { JOURNEY_STAGES, journeyStageOf, type JourneyStage } from '../intake/intake-logic';

const STAGE_INDEX = new Map<JourneyStage, number>(JOURNEY_STAGES.map((s, i) => [s.id, i]));

/** 阶段在四阶段旅程中的序号（idea=0 … manuscript=3） */
export function stageIndex(stage: JourneyStage): number {
  return STAGE_INDEX.get(stage) ?? 0;
}

/**
 * 当前已建 Region 的阶段。B10 起四个阶段全部有 Region（manuscript → ChapterRegion），
 * 故 deriveViewStage 的"回落到最近已实现阶段"分支在当前版本不会再被走到——保留该
 * 分支是因为它是结构性兜底：将来若新增阶段而 Region 未跟上，回落仍然正确。
 */
const IMPLEMENTED_STAGES: ReadonlySet<JourneyStage> = new Set([
  'idea',
  'research',
  'blueprint',
  'manuscript',
]);

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
 *    该阶段尚无 Region：manuscript 会展示 IntakeRegion 的 beyond-intake 占位
 *    文案，这是对用户主动操作的诚实反馈，不做二次回落）；
 * 2. 否则默认跟随 frontierStage，前提是该阶段已有 Region 实现；
 * 3. frontierStage 指向尚未建 Region 的阶段（B8 后仅剩 manuscript）——回落到
 *    不超过它的最近一个已实现阶段（即 blueprint）。之所以不必再读一次上游状态
 *    来确认"该阶段是否有内容可展示"：Graph 结构保证 frontier 能越过某阶段，
 *    其产物必然已经产出（条件边要求上游 outcome 存在才能前进），故阶段序号本身
 *    就是"已有可展示内容"的结构性代理信号，无需额外探测请求。
 */
export function deriveViewStage(input: ViewStageInput): JourneyStage {
  const { frontierStage, userSelectedStage, reachedStages } = input;
  if (userSelectedStage !== null && reachedStages.has(userSelectedStage)) {
    return userSelectedStage;
  }
  if (isImplementedStage(frontierStage)) {
    return frontierStage;
  }
  // 回落到不超过 frontier 的最近一个已实现阶段（B8 之前这里硬编码为 research；
  // 已实现集合会随 GE-7 继续增长，故改为按序号向下寻找，不再逐批改常量）。
  for (let i = stageIndex(frontierStage) - 1; i >= 0; i -= 1) {
    const candidate = JOURNEY_STAGES[i].id;
    if (isImplementedStage(candidate)) return candidate;
  }
  return 'idea';
}

/**
 * 由 Graph 读取推导推进阶段（D-B8-2：阶段派生上提到 App）。
 *
 * 旧结构是"由当前挂载的 Region 经 onStageChange 回报阶段"，已连续产生两条同质
 * blocker：B6 的 D-B6-10（frontier 走到未实现阶段 → Region 被卸载 → 内容不可达），
 * 以及 B8 侦察发现的终态 blocker（run 终态后 activeNodes 恒空 → 阶段回落 idea →
 * 冷启动时 JourneyNav 的蓝图项 disabled，用户永远回不到已接受的蓝图）。根因同一：
 * **没有 Region 该被挂载时，阶段却只能由被挂载的 Region 回报**——鸡生蛋。故阶段
 * 派生改由 App 自持的探针独立计算，Region 只负责渲染与自身内容拉取。
 *
 * 规则：
 * 1. 无 run → 'idea'；
 * 2. **run 已终态（completed/blocked/cancelled）→ 按已产出 artifact 推导（D-B8-3）**：
 *    - **蓝图已被接受且 run 正常完成（PROJECT_READY）→ 'manuscript'（D-B10-6）**：
 *      项目就绪后用户的下一步就是逐章写正文。若仍停在 'blueprint'，manuscript 永远
 *      不进 reachedStages，JourneyNav 的"成稿"恒为 disabled——B10 交付的整个章节
 *      生成界面将永不可达（与 D-B6-10 / D-B8-3 同族的可达性缺陷，由 App 级测试坐实）；
 *    - 否则有 storyBlueprint → 'blueprint'；再否则有 researchBundle → 'research'；否则 'idea'。
 *    activeNodes 在终态恒空，不能作为依据；
 * 3. 无 progress（尚未取到）→ null，调用方保留上一次已知阶段，避免瞬时闪烁；
 * 4. 否则取 waiting_for_human 节点（没有则第一个 active 节点）的 stage 投影——
 *    **终态节点（stage 'done'：PROJECT_READY/BLOCKED/CANCELLED）除外**：人工决策
 *    提交后、异步驱动把 terminalStatus 写入前，存在一个"终态节点 active 而
 *    run 还没有 terminalStatus"的真实窗口（B8 独立复查坐实）。'done' 不是用户
 *    阶段，直接投影会得到 'manuscript' 并被 maxFrontierStage 单调锁死到会话结束；
 *    该窗口按规则 2 的 artifact 推导处理；
 * 5. 无任何 active 节点（节点间过渡瞬时态）→ null，同样保留上一次已知阶段。
 */
export interface FrontierStageInput {
  readonly run: GraphRunSummaryDto | null;
  readonly progress: GraphProgressProjectionDto | null;
  /** 已产出 storyBlueprint artifact（blueprint.getState 的 blueprintRef 非空） */
  readonly hasBlueprintArtifact: boolean;
  /** 已产出 researchBundle artifact（research.getResearchState 的 bundleRef 非空） */
  readonly hasResearchArtifact: boolean;
  /** 蓝图已被用户显式接受（blueprint.getState 的 accepted） */
  readonly blueprintAccepted: boolean;
}

export function deriveFrontierStage(input: FrontierStageInput): JourneyStage | null {
  const { run, progress, hasBlueprintArtifact, hasResearchArtifact, blueprintAccepted } = input;
  if (!run) return 'idea';
  if (run.terminalStatus !== null) {
    // D-B10-6：PROJECT_READY（run completed + 蓝图已接受）→ 进入成稿阶段
    if (run.terminalStatus === 'completed' && blueprintAccepted) return 'manuscript';
    if (hasBlueprintArtifact) return 'blueprint';
    if (hasResearchArtifact) return 'research';
    return 'idea';
  }
  if (!progress) return null;
  const journeyNodes = progress.activeNodes.filter((n) => n.stage !== 'done');
  const waiting = journeyNodes.find((n) => n.status === 'waiting_for_human');
  const frontier = waiting ?? journeyNodes[0];
  if (!frontier) {
    if (progress.activeNodes.length > 0 && hasBlueprintArtifact) {
      // 只剩终态节点在途（terminalStatus 尚未写入的窗口）且蓝图已产出：
      // 按 artifact 推导，与终态分支同规则。
      return 'blueprint';
    }
    // 其余情况（纯节点间过渡，或终态窗口但无蓝图 artifact——此时探针尚未拉
    // 调研态，无从区分 research/idea）→ 保留上一阶段，等 terminalStatus 落地
    // 后由规则 2 定论，避免一次假回退闪烁。
    return null;
  }
  return journeyStageOf(frontier.stage);
}
