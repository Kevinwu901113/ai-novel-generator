/**
 * StoryBlueprint 旅程纯逻辑（B8，设计见 docs/development/b8-blueprint-ui-design.md）。
 *
 * 与 B4/B6 同一纪律：相位全部由后端 DTO（BlueprintStateDto + run 终态 + "是否存在
 * 在途 BLUEPRINT_GENERATE 任务"）驱动，renderer 不自行推导 Graph 语义，只做展示投影。
 */

import type {
  BlueprintStateDto,
  GraphProgressProjectionDto,
  RunTerminalStatusDto,
} from '@ai-novel/contracts';

/**
 * 蓝图是否正在生成中：BLUEPRINT_GENERATE 节点处于 active。
 *
 * 取自 App 探针已有的 progress 投影，而不是再起一条 tasks.list 轮询——
 * 节点 active 是 Graph 权威事实，任务在途只是它的实现细节（B6 需要 tasks.list
 * 是因为要区分 key-missing 导致的 PENDING，蓝图侧没有这个分叉）。
 */
export function hasActiveBlueprintGenerate(progress: GraphProgressProjectionDto | null): boolean {
  if (!progress) return false;
  return progress.activeNodes.some(
    (n) => n.nodeId === 'BLUEPRINT_GENERATE' && n.status === 'active',
  );
}

/**
 * 蓝图相位（判别联合；驱动 BlueprintRegion 渲染）。
 *
 * - no-run：项目还没有 project run；
 * - generating：BLUEPRINT_GENERATE 任务在途；
 * - stale：现行 blueprintRef 已因创作要求变更失效——**接受按钮必须禁用**
 *   （D-B8-4：后端 D-B7-8 会 fail-closed 抛 GRAPH_RUN_STATE_CONFLICT，UI 不靠报错），
 *   但仍降级展示旧内容，否则用户无从判断要不要重新生成；
 * - gate：BLUEPRINT_USER_GATE 等待人工确认（accept / request_rewrite）；
 * - escalation：改写预算耗尽，BLUEPRINT_ESCALATION 等待人工决策（四选项）；
 * - ready：蓝图已被接受，项目就绪（run 通常已 completed）；
 * - terminal：run 已终态但蓝图未被接受（blocked/cancelled，或 completed 的兜底）；
 * - not-started：run 存在但蓝图尚未产出（上游阶段仍在进行）。
 */
export type BlueprintPhase =
  | { readonly kind: 'no-run' }
  | { readonly kind: 'not-started' }
  | { readonly kind: 'generating' }
  | { readonly kind: 'stale'; readonly blueprintRef: string }
  | { readonly kind: 'gate'; readonly blueprintRef: string }
  | { readonly kind: 'escalation' }
  | { readonly kind: 'ready'; readonly blueprintRef: string }
  | { readonly kind: 'terminal'; readonly status: RunTerminalStatusDto };

/**
 * 派生蓝图相位。优先级（自上而下，命中即返回）：
 *
 * 1. 无 run / runId 为空 → no-run
 * 2. escalationActive → escalation（预算耗尽，需要用户立即行动）
 * 3. gateActive 且蓝图已失效 → stale（失效优先于 gate：此时 accept 会被后端
 *    fail-closed 拒绝，UI 必须先禁用而不是让用户撞一次错误）
 * 4. gateActive → gate
 * 5. accepted 且有 blueprintRef → ready（项目就绪；即便 run 已 completed 也走这里，
 *    冷启动可直接看到已接受的蓝图，这是 D-B8-3 的验收点）
 * 6. 蓝图已失效且有 ref → stale（非 gate 态下的失效，如等待重新生成）
 * 7. run 已终态 → terminal（blocked/cancelled：蓝图未被接受就结束）
 * 8. 有在途 BLUEPRINT_GENERATE 任务 → generating
 * 9. 有 blueprintRef（已产出、未接受、gate 尚未激活的瞬时态）→ gate 兜底展示内容
 * 10. 兜底 → not-started
 */
