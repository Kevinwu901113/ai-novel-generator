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
 * - escalation：改写预算耗尽，BLUEPRINT_ESCALATION 等待人工决策（四选项）。
 *   **必须带 blueprintRef 并展示正文**——四选项里第一条就是"就用现在这版蓝图"，
 *   让用户拍板一份他看不见的东西是不可接受的（与终态、失效同族的可达性缺口）；
 * - ready：蓝图已被接受，项目就绪（run 通常已 completed）；
 * - terminal：run 已终态但蓝图未被接受（blocked/cancelled，或 completed 的兜底）。
 *   **仍带 blueprintRef**：这一版蓝图已经生成出来了，只是没被确认就结束——不给看
 *   就又是一次"内容存在却不可达"（D-B6-10/D-B8-3 同族）。终态说明 + 只读展示，
 *   不给决策按钮（gate 没在等人工，提交必被后端拒）；
 * - not-started：run 存在但蓝图尚未产出（上游阶段仍在进行）。
 */
export type BlueprintPhase =
  | { readonly kind: 'no-run' }
  | { readonly kind: 'not-started' }
  | { readonly kind: 'generating' }
  | { readonly kind: 'stale'; readonly blueprintRef: string }
  | { readonly kind: 'gate'; readonly blueprintRef: string }
  | { readonly kind: 'escalation'; readonly blueprintRef: string | null }
  | { readonly kind: 'ready'; readonly blueprintRef: string }
  | {
      readonly kind: 'terminal';
      readonly status: RunTerminalStatusDto;
      /** 终态时若已产出蓝图则非空——只读展示用 */
      readonly blueprintRef: string | null;
    };

/**
 * 派生蓝图相位。优先级（自上而下，命中即返回）：
 *
 * 1. 无 run / runId 为空 → no-run
 * 2. escalationActive → escalation（预算耗尽，需要用户立即行动；带上 blueprintRef
 *    以便同屏展示待决策的那一版）
 * 3. gateActive 且蓝图已失效 → stale（失效优先于 gate：此时 accept 会被后端
 *    fail-closed 拒绝，UI 必须先禁用而不是让用户撞一次错误）
 * 4. gateActive → gate
 * 5. accepted 且有 blueprintRef → ready（项目就绪；即便 run 已 completed 也走这里，
 *    冷启动可直接看到已接受的蓝图，这是 D-B8-3 的验收点）
 * 6. run 已终态 → terminal（blocked/cancelled/failed：蓝图未被接受就结束；带上
 *    blueprintRef 以便只读展示已生成的那一版）。**终态必须先于非 gate 态的失效**
 *    （B8 独立复查坐实）：失效 run 一旦死掉（后续任务硬失败、二轮流程被取消等），
 *    "重新生成后才能确认"永远不会发生——那时 stale 横幅是对用户的无限期空等承诺，
 *    终态说明才是真相；
 * 7. 有在途 BLUEPRINT_GENERATE 任务 → generating。**先于非 gate 态的失效**：失效后
 *    的重新生成正在进行时，如实显示"正在生成"，而不是"需要重新生成后才能确认"
 *    （文案与事实矛盾，且压掉了进行中反馈）；
 * 8. 蓝图已失效且有 ref → stale（非 gate 态下的失效：等待新要求落盘、重新生成
 *    尚未排上——run 还活着，重新生成真的会来）
 * 9. 有 blueprintRef（已产出、未接受、gate 尚未激活的瞬时态）→ gate 兜底展示内容
 *    （决策按钮由 gateActive 单独把关，不随相位出现）
 * 10. 兜底 → not-started
 */
