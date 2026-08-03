/**
 * @ai-novel/domain - Idea-to-Novel Graph Pure Transition Functions
 *
 * 纯函数，不访问时间、UUID、文件系统、数据库或模型。
 *
 * 执行语义全部从 Graph Definition 读取（节点输出契约 / humanDecisionType /
 * budgetResetPolicy / joinAggregationPolicy / terminalStatus），Graph 外部不持有权威映射。
 *
 * 两种 Graph（Project / Chapter）共用同一套转移机器：
 * - `assertValidTransitionState` 依据 graphId/version 匹配拒绝把 Project state 传给 Chapter
 *   transition（反之亦然）；
 * - `canTraverseEdge`：条件边是否成立（源节点成功 + 闭合条件匹配 + 预算可用/耗尽）；
 * - `routesFrom`：一个已成功源节点实际会走的边（有界循环优先于耗尽出口）；
 * - `computeNextFrontier`：从成功源出发，计算下一批应激活的节点；
 * - `aggregateJoinOutcome`：JOIN 节点从策略声明的来源确定性聚合结果，拒绝调用方伪造；
 * - `applyNodeSuccess`：推进一个节点完成，强制节点输出契约，维护 frontier / 预算 / loop 回环重置；
 * - `applyNodeFailure`：节点硬失败 → 运行终止 failed；
 * - `requestHumanDecision` / `applyHumanDecision`：人工中断节点的挂起与决议。
 *
 * Idea Intake 回答语义（凭证制，graph 不保存回答正文）：
 * - `intake_response` 决策是闭合判别联合：answer（必须带非空、trimmed 的持久化 answerId）/
 *   skip（跳过当前问题）/ finish（主动结束访谈）；
 * - 未来 Runtime 先把回答写入现有 Grill/Idea Intake 权威存储，取得 answerId，再推进 Graph transition；
 * - graph 拒绝空 answerId / 未持久化的原始文本作为完成证据。
 *
 * 有界循环语义：
 * - loop-back 边声明 `{ budget, maxIterations }`；重入前预算 `used < maxIterations`；
 * - 重入 loop 时，把循环体（loop body）节点重置为 pending 并清除其产出，
 *   保证下一轮循环体内的节点可以重新执行；
 * - 已消费边（`consumedEdges`）防止 loop 体外部在循环回环时再次触发；
 * - 预算耗尽时走 `X_budget: exhausted` 出口（人工升级节点，而非自动接受）。
 */

import {
  aggregateCritiqueVerdict,
  BUDGET_CONDITION_NAMES,
  budgetKeyForCondition,
  getLoopBudgetMax,
  isGraphConditionOutcome,
  isTerminalKind,
  type AnswerReceiptId,
  type AnyIdeaToNovelGraphV1,
  type BlueprintGateDecision,
  type CandidateGateDecision,
  type EscalationDecision,
  type GraphNodeId,
  type GraphNodeOutcome,
  type GraphRunTerminalStatus,
  type HumanDecisionType,
  type IdeaToNovelGraphEdgeDefinition,
  type IdeaToNovelGraphNodeDefinition,
  type IntakeAction,
  type IntakeEscalationDecision,
  type LoopBudgetConditionName,
  type LoopBudgetKey,
  type ResearchEscalationDecision,
} from './idea-to-novel-graph.js';
import type {
  AnyIdeaToNovelRunState,
  ArtifactRef,
  PendingHumanDecision,
} from './idea-to-novel-graph-state.js';
import { applyArtifactChange } from './idea-to-novel-graph-invalidation.js';
import { validateGraphRunState } from './idea-to-novel-graph-state-validation.js';

// ── 节点成功推进选项 ────────────────────────────────────────────

export interface ApplyNodeSuccessOptions {
  /** 决策节点产出（闭合判别联合）—— JOIN 节点不接受调用方提供 */
  readonly outcome?: GraphNodeOutcome;
  /** 节点产生的权威 artifact 引用（同时触发级联失效） */
  readonly artifactRef?: ArtifactRef;
}

