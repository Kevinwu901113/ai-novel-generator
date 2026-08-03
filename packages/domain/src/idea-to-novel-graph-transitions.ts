/**
 * @ai-novel/domain - Idea-to-Novel Graph Pure Transition Functions
 *
 * 纯函数，不访问时间、UUID、文件系统、数据库或模型。
 *
 * 语义要点：
 * - `canTraverseEdge`：条件边是否成立（源节点成功 + 闭合条件匹配 + 预算可用/耗尽）；
 * - `routesFrom`：一个已成功源节点实际会走的边（有界循环优先于耗尽出口）；
 * - `computeNextFrontier`：从成功源出发，计算下一批应激活的节点；
 * - `applyNodeSuccess`：推进一个节点完成，维护 frontier / 预算 / loop 回环重置；
 * - `applyNodeFailure`：节点硬失败 → 运行终止 failed；
 * - `requestHumanDecision` / `applyHumanDecision`：人工中断节点的挂起与决议。
 *
 * 有界循环语义：
 * - loop-back 边声明 `{ budget, maxIterations }`；重入前预算 `used < maxIterations`；
 * - 重入 loop 时，把循环体（loop body）节点重置为 pending 并清除其产出，
 *   保证下一轮循环体内的节点（如三个 Critic）可以重新执行；
 * - 已消费边（`consumedEdges`）防止 loop 体外部（如 DRAFT→Critic）在循环回环时再次触发；
 * - 预算耗尽时走 `X_budget: exhausted` 出口。
 */

import {
  BUDGET_CONDITION_NAMES,
  BLUEPRINT_USER_GATE,
  budgetKeyForCondition,
  CANDIDATE_GATE,
  COLLECT_ANSWER,
  DRAFT,
  getLoopBudgetMax,
  isGraphConditionOutcome,
  isTerminalKind,
  type BlueprintGateDecision,
  type CandidateGateDecision,
  type GraphNodeId,
  type GraphNodeOutcome,
  type IdeaToNovelGraphEdgeDefinition,
  type IdeaToNovelGraphV1,
  type LoopBudgetConditionName,
  type LoopBudgetKey,
} from './idea-to-novel-graph.js';
import type {
  ArtifactRef,
  GraphRunTerminalStatus,
  HumanDecisionType,
  IdeaToNovelGraphRunState,
  PendingHumanDecision,
} from './idea-to-novel-graph-state.js';
import { applyArtifactChange } from './idea-to-novel-graph-invalidation.js';

// ── 节点成功推进选项 ────────────────────────────────────────────

export interface ApplyNodeSuccessOptions {
  /** 决策节点产出（闭合判别联合） */
  readonly outcome?: GraphNodeOutcome;
  /** 节点产生的权威 artifact 引用（同时触发级联失效） */
  readonly artifactRef?: ArtifactRef;
}

/** 人工决策输入（闭合判别联合） */
export type HumanDecisionInput =
  | {
      readonly nodeId: GraphNodeId;
      readonly decisionType: 'answer_question';
      readonly answer: string;
    }
  | {
      readonly nodeId: GraphNodeId;
      readonly decisionType: 'blueprint_gate';
      readonly outcome: BlueprintGateDecision;
    }
  | {
      readonly nodeId: GraphNodeId;
      readonly decisionType: 'candidate_gate';
      readonly outcome: CandidateGateDecision;
    };

/** 人工决策类型 → 节点（闭合映射，键使用导出的品牌常量） */
export const HUMAN_DECISION_TYPE_BY_NODE: Readonly<Record<string, HumanDecisionType>> = {
  [COLLECT_ANSWER]: 'answer_question',
  [BLUEPRINT_USER_GATE]: 'blueprint_gate',
  [CANDIDATE_GATE]: 'candidate_gate',
};

/**
 * 某些节点成功时重置的预算。
 *
 * - DRAFT 之后重设 rewrite / candidateRewrite（新一轮草稿获得全新的自动改写预算）；
 * - CANDIDATE_GATE 之后重设 rewrite（用户明确要求改写 = 新一轮评审，critique 改写预算刷新）。
 */
const BUDGET_RESETS_ON_NODE_SUCCESS: Readonly<Record<string, ReadonlyArray<LoopBudgetKey>>> = {
  [DRAFT]: ['rewrite', 'candidateRewrite'],
  [CANDIDATE_GATE]: ['rewrite'],
};

