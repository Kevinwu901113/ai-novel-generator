/**
 * 双 Graph Walking Skeleton（GE-2）。
 *
 * 确定性 fake executors + 推进器：在 GraphRunService 之上按图驱动节点，
 * 直到遇到人工 Gate（waiting_for_human）或终态。用于：
 * - 完整跑通 Project Graph 与 Chapter Graph 全路径；
 * - 故障注入（失败 / 取消 / 预算耗尽 / 重启恢复）；
 * - GE-3 起逐节点替换为真实 executor。
 *
 * 约束：只通过 GraphRunService 的 Domain transition 推进，绝不直接拼装 Graph state；
 * 人工节点（CLARIFY_ANSWER / USER_GATE）由测试驱动 applyHumanDecision，fake 不代答。
 */

import type { AnyIdeaToNovelGraphV1, AnyIdeaToNovelRunState } from '@ai-novel/domain';
import type { AdvanceNodeInput, GraphRunDeps } from './graph-run.js';
import { advanceNode, getRunProgress } from './graph-run.js';

/** 真正的人工 Gate：只有这些 kind 必须经 applyHumanDecision 完成 */
function isHumanGateKind(kind: string): boolean {
  return kind === 'CLARIFY_ANSWER' || kind === 'USER_GATE';
}

// ── 确定性 fake 配置 ─────────────────────────────────────────────

/** 每个节点的 fake 行为覆盖 */
export interface FakeNodeBehavior {
  readonly outcome?: string;
  readonly artifactId?: string;
}

export type FakeExecutorConfig = Readonly<Record<string, FakeNodeBehavior>>;

/** 非人工、非预算条件的默认"快乐路径"取值 */
const DEFAULT_OUTCOME: Readonly<Record<string, string>> = {
  clarification_remaining: 'spec_complete',
  research_decision: 'none',
  research_valid: 'valid',
  critique_verdict: 'pass',
};

/**
 * 为节点产生确定性成功产物（读取节点输出契约，数据驱动）。
 * - 人工交互节点（CLARIFY_ANSWER / USER_GATE）与 JOIN 节点不应走到这里；
 * - 预算条件（X_budget）不是节点产出，不产生 outcome。
 */
export function fakeProducerForNode(
  graph: AnyIdeaToNovelGraphV1,
  nodeId: string,
  config: FakeExecutorConfig,
): {
  outcome?: { readonly condition: string; readonly value: string };
  artifactRef?: { readonly kind: string; readonly artifactId: string };
} {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`节点不存在: ${nodeId}`);
  if (isHumanGateKind(node.kind)) {
    throw new Error(`人工 Gate 节点 ${nodeId} 不能由 fake executor 完成`);
  }
  // JOIN 节点不接受调用方产物：由 domain 从策略来源确定性聚合，返回空产物即可
  if (node.joinAggregationPolicy) {
    return {};
  }

  const result: {
    outcome?: { readonly condition: string; readonly value: string };
    artifactRef?: { readonly kind: string; readonly artifactId: string };
  } = {};

  const condition = node.output.requiredOutcomeCondition;
  if (condition !== null) {
    const overridden = config[node.id]?.outcome;
    const value = overridden ?? DEFAULT_OUTCOME[condition];
    if (value !== undefined) {
      result.outcome = { condition, value };
    }
  }
  const kind = node.output.allowedArtifactKind;
  if (kind !== null) {
    result.artifactRef = {
      kind,
      artifactId: config[node.id]?.artifactId ?? `art-${node.id}`,
    };
  }
  return result;
}

// ── 推进器 ───────────────────────────────────────────────────────

export type RunFakeStop =
  | { readonly kind: 'terminal'; readonly state: AnyIdeaToNovelRunState }
  | { readonly kind: 'human'; readonly state: AnyIdeaToNovelRunState };

/**
 * 推进非人工节点直到人工 Gate 或终态。
 * 每次外层迭代重新读取状态；只推进当前 active 且非人工、非 JOIN 的节点；
 * 每个节点用唯一 idempotencyKey，保证可重放。
 */
export function runFakeUntilHumanOrTerminal(
  deps: GraphRunDeps,
  projectId: string,
  runId: string,
  config: FakeExecutorConfig,
): RunFakeStop {
  let step = 0;
  for (;;) {
    const state = getRunProgress(deps, { projectId, runId });
    if (state.terminalStatus !== null) return { kind: 'terminal', state };
    if (state.pendingHumanDecision !== null) return { kind: 'human', state };

    const graph = graphFor(deps, state.graphId);
    const nextActive = graph.nodes.find(
      (n) => state.nodeStatuses[n.id] === 'active' && !isHumanGateKind(n.kind),
    );
    if (!nextActive) {
      // 只剩人工节点但无 pending（图设计异常）：停止，交由调用方处理
      return { kind: 'human', state };
    }

    const product = fakeProducerForNode(graph, nextActive.id, config);
    const input: AdvanceNodeInput = {
      projectId,
      runId,
      nodeId: nextActive.id,
      idempotencyKey: `skeleton:${nextActive.id}:${step}`,
      ...(product.outcome !== undefined ? { outcome: product.outcome } : {}),
      ...(product.artifactRef !== undefined ? { artifactRef: product.artifactRef } : {}),
    };
    advanceNode(deps, input);
    step += 1;
  }
}

function graphFor(deps: GraphRunDeps, graphId: string): AnyIdeaToNovelGraphV1 {
  if (graphId === deps.projectGraph.id) return deps.projectGraph;
  if (graphId === deps.chapterGraph.id) return deps.chapterGraph;
  throw new Error(`未知 graphId: ${graphId}`);
}