/**
 * Idea Intake 回答决策（凭证制，原子事务 receipt）。
 *
 * - answer：必须带非空、trimmed 的 `answerId`（`AnswerReceiptId`）。Graph 只记录持久化凭证，
 *   不记录回答正文。原子事务 receipt 契约：未来 Runtime 先把回答写入现有 Grill/Idea Intake
 *   权威存储（同一事务持久化提交），取得 receipt 后再推进 Graph transition；
 *   graph 拒绝空 receipt / 未持久化的原始文本作为完成证据。
 * - skip：不需要 answerId，表示用户跳过当前问题。
 * - finish：不需要 answerId，表示用户主动结束访谈。
 */
export type IntakeHumanDecision =
  | {
      readonly nodeId: GraphNodeId;
      readonly decisionType: 'intake_response';
      readonly action: 'answer';
      readonly answerId: AnswerReceiptId;
    }
  | {
      readonly nodeId: GraphNodeId;
      readonly decisionType: 'intake_response';
      readonly action: 'skip';
    }
  | {
      readonly nodeId: GraphNodeId;
      readonly decisionType: 'intake_response';
      readonly action: 'finish';
    };

/** 人工升级决策取值（含各升级节点的闭合枚举） */
export type EscalationDecisionOutcome =
  EscalationDecision | IntakeEscalationDecision | ResearchEscalationDecision;

/** 人工决策输入（闭合判别联合） */
export type HumanDecisionInput =
  | IntakeHumanDecision
  | {
      readonly nodeId: GraphNodeId;
      readonly decisionType: 'blueprint_gate';
      readonly outcome: BlueprintGateDecision;
    }
  | {
      readonly nodeId: GraphNodeId;
      readonly decisionType: 'candidate_gate';
      readonly outcome: CandidateGateDecision;
    }
  | {
      readonly nodeId: GraphNodeId;
      readonly decisionType: 'escalation';
      readonly outcome: EscalationDecisionOutcome;
    };

// ── 前置不变量（公开 transition 先验证）──────────────────────────

/**
 * 公开 transition 的前置不变量：复用权威 graph-aware 状态校验。
 * 非法 state 直接抛错（fail-closed，不部分推进）；run 已终止时拒绝继续推进。
 * graphId/version 匹配由 `validateGraphRunState` 强制：Project state 传给 Chapter
 * transition（或反之）会在 graph 身份校验处失败。
 */
export function assertValidTransitionState(
  graph: AnyIdeaToNovelGraphV1,
  state: AnyIdeaToNovelRunState,
): void {
  const errors = validateGraphRunState(graph, state);
  if (errors.length > 0) {
    throw new Error(`非法运行状态: ${errors.map((e) => e.message).join('; ')}`);
  }
  if (state.terminalStatus !== null) {
    throw new Error('run 已终止，不能继续推进');
  }
}

// ── 边条件判定 ──────────────────────────────────────────────────

function isBudgetConditionName(value: string): value is LoopBudgetConditionName {
  return BUDGET_CONDITION_NAMES.has(value as LoopBudgetConditionName);
}

function isTrimmedNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

/**
 * 读取状态预算计数（宽松视图）。
 *
 * 状态类型把 attemptBudget 拆成各 Graph 的预算键子集；transition 中出现的预算键
 * 都来自本图 loop 边（graph-aware validator 保证 ∈ graph.budgetKeys ⊆ 状态预算键），
 * 因此对完整 LoopBudgetKey 视图的读取是安全的。
 */
function attemptBudgetOf(state: AnyIdeaToNovelRunState): Readonly<Record<LoopBudgetKey, number>> {
  return state.attemptBudget as Readonly<Record<LoopBudgetKey, number>>;
}