// ── 边条件判定 ──────────────────────────────────────────────────

function isBudgetConditionName(value: string): value is LoopBudgetConditionName {
  return BUDGET_CONDITION_NAMES.has(value as LoopBudgetConditionName);
}

function matchesBudgetState(
  graph: IdeaToNovelGraphV1,
  state: IdeaToNovelGraphRunState,
  budget: LoopBudgetKey,
  expected: string,
): boolean {
  const max = getLoopBudgetMax(graph, budget);
  if (max === null) return false;
  const used = state.attemptBudget[budget];
  if (expected === 'available') return used < max;
  if (expected === 'exhausted') return used >= max;
  return false;
}

/**
 * 判断某条边是否可走（源节点成功 + 条件匹配 + 预算可用/耗尽）。
 *
 * 不检查边是否已消费、也不处理 loop 优先级 —— 那是 frontier 层的职责。
 * 未知边 id 或条件不满足时返回 false（fail-closed，不抛异常）。
 */
export function canTraverseEdge(
  graph: IdeaToNovelGraphV1,
  state: IdeaToNovelGraphRunState,
  edgeId: string,
): boolean {
  const edge = graph.edges.find((e) => e.id === edgeId);
  if (!edge) return false;
  if (state.nodeStatuses[edge.from] !== 'succeeded') return false;

  if (edge.kind === 'fixed') {
    if (!edge.loop) return true;
    return matchesBudgetState(graph, state, edge.loop.budget, 'available');
  }

  const reqs = edge.requiredOutcomes;
  if (!reqs || reqs.length === 0) return false;
  for (const req of reqs) {
    if (isBudgetConditionName(req.condition)) {
      const budget = budgetKeyForCondition(req.condition);
      if (!budget) return false;
      if (!matchesBudgetState(graph, state, budget, req.expectedOutcome)) return false;
    } else {
      const outcome = state.nodeOutcomes[edge.from];
      if (!outcome) return false;
      if (outcome.condition !== req.condition) return false;
      if (outcome.value !== req.expectedOutcome) return false;
    }
  }
  if (edge.loop) {
    if (!matchesBudgetState(graph, state, edge.loop.budget, 'available')) return false;
  }
  return true;
}

// ── 路径可达性 ──────────────────────────────────────────────────

/**
 * 在"去掉其它 loop-back 边"的受限图上计算可达性。
 *
 * 只保留当前 loop 边 `currentLoopEdgeId`，去掉其它 loop-back 边，
 * 避免其它循环（如 regenerate / candidateRewrite）把循环体外节点拉进本循环体。
 */
function pathExistsRestricted(
  graph: IdeaToNovelGraphV1,
  from: GraphNodeId,
  to: GraphNodeId,
  currentLoopEdgeId: string,
): boolean {
  const seen = new Set<GraphNodeId>();
  const stack: GraphNodeId[] = [from];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (current === to) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of graph.edges) {
      if (edge.loop && edge.id !== currentLoopEdgeId) continue;
      if (edge.from === current && !seen.has(edge.to)) stack.push(edge.to);
    }
  }
  return false;
}

/**
 * 计算 loop-back 边 `source -> target` 的循环体节点。
 *
 * 循环体 = { N : N ≠ source 且存在受限路径 target→N 且存在受限路径 N→source }，
 * 其中受限路径忽略其它 loop-back 边。这些节点在重入循环时会被重置为 pending，
 * 以便下一轮重新执行（source 由 resetLoopBody 一并重置）。
 */
export function computeLoopBodyNodes(
  graph: IdeaToNovelGraphV1,
  source: GraphNodeId,
  target: GraphNodeId,
  currentLoopEdgeId: string,
): ReadonlyArray<GraphNodeId> {
  return graph.nodes
    .map((n) => n.id)
    .filter(
      (id) =>
        id !== source &&
        pathExistsRestricted(graph, target, id, currentLoopEdgeId) &&
        pathExistsRestricted(graph, id, source, currentLoopEdgeId),
    );
}

// ── 边消费与路由 ────────────────────────────────────────────────

/**
 * 一个已成功源节点实际会走的边。
 *
 * 优先级：
 * 1. 若存在可走的 loop-back 边（条件匹配 + 预算可用）→ 只返回这些 loop 边；
 * 2. 否则返回所有可走的非 loop 边（含 `X_budget: exhausted` 出口）。
 * 已消费边不参与。
 */
