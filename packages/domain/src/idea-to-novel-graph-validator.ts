/**
 * @ai-novel/domain - Idea-to-Novel Graph Definition Static Validator
 *
 * 对 Graph Definition 做静态校验，fail-closed：
 * 任何损坏定义都返回至少一条错误，绝不抛异常、绝不返回"有效"。
 *
 * 拒绝：
 * - 重复 node / edge ID，未知 edge source/target；
 * - 未知入口、不可达节点、无终止节点；
 * - exact-key / shape 违规：node / edge / output / join / loop / requirement 的未知键、
 *   null / array / 非对象、自定义原型或继承键；
 * - 原型键（constructor / toString / __proto__ 等）作为条件名或节点 id；
 * - 非法 node.kind / edge.kind / edge.mode / humanDecisionType / terminalStatus；
 * - 非终止节点无合法出口（含仅预算耗尽出口）；终止节点禁止出口边；
 * - JOIN kind 必须声明合法 join 与 joinAggregationPolicy；非 JOIN 节点禁止声明 join；
 * - join 来源不唯一 / 与 join-mode 入边不匹配；
 * - 无界循环：移除全部 loop-back 边后剩余图必须无环；loop 边必须本身在环上；
 * - 预算键 loop 边 maxIterations 必须一致；预算耗尽出口必须绑定到对应 loop source 与 budget；
 * - 未知 / 未覆盖的条件枚举；条件边缺条件；固定边带条件；歧义条件；
 * - 模型类节点缺 promptId 或引用未知 promptId；
 * - 人工交互节点缺 humanDecisionType；
 * - 非法 stage projection；
 * - 输出契约违规（outputRequired 不一致、非法条件名 / artifact kind）。
 */

