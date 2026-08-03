/**
 * @ai-novel/domain - Idea-to-Novel Graph Definition Static Validator
 *
 * 对 Graph Definition 做静态校验，fail-closed：
 * 任何损坏定义都返回至少一条错误，绝不抛异常、绝不返回"有效"。
 *
 * 拒绝：
 * - 重复 node ID / edge ID；
 * - 不存在的 edge source/target；
 * - 不可达节点；
 * - 无合法出口的非终止节点；
 * - 没有 join 声明的 fan-in / join 声明不匹配 / join 与 exclusive 混入；
 * - 无最大次数的循环（SCC 无 loop 边）、loop 边不在环上、预算键重复、预算无耗尽出口；
 * - 未覆盖的条件枚举 / 空条件 / 固定边带条件 / 歧义条件；
 * - 非法 stage projection；
 * - 模型类节点缺 promptId 或引用未知 promptId；
 * - 人工交互节点缺决策类型映射。
 */

import {
  BUDGET_CONDITION_NAMES,
  GRAPH_CONDITION_OUTCOMES,
  isGraphConditionName,
  isGraphConditionOutcome,
  isGraphEdgeKind,
  isGraphEdgeMode,
  isGraphNodeImplementationKind,
  isKnownStablePromptId,
  isLoopBudgetKey,
  isPromptRequiredKind,
  isHumanInterruptKind,
  isTerminalKind,
  LOOP_BUDGET_CONDITION_BY_KEY,
  type GraphConditionName,
  type GraphNodeId,
  type GraphNodeImplementationKind,
  type IdeaToNovelGraphEdgeDefinition,
  type IdeaToNovelGraphNodeDefinition,
  type IdeaToNovelGraphV1,
  type LoopBudgetKey,
} from './idea-to-novel-graph.js';
import { HUMAN_DECISION_TYPE_BY_NODE } from './idea-to-novel-graph-transitions.js';
import { workflowStageForNodeId } from './idea-to-novel-graph-stages.js';

/** 校验错误码（闭合枚举） */
export type GraphValidationErrorCode =
  | 'MALFORMED_GRAPH'
  | 'DUPLICATE_NODE_ID'
  | 'DUPLICATE_EDGE_ID'
  | 'UNKNOWN_EDGE_SOURCE'
  | 'UNKNOWN_EDGE_TARGET'
  | 'UNKNOWN_ENTRY_NODE'
  | 'UNREACHABLE_NODE'
  | 'NO_LEGAL_EXIT'
  | 'MISSING_TERMINAL_NODE'
  | 'FAN_IN_WITHOUT_JOIN'
  | 'JOIN_DECLARATION_MISMATCH'
  | 'MIXED_JOIN_AND_EXCLUSIVE_INCOMING'
  | 'UNBOUNDED_CYCLE'
  | 'LOOP_EDGE_NOT_CYCLIC'
  | 'INVALID_LOOP_MAX'
  | 'DUPLICATE_LOOP_BUDGET'
  | 'MISSING_BUDGET_EXIT'
  | 'UNKNOWN_CONDITION'
  | 'UNKNOWN_CONDITION_OUTCOME'
  | 'EMPTY_CONDITIONAL_EDGE'
  | 'CONDITIONAL_OUTCOMES_ON_FIXED_EDGE'
  | 'AMBIGUOUS_EDGE_OUTCOMES'
  | 'MISSING_PROMPT_ID_FOR_MODEL_NODE'
  | 'UNKNOWN_PROMPT_ID'
  | 'MISSING_HUMAN_DECISION_TYPE'
  | 'INVALID_STAGE_PROJECTION'
  | 'INVALID_NODE_KIND'
  | 'INVALID_EDGE_KIND'
  | 'INVALID_EDGE_MODE'
  | 'UNCOVERED_CONDITION_OUTCOME';

/** 单条校验错误 */
export interface GraphValidationError {
  readonly code: GraphValidationErrorCode;
  readonly message: string;
  readonly nodeId?: GraphNodeId;
  readonly edgeId?: string;
}

function err(
  code: GraphValidationErrorCode,
  message: string,
  nodeId?: GraphNodeId,
  edgeId?: string,
): GraphValidationError {
  return { code, message, ...(nodeId ? { nodeId } : {}), ...(edgeId ? { edgeId } : {}) };
}

function requirementKey(edge: IdeaToNovelGraphEdgeDefinition): string {
  return (edge.requiredOutcomes ?? [])
    .map((r) => `${r.condition}=${r.expectedOutcome}`)
    .sort()
    .join('|');
}

function isReachable(graph: IdeaToNovelGraphV1, from: GraphNodeId): Set<GraphNodeId> {
  const seen = new Set<GraphNodeId>();
  const stack: GraphNodeId[] = [from];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    for (const edge of graph.edges) {
      if (edge.from === current && !seen.has(edge.to)) stack.push(edge.to);
    }
  }
  return seen;
}

