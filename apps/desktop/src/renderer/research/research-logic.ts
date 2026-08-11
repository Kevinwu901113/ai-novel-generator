/**
 * Web Research 旅程纯逻辑（B6，设计见 docs/development/b6-research-ui-design.md）。
 *
 * - 调研相位派生：全部由 research.getResearchState 的 ResearchStateDto + search.hasApiKey +
 *   "是否存在在途 RESEARCH_RUN 任务" 三个信号驱动，renderer 不自行推导 Graph 语义
 *   （锁定不变量同 B4 intake-logic：只做展示投影）；
 * - 必须能区分"无需调研（none，直达蓝图）"与"尚未调研（null，RESEARCH_DECISION 未产出）"（D-B6-4）；
 * - bundleInvalidated（创作要求变更 → 下游 researchBundle 失效，旧 ref 仍在 artifacts 槽位）
 *   优先于 ready 判定：有失效标记就不能把作废资料包当现行内容展示。
 * - 调研问题计划只读（D-B6-1）；不做重新调研按钮（D-B6-6）。
 */

import type {
  GraphProgressProjectionDto,
  GraphRunSummaryDto,
  ResearchBundleDto,
  ResearchDepthDto,
  ResearchStateDto,
} from '@ai-novel/contracts';
import { journeyStageOf, type JourneyStage } from '../intake/intake-logic';

/**
 * 调研相位（判别联合；驱动 ResearchRegion 渲染）。
 *
 * - no-run：项目还没有 project run（尚未开始创作旅程）；
 * - not-started：run 存在，但 RESEARCH_DECISION 尚未产出决策（"尚未调研"）；
 * - skipped-none：RESEARCH_DECISION 判定本项目无需调研（"无需调研"，与 not-started 严格区分，D-B6-4）；
 * - running：调研正在执行中（存在在途 RESEARCH_RUN 任务，且搜索服务 key 已配置）；
 * - key-missing：存在在途 RESEARCH_RUN 任务，但缺搜索服务 key（任务保持 PENDING，D-B6-5）；
 * - stale：现行 bundleRef 指向的资料包已因创作要求变更失效，不得当作现行内容展示；
 * - ready：调研已产出有效资料包，可查看；
 * - invalid-retrying：调研校验判定无效，重试预算未耗尽（自动重试中）；
 * - escalation：调研无效且重试预算耗尽，RESEARCH_ESCALATION 等待人工决策；
 * - unsettled（B6 REWORK 复查随行修复）：RESEARCH_RUN 任务已 FAILED，但节点尚
 *   未 settle（Settlement/恢复机制会自动推进重试或升级）的瞬时窗口——此时兜底
 *   落到 not-started 会显示"尚未开始调研"，与"确实已经跑过一次但失败了"的事
 *   实相反，故单独给一个中性相位。
 */
export type ResearchPhase =
  | { readonly kind: 'no-run' }
  | { readonly kind: 'not-started' }
  | { readonly kind: 'skipped-none' }
  | { readonly kind: 'running' }
  | { readonly kind: 'key-missing' }
  | { readonly kind: 'stale'; readonly bundleRef: string }
  | { readonly kind: 'ready'; readonly bundleRef: string }
  | { readonly kind: 'invalid-retrying' }
  | { readonly kind: 'escalation' }
  | { readonly kind: 'unsettled' };

/**
 * 派生调研相位。
 *
 * 优先级（自上而下，命中即返回）：
 * 1. 无 run → no-run
 * 2. RESEARCH_ESCALATION 等待人工 → escalation（最紧急，需要用户立即行动）
 * 3. 有在途任务但缺 key → key-missing
 * 4. researchDecision === null → not-started（区分于 none）
 * 5. researchDecision === 'none' → skipped-none
 * 6. 有在途任务（key 已配置）→ running
 * 7. bundleInvalidated 且有 bundleRef → stale（优先于 ready；作废资料包不得当现行展示）
 * 8. researchValid === 'valid' 且有 bundleRef → ready
 * 9. researchValid === 'invalid' → invalid-retrying
 * 10. 兜底：hasFailedResearchTask（RESEARCH_RUN 任务已 FAILED，节点尚未
 *     settle 的瞬时窗口）→ unsettled（中性文案，不误报"尚未开始"）；
 *     否则 → not-started（如 decision 已产出但 plan/execute 尚未落地的瞬时态）
 */
export function deriveResearchPhase(
  state: ResearchStateDto | null,
  hasApiKey: boolean,
  pendingResearchTask: boolean,
  hasFailedResearchTask = false,
): ResearchPhase {
  if (!state || state.runId === null) return { kind: 'no-run' };
  if (state.escalationActive) return { kind: 'escalation' };
  if (pendingResearchTask && !hasApiKey) return { kind: 'key-missing' };
  if (state.researchDecision === null) return { kind: 'not-started' };
  if (state.researchDecision === 'none') return { kind: 'skipped-none' };
  if (pendingResearchTask) return { kind: 'running' };
  if (state.bundleInvalidated && state.bundleRef !== null) {
    return { kind: 'stale', bundleRef: state.bundleRef };
  }
  if (state.researchValid === 'valid' && state.bundleRef !== null) {
    return { kind: 'ready', bundleRef: state.bundleRef };
  }
  if (state.researchValid === 'invalid') return { kind: 'invalid-retrying' };
  if (hasFailedResearchTask) return { kind: 'unsettled' };
  return { kind: 'not-started' };
}