import {
  BUDGET_CONDITION_NAMES,
  GRAPH_CONDITION_OUTCOMES,
  isGraphConditionName,
  isGraphConditionOutcome,
  isGraphEdgeKind,
  isGraphEdgeMode,
  isGraphNodeImplementationKind,
  isHumanInterruptKind,
  isKnownStablePromptId,
  isLoopBudgetKey,
  isPromptRequiredKind,
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
import { isArtifactKind } from './idea-to-novel-graph-state.js';
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
  | 'JOIN_KIND_WITHOUT_JOIN'
  | 'NON_JOIN_WITH_JOIN'
  | 'JOIN_POLICY_MISMATCH'
  | 'UNBOUNDED_CYCLE'
  | 'CYCLE_AFTER_LOOP_REMOVAL'
  | 'LOOP_EDGE_NOT_CYCLIC'
  | 'INVALID_LOOP_MAX'
  | 'LOOP_MAX_INCONSISTENT'
  | 'MISSING_BUDGET_EXIT'
  | 'BUDGET_EXIT_NOT_BOUND'
  | 'TERMINAL_HAS_OUTGOING_EDGE'
  | 'UNKNOWN_CONDITION'
  | 'UNKNOWN_CONDITION_OUTCOME'
  | 'EMPTY_CONDITIONAL_EDGE'
  | 'CONDITIONAL_OUTCOMES_ON_FIXED_EDGE'
  | 'AMBIGUOUS_EDGE_OUTCOMES'
  | 'EDGE_CONDITION_NOT_PRODUCED'
  | 'UNCOVERED_CONDITION_OUTCOME'
  | 'MISSING_PROMPT_ID_FOR_MODEL_NODE'
  | 'UNKNOWN_PROMPT_ID'
  | 'MISSING_HUMAN_DECISION_TYPE'
  | 'INVALID_HUMAN_DECISION_TYPE'
  | 'INVALID_TERMINAL_STATUS'
  | 'INVALID_STAGE_PROJECTION'
  | 'INVALID_NODE_KIND'
  | 'INVALID_EDGE_KIND'
  | 'INVALID_EDGE_MODE'
  | 'INVALID_OUTPUT_CONTRACT'
  | 'UNKNOWN_GRAPH_KEY'
  | 'UNKNOWN_NODE_KEY'
  | 'UNKNOWN_EDGE_KEY'
  | 'UNKNOWN_OUTPUT_KEY'
  | 'UNKNOWN_JOIN_KEY'
  | 'UNKNOWN_LOOP_KEY'
  | 'UNKNOWN_REQUIREMENT_KEY'
  | 'INVALID_JOIN_POLICY'
  | 'INVALID_BUDGET_RESET_POLICY'
  | 'BUDGET_EXIT_CONDITION_MISMATCH';

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

const GRAPH_KEYS = new Set(['id', 'version', 'entryNodeId', 'nodes', 'edges']);
const NODE_KEYS = new Set([
  'id',
  'kind',
  'label',
  'promptId',
  'output',
  'humanDecisionType',
  'budgetResetPolicy',
  'join',
  'joinAggregationPolicy',
  'terminalStatus',
]);
const EDGE_KEYS = new Set(['id', 'from', 'to', 'kind', 'requiredOutcomes', 'mode', 'loop']);
const OUTPUT_KEYS = new Set(['requiredOutcomeCondition', 'allowedArtifactKind', 'outputRequired']);
const JOIN_KEYS = new Set(['requiredIncoming']);
const LOOP_KEYS = new Set(['budget', 'maxIterations']);
const REQUIREMENT_KEYS = new Set(['condition', 'expectedOutcome']);
const JOIN_POLICY_KEYS = new Set(['kind', 'sources', 'rule']);
const HUMAN_DECISION_TYPES = new Set([
  'answer_question',
  'blueprint_gate',
  'candidate_gate',
  'escalation',
]);
const BUDGET_KEYS = new Set([
  'clarification',
  'researchRetry',
  'blueprintRewrite',
  'rewrite',
  'candidateRewrite',
  'regenerate',
  'specRevision',
]);

/**
 * 仅接受 Object.prototype 或 null prototype 的普通对象；自定义原型 / 数组 / null 拒绝。
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 缺失/损坏 output 时的安全默认值（fail-closed，不崩溃） */
function safeOutput(node: IdeaToNovelGraphNodeDefinition): {
  requiredOutcomeCondition: GraphConditionName | null;
  allowedArtifactKind: string | null;
} {
  if (isPlainObject(node.output)) {
    return node.output as {
      requiredOutcomeCondition: GraphConditionName | null;
      allowedArtifactKind: string | null;
    };
  }
  return { requiredOutcomeCondition: null, allowedArtifactKind: null };
}

function checkExactKeys(
  errors: GraphValidationError[],
  obj: object,
  allowed: ReadonlySet<string>,
  code: GraphValidationErrorCode,
  where: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      errors.push(err(code, `${where} 含未知键: ${key}`));
    }
  }
}

function requirementKey(edge: IdeaToNovelGraphEdgeDefinition): string {
  return (edge.requiredOutcomes ?? [])
    .map((r) => `${r.condition}=${r.expectedOutcome}`)
    .sort()
    .join('|');
}

function isReachable(
  edges: ReadonlyArray<IdeaToNovelGraphEdgeDefinition>,
  from: GraphNodeId,
): Set<GraphNodeId> {
  const seen = new Set<GraphNodeId>();
  const stack: GraphNodeId[] = [from];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    for (const edge of edges) {
      if (edge.from === current && !seen.has(edge.to)) stack.push(edge.to);
    }
  }
  return seen;
}