/** SCC（Tarjan），用于无界循环检测 */
function stronglyConnectedComponents(
  graph: IdeaToNovelGraphV1,
): ReadonlyArray<ReadonlyArray<GraphNodeId>> {
  const index = new Map<GraphNodeId, number>();
  const low = new Map<GraphNodeId, number>();
  const onStack = new Set<GraphNodeId>();
  const stack: GraphNodeId[] = [];
  const components: GraphNodeId[][] = [];
  let counter = 0;

  const strongConnect = (v: GraphNodeId): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const edge of graph.edges) {
      if (edge.from !== v) continue;
      const w = edge.to;
      if (!index.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component: GraphNodeId[] = [];
      let w: GraphNodeId | undefined;
      do {
        w = stack.pop();
        if (w === undefined) break;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      components.push(component);
    }
  };

  for (const node of graph.nodes) {
    if (!index.has(node.id)) strongConnect(node.id);
  }
  return components;
}

/**
 * 校验 Graph Definition，返回错误列表（空数组 = 有效）。
 * fail-closed：损坏输入返回 MALFORMED_GRAPH，绝不抛异常。
 */
export function validateIdeaToNovelGraphV1(
  graph: IdeaToNovelGraphV1,
): ReadonlyArray<GraphValidationError> {
  if (!graph || typeof graph !== 'object') {
    return [err('MALFORMED_GRAPH', 'graph 不是对象')];
  }
  const nodes: ReadonlyArray<IdeaToNovelGraphNodeDefinition> = Array.isArray(graph.nodes)
    ? graph.nodes
    : [];
  const edges: ReadonlyArray<IdeaToNovelGraphEdgeDefinition> = Array.isArray(graph.edges)
    ? graph.edges
    : [];
  if (nodes.length === 0 || edges.length === 0 || typeof graph.entryNodeId !== 'string') {
    return [err('MALFORMED_GRAPH', 'nodes / edges / entryNodeId 缺失')];
  }

  const errors: GraphValidationError[] = [];
  const nodeIds = nodes.map((n) => n.id);

  // 入口节点存在
  if (!nodeIds.includes(graph.entryNodeId)) {
    errors.push(err('UNKNOWN_ENTRY_NODE', `入口节点不存在: ${String(graph.entryNodeId)}`));
  }

  // 1. 重复 node ID；node.kind 闭合枚举
  const seenNode = new Set<GraphNodeId>();
  for (const node of nodes) {
    if (seenNode.has(node.id)) {
      errors.push(err('DUPLICATE_NODE_ID', `重复节点: ${node.id}`, node.id));
    }
    seenNode.add(node.id);
    if (!isGraphNodeImplementationKind(node.kind)) {
      errors.push(
        err('INVALID_NODE_KIND', `节点 ${node.id} 的 kind 非法: ${String(node.kind)}`, node.id),
      );
    }
  }

  // 2. 重复 edge ID；edge source/target 存在；edge.kind / edge.mode 闭合枚举
  const seenEdge = new Set<string>();
  for (const edge of edges) {
    if (seenEdge.has(edge.id)) {
      errors.push(err('DUPLICATE_EDGE_ID', `重复边: ${edge.id}`, undefined, edge.id));
    }
    seenEdge.add(edge.id);
    if (!nodeIds.includes(edge.from)) {
      errors.push(err('UNKNOWN_EDGE_SOURCE', `边 ${edge.id} 的 source 不存在`, undefined, edge.id));
    }
    if (!nodeIds.includes(edge.to)) {
      errors.push(err('UNKNOWN_EDGE_TARGET', `边 ${edge.id} 的 target 不存在`, undefined, edge.id));
    }
    if (!isGraphEdgeKind(edge.kind)) {
      errors.push(
        err(
          'INVALID_EDGE_KIND',
          `边 ${edge.id} 的 kind 非法: ${String(edge.kind)}`,
          undefined,
          edge.id,
        ),
      );
    }
    if (!isGraphEdgeMode(edge.mode)) {
      errors.push(
        err(
          'INVALID_EDGE_MODE',
          `边 ${edge.id} 的 mode 非法: ${String(edge.mode)}`,
          undefined,
          edge.id,
        ),
      );
    }
  }

  // 3. 无合法出口的非终止节点（非终止节点必须有固定边或非预算条件出口）+ 4. join 声明
  for (const node of nodes) {
    const kind = node.kind as GraphNodeImplementationKind;
    const outgoing = edges.filter((e) => e.from === node.id);
    if (!isTerminalKind(kind)) {
      if (outgoing.length === 0) {
        errors.push(err('NO_LEGAL_EXIT', `非终止节点没有出口: ${node.id}`, node.id));
      } else {
        const hasNonBudgetExit = outgoing.some((e) => {
          if (e.kind === 'fixed') return true;
          return (e.requiredOutcomes ?? []).some((r) => !BUDGET_CONDITION_NAMES.has(r.condition));
        });
        if (!hasNonBudgetExit) {
          errors.push(
            err(
              'NO_LEGAL_EXIT',
              `非终止节点只有预算耗尽出口，可能永远无法满足: ${node.id}`,
              node.id,
            ),
          );
        }
      }
    }

    const incoming = edges.filter((e) => e.to === node.id);
    const joinIncoming = incoming.filter((e) => e.mode === 'join');
    const exclusiveIncoming = incoming.filter((e) => e.mode !== 'join');
    if (joinIncoming.length > 0 && exclusiveIncoming.length > 0) {
      errors.push(
        err(
          'MIXED_JOIN_AND_EXCLUSIVE_INCOMING',
          `节点 ${node.id} 同时有 join 与 exclusive 入边`,
          node.id,
        ),
      );
    }
    if (joinIncoming.length > 0 && !node.join) {
      errors.push(err('FAN_IN_WITHOUT_JOIN', `节点 ${node.id} 有 join 入边但未声明 join`, node.id));
    }
    if (node.join) {
      if (joinIncoming.length !== node.join.requiredIncoming || node.join.requiredIncoming < 2) {
        errors.push(
          err(
            'JOIN_DECLARATION_MISMATCH',
            `节点 ${node.id} join 声明 ${String(node.join.requiredIncoming)} 与实际 join 入边数 ${joinIncoming.length} 不符`,
            node.id,
          ),
        );
      }
    }
  }

  // 5. 循环：有界性与预算
  const budgetLoopEdges = new Map<LoopBudgetKey, string>();
  for (const edge of edges) {
    if (!edge.loop) continue;
    if (!isLoopBudgetKey(edge.loop.budget)) {
      errors.push(err('INVALID_LOOP_MAX', `边 ${edge.id} 的 loop.budget 非法`, undefined, edge.id));
      continue;
    }
    if (!Number.isSafeInteger(edge.loop.maxIterations) || edge.loop.maxIterations < 1) {
      errors.push(
        err('INVALID_LOOP_MAX', `边 ${edge.id} 的 maxIterations 非法`, undefined, edge.id),
      );
    }
    const prev = budgetLoopEdges.get(edge.loop.budget);
    if (prev !== undefined) {
      errors.push(
        err(
          'DUPLICATE_LOOP_BUDGET',
          `预算 ${edge.loop.budget} 同时用于边 ${prev} 与 ${edge.id}`,
          undefined,
          edge.id,
        ),
      );
    }
    budgetLoopEdges.set(edge.loop.budget, edge.id);
    // loop 边必须在环上
    const reachableFromTarget = isReachable(graph, edge.to);
    if (!reachableFromTarget.has(edge.from)) {
      errors.push(err('LOOP_EDGE_NOT_CYCLIC', `loop 边 ${edge.id} 不在环上`, undefined, edge.id));
    }
  }
  // 每个预算必须有耗尽出口
  for (const budget of budgetLoopEdges.keys()) {
    const condition = LOOP_BUDGET_CONDITION_BY_KEY[budget];
    const hasExit = edges.some((e) =>
      (e.requiredOutcomes ?? []).some(
        (r) => r.condition === condition && r.expectedOutcome === 'exhausted',
      ),
    );
    if (!hasExit) {
      errors.push(err('MISSING_BUDGET_EXIT', `预算 ${budget} 缺少 ${condition}=exhausted 出口`));
    }
  }
  // 无界循环：每个 >1 的 SCC（或自环）必须含至少一条 loop 边
  for (const component of stronglyConnectedComponents(graph)) {
    const cyclic =
      component.length > 1 || edges.some((e) => e.from === e.to && component.includes(e.from));
    if (!cyclic) continue;
    const hasLoopEdge = component.some((nodeId) =>
      edges.some((e) => e.from === nodeId && component.includes(e.to) && e.loop),
    );
    if (!hasLoopEdge) {
      errors.push(err('UNBOUNDED_CYCLE', `存在无界循环: ${component.join(', ')}`));
    }
  }

  // 6. 条件枚举覆盖与边合法性
  for (const edge of edges) {
    if (edge.kind === 'fixed') {
      if (edge.requiredOutcomes && edge.requiredOutcomes.length > 0) {
        errors.push(
          err(
            'CONDITIONAL_OUTCOMES_ON_FIXED_EDGE',
            `固定边 ${edge.id} 不应携带条件`,
            undefined,
            edge.id,
          ),
        );
      }
      continue;
    }
    const reqs = edge.requiredOutcomes;
    if (!reqs || reqs.length === 0) {
      errors.push(err('EMPTY_CONDITIONAL_EDGE', `条件边 ${edge.id} 缺少条件`, undefined, edge.id));
      continue;
    }
    for (const req of reqs) {
      if (!isGraphConditionName(req.condition)) {
        errors.push(
          err(
            'UNKNOWN_CONDITION',
            `边 ${edge.id} 引用未知条件: ${String(req.condition)}`,
            undefined,
            edge.id,
          ),
        );
        continue;
      }
      const condition = req.condition as GraphConditionName;
      if (!isGraphConditionOutcome(condition, req.expectedOutcome)) {
        errors.push(
          err(
            'UNKNOWN_CONDITION_OUTCOME',
            `边 ${edge.id} 的条件 ${condition} 引用了非法取值: ${String(req.expectedOutcome)}`,
            undefined,
            edge.id,
          ),
        );
      }
    }
  }
  // 歧义条件：同源节点的两条边条件集合相同
  const bySource = new Map<GraphNodeId, Map<string, string>>();
  for (const edge of edges) {
    if (edge.kind !== 'conditional') continue;
    const sourceMap = bySource.get(edge.from) ?? new Map<string, string>();
    const key = requirementKey(edge);
    const prev = sourceMap.get(key);
    if (prev !== undefined) {
      errors.push(
        err(
          'AMBIGUOUS_EDGE_OUTCOMES',
          `节点 ${edge.from} 的边 ${prev} 与 ${edge.id} 条件相同`,
          edge.from,
          edge.id,
        ),
      );
    } else {
      sourceMap.set(key, edge.id);
      bySource.set(edge.from, sourceMap);
    }
  }
  // 6.5 条件覆盖：每个非预算条件的每个取值必须被至少一条边引用
  for (const conditionName of Object.keys(GRAPH_CONDITION_OUTCOMES) as GraphConditionName[]) {
    if (BUDGET_CONDITION_NAMES.has(conditionName)) continue;
    const referenced = new Set<string>();
    for (const edge of edges) {
      for (const req of edge.requiredOutcomes ?? []) {
        if (req.condition === conditionName) referenced.add(String(req.expectedOutcome));
      }
    }
    for (const outcome of GRAPH_CONDITION_OUTCOMES[conditionName]) {
      if (!referenced.has(outcome)) {
        errors.push(
          err(
            'UNCOVERED_CONDITION_OUTCOME',
            `条件 ${conditionName} 的取值 ${outcome} 未被任何边覆盖，运行时可能卡死`,
          ),
        );
      }
    }
  }

  // 7. 可达性
  const reachable = isReachable(graph, graph.entryNodeId);
  for (const node of nodes) {
    if (!reachable.has(node.id)) {
      errors.push(err('UNREACHABLE_NODE', `节点不可达: ${node.id}`, node.id));
    }
  }

  // 8. 至少一个终止节点
  if (!nodes.some((n) => isTerminalKind(n.kind as GraphNodeImplementationKind))) {
    errors.push(err('MISSING_TERMINAL_NODE', '图中没有终止节点'));
  }

  // 9. prompt 分离
  for (const node of nodes) {
    const kind = node.kind as GraphNodeImplementationKind;
    if (isPromptRequiredKind(kind) && node.promptId === undefined) {
      errors.push(
        err('MISSING_PROMPT_ID_FOR_MODEL_NODE', `模型类节点缺少 promptId: ${node.id}`, node.id),
      );
    }
    if (node.promptId !== undefined && !isKnownStablePromptId(node.promptId)) {
      errors.push(
        err(
          'UNKNOWN_PROMPT_ID',
          `节点 ${node.id} 引用未知 promptId: ${String(node.promptId)}`,
          node.id,
        ),
      );
    }
  }

  // 10. 人工交互节点决策类型映射
  for (const node of nodes) {
    const kind = node.kind as GraphNodeImplementationKind;
    if (isHumanInterruptKind(kind) && kind !== 'IDEA_INPUT') {
      if (HUMAN_DECISION_TYPE_BY_NODE[node.id] === undefined) {
        errors.push(
          err('MISSING_HUMAN_DECISION_TYPE', `人工交互节点缺少决策类型: ${node.id}`, node.id),
        );
      }
    }
  }

  // 11. stage projection 完整性
  for (const node of nodes) {
    if (workflowStageForNodeId(node.id) === undefined) {
      errors.push(
        err('INVALID_STAGE_PROJECTION', `节点 ${node.id} 无 WorkflowStage 映射`, node.id),
      );
    }
  }

  return errors;
}

/** 是否有效（错误列表为空） */
export function isValidIdeaToNovelGraphV1(graph: IdeaToNovelGraphV1): boolean {
  return validateIdeaToNovelGraphV1(graph).length === 0;
}