export function routesFrom(
  graph: IdeaToNovelGraphV1,
  state: IdeaToNovelGraphRunState,
  sourceId: GraphNodeId,
): ReadonlyArray<IdeaToNovelGraphEdgeDefinition> {
  if (state.nodeStatuses[sourceId] !== 'succeeded') return [];
  const candidates = graph.edges.filter(
    (e) =>
      e.from === sourceId &&
      !state.consumedEdges.includes(e.id) &&
      canTraverseEdge(graph, state, e.id),
  );
  const loopTaken = candidates.filter((e) => e.loop);
  return loopTaken.length > 0 ? loopTaken : candidates;
}

/** 边是否被来源实际走（用于 join 判定与 frontier 计算） */
export function isEdgeTaken(
  graph: IdeaToNovelGraphV1,
  state: IdeaToNovelGraphRunState,
  edgeId: string,
): boolean {
  const edge = graph.edges.find((e) => e.id === edgeId);
  if (!edge) return false;
  return routesFrom(graph, state, edge.from).some((e) => e.id === edgeId);
}

// ── Frontier 计算 ───────────────────────────────────────────────

/**
 * 计算下一批应激活的节点（仅返回 pending → 待激活）。
 *
 * - join 目标：全部 join 边可走（源成功，不看边消费）才激活；
 * - 非 join 目标：任一 incoming 边被实际走才激活；
 * - 无 incoming 的入口节点：仅在其为 pending 时返回。
 */
export function computeNextFrontier(
  graph: IdeaToNovelGraphV1,
  state: IdeaToNovelGraphRunState,
): ReadonlyArray<GraphNodeId> {
  const result: GraphNodeId[] = [];
  for (const node of graph.nodes) {
    if (state.nodeStatuses[node.id] !== 'pending') continue;
    const incoming = graph.edges.filter((e) => e.to === node.id);
    if (incoming.length === 0) {
      result.push(node.id);
      continue;
    }
    const joinIncoming = incoming.filter((e) => e.mode === 'join');
    if (joinIncoming.length > 0) {
      if (joinIncoming.every((e) => canTraverseEdge(graph, state, e.id))) result.push(node.id);
    } else if (incoming.some((e) => isEdgeTaken(graph, state, e.id))) {
      result.push(node.id);
    }
  }
  return result;
}

// ── 内部状态变更辅助 ────────────────────────────────────────────

function incrementBudget(
  state: IdeaToNovelGraphRunState,
  budget: LoopBudgetKey,
): IdeaToNovelGraphRunState {
  return {
    ...state,
    attemptBudget: { ...state.attemptBudget, [budget]: state.attemptBudget[budget] + 1 },
  };
}

function unconsumeEdges(
  state: IdeaToNovelGraphRunState,
  edgeIds: ReadonlyArray<string>,
): IdeaToNovelGraphRunState {
  const set = new Set(edgeIds);
  const remaining = state.consumedEdges.filter((id) => !set.has(id));
  return { ...state, consumedEdges: remaining };
}

function consumeEdges(
  state: IdeaToNovelGraphRunState,
  edgeIds: ReadonlyArray<string>,
): IdeaToNovelGraphRunState {
  const set = new Set(state.consumedEdges);
  for (const id of edgeIds) set.add(id);
  return { ...state, consumedEdges: [...set] };
}

/**
 * 重入 loop-back 边时重置循环体（含 loop 源节点）。
 *
 * - 循环体节点 + loop 源节点都重置为 pending 并清除产出，
 *   使下一轮循环内的节点（含源节点，如 RESEARCH_VALIDATE / CRITIQUE_JOIN）可以重新执行；
 * - 循环体内边（from/to 都在重置集合内）取消消费，使下一轮可重新触发；
 * - 循环体外进入循环体的边（如 DRAFT→Critic）保持消费，防止再次触发。
 */