/** 在给定边列表上计算 SCC（Tarjan），用于无环性检测 */
function strongComponents(
  nodeIds: ReadonlyArray<GraphNodeId>,
  edges: ReadonlyArray<IdeaToNovelGraphEdgeDefinition>,
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
    for (const edge of edges) {
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

  for (const id of nodeIds) {
    if (!index.has(id)) strongConnect(id);
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
  const errors: GraphValidationError[] = [];
  if (!isPlainObject(graph)) {
    return [err('MALFORMED_GRAPH', 'graph 不是普通对象')];
  }
  checkExactKeys(errors, graph, GRAPH_KEYS, 'UNKNOWN_GRAPH_KEY', 'graph');
  if (
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges) ||
    typeof graph.entryNodeId !== 'string'
  ) {
    return [err('MALFORMED_GRAPH', 'nodes / edges / entryNodeId 缺失或类型错误')];
  }

  // 先安全解析 shape：剔除非普通对象条目，避免后续语义校验解引用 null/损坏项
  const rawNodes = graph.nodes as unknown[];
  const rawEdges = graph.edges as unknown[];
  const nodes: IdeaToNovelGraphNodeDefinition[] = [];
  for (const raw of rawNodes) {
    if (isPlainObject(raw)) {
      nodes.push(raw as unknown as IdeaToNovelGraphNodeDefinition);
    } else {
      errors.push(err('MALFORMED_GRAPH', 'nodes 数组含非对象条目'));
    }
  }
  const edges: IdeaToNovelGraphEdgeDefinition[] = [];
  for (const raw of rawEdges) {
    if (isPlainObject(raw)) {
      edges.push(raw as unknown as IdeaToNovelGraphEdgeDefinition);
    } else {
      errors.push(err('MALFORMED_GRAPH', 'edges 数组含非对象条目'));
    }
  }
  if (nodes.length === 0 || edges.length === 0) {
    errors.push(err('MALFORMED_GRAPH', 'nodes / edges 为空'));
  }

  const nodeIds = nodes.map((n) => n.id);

  // 入口节点存在
  if (!nodeIds.includes(graph.entryNodeId)) {
    errors.push(err('UNKNOWN_ENTRY_NODE', `入口节点不存在: ${String(graph.entryNodeId)}`));
  }

  // 1. 节点：重复 ID、kind、exact-key/shape、输出契约、人工类型、终止状态
  const seenNode = new Set<GraphNodeId>();
  for (const node of nodes) {
    if (!isPlainObject(node)) {
      errors.push(err('MALFORMED_GRAPH', '节点不是对象'));
      continue;
    }
    checkExactKeys(errors, node, NODE_KEYS, 'UNKNOWN_NODE_KEY', `节点 ${String(node.id)}`);
    if (seenNode.has(node.id)) {
      errors.push(err('DUPLICATE_NODE_ID', `重复节点: ${node.id}`, node.id));
    }
    seenNode.add(node.id);
    if (!isGraphNodeImplementationKind(node.kind)) {
      errors.push(
        err(
          'INVALID_NODE_KIND',
          `节点 ${String(node.id)} 的 kind 非法: ${String(node.kind)}`,
          node.id,
        ),
      );
    }

    // 输出契约
    if (!isPlainObject(node.output)) {
      errors.push(
        err('INVALID_OUTPUT_CONTRACT', `节点 ${String(node.id)} 的 output 不是对象`, node.id),
      );
    } else {
      checkExactKeys(
        errors,
        node.output,
        OUTPUT_KEYS,
        'UNKNOWN_OUTPUT_KEY',
        `节点 ${String(node.id)}.output`,
      );
      const { requiredOutcomeCondition, allowedArtifactKind, outputRequired } = node.output;
      if (requiredOutcomeCondition !== null && !isGraphConditionName(requiredOutcomeCondition)) {
        errors.push(
          err(
            'INVALID_OUTPUT_CONTRACT',
            `节点 ${String(node.id)} 的 requiredOutcomeCondition 非法`,
            node.id,
          ),
        );
      }
      if (allowedArtifactKind !== null && !isArtifactKind(allowedArtifactKind)) {
        errors.push(
          err(
            'INVALID_OUTPUT_CONTRACT',
            `节点 ${String(node.id)} 的 allowedArtifactKind 非法`,
            node.id,
          ),
        );
      }
      if (typeof outputRequired !== 'boolean') {
        errors.push(
          err('INVALID_OUTPUT_CONTRACT', `节点 ${String(node.id)} 的 outputRequired 非法`, node.id),
        );
      } else {
        const shouldBeRequired = requiredOutcomeCondition !== null || allowedArtifactKind !== null;
        if (outputRequired !== shouldBeRequired) {
          errors.push(
            err(
              'INVALID_OUTPUT_CONTRACT',
              `节点 ${String(node.id)} 的 outputRequired 与契约不一致`,
              node.id,
            ),
          );
        }
      }
    }

    if (node.humanDecisionType !== undefined && !HUMAN_DECISION_TYPES.has(node.humanDecisionType)) {
      errors.push(
        err(
          'INVALID_HUMAN_DECISION_TYPE',
          `节点 ${String(node.id)} 的 humanDecisionType 非法`,
          node.id,
        ),
      );
    }

    if (node.terminalStatus !== undefined) {
      const validTerminal =
        node.terminalStatus === 'completed' ||
        node.terminalStatus === 'failed' ||
        node.terminalStatus === 'cancelled' ||
        node.terminalStatus === 'blocked';
      if (!validTerminal) {
        errors.push(
          err('INVALID_TERMINAL_STATUS', `节点 ${String(node.id)} 的 terminalStatus 非法`, node.id),
        );
      }
    }
    if (node.join !== undefined && !isPlainObject(node.join)) {
      errors.push(
        err('JOIN_DECLARATION_MISMATCH', `节点 ${String(node.id)} 的 join 声明不是对象`, node.id),
      );
    } else if (isPlainObject(node.join)) {
      checkExactKeys(
        errors,
        node.join,
        JOIN_KEYS,
        'UNKNOWN_JOIN_KEY',
        `节点 ${String(node.id)}.join`,
      );
    }
    // budgetResetPolicy：必须是闭合预算键数组、无重复
    if (node.budgetResetPolicy !== undefined) {
      if (!Array.isArray(node.budgetResetPolicy)) {
        errors.push(
          err(
            'INVALID_BUDGET_RESET_POLICY',
            `节点 ${String(node.id)} 的 budgetResetPolicy 必须是数组`,
            node.id,
          ),
        );
      } else {
        const seen = new Set<string>();
        for (const key of node.budgetResetPolicy) {
          if (!BUDGET_KEYS.has(key)) {
            errors.push(
              err(
                'INVALID_BUDGET_RESET_POLICY',
                `节点 ${String(node.id)} 的 budgetResetPolicy 含未知预算 ${String(key)}`,
                node.id,
              ),
            );
          }
          if (seen.has(key)) {
            errors.push(
              err(
                'INVALID_BUDGET_RESET_POLICY',
                `节点 ${String(node.id)} 的 budgetResetPolicy 含重复预算 ${String(key)}`,
                node.id,
              ),
            );
          }
          seen.add(String(key));
        }
      }
    }
  }

  // 2. 边：重复 ID、source/target、kind/mode、exact-key/shape、loop、requirement
  const seenEdge = new Set<string>();
  for (const edge of edges) {
    if (!isPlainObject(edge)) {
      errors.push(err('MALFORMED_GRAPH', '边不是对象'));
      continue;
    }
    checkExactKeys(errors, edge, EDGE_KEYS, 'UNKNOWN_EDGE_KEY', `边 ${String(edge.id)}`);
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
    if (edge.loop !== undefined) {
      if (!isPlainObject(edge.loop)) {
        errors.push(err('INVALID_LOOP_MAX', `边 ${edge.id} 的 loop 不是对象`, undefined, edge.id));
      } else {
        checkExactKeys(errors, edge.loop, LOOP_KEYS, 'UNKNOWN_LOOP_KEY', `边 ${edge.id}.loop`);
        if (!isLoopBudgetKey(edge.loop.budget)) {
          errors.push(
            err('INVALID_LOOP_MAX', `边 ${edge.id} 的 loop.budget 非法`, undefined, edge.id),
          );
        }
        if (!Number.isSafeInteger(edge.loop.maxIterations) || edge.loop.maxIterations < 1) {
          errors.push(
            err('INVALID_LOOP_MAX', `边 ${edge.id} 的 maxIterations 非法`, undefined, edge.id),
          );
        }
      }
    }
    if (edge.requiredOutcomes !== undefined && !Array.isArray(edge.requiredOutcomes)) {
      errors.push(
        err(
          'EMPTY_CONDITIONAL_EDGE',
          `边 ${edge.id} 的 requiredOutcomes 必须是数组`,
          undefined,
          edge.id,
        ),
      );
    } else {
      for (const req of edge.requiredOutcomes ?? []) {
        if (!isPlainObject(req)) {
          errors.push(
            err(
              'UNKNOWN_REQUIREMENT_KEY',
              `边 ${edge.id} 的 requiredOutcome 不是对象`,
              undefined,
              edge.id,
            ),
          );
          continue;
        }
        checkExactKeys(
          errors,
          req,
          REQUIREMENT_KEYS,
          'UNKNOWN_REQUIREMENT_KEY',
          `边 ${edge.id} 条件`,
        );
      }
    }
  }

  // 3. 非终止节点出口 / 终止节点禁止出口 / join 声明 / 输出契约与边一致性
  for (const node of nodes) {
    const kind = node.kind as GraphNodeImplementationKind;
    const outgoing = edges.filter((e) => e.from === node.id);
    if (isTerminalKind(kind)) {
      if (outgoing.length > 0) {
        errors.push(err('TERMINAL_HAS_OUTGOING_EDGE', `终止节点不允许出口边: ${node.id}`, node.id));
      }
      if (node.terminalStatus === undefined) {
        errors.push(
          err('INVALID_TERMINAL_STATUS', `终止节点缺少 terminalStatus: ${node.id}`, node.id),
        );
      }
    } else {
      if (node.terminalStatus !== undefined) {
        errors.push(
          err('INVALID_TERMINAL_STATUS', `非终止节点不应声明 terminalStatus: ${node.id}`, node.id),
        );
      }
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
      // 非预算条件边必须使用节点产出的 condition
      for (const e of outgoing) {
        if (e.kind !== 'conditional') continue;
        for (const req of e.requiredOutcomes ?? []) {
          if (BUDGET_CONDITION_NAMES.has(req.condition)) continue;
          if (req.condition !== safeOutput(node).requiredOutcomeCondition) {
            errors.push(
              err(
                'EDGE_CONDITION_NOT_PRODUCED',
                `节点 ${node.id} 的边 ${e.id} 使用了未产出的条件 ${req.condition}`,
                node.id,
                e.id,
              ),
            );
          }
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
    const isJoinKind = kind === 'JOIN';
    if (isJoinKind && !node.join) {
      errors.push(err('JOIN_KIND_WITHOUT_JOIN', `JOIN 节点缺少 join 声明: ${node.id}`, node.id));
    }
    if (!isJoinKind && node.join !== undefined) {
      errors.push(err('NON_JOIN_WITH_JOIN', `非 JOIN 节点不应声明 join: ${node.id}`, node.id));
    }
    if (isJoinKind && !node.joinAggregationPolicy) {
      errors.push(
        err('JOIN_POLICY_MISMATCH', `JOIN 节点缺少 joinAggregationPolicy: ${node.id}`, node.id),
      );
    }
    if (!isJoinKind && node.joinAggregationPolicy !== undefined) {
      errors.push(
        err(
          'JOIN_POLICY_MISMATCH',
          `非 JOIN 节点不应声明 joinAggregationPolicy: ${node.id}`,
          node.id,
        ),
      );
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
    if (joinIncoming.length > 0 && !node.join) {
      errors.push(err('FAN_IN_WITHOUT_JOIN', `节点 ${node.id} 有 join 入边但未声明 join`, node.id));
    }
    // join 来源唯一
    const joinSourceIds = joinIncoming.map((e) => e.from);
    if (new Set(joinSourceIds).size !== joinSourceIds.length) {
      errors.push(err('JOIN_POLICY_MISMATCH', `节点 ${node.id} 的 join 来源重复`, node.id));
    }
    if (node.joinAggregationPolicy) {
      const policy = node.joinAggregationPolicy;
      if (!isPlainObject(policy)) {
        errors.push(
          err('INVALID_JOIN_POLICY', `节点 ${node.id} 的 joinAggregationPolicy 不是对象`, node.id),
        );
      } else {
        checkExactKeys(
          errors,
          policy,
          JOIN_POLICY_KEYS,
          'INVALID_JOIN_POLICY',
          `节点 ${node.id}.joinAggregationPolicy`,
        );
      }
      if (policy.kind !== 'critique_verdict' || policy.rule !== 'all_pass_or_needs_rewrite') {
        errors.push(err('JOIN_POLICY_MISMATCH', `节点 ${node.id} 的聚合策略非法`, node.id));
      }
      if (!Array.isArray(policy.sources)) {
        errors.push(
          err('INVALID_JOIN_POLICY', `节点 ${node.id} 的策略 sources 必须是数组`, node.id),
        );
      }
      const sources = [...(Array.isArray(policy.sources) ? policy.sources : [])];
      if (new Set(sources).size !== sources.length) {
        errors.push(err('JOIN_POLICY_MISMATCH', `节点 ${node.id} 的策略来源重复`, node.id));
      }
      const sourceSet = new Set(sources);
      const joinSourceSet = new Set(joinSourceIds);
      if (
        sources.length !== joinSourceIds.length ||
        !sources.every((s) => joinSourceSet.has(s)) ||
        !joinSourceIds.every((s) => sourceSet.has(s))
      ) {
        errors.push(
          err('JOIN_POLICY_MISMATCH', `节点 ${node.id} 的策略来源与 join 入边不匹配`, node.id),
        );
      }
    }
  }

  // 4. 循环：有界性与预算
  const budgetLoopMax = new Map<LoopBudgetKey, number>();
  const loopSourcesByBudget = new Map<LoopBudgetKey, Set<GraphNodeId>>();
  for (const edge of edges) {
    if (!edge.loop) continue;
    if (!isLoopBudgetKey(edge.loop.budget)) continue;
    const budget = edge.loop.budget;
    const prevMax = budgetLoopMax.get(budget);
    if (prevMax !== undefined && prevMax !== edge.loop.maxIterations) {
      errors.push(err('LOOP_MAX_INCONSISTENT', `预算 ${budget} 的 loop 边 maxIterations 不一致`));
    }
    budgetLoopMax.set(budget, edge.loop.maxIterations);
    const sources = loopSourcesByBudget.get(budget) ?? new Set<GraphNodeId>();
    sources.add(edge.from);
    loopSourcesByBudget.set(budget, sources);
    // loop 边必须在环上
    const reachableFromTarget = isReachable(edges, edge.to);
    if (!reachableFromTarget.has(edge.from)) {
      errors.push(err('LOOP_EDGE_NOT_CYCLIC', `loop 边 ${edge.id} 不在环上`, undefined, edge.id));
    }
  }
  // 每个预算的 loop source 必须有绑定到同一 source 的耗尽出口，
  // 且耗尽出口的非预算条件必须与对应 loop 边完全一致（业务条件合取）
  const nonBudgetRequirementKey = (e: IdeaToNovelGraphEdgeDefinition): string =>
    (e.requiredOutcomes ?? [])
      .filter((r) => !BUDGET_CONDITION_NAMES.has(r.condition))
      .map((r) => `${r.condition}=${r.expectedOutcome}`)
      .sort()
      .join('|');
  for (const [budget, sources] of loopSourcesByBudget) {
    const condition = LOOP_BUDGET_CONDITION_BY_KEY[budget];
    for (const source of sources) {
      const loopEdges = edges.filter((e) => e.from === source && e.loop?.budget === budget);
      const exhaustedEdges = edges.filter(
        (e) =>
          e.from === source &&
          (e.requiredOutcomes ?? []).some(
            (r) => r.condition === condition && r.expectedOutcome === 'exhausted',
          ),
      );
      if (exhaustedEdges.length === 0) {
        errors.push(
          err(
            'BUDGET_EXIT_NOT_BOUND',
            `预算 ${budget} 的 loop source ${source} 缺少 ${condition}=exhausted 出口`,
            source,
          ),
        );
        continue;
      }
      // 耗尽出口的业务条件必须与每条 loop 边一致（非预算 requiredOutcomes 完全一致）
      for (const loopEdge of loopEdges) {
        const loopKey = nonBudgetRequirementKey(loopEdge);
        for (const exitEdge of exhaustedEdges) {
          if (nonBudgetRequirementKey(exitEdge) !== loopKey) {
            errors.push(
              err(
                'BUDGET_EXIT_CONDITION_MISMATCH',
                `预算 ${budget} 的耗尽出口 ${exitEdge.id} 业务条件与 loop 边 ${loopEdge.id} 不一致`,
                source,
                exitEdge.id,
              ),
            );
          }
        }
      }
    }
  }
  // 移除全部 loop-back 边后剩余图必须无环
  const nonLoopEdges = edges.filter((e) => !e.loop);
  for (const component of strongComponents(nodeIds, nonLoopEdges)) {
    const cyclic =
      component.length > 1 ||
      nonLoopEdges.some((e) => e.from === e.to && component.includes(e.from));
    if (cyclic) {
      errors.push(
        err('CYCLE_AFTER_LOOP_REMOVAL', `移除 loop 边后仍存在环: ${component.join(', ')}`),
      );
    }
  }
  // 无界循环：SCC 无 loop 边（保留显式错误码）
  for (const component of strongComponents(nodeIds, edges)) {
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

  // 5. 条件枚举覆盖与边合法性
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
  // per-source 条件覆盖：每个产生条件的节点，其非预算出口必须覆盖该条件的全部取值
  // （join 来源的产出由 joinAggregationPolicy 消费，其覆盖由 JOIN_POLICY_MISMATCH 检查保证）
  const joinSourceIds = new Set<GraphNodeId>();
  for (const n of nodes) {
    for (const src of n.joinAggregationPolicy?.sources ?? []) joinSourceIds.add(src);
  }
  for (const node of nodes) {
    if (joinSourceIds.has(node.id)) continue;
    const produced = safeOutput(node).requiredOutcomeCondition;
    if (produced === null || !isGraphConditionName(produced)) continue;
    const referenced = new Set<string>();
    for (const e of edges) {
      if (e.from !== node.id || e.kind !== 'conditional') continue;
      for (const req of e.requiredOutcomes ?? []) {
        if (req.condition === produced) referenced.add(String(req.expectedOutcome));
      }
    }
    for (const outcome of GRAPH_CONDITION_OUTCOMES[produced]) {
      if (!referenced.has(outcome)) {
        errors.push(
          err(
            'UNCOVERED_CONDITION_OUTCOME',
            `节点 ${node.id} 产出的条件 ${produced} 取值 ${outcome} 未被任何出口边覆盖`,
            node.id,
          ),
        );
      }
    }
  }

  // 6. 可达性
  const reachable = isReachable(edges, graph.entryNodeId);
  for (const node of nodes) {
    if (!reachable.has(node.id)) {
      errors.push(err('UNREACHABLE_NODE', `节点不可达: ${node.id}`, node.id));
    }
  }

  // 7. 至少一个终止节点
  if (!nodes.some((n) => isTerminalKind(n.kind as GraphNodeImplementationKind))) {
    errors.push(err('MISSING_TERMINAL_NODE', '图中没有终止节点'));
  }

  // 8. prompt 分离
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

  // 9. 人工交互节点 humanDecisionType
  for (const node of nodes) {
    const kind = node.kind as GraphNodeImplementationKind;
    if (isHumanInterruptKind(kind) && kind !== 'IDEA_INPUT') {
      if (node.humanDecisionType === undefined) {
        errors.push(
          err(
            'MISSING_HUMAN_DECISION_TYPE',
            `人工交互节点缺少 humanDecisionType: ${node.id}`,
            node.id,
          ),
        );
      }
    }
    if (kind !== 'IDEA_INPUT' && kind !== 'CLARIFY_ANSWER' && kind !== 'USER_GATE') {
      if (node.humanDecisionType !== undefined) {
        errors.push(
          err(
            'INVALID_HUMAN_DECISION_TYPE',
            `非人工节点不应声明 humanDecisionType: ${node.id}`,
            node.id,
          ),
        );
      }
    }
  }

  // 10. stage projection 完整性
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