/** RESEARCH_ESCALATION 的用户可选项（domain 闭合枚举 ResearchEscalationDecision 的友好文案投影） */
export const RESEARCH_ESCALATION_OPTIONS: ReadonlyArray<{
  readonly outcome: string;
  readonly label: string;
  readonly description: string;
}> = [
  {
    outcome: 'use_current_research',
    label: '就用现在的调研结果',
    description: '不再重试，直接使用当前已有的调研资料继续',
  },
  {
    outcome: 'skip_research',
    label: '跳过调研，继续下一步',
    description: '放弃这次调研，后续创作不依赖调研资料',
  },
  {
    outcome: 'modify_requirements',
    label: '修改创作要求',
    description: '回到创作要求重新调整，调整后可能改变调研方向',
  },
  {
    outcome: 'continue_later',
    label: '稍后再说',
    description: '先停在这里；之后回来需重新决定',
  },
  {
    outcome: 'cancel',
    label: '取消这个项目的调研',
    description: '结束本次调研流程（项目保留）',
  },
];

/** 调研强度的中文说明（none 特别强调"无需"，避免与"尚未"混淆） */
export function depthLabel(depth: ResearchDepthDto): string {
  switch (depth) {
    case 'none':
      return '本项目无需调研';
    case 'light':
      return '轻度调研';
    case 'deep':
      return '深度调研';
    default: {
      const exhaustive: never = depth;
      return exhaustive;
    }
  }
}

function byCreatedAtThenId(a: ResearchBundleDto, b: ResearchBundleDto): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 按 basedOnBundleId 把资料包串成版本链（最早 → 最新）。
 *
 * - 无上游（basedOnBundleId 为 null，或指向集合外的 id）视为链起点；多条链之间、
 *   以及各链内的同层分支，均按 createdAt（同时间戳按 id）稳定排序；
 * - 防环：self-reference（basedOnBundleId === 自身 id）与多节点循环引用
 *   （如 A→B→A）都不会进入子节点表，最终由兜底逻辑按 createdAt 追加，
 *   保证不丢项、不死循环。
 */
export function orderBundleChain(bundles: ReadonlyArray<ResearchBundleDto>): ResearchBundleDto[] {
  const byId = new Map(bundles.map((b) => [b.id, b] as const));
  const childrenByParent = new Map<string, ResearchBundleDto[]>();
  const roots: ResearchBundleDto[] = [];

  for (const b of bundles) {
    const parentId = b.basedOnBundleId;
    if (parentId !== null && parentId !== b.id && byId.has(parentId)) {
      const list = childrenByParent.get(parentId) ?? [];
      list.push(b);
      childrenByParent.set(parentId, list);
    } else {
      roots.push(b);
    }
  }

  roots.sort(byCreatedAtThenId);
  for (const list of childrenByParent.values()) {
    list.sort(byCreatedAtThenId);
  }

  const result: ResearchBundleDto[] = [];
  const visited = new Set<string>();

  function walk(bundle: ResearchBundleDto): void {
    if (visited.has(bundle.id)) return; // 防环：已访问不重入
    visited.add(bundle.id);
    result.push(bundle);
    for (const child of childrenByParent.get(bundle.id) ?? []) {
      walk(child);
    }
  }

  for (const root of roots) {
    walk(root);
  }

  // 兜底：纯循环引用（无 root，如 A↔B 互指）不会被上面的遍历访问到——
  // 按 createdAt 追加剩余未访问项，保证不丢失、不死循环。
  const remaining = bundles.filter((b) => !visited.has(b.id));
  remaining.sort(byCreatedAtThenId);
  for (const b of remaining) {
    if (!visited.has(b.id)) {
      visited.add(b.id);
      result.push(b);
    }
  }

  return result;
}

/**
 * 由当前 project run 的 Graph 进度投影推导旅程阶段（D-B6-7：阶段回退检测）。
 *
 * RESEARCH_ESCALATION 并非只能停在 research 阶段——modify_requirements 回环到
 * SPEC_EXTRACT/COLLECT_ANSWER（stage 'clarify'）、use_current_research/skip_research
 * 前进到 BLUEPRINT_GENERATE（stage 'blueprint'）、cancel/continue_later/预算耗尽
 * 都落到终态 run。ResearchRegion 轮询本函数的结果并回报 App：一旦 frontier 不再是
 * 'research'，App 换回 IntakeRegion（其自身的 deriveIntakePhase 会据此再渲染出
 * 正确的相位——awaiting-answer/extracting/beyond-intake/terminal 皆已有对应处理）。
 *
 * - run 不存在，或已到终态（completed/failed/cancelled/blocked）→ 'idea'
 *   （交还 IntakeRegion：无 run 显示"还没有开始"，terminal 显示对应终态文案）；
 * - 否则取 waiting_for_human 节点（没有则取第一个 active 节点）的 stage 投影；
 * - 无任何 active 节点（节点间过渡的瞬时态）→ null，调用方应保留上一次已知阶段，
 *   不强行回退（避免瞬时态导致的阶段闪烁）。
 */
export function deriveResearchJourneyStage(
  run: GraphRunSummaryDto | null,
  progress: GraphProgressProjectionDto | null,
): JourneyStage | null {
  if (!run || run.terminalStatus !== null) return 'idea';
  if (!progress) return null;
  const waiting = progress.activeNodes.find((n) => n.status === 'waiting_for_human');
  const frontier = waiting ?? progress.activeNodes[0];
  if (!frontier) return null;
  return journeyStageOf(frontier.stage);
}