function resetLoopBody(
  graph: IdeaToNovelGraphV1,
  state: IdeaToNovelGraphRunState,
  loopEdge: IdeaToNovelGraphEdgeDefinition,
): IdeaToNovelGraphRunState {
  const body = computeLoopBodyNodes(graph, loopEdge.from, loopEdge.to, loopEdge.id);
  const resetSet = new Set<GraphNodeId>([loopEdge.from, ...body]);
  const nodeStatuses = { ...state.nodeStatuses };
  const nodeOutcomes = { ...state.nodeOutcomes };
  for (const id of resetSet) {
    nodeStatuses[id] = 'pending';
    delete nodeOutcomes[id];
  }
  const internalEdgeIds = graph.edges
    .filter((e) => resetSet.has(e.from) && resetSet.has(e.to))
    .map((e) => e.id);
  return unconsumeEdges({ ...state, nodeStatuses, nodeOutcomes }, internalEdgeIds);
}

// ── 节点完成推进（内部共享）──────────────────────────────────────

function completeNode(
  graph: IdeaToNovelGraphV1,
  state: IdeaToNovelGraphRunState,
  nodeId: GraphNodeId,
  opts: ApplyNodeSuccessOptions,
): IdeaToNovelGraphRunState {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`节点不存在: ${nodeId}`);
  const status = state.nodeStatuses[nodeId];
  if (status !== 'active' && status !== 'waiting_for_human') {
    throw new Error(`节点 ${nodeId} 不在活跃 frontier，不能完成`);
  }

  let next: IdeaToNovelGraphRunState = {
    ...state,
    nodeStatuses: { ...state.nodeStatuses, [nodeId]: 'succeeded' },
  };
  if (opts.outcome) {
    next = { ...next, nodeOutcomes: { ...next.nodeOutcomes, [nodeId]: opts.outcome } };
  }
  if (opts.artifactRef) {
    next = applyArtifactChange(next, opts.artifactRef);
  }

  // 节点成功触发的预算重置（DRAFT 之后重设 rewrite / candidateRewrite）
  const resets = BUDGET_RESETS_ON_NODE_SUCCESS[nodeId];
  if (resets) {
    const budget = { ...next.attemptBudget };
    for (const key of resets) budget[key] = 0;
    next = { ...next, attemptBudget: budget };
  }

  // 该节点实际走的边（loop 优先，基于 reset 前状态判定）
  const routes = routesFrom(graph, next, nodeId);

  // 重入有界循环：重置循环体 + 递增预算
  for (const route of routes) {
    if (route.loop) {
      next = resetLoopBody(graph, next, route);
      next = incrementBudget(next, route.loop.budget);
    }
  }

  // 先计算下一批待激活节点（此时边尚未消费，routesFrom 能看见本次走的边）
  const ready = new Set<GraphNodeId>(computeNextFrontier(graph, next));
  // loop 目标必须显式进入（预算可能在递增后耗尽，computeNextFrontier 不再包含）
  for (const route of routes) {
    if (route.loop) ready.add(route.to);
  }

  // 消费本次实际走的边（loop-back 边永不消费，否则下一轮无法再次触发；
  // 循环体内其它边由 resetLoopBody 在重入时统一取消消费）
  next = consumeEdges(
    next,
    routes.filter((r) => !r.loop).map((r) => r.id),
  );

  // 更新 frontier：移除已完成节点，加入待激活节点
  const nodeStatuses = { ...next.nodeStatuses };
  const frontier = new Set<GraphNodeId>(next.activeFrontier);
  frontier.delete(nodeId);
  for (const id of ready) {
    frontier.add(id);
    nodeStatuses[id] = 'active';
  }

  next = { ...next, nodeStatuses, activeFrontier: [...frontier] };

  if (isTerminalKind(node.kind)) {
    return { ...next, activeFrontier: [], terminalStatus: 'completed' };
  }
  return next;
}

// ── 公开 Transition 函数 ────────────────────────────────────────

/**
 * 应用一次节点成功。
 *
 * - 人工交互节点（CLARIFY_ANSWER / USER_GATE）必须走 applyHumanDecision；
 * - 其余节点直接推进。
 */
export function applyNodeSuccess(
  graph: IdeaToNovelGraphV1,
  state: IdeaToNovelGraphRunState,
  nodeId: GraphNodeId,
  opts?: ApplyNodeSuccessOptions,
): IdeaToNovelGraphRunState {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`节点不存在: ${nodeId}`);
  if (node.kind === 'CLARIFY_ANSWER' || node.kind === 'USER_GATE') {
    throw new Error(`人工交互节点 ${nodeId} 必须通过 requestHumanDecision/applyHumanDecision 完成`);
  }
  return completeNode(graph, state, nodeId, opts ?? {});
}