export function deriveBlueprintPhase(
  state: BlueprintStateDto | null,
  terminalStatus: RunTerminalStatusDto | null,
  pendingBlueprintTask: boolean,
): BlueprintPhase {
  if (!state || state.runId === null) return { kind: 'no-run' };
  if (state.escalationActive) {
    return { kind: 'escalation', blueprintRef: state.blueprintRef };
  }
  if (state.gateActive && state.blueprintInvalidated && state.blueprintRef !== null) {
    return { kind: 'stale', blueprintRef: state.blueprintRef };
  }
  if (state.gateActive && state.blueprintRef !== null) {
    return { kind: 'gate', blueprintRef: state.blueprintRef };
  }
  if (state.accepted && state.blueprintRef !== null) {
    return { kind: 'ready', blueprintRef: state.blueprintRef };
  }
  if (terminalStatus !== null) {
    return { kind: 'terminal', status: terminalStatus, blueprintRef: state.blueprintRef };
  }
  if (pendingBlueprintTask) return { kind: 'generating' };
  if (state.blueprintInvalidated && state.blueprintRef !== null) {
    return { kind: 'stale', blueprintRef: state.blueprintRef };
  }
  if (state.blueprintRef !== null) return { kind: 'gate', blueprintRef: state.blueprintRef };
  return { kind: 'not-started' };
}

/**
 * 相位是否应展示蓝图正文。
 *
 * 除 gate/ready 的常规展示外，还有三类"必须看得到"的场景，它们同属一个原则——
 * **不能让用户对着看不见的内容做决定或失去回看**：
 * - stale：要看到旧内容才能判断要不要重新生成；
 * - escalation：四选项第一条就是"就用现在这版蓝图"；
 * - terminal：那一版已经生成出来了，只是没被确认就结束。
 * 后三者都不给 gate 决策按钮（gate 并没有在等人工）。
 */
export function showsBlueprintContent(phase: BlueprintPhase): boolean {
  if (phase.kind === 'terminal' || phase.kind === 'escalation') {
    return phase.blueprintRef !== null;
  }
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

/**
 * gate 的 request_rewrite 按钮文案，随剩余次数变化（B8 独立复查坐实的 blocker）：
 *
 * Graph 的 gate→escalation 边要求"提交 request_rewrite 且预算已耗尽"才路由进
 * BLUEPRINT_ESCALATION——**耗尽后再提交一次 request_rewrite 是进入升级四选项的
 * 唯一入口**（domain transitions 测试自证，且 BLUEPRINT_ESCALATION 无其他入边）。
 * 故按钮在次数用尽时**绝不能禁用**（禁用会让 gate 变成死端：不满意又不想接受的
 * 用户没有任何出路；叠加失效时更是零可用操作），而是如实改写文案说明提交后走向。
 */
export function gateRewriteOptionCopy(remaining: number): {
  readonly label: string;
  readonly description: string;
} {
  if (remaining > 0) {
    const base = BLUEPRINT_GATE_OPTIONS.find((o) => o.outcome === 'request_rewrite');
    return { label: base?.label ?? '重新生成一版', description: base?.description ?? '' };
  }
  return {
    label: '不用这版，进入后续决策',
    description: '重新生成次数已用完；提交后由你决定：就用这版、修改创作要求、稍后再说或取消',
  };
}

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
    // 文案如实（B8 独立复查）：spec 调整额度也有上限（domain spec_revision 预算），
    // 耗尽时该选项直接把项目路由到"已搁置"终态，且 UI 拿不到该计数无从预警——
    // 不能许诺"会重新生成"。
    description: '回到创作要求重新调整；若还有调整额度，蓝图会按新要求重新生成，否则项目将转为搁置',
  },
  {
    outcome: 'continue_later',
    label: '稍后再说',
    // 文案如实（B8 独立复查）：continue_later 进 PROJECT_BLOCKED 终态，没有
    // "回来重新决定"的界面——继续的唯一出路是回"想法"阶段重新开始流程。
    description: '先停在这里，项目会转为已搁置；之后如需继续，要从"想法"阶段重新开始',
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
      // 不写"可以继续"——blocked 是终态，没有原地恢复的界面；如实的继续指引
      // （回"想法"阶段重新开始）由 BlueprintRegion 的终态卡片给出。
      return '项目已搁置';
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