function matchesBudgetState(
  graph: AnyIdeaToNovelGraphV1,
  state: AnyIdeaToNovelRunState,
  budget: LoopBudgetKey,
  expected: string,
): boolean {
  const max = getLoopBudgetMax(graph, budget);
  if (max === null) return false;
  const used = attemptBudgetOf(state)[budget];
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
  graph: AnyIdeaToNovelGraphV1,
  state: AnyIdeaToNovelRunState,
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

function pathExistsRestricted(
  graph: AnyIdeaToNovelGraphV1,
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
  graph: AnyIdeaToNovelGraphV1,
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
  graph: AnyIdeaToNovelGraphV1,
  state: AnyIdeaToNovelRunState,
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
  graph: AnyIdeaToNovelGraphV1,
  state: AnyIdeaToNovelRunState,
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
  graph: AnyIdeaToNovelGraphV1,
  state: AnyIdeaToNovelRunState,
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

// ── JOIN 确定性聚合 ─────────────────────────────────────────────

/**
 * 从 joinAggregationPolicy 声明的来源确定性聚合 JOIN 节点结果。
 *
 * - 来源必须恰好为策略声明的集合、无重复、每个来源都产出指定 condition；
 * - 三个 source 必须都 succeeded —— 拒绝仅注入 nodeOutcomes 的伪造 state；
 * - 必须对应三条已满足的 join incoming edge（来源逐一对应）；
 * - 空数组 / 缺项 / 重复来源 / 非法 outcome 一律 fail-closed（抛错）；
 * - 全 pass 才 pass，否则 needs_rewrite。
 */
export function aggregateJoinOutcome(
  graph: AnyIdeaToNovelGraphV1,
  state: AnyIdeaToNovelRunState,
  joinNodeId: GraphNodeId,
): GraphNodeOutcome {
  const node = graph.nodes.find((n) => n.id === joinNodeId);
  if (!node) throw new Error(`join 节点不存在: ${joinNodeId}`);
  const policy = node.joinAggregationPolicy;
  if (!policy) throw new Error(`join 节点 ${joinNodeId} 缺少 joinAggregationPolicy`);
  if (policy.kind !== 'critique_verdict') {
    throw new Error(`join 节点 ${joinNodeId} 的聚合策略不支持: ${policy.kind}`);
  }
  if (policy.rule !== 'all_pass_or_needs_rewrite') {
    throw new Error(`join 节点 ${joinNodeId} 的聚合规则不支持: ${policy.rule}`);
  }
  const sources = [...policy.sources];
  if (sources.length !== 3) {
    throw new Error(`join ${joinNodeId} 来源数量必须恰好为 3，实际 ${sources.length}`);
  }
  if (new Set(sources).size !== sources.length) {
    throw new Error(`join ${joinNodeId} 来源不允许重复`);
  }
  // 三个 source 必须都 succeeded —— 防仅注入 nodeOutcomes 的伪造 state
  for (const src of sources) {
    if (state.nodeStatuses[src] !== 'succeeded') {
      throw new Error(`join 来源 ${src} 未 succeeded，拒绝伪造 state`);
    }
  }
  // 必须对应三条已满足的 join incoming edge（来源逐一对应）
  const joinIncoming = graph.edges.filter((e) => e.to === joinNodeId && e.mode === 'join');
  if (joinIncoming.length !== sources.length) {
    throw new Error(`join ${joinNodeId} 的 join 入边数 ${joinIncoming.length} 与策略来源数不符`);
  }
  const joinSourceSet = new Set(joinIncoming.map((e) => e.from));
  for (const src of sources) {
    if (!joinSourceSet.has(src)) {
      throw new Error(`join 来源 ${src} 不在 join 入边中`);
    }
  }
  const criticOutcomes: GraphNodeOutcome[] = [];
  for (const src of sources) {
    const outcome = state.nodeOutcomes[src];
    if (!outcome) throw new Error(`join 来源 ${src} 缺少产出`);
    if (outcome.condition !== 'critique_verdict') {
      throw new Error(`join 来源 ${src} 的 condition 非法: ${outcome.condition}`);
    }
    criticOutcomes.push(outcome);
  }
  return { condition: 'critique_verdict', value: aggregateCritiqueVerdict(criticOutcomes) };
}

// ── 内部状态变更辅助 ────────────────────────────────────────────

function incrementBudget<S extends AnyIdeaToNovelRunState>(state: S, budget: LoopBudgetKey): S {
  const current = attemptBudgetOf(state);
  const nextBudget = {
    ...current,
    [budget]: current[budget] + 1,
  } as S['attemptBudget'];
  return { ...state, attemptBudget: nextBudget };
}

function unconsumeEdges<S extends AnyIdeaToNovelRunState>(
  state: S,
  edgeIds: ReadonlyArray<string>,
): S {
  const set = new Set(edgeIds);
  const remaining = state.consumedEdges.filter((id) => !set.has(id));
  return { ...state, consumedEdges: remaining };
}

function consumeEdges<S extends AnyIdeaToNovelRunState>(
  state: S,
  edgeIds: ReadonlyArray<string>,
): S {
  const set = new Set(state.consumedEdges);
  for (const id of edgeIds) set.add(id);
  return { ...state, consumedEdges: [...set] };
}

/**
 * 重入 loop-back 边时重置循环体（含 loop 源节点）。
 *
 * - 循环体节点 + loop 源节点都重置为 pending 并清除产出，
 *   使下一轮循环内的节点（含源节点，如 SPEC_EXTRACT / RESEARCH_VALIDATE / CRITIQUE_JOIN）可以重新执行；
 * - 循环体内边（from/to 都在重置集合内）取消消费，使下一轮可重新触发；
 * - 循环体外进入循环体的边保持消费，防止再次触发。
 */
function resetLoopBody<S extends AnyIdeaToNovelRunState>(
  graph: AnyIdeaToNovelGraphV1,
  state: S,
  loopEdge: IdeaToNovelGraphEdgeDefinition,
): S {
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

// ── 输出契约校验 ────────────────────────────────────────────────

function assertOutcomeMatchesContract(
  node: IdeaToNovelGraphNodeDefinition,
  outcome: GraphNodeOutcome | undefined,
): void {
  const expected = node.output.requiredOutcomeCondition;
  if (expected === null) {
    if (outcome !== undefined) {
      throw new Error(`节点 ${node.id} 不接受多余 outcome`);
    }
    return;
  }
  if (outcome === undefined) throw new Error(`节点 ${node.id} 缺少必需 outcome: ${expected}`);
  if (outcome.condition !== expected) {
    throw new Error(
      `节点 ${node.id} 的 outcome 条件 ${outcome.condition} 与契约 ${expected} 不匹配`,
    );
  }
  if (!isGraphConditionOutcome(expected, outcome.value)) {
    throw new Error(`节点 ${node.id} 的 outcome 取值非法`);
  }
}

function assertArtifactMatchesContract(
  node: IdeaToNovelGraphNodeDefinition,
  artifactRef: ArtifactRef | undefined,
): void {
  const expected = node.output.allowedArtifactKind;
  if (expected === null) {
    if (artifactRef !== undefined) {
      throw new Error(`节点 ${node.id} 不允许产出 artifact`);
    }
    return;
  }
  if (artifactRef === undefined) throw new Error(`节点 ${node.id} 缺少必需 artifact: ${expected}`);
  if (artifactRef.kind !== expected) {
    throw new Error(
      `节点 ${node.id} 的 artifact kind ${artifactRef.kind} 与契约 ${expected} 不匹配`,
    );
  }
}

// ── 节点完成推进（内部共享）──────────────────────────────────────

function completeNode<S extends AnyIdeaToNovelRunState>(
  graph: AnyIdeaToNovelGraphV1,
  state: S,
  nodeId: GraphNodeId,
  opts: ApplyNodeSuccessOptions,
): S {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`节点不存在: ${nodeId}`);
  const status = state.nodeStatuses[nodeId];
  if (status !== 'active' && status !== 'waiting_for_human') {
    throw new Error(`节点 ${nodeId} 不在活跃 frontier，不能完成`);
  }

  // JOIN 节点：不接受调用方伪造的 outcome，从策略来源确定性聚合
  let effectiveOutcome = opts.outcome;
  if (node.joinAggregationPolicy) {
    if (opts.outcome !== undefined) {
      throw new Error(`join 节点 ${nodeId} 不接受调用方伪造的 outcome`);
    }
    effectiveOutcome = aggregateJoinOutcome(graph, state, nodeId);
  }
  assertOutcomeMatchesContract(node, effectiveOutcome);
  assertArtifactMatchesContract(node, opts.artifactRef);

  let next: S = {
    ...state,
    nodeStatuses: { ...state.nodeStatuses, [nodeId]: 'succeeded' },
  };
  if (effectiveOutcome !== undefined) {
    next = { ...next, nodeOutcomes: { ...next.nodeOutcomes, [nodeId]: effectiveOutcome } };
  }
  if (opts.artifactRef) {
    next = applyArtifactChange(next, opts.artifactRef, graph.artifactDownstreamOrder);
  }

  // 节点成功触发的预算重置（执行语义来自 node.budgetResetPolicy）
  const resets = node.budgetResetPolicy ?? [];
  if (resets.length > 0) {
    const budget = { ...attemptBudgetOf(next) } as S['attemptBudget'];
    for (const key of resets) (budget as Record<LoopBudgetKey, number>)[key] = 0;
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
    return {
      ...next,
      activeFrontier: [],
      terminalStatus: node.terminalStatus ?? 'completed',
    };
  }
  return next;
}

// ── 公开 Transition 函数 ────────────────────────────────────────

/**
 * 应用一次节点成功。
 *
 * - 人工交互节点（CLARIFY_ANSWER / USER_GATE）必须走 applyHumanDecision；
 * - JOIN 节点结果由聚合策略计算，不接受调用方伪造；
 * - 强制节点输出契约。
 */
export function applyNodeSuccess<S extends AnyIdeaToNovelRunState>(
  graph: AnyIdeaToNovelGraphV1,
  state: S,
  nodeId: GraphNodeId,
  opts?: ApplyNodeSuccessOptions,
): S {
  assertValidTransitionState(graph, state);
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
 *
 * fan-out failure：失败节点 → failed；其它 active/waiting_for_human → cancelled；
 * frontier 清空；pendingHumanDecision 清空；失败节点清空 outcome；run 终止 failed。
 */
export function applyNodeFailure<S extends AnyIdeaToNovelRunState>(
  graph: AnyIdeaToNovelGraphV1,
  state: S,
  nodeId: GraphNodeId,
): S {
  assertValidTransitionState(graph, state);
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`节点不存在: ${nodeId}`);
  const status = state.nodeStatuses[nodeId];
  if (status !== 'active' && status !== 'waiting_for_human') {
    throw new Error(`节点 ${nodeId} 不在活跃 frontier，不能 applyNodeFailure`);
  }

  // fan-out failure：当前失败节点 → failed；其它 active/waiting_for_human → cancelled；
  // frontier 清空；pendingHumanDecision 清空；失败节点清空 outcome。
  const nodeStatuses = { ...state.nodeStatuses };
  for (const n of graph.nodes) {
    if (n.id === nodeId) {
      nodeStatuses[n.id] = 'failed';
    } else if (nodeStatuses[n.id] === 'active' || nodeStatuses[n.id] === 'waiting_for_human') {
      nodeStatuses[n.id] = 'cancelled';
    }
  }
  const nodeOutcomes = { ...state.nodeOutcomes };
  delete nodeOutcomes[nodeId];

  const next: S = {
    ...state,
    nodeStatuses,
    nodeOutcomes,
    activeFrontier: [],
    pendingHumanDecision: null,
    terminalStatus: 'failed',
  };
  // 输出状态必须通过权威 graph-aware 状态校验（terminal 状态用 validateGraphRunState）
  const validationErrors = validateGraphRunState(graph, next);
  if (validationErrors.length > 0) {
    throw new Error(
      `applyNodeFailure 产出非法状态: ${validationErrors.map((e) => e.message).join('; ')}`,
    );
  }
  return next;
}

/**
 * 请求一次人工决策：把人工交互节点挂起为 waiting_for_human。
 */
export function requestHumanDecision<S extends AnyIdeaToNovelRunState>(
  graph: AnyIdeaToNovelGraphV1,
  state: S,
  nodeId: GraphNodeId,
  decisionType: HumanDecisionType,
): S {
  assertValidTransitionState(graph, state);
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`节点不存在: ${nodeId}`);
  if (node.kind !== 'CLARIFY_ANSWER' && node.kind !== 'USER_GATE') {
    throw new Error(`节点 ${nodeId} 不是人工交互节点`);
  }
  if (state.nodeStatuses[nodeId] !== 'active') {
    throw new Error(`节点 ${nodeId} 不在活跃 frontier，不能请求人工决策`);
  }
  if (state.pendingHumanDecision !== null) {
    throw new Error('已存在待处理的人工决策');
  }
  if (node.humanDecisionType === undefined || node.humanDecisionType !== decisionType) {
    throw new Error(`节点 ${nodeId} 的人工决策类型应为 ${String(node.humanDecisionType)}`);
  }
  const pending: PendingHumanDecision = { nodeId, decisionType };
  return {
    ...state,
    nodeStatuses: { ...state.nodeStatuses, [nodeId]: 'waiting_for_human' },
    pendingHumanDecision: pending,
  };
}

/**
 * 应用一次人工决策，把人工交互节点完成。
 *
 * - `intake_response`：answer 必须带非空、trimmed 的持久化 answerId（凭证制）；
 *   skip / finish 不需要 answerId；产出 `intake_action` 结果由边条件路由。
 * - 门禁/升级节点：outcome 条件由节点输出契约（requiredOutcomeCondition）决定。
 */
export function applyHumanDecision<S extends AnyIdeaToNovelRunState>(
  graph: AnyIdeaToNovelGraphV1,
  state: S,
  decision: HumanDecisionInput,
): S {
  assertValidTransitionState(graph, state);
  const pending = state.pendingHumanDecision;
  if (!pending) throw new Error('没有待处理的人工决策');
  if (pending.nodeId !== decision.nodeId) {
    throw new Error(`决策节点不匹配: 期望 ${pending.nodeId}，收到 ${decision.nodeId}`);
  }
  if (pending.decisionType !== decision.decisionType) {
    throw new Error(`决策类型不匹配: 期望 ${pending.decisionType}，收到 ${decision.decisionType}`);
  }
  const node = graph.nodes.find((n) => n.id === decision.nodeId);
  if (!node) throw new Error(`节点不存在: ${decision.nodeId}`);
  if (node.humanDecisionType !== decision.decisionType) {
    throw new Error(
      `节点 ${node.id} 的 humanDecisionType 为 ${String(node.humanDecisionType)}，不接受 ${decision.decisionType}`,
    );
  }

  let opts: ApplyNodeSuccessOptions = {};
  if (decision.decisionType === 'intake_response') {
    // Idea Intake 回答：graph 只记录持久化凭证语义，不记录回答正文。
    // answer 必须带非空、trimmed 的 answerId（由 Runtime 先写入权威存储取得）；
    // 拒绝空 answer / 未持久化的原始文本作为完成证据。
    if (decision.action === 'answer' && !isTrimmedNonEmpty(decision.answerId)) {
      throw new Error('intake answer 必须带非空、trimmed 的持久化 answerId');
    }
    const intakeAction: IntakeAction = decision.action;
    opts = { outcome: { condition: 'intake_action', value: intakeAction } };
  } else {
    // 门禁 / 升级：outcome 条件来自节点输出契约
    const condition = node.output.requiredOutcomeCondition;
    if (condition === null) {
      throw new Error(`节点 ${node.id} 没有 requiredOutcomeCondition 却要求 outcome`);
    }
    if (!isGraphConditionOutcome(condition, decision.outcome)) {
      throw new Error(`决策取值非法: ${condition} = ${String(decision.outcome)}`);
    }
    // condition 已通过 isGraphConditionOutcome 校验，取值为对应闭合枚举成员
    opts = { outcome: { condition, value: decision.outcome } as GraphNodeOutcome };
  }

  const cleared: S = { ...state, pendingHumanDecision: null };
  return completeNode(graph, cleared, decision.nodeId, opts);
}

/**
 * 判断 run 是否终止（terminalStatus 已设置）。
 */
export function isRunTerminal(
  _graph: AnyIdeaToNovelGraphV1,
  state: AnyIdeaToNovelRunState,
): boolean {
  return state.terminalStatus !== null;
}

/** 读取当前终止状态（测试辅助） */
export function terminalStatusOf(state: AnyIdeaToNovelRunState): GraphRunTerminalStatus | null {
  return state.terminalStatus;
}