/**
 * 应用一次节点失败（硬失败）。
 *
 * 失败即终止整个 run（terminalStatus = failed）。V1 不做节点级自动重试；
 * 可重试的"调研校验失败"通过 `research_valid: invalid` 条件边回环表达。
 */
export function applyNodeFailure(
  graph: IdeaToNovelGraphV1,
  state: IdeaToNovelGraphRunState,
  nodeId: GraphNodeId,
): IdeaToNovelGraphRunState {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`节点不存在: ${nodeId}`);
  const status = state.nodeStatuses[nodeId];
  if (status !== 'active' && status !== 'waiting_for_human') {
    throw new Error(`节点 ${nodeId} 不在活跃 frontier，不能 applyNodeFailure`);
  }
  return {
    ...state,
    nodeStatuses: { ...state.nodeStatuses, [nodeId]: 'failed' },
    activeFrontier: [],
    pendingHumanDecision: null,
    terminalStatus: 'failed',
  };
}

/**
 * 请求一次人工决策：把人工交互节点挂起为 waiting_for_human。
 */
export function requestHumanDecision(
  graph: IdeaToNovelGraphV1,
  state: IdeaToNovelGraphRunState,
  nodeId: GraphNodeId,
  decisionType: HumanDecisionType,
): IdeaToNovelGraphRunState {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`节点不存在: ${nodeId}`);
  if (state.nodeStatuses[nodeId] !== 'active') {
    throw new Error(`节点 ${nodeId} 不在活跃 frontier，不能请求人工决策`);
  }
  if (state.pendingHumanDecision !== null) {
    throw new Error('已存在待处理的人工决策');
  }
  const expected = HUMAN_DECISION_TYPE_BY_NODE[nodeId];
  if (!expected || expected !== decisionType) {
    throw new Error(`节点 ${nodeId} 的人工决策类型应为 ${String(expected)}`);
  }
  const pending: PendingHumanDecision = { nodeId, decisionType };
  return {
    ...state,
    nodeStatuses: { ...state.nodeStatuses, [nodeId]: 'waiting_for_human' },
    pendingHumanDecision: pending,
  };
}

function assertGateOutcome(condition: 'blueprint_gate' | 'candidate_gate', value: unknown): void {
  if (!isGraphConditionOutcome(condition, value)) {
    throw new Error(`人工门禁决策非法: ${condition} = ${String(value)}`);
  }
}

/**
 * 应用一次人工决策，把人工交互节点完成。
 */
export function applyHumanDecision(
  graph: IdeaToNovelGraphV1,
  state: IdeaToNovelGraphRunState,
  decision: HumanDecisionInput,
): IdeaToNovelGraphRunState {
  const pending = state.pendingHumanDecision;
  if (!pending) throw new Error('没有待处理的人工决策');
  if (pending.nodeId !== decision.nodeId) {
    throw new Error(`决策节点不匹配: 期望 ${pending.nodeId}，收到 ${decision.nodeId}`);
  }
  if (pending.decisionType !== decision.decisionType) {
    throw new Error(`决策类型不匹配: 期望 ${pending.decisionType}，收到 ${decision.decisionType}`);
  }

  let opts: ApplyNodeSuccessOptions = {};
  if (decision.decisionType === 'answer_question') {
    // 回答内容为数据，不进共享状态；仅推进节点
  } else if (decision.decisionType === 'blueprint_gate') {
    assertGateOutcome('blueprint_gate', decision.outcome);
    opts = { outcome: { condition: 'blueprint_gate', value: decision.outcome } };
  } else {
    assertGateOutcome('candidate_gate', decision.outcome);
    opts = { outcome: { condition: 'candidate_gate', value: decision.outcome } };
  }

  const cleared: IdeaToNovelGraphRunState = { ...state, pendingHumanDecision: null };
  return completeNode(graph, cleared, decision.nodeId, opts);
}

/**
 * 判断 run 是否终止（terminalStatus 已设置）。
 */
export function isRunTerminal(
  _graph: IdeaToNovelGraphV1,
  state: IdeaToNovelGraphRunState,
): boolean {
  return state.terminalStatus !== null;
}

/** 读取当前终止状态（测试辅助） */
export function terminalStatusOf(state: IdeaToNovelGraphRunState): GraphRunTerminalStatus | null {
  return state.terminalStatus;
}