export function deriveBlueprintPhase(
  state: BlueprintStateDto | null,
  terminalStatus: RunTerminalStatusDto | null,
  pendingBlueprintTask: boolean,
): BlueprintPhase {
  if (!state || state.runId === null) return { kind: 'no-run' };
  if (state.escalationActive) return { kind: 'escalation' };
  if (state.gateActive && state.blueprintInvalidated && state.blueprintRef !== null) {
    return { kind: 'stale', blueprintRef: state.blueprintRef };
  }
  if (state.gateActive && state.blueprintRef !== null) {
    return { kind: 'gate', blueprintRef: state.blueprintRef };
  }
  if (state.accepted && state.blueprintRef !== null) {
    return { kind: 'ready', blueprintRef: state.blueprintRef };
  }
  if (state.blueprintInvalidated && state.blueprintRef !== null) {
    return { kind: 'stale', blueprintRef: state.blueprintRef };
  }
  if (terminalStatus !== null) return { kind: 'terminal', status: terminalStatus };
  if (pendingBlueprintTask) return { kind: 'generating' };
  if (state.blueprintRef !== null) return { kind: 'gate', blueprintRef: state.blueprintRef };
  return { kind: 'not-started' };
}

/** 相位是否应展示蓝图正文（含失效降级展示） */
export function showsBlueprintContent(phase: BlueprintPhase): boolean {
  return phase.kind === 'stale' || phase.kind === 'gate' || phase.kind === 'ready';
}

/**
 * BLUEPRINT_USER_GATE 的用户可选项（domain 闭合枚举 BlueprintGateDecision 的投影）。
 *
 * D-B8-7：request_rewrite **不承载改写意见**（TD-029-1）——`BLUEPRINT_GENERATE.input`
 * 不含 storyBlueprint、模型也拿不到上一版做对比，只加输入框而后端不消费是空承诺。
 * 故文案如实写"将重新生成一版蓝图"，不暗示能定向修改。
 */
export const BLUEPRINT_GATE_OPTIONS: ReadonlyArray<{
  readonly outcome: 'accept' | 'request_rewrite';
  readonly label: string;
  readonly description: string;
}> = [
  {
    outcome: 'accept',
    label: '接受这份蓝图',
    description: '确认后项目进入就绪状态，可以开始逐章生成',
  },
  {
    outcome: 'request_rewrite',
    label: '重新生成一版',
    description: '按当前创作要求与调研资料重新生成一版蓝图（不能定向修改某一处）',
  },
];

/** BLUEPRINT_ESCALATION 的用户可选项（domain 闭合枚举 EscalationDecision 的投影） */
export const BLUEPRINT_ESCALATION_OPTIONS: ReadonlyArray<{
  readonly outcome: string;
  readonly label: string;
  readonly description: string;
}> = [
  {
    outcome: 'accept_current',
    label: '就用现在这版蓝图',
    description: '不再重新生成，直接接受当前蓝图并进入就绪状态',
  },
  {
    outcome: 'modify_requirements',
    label: '修改创作要求',
    description: '回到创作要求重新调整；调整后蓝图会按新要求重新生成',
  },
  {
    outcome: 'continue_later',
    label: '稍后再说',
    description: '先停在这里；之后回来需重新决定',
  },
  {
    outcome: 'cancel',
    label: '取消这个项目的蓝图',
    description: '结束本次蓝图流程（项目与已有内容保留）',
  },
];

/** run 终态的中文说明（三终态各自文案，D-B8-3） */
export function terminalStatusLabel(status: RunTerminalStatusDto): string {
  switch (status) {
    case 'completed':
      return '项目已就绪';
    case 'blocked':
      return '项目已搁置，可以继续';
    case 'cancelled':
      return '项目流程已取消';
    case 'failed':
      return '项目流程失败';
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/** 剩余改写次数（上限见 Graph 的 attemptBudget.blueprintRewrite 预算） */
export const BLUEPRINT_REWRITE_LIMIT = 3;

export function rewriteRemaining(rewriteUsed: number): number {
  return Math.max(0, BLUEPRINT_REWRITE_LIMIT - rewriteUsed);
}
