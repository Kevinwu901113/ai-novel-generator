/**
 * @ai-novel/domain - Idea-to-Novel Graph Definition Static Validator（required + exact）
 *
 * 对两张 Graph（Project / Chapter）做静态校验，fail-closed：
 * 任何损坏定义都返回至少一条错误，绝不抛异常、绝不返回"有效"。
 *
 * required + exact：
 * - 每种结构定义必需字段集合（Graph / Node / Edge / OutputContract / JoinDeclaration /
 *   JoinAggregationPolicy / LoopDeclaration / OutcomeRequirement）；
 * - 必需键存在、无额外键、普通对象、字段类型正确、字符串非空无首尾空白、基础长度上限、闭合枚举、数组元素合法；
 * - 删除任何必需字段都返回稳定的 MISSING_* 错误码。
 *
 * 拒绝：
 * - 重复 node / edge ID，未知 edge source/target；
 * - 未知入口、不可达节点、无终止节点；
 * - exact-key / shape 违规：node / edge / output / join / loop / requirement 的未知键、
 *   null / array / 非对象、自定义原型或继承键；
 * - 原型键（constructor / toString / __proto__ 等）作为条件名或节点 id；
 * - 非法 node.kind / edge.kind / edge.mode / humanDecisionType / terminalStatus / graph.kind；
 * - 非终止节点无合法出口（含仅预算耗尽出口）；终止节点禁止出口边；
 * - JOIN kind 必须声明合法 join 与 joinAggregationPolicy；非 JOIN 节点禁止声明 join；
 * - join 来源不唯一 / 与 join-mode 入边不匹配；
 * - 无界循环：移除全部 loop-back 边后剩余图必须无环；loop 边必须本身在环上；
 * - 预算键 loop 边 maxIterations 必须一致；预算耗尽出口必须绑定到对应 loop source 与 budget，
 *   且耗尽出口的非预算条件必须与 loop 边完全一致（业务条件合取）；
 * - 未知 / 未覆盖的条件枚举；条件边缺条件；固定边带条件；歧义条件；
 * - 模型类节点缺 promptId 或引用未知 promptId；
 * - 人工交互节点缺 humanDecisionType；
 * - 非法 stage projection；
 * - 输出契约违规（outputRequired 不一致、非法条件名 / artifact kind）；
 * - artifactKinds / budgetKeys / artifactDownstreamOrder 完整性（与节点/边声明一致）。
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
  type AnyIdeaToNovelGraphV1,
  type ChapterGenerationGraphV1,
  type EdgeOutcomeRequirement,
  type GraphConditionName,
  type GraphNodeId,
  type GraphNodeImplementationKind,
  type IdeaToNovelGraphEdgeDefinition,
  type IdeaToNovelGraphNodeDefinition,
  type IdeaToNovelProjectGraphV1,
  type LoopBudgetKey,
} from './idea-to-novel-graph.js';
import { isArtifactKind } from './idea-to-novel-graph-state.js';
import { workflowStageForNodeId } from './idea-to-novel-graph-stages.js';

/** 校验错误码（闭合枚举） */
export type GraphValidationErrorCode =
  | 'MALFORMED_GRAPH'
  | 'MISSING_GRAPH_KEY'
  | 'MISSING_NODE_KEY'
  | 'MISSING_EDGE_KEY'
  | 'MISSING_OUTPUT_KEY'
  | 'MISSING_INPUT_KEY'
  | 'MISSING_JOIN_KEY'
  | 'MISSING_LOOP_KEY'
  | 'MISSING_REQUIREMENT_KEY'
  | 'MISSING_JOIN_POLICY_KEY'
  | 'INVALID_GRAPH_KIND'
  | 'INVALID_ID_FIELD'
  | 'INVALID_LABEL'
  | 'INVALID_ARTIFACT_KINDS'
  | 'INVALID_BUDGET_KEYS'
  | 'INVALID_DOWNSTREAM_ORDER'
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
  | 'INVALID_INPUT_CONTRACT'
  | 'UNKNOWN_GRAPH_KEY'
  | 'UNKNOWN_NODE_KEY'
  | 'UNKNOWN_EDGE_KEY'
  | 'UNKNOWN_OUTPUT_KEY'
  | 'UNKNOWN_INPUT_KEY'
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

// ── required + exact 键集 ───────────────────────────────────────

const GRAPH_REQUIRED: ReadonlyArray<string> = [
  'id',
  'version',
  'kind',
  'entryNodeId',
  'nodes',
  'edges',
  'artifactKinds',
  'budgetKeys',
  'artifactDownstreamOrder',
];
const GRAPH_KEYS = new Set(GRAPH_REQUIRED);

const NODE_REQUIRED: ReadonlyArray<string> = ['id', 'kind', 'label', 'input', 'output'];
const NODE_KEYS = new Set([
  ...NODE_REQUIRED,
  'promptId',
  'humanDecisionType',
  'budgetResetPolicy',
  'join',
  'joinAggregationPolicy',
  'terminalStatus',
]);

const INPUT_REQUIRED: ReadonlyArray<string> = [
  'requiresArtifacts',
  'requiresOutcomes',
  'requiresBudgetKeys',
  'requiresBindings',
];
const INPUT_KEYS = new Set(INPUT_REQUIRED);

const EDGE_REQUIRED: ReadonlyArray<string> = ['id', 'from', 'to', 'kind', 'mode'];
const EDGE_KEYS = new Set([...EDGE_REQUIRED, 'requiredOutcomes', 'loop']);

const OUTPUT_REQUIRED: ReadonlyArray<string> = [
  'requiredOutcomeCondition',
  'allowedArtifactKind',
  'outputRequired',
];
const OUTPUT_KEYS = new Set(OUTPUT_REQUIRED);

const JOIN_REQUIRED: ReadonlyArray<string> = ['requiredIncoming'];
const JOIN_KEYS = new Set(JOIN_REQUIRED);

const LOOP_REQUIRED: ReadonlyArray<string> = ['budget', 'maxIterations'];
const LOOP_KEYS = new Set(LOOP_REQUIRED);

const REQUIREMENT_REQUIRED: ReadonlyArray<string> = ['condition', 'expectedOutcome'];
const REQUIREMENT_KEYS = new Set(REQUIREMENT_REQUIRED);

const JOIN_POLICY_REQUIRED: ReadonlyArray<string> = ['kind', 'sources', 'rule'];
const JOIN_POLICY_KEYS = new Set(JOIN_POLICY_REQUIRED);

const HUMAN_DECISION_TYPES = new Set([
  'intake_response',
  'blueprint_gate',
  'candidate_gate',
  'escalation',
]);
const VALID_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'blocked']);

const MAX_ID_LENGTH = 128;
const MAX_LABEL_LENGTH = 200;

// ── 基础守卫 ────────────────────────────────────────────────────

/**
 * 仅接受 Object.prototype 或 null prototype 的普通对象；自定义原型 / 数组 / null 拒绝。
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isTrimmedNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function checkRequiredKeys(
  errors: GraphValidationError[],
  obj: object,
  required: ReadonlyArray<string>,
  code: GraphValidationErrorCode,
  where: string,
): void {
  for (const key of required) {
    if (!hasOwn(obj, key)) errors.push(err(code, `${where} 缺少必需键: ${key}`));
  }
}

function checkExactKeys(
  errors: GraphValidationError[],
  obj: object,
  allowed: ReadonlySet<string>,
  code: GraphValidationErrorCode,
  where: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) errors.push(err(code, `${where} 含未知键: ${key}`));
  }
}

/** 校验 id 类字符串字段：非空、trim 无首尾空白、长度上限 */
function checkIdField(
  errors: GraphValidationError[],
  value: unknown,
  where: string,
  maxLength: number = MAX_ID_LENGTH,
): value is string {
  if (!isTrimmedNonEmpty(value)) {
    errors.push(err('INVALID_ID_FIELD', `${where} 非法（非字符串或为空）`));
    return false;
  }
  if (value !== value.trim()) {
    errors.push(err('INVALID_ID_FIELD', `${where} 含首尾空白`));
    return false;
  }
  if (value.length > maxLength) {
    errors.push(err('INVALID_ID_FIELD', `${where} 超过长度上限 ${maxLength}`));
    return false;
  }
  return true;
}

/** 校验 label：非空、trim 无首尾空白、长度上限 */
function checkLabelField(errors: GraphValidationError[], value: unknown, where: string): boolean {
  if (!isTrimmedNonEmpty(value)) {
    errors.push(err('INVALID_LABEL', `${where} 非法（非字符串或为空）`));
    return false;
  }
  if (value !== value.trim()) {
    errors.push(err('INVALID_LABEL', `${where} 含首尾空白`));
    return false;
  }
  if (value.length > MAX_LABEL_LENGTH) {
    errors.push(err('INVALID_LABEL', `${where} 超过长度上限 ${MAX_LABEL_LENGTH}`));
    return false;
  }
  return true;
}

/** 缺失/损坏 output 时的安全默认值（fail-closed，不崩溃） */
function safeOutput(node: IdeaToNovelGraphNodeDefinition): {
  requiredOutcomeCondition: GraphConditionName | null;
  allowedArtifactKind: string | null;
} {
  if (isPlainObject(node.output)) {
    return {
      requiredOutcomeCondition: node.output.requiredOutcomeCondition as GraphConditionName | null,
      allowedArtifactKind: node.output.allowedArtifactKind as string | null,
    };
  }
  return { requiredOutcomeCondition: null, allowedArtifactKind: null };
}

/**
 * 只取已通过 shape 校验的 requirement（损坏条目已在 shape 阶段报告，语义阶段跳过）。
 *
 * requiredOutcomes 可能是任何损坏值（非数组 / null / 原始类型）：
 * 必须先用 Array.isArray 守卫，避免对原始值调用 `.filter` 抛异常。
 */
function safeRequirements(
  edge: IdeaToNovelGraphEdgeDefinition,
): ReadonlyArray<EdgeOutcomeRequirement> {
  const raw = edge.requiredOutcomes;
  if (!Array.isArray(raw)) return [];
  // 元素已在 shape 阶段校验为普通对象；此处仅为取合法元素做二次防御
  return raw.filter(isPlainObject) as unknown as ReadonlyArray<EdgeOutcomeRequirement>;
}

function requirementKey(edge: IdeaToNovelGraphEdgeDefinition): string {
  return safeRequirements(edge)
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

// ── 权威入口 ────────────────────────────────────────────────────

/**
 * 校验 Graph Definition，返回错误列表（空数组 = 有效）。
 * fail-closed：损坏输入返回 MALFORMED_GRAPH 或具体错误码，绝不抛异常。
 */
function validateGraphDefinition(
  graph: AnyIdeaToNovelGraphV1,
): ReadonlyArray<GraphValidationError> {
  const errors: GraphValidationError[] = [];
  if (!isPlainObject(graph)) {
    return [err('MALFORMED_GRAPH', 'graph 不是普通对象')];
  }
  checkRequiredKeys(errors, graph, GRAPH_REQUIRED, 'MISSING_GRAPH_KEY', 'graph');
  checkExactKeys(errors, graph, GRAPH_KEYS, 'UNKNOWN_GRAPH_KEY', 'graph');

  // 顶层 id / version / kind / entryNodeId
  checkIdField(errors, graph.id, 'graph.id');
  checkIdField(errors, graph.version, 'graph.version');
  if (graph.kind !== 'project' && graph.kind !== 'chapter') {
    errors.push(err('INVALID_GRAPH_KIND', `graph.kind 非法: ${String(graph.kind)}`));
  }
  checkIdField(errors, graph.entryNodeId, 'graph.entryNodeId');

  // artifactKinds / budgetKeys / artifactDownstreamOrder 完整性
  const artifactKinds: string[] = [];
  if (!Array.isArray(graph.artifactKinds)) {
    errors.push(err('INVALID_ARTIFACT_KINDS', 'graph.artifactKinds 必须是数组'));
  } else {
    const seenKinds = new Set<string>();
    for (const kind of graph.artifactKinds) {
      if (!isArtifactKind(kind)) {
        errors.push(err('INVALID_ARTIFACT_KINDS', `artifactKinds 含未知 kind: ${String(kind)}`));
        continue;
      }
      if (seenKinds.has(kind)) {
        errors.push(err('INVALID_ARTIFACT_KINDS', `artifactKinds 含重复 kind: ${String(kind)}`));
      }
      seenKinds.add(kind);
      artifactKinds.push(kind);
    }
  }
  const budgetKeys: string[] = [];
  if (!Array.isArray(graph.budgetKeys)) {
    errors.push(err('INVALID_BUDGET_KEYS', 'graph.budgetKeys 必须是数组'));
  } else {
    const seenBudgets = new Set<string>();
    for (const key of graph.budgetKeys) {
      if (!isLoopBudgetKey(key)) {
        errors.push(err('INVALID_BUDGET_KEYS', `budgetKeys 含未知预算: ${String(key)}`));
        continue;
      }
      if (seenBudgets.has(key)) {
        errors.push(err('INVALID_BUDGET_KEYS', `budgetKeys 含重复预算: ${String(key)}`));
      }
      seenBudgets.add(key);
      budgetKeys.push(key);
    }
  }
  if (!Array.isArray(graph.artifactDownstreamOrder)) {
    errors.push(err('INVALID_DOWNSTREAM_ORDER', 'artifactDownstreamOrder 必须是数组'));
  } else {
    const seenDown = new Set<string>();
    for (const kind of graph.artifactDownstreamOrder) {
      if (!isArtifactKind(kind)) {
        errors.push(
          err('INVALID_DOWNSTREAM_ORDER', `artifactDownstreamOrder 含未知 kind: ${String(kind)}`),
        );
        continue;
      }
      if (seenDown.has(kind)) {
        errors.push(
          err('INVALID_DOWNSTREAM_ORDER', `artifactDownstreamOrder 含重复 kind: ${String(kind)}`),
        );
      }
      seenDown.add(kind);
    }
    // artifactDownstreamOrder 必须是 artifactKinds 的排列（集合一致、无遗漏）
    const kindSet = new Set(artifactKinds);
    const downSet = new Set(graph.artifactDownstreamOrder);
    if (
      kindSet.size !== downSet.size ||
      ![...kindSet].every((k) => downSet.has(k)) ||
      ![...downSet].every((k) => kindSet.has(k))
    ) {
      errors.push(
        err('INVALID_DOWNSTREAM_ORDER', 'artifactDownstreamOrder 与 artifactKinds 不一致'),
      );
    }
  }

  if (
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges) ||
    typeof graph.entryNodeId !== 'string'
  ) {
    errors.push(err('MALFORMED_GRAPH', 'nodes / edges / entryNodeId 缺失或类型错误'));
    // nodes / edges 非数组时无法继续安全解析，提前返回（保留已累积的错误）
    if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
      return errors;
    }
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

  const nodeIds = nodes.filter((n) => typeof n.id === 'string').map((n) => n.id);
  const nodeIdSet = new Set<string>(nodeIds as string[]);

  // 入口节点存在
  if (typeof graph.entryNodeId === 'string' && !nodeIds.includes(graph.entryNodeId)) {
    errors.push(err('UNKNOWN_ENTRY_NODE', `入口节点不存在: ${String(graph.entryNodeId)}`));
  }

  // 1. 节点：重复 ID、kind、required+exact、输出契约、人工类型、终止状态
  const seenNode = new Set<GraphNodeId>();
  for (const rawNode of nodes) {
    const node = rawNode as IdeaToNovelGraphNodeDefinition;
    const where = typeof node.id === 'string' ? `节点 ${node.id}` : '节点 <id 缺失>';
    checkRequiredKeys(errors, node, NODE_REQUIRED, 'MISSING_NODE_KEY', where);
    checkExactKeys(errors, node, NODE_KEYS, 'UNKNOWN_NODE_KEY', where);
    checkIdField(errors, node.id, `${where} 的 id`);
    checkLabelField(errors, node.label, `${where} 的 label`);
    if (typeof node.id === 'string') {
      if (seenNode.has(node.id)) {
        errors.push(err('DUPLICATE_NODE_ID', `重复节点: ${node.id}`, node.id));
      }
      seenNode.add(node.id);
    }
    if (!isGraphNodeImplementationKind(node.kind)) {
      errors.push(
        err(
          'INVALID_NODE_KIND',
          `${where} 的 kind 非法: ${String(node.kind)}`,
          typeof node.id === 'string' ? node.id : undefined,
        ),
      );
    }

    // 输入契约（required + exact；RW-1-R5 canonical input contract）
    if (!isPlainObject(node.input)) {
      errors.push(err('INVALID_INPUT_CONTRACT', `${where} 的 input 不是对象`, node.id));
    } else {
      checkRequiredKeys(errors, node.input, INPUT_REQUIRED, 'MISSING_INPUT_KEY', `${where}.input`);
      checkExactKeys(errors, node.input, INPUT_KEYS, 'UNKNOWN_INPUT_KEY', `${where}.input`);
      const { requiresArtifacts, requiresOutcomes, requiresBudgetKeys, requiresBindings } =
        node.input;
      if (
        !Array.isArray(requiresArtifacts) ||
        !requiresArtifacts.every((k) => typeof k === 'string' && artifactKinds.includes(k))
      ) {
        errors.push(err('INVALID_INPUT_CONTRACT', `${where} 的 requiresArtifacts 非法`, node.id));
      }
      if (
        !Array.isArray(requiresOutcomes) ||
        !requiresOutcomes.every((id) => typeof id === 'string' && nodeIdSet.has(id))
      ) {
        errors.push(err('INVALID_INPUT_CONTRACT', `${where} 的 requiresOutcomes 非法`, node.id));
      }
      if (
        !Array.isArray(requiresBudgetKeys) ||
        !requiresBudgetKeys.every((k) => typeof k === 'string' && budgetKeys.includes(k))
      ) {
        errors.push(err('INVALID_INPUT_CONTRACT', `${where} 的 requiresBudgetKeys 非法`, node.id));
      }
      if (typeof requiresBindings !== 'boolean') {
        errors.push(err('INVALID_INPUT_CONTRACT', `${where} 的 requiresBindings 非法`, node.id));
      }
    }

    // 输出契约（required + exact）
    if (!isPlainObject(node.output)) {
      errors.push(err('INVALID_OUTPUT_CONTRACT', `${where} 的 output 不是对象`, node.id));
    } else {
      checkRequiredKeys(
        errors,
        node.output,
        OUTPUT_REQUIRED,
        'MISSING_OUTPUT_KEY',
        `${where}.output`,
      );
      checkExactKeys(errors, node.output, OUTPUT_KEYS, 'UNKNOWN_OUTPUT_KEY', `${where}.output`);
      const { requiredOutcomeCondition, allowedArtifactKind, outputRequired } = node.output;
      if (requiredOutcomeCondition !== null && !isGraphConditionName(requiredOutcomeCondition)) {
        errors.push(
          err('INVALID_OUTPUT_CONTRACT', `${where} 的 requiredOutcomeCondition 非法`, node.id),
        );
      }
      if (allowedArtifactKind !== null && !isArtifactKind(allowedArtifactKind)) {
        errors.push(
          err('INVALID_OUTPUT_CONTRACT', `${where} 的 allowedArtifactKind 非法`, node.id),
        );
      }
      if (typeof outputRequired !== 'boolean') {
        errors.push(err('INVALID_OUTPUT_CONTRACT', `${where} 的 outputRequired 非法`, node.id));
      } else {
        const shouldBeRequired = requiredOutcomeCondition !== null || allowedArtifactKind !== null;
        if (outputRequired !== shouldBeRequired) {
          errors.push(
            err('INVALID_OUTPUT_CONTRACT', `${where} 的 outputRequired 与契约不一致`, node.id),
          );
        }
      }
    }

    // 节点产物 artifact 必须在 artifactKinds 内
    const producedKind = safeOutput(node).allowedArtifactKind;
    if (producedKind !== null && !artifactKinds.includes(producedKind)) {
      errors.push(
        err(
          'INVALID_ARTIFACT_KINDS',
          `${where} 产出 artifact ${producedKind} 不在 artifactKinds 内`,
          node.id,
        ),
      );
    }

    if (node.humanDecisionType !== undefined && !HUMAN_DECISION_TYPES.has(node.humanDecisionType)) {
      errors.push(
        err('INVALID_HUMAN_DECISION_TYPE', `${where} 的 humanDecisionType 非法`, node.id),
      );
    }

    if (node.terminalStatus !== undefined && !VALID_TERMINAL_STATUSES.has(node.terminalStatus)) {
      errors.push(err('INVALID_TERMINAL_STATUS', `${where} 的 terminalStatus 非法`, node.id));
    }

    // join 声明（required + exact）
    if (node.join !== undefined && !isPlainObject(node.join)) {
      errors.push(err('JOIN_DECLARATION_MISMATCH', `${where} 的 join 声明不是对象`, node.id));
    } else if (isPlainObject(node.join)) {
      checkRequiredKeys(errors, node.join, JOIN_REQUIRED, 'MISSING_JOIN_KEY', `${where}.join`);
      checkExactKeys(errors, node.join, JOIN_KEYS, 'UNKNOWN_JOIN_KEY', `${where}.join`);
    }

    // budgetResetPolicy：必须是闭合预算键数组、无重复
    if (node.budgetResetPolicy !== undefined) {
      if (!Array.isArray(node.budgetResetPolicy)) {
        errors.push(
          err('INVALID_BUDGET_RESET_POLICY', `${where} 的 budgetResetPolicy 必须是数组`, node.id),
        );
      } else {
        const seen = new Set<string>();
        for (const key of node.budgetResetPolicy) {
          if (!isLoopBudgetKey(key)) {
            errors.push(
              err(
                'INVALID_BUDGET_RESET_POLICY',
                `${where} 的 budgetResetPolicy 含未知预算 ${String(key)}`,
                node.id,
              ),
            );
          }
          if (seen.has(key)) {
            errors.push(
              err(
                'INVALID_BUDGET_RESET_POLICY',
                `${where} 的 budgetResetPolicy 含重复预算 ${String(key)}`,
                node.id,
              ),
            );
          }
          seen.add(String(key));
        }
      }
    }
  }

  // 2. 边：重复 ID、source/target、kind/mode、required+exact、loop、requirement
  const seenEdge = new Set<string>();
  for (const rawEdge of edges) {
    const edge = rawEdge as IdeaToNovelGraphEdgeDefinition;
    const where = typeof edge.id === 'string' ? `边 ${edge.id}` : '边 <id 缺失>';
    checkRequiredKeys(errors, edge, EDGE_REQUIRED, 'MISSING_EDGE_KEY', where);
    checkExactKeys(errors, edge, EDGE_KEYS, 'UNKNOWN_EDGE_KEY', where);
    checkIdField(errors, edge.id, `${where} 的 id`);
    if (typeof edge.id === 'string') {
      if (seenEdge.has(edge.id)) {
        errors.push(err('DUPLICATE_EDGE_ID', `重复边: ${edge.id}`, undefined, edge.id));
      }
      seenEdge.add(edge.id);
    }
    if (typeof edge.from === 'string') {
      if (!nodeIds.includes(edge.from)) {
        errors.push(err('UNKNOWN_EDGE_SOURCE', `${where} 的 source 不存在`, undefined, edge.id));
      }
    }
    if (typeof edge.to === 'string') {
      if (!nodeIds.includes(edge.to)) {
        errors.push(err('UNKNOWN_EDGE_TARGET', `${where} 的 target 不存在`, undefined, edge.id));
      }
    }
    if (!isGraphEdgeKind(edge.kind)) {
      errors.push(
        err('INVALID_EDGE_KIND', `${where} 的 kind 非法: ${String(edge.kind)}`, undefined, edge.id),
      );
    }
    if (!isGraphEdgeMode(edge.mode)) {
      errors.push(
        err('INVALID_EDGE_MODE', `${where} 的 mode 非法: ${String(edge.mode)}`, undefined, edge.id),
      );
    }
    // loop 声明（required + exact）
    if (edge.loop !== undefined) {
      if (!isPlainObject(edge.loop)) {
        errors.push(err('INVALID_LOOP_MAX', `${where} 的 loop 不是对象`, undefined, edge.id));
      } else {
        checkRequiredKeys(errors, edge.loop, LOOP_REQUIRED, 'MISSING_LOOP_KEY', `${where}.loop`);
        checkExactKeys(errors, edge.loop, LOOP_KEYS, 'UNKNOWN_LOOP_KEY', `${where}.loop`);
        if (!isLoopBudgetKey(edge.loop.budget)) {
          errors.push(err('INVALID_LOOP_MAX', `${where} 的 loop.budget 非法`, undefined, edge.id));
        }
        if (!Number.isSafeInteger(edge.loop.maxIterations) || edge.loop.maxIterations < 1) {
          errors.push(
            err('INVALID_LOOP_MAX', `${where} 的 maxIterations 非法`, undefined, edge.id),
          );
        }
        // loop 预算必须在 graph.budgetKeys 内
        if (isLoopBudgetKey(edge.loop.budget) && !budgetKeys.includes(edge.loop.budget)) {
          errors.push(
            err(
              'INVALID_BUDGET_KEYS',
              `${where} 的 loop 预算 ${edge.loop.budget} 不在 budgetKeys 内`,
              undefined,
              edge.id,
            ),
          );
        }
      }
    }
    // requiredOutcomes（required + exact 每个 requirement）
    if (edge.requiredOutcomes !== undefined && !Array.isArray(edge.requiredOutcomes)) {
      errors.push(
        err(
          'EMPTY_CONDITIONAL_EDGE',
          `${where} 的 requiredOutcomes 必须是数组`,
          undefined,
          edge.id,
        ),
      );
    } else {
      for (const req of edge.requiredOutcomes ?? []) {
        const reqWhere = `${where} 条件`;
        if (!isPlainObject(req)) {
          errors.push(err('UNKNOWN_REQUIREMENT_KEY', `${reqWhere} 不是对象`, undefined, edge.id));
          continue;
        }
        checkRequiredKeys(errors, req, REQUIREMENT_REQUIRED, 'MISSING_REQUIREMENT_KEY', reqWhere);
        checkExactKeys(errors, req, REQUIREMENT_KEYS, 'UNKNOWN_REQUIREMENT_KEY', reqWhere);
        if (!isGraphConditionName(req.condition)) {
          errors.push(
            err(
              'UNKNOWN_CONDITION',
              `${reqWhere} 引用未知条件: ${String(req.condition)}`,
              undefined,
              edge.id,
            ),
          );
        }
      }
    }
  }

  // 3. 非终止节点出口 / 终止节点禁止出口 / join 声明 / 输出契约与边一致性
  for (const node of nodes) {
    if (typeof node.id !== 'string') continue;
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
          return safeRequirements(e).some((r) => !BUDGET_CONDITION_NAMES.has(r.condition));
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
        for (const req of safeRequirements(e)) {
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
    // joinAggregationPolicy（required + exact）
    if (node.joinAggregationPolicy) {
      const policy = node.joinAggregationPolicy;
      if (!isPlainObject(policy)) {
        errors.push(
          err('INVALID_JOIN_POLICY', `节点 ${node.id} 的 joinAggregationPolicy 不是对象`, node.id),
        );
      } else {
        checkRequiredKeys(
          errors,
          policy,
          JOIN_POLICY_REQUIRED,
          'MISSING_JOIN_POLICY_KEY',
          `节点 ${node.id}.joinAggregationPolicy`,
        );
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
    safeRequirements(e)
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
          safeRequirements(e).some(
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
    for (const req of safeRequirements(edge)) {
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
    // sources 可能是任何损坏值：先守卫 Array.isArray，避免 for...of 对原始值抛异常
    const sources = n.joinAggregationPolicy?.sources;
    if (!Array.isArray(sources)) continue;
    for (const src of sources) joinSourceIds.add(src);
  }
  for (const node of nodes) {
    if (typeof node.id !== 'string') continue;
    if (joinSourceIds.has(node.id)) continue;
    const produced = safeOutput(node).requiredOutcomeCondition;
    if (produced === null || !isGraphConditionName(produced)) continue;
    const referenced = new Set<string>();
    for (const e of edges) {
      if (e.from !== node.id || e.kind !== 'conditional') continue;
      for (const req of safeRequirements(e)) {
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
  if (typeof graph.entryNodeId === 'string') {
    const reachable = isReachable(edges, graph.entryNodeId);
    for (const node of nodes) {
      if (typeof node.id !== 'string') continue;
      if (!reachable.has(node.id)) {
        errors.push(err('UNREACHABLE_NODE', `节点不可达: ${node.id}`, node.id));
      }
    }
  }

  // 7. 至少一个终止节点
  if (!nodes.some((n) => isTerminalKind(n.kind as GraphNodeImplementationKind))) {
    errors.push(err('MISSING_TERMINAL_NODE', '图中没有终止节点'));
  }

  // 8. prompt 分离
  for (const node of nodes) {
    if (typeof node.id !== 'string') continue;
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
    if (typeof node.id !== 'string') continue;
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
    if (typeof node.id !== 'string') continue;
    if (workflowStageForNodeId(node.id) === undefined) {
      errors.push(
        err('INVALID_STAGE_PROJECTION', `节点 ${node.id} 无 WorkflowStage 映射`, node.id),
      );
    }
  }

  return errors;
}

/** Project Graph 校验（fail-closed） */
export function validateIdeaToNovelProjectGraphV1(
  graph: IdeaToNovelProjectGraphV1,
): ReadonlyArray<GraphValidationError> {
  return validateGraphDefinition(graph);
}

/** Chapter Graph 校验（fail-closed） */
export function validateChapterGenerationGraphV1(
  graph: ChapterGenerationGraphV1,
): ReadonlyArray<GraphValidationError> {
  return validateGraphDefinition(graph);
}

/** Project Graph 是否有效（错误列表为空） */
export function isValidIdeaToNovelProjectGraphV1(graph: IdeaToNovelProjectGraphV1): boolean {
  return validateIdeaToNovelProjectGraphV1(graph).length === 0;
}

/** Chapter Graph 是否有效（错误列表为空） */
export function isValidChapterGenerationGraphV1(graph: ChapterGenerationGraphV1): boolean {
  return validateChapterGenerationGraphV1(graph).length === 0;
}

/** 兼容入口：校验任意一张 Graph（Project / Chapter） */
export function isValidIdeaToNovelGraphV1(graph: AnyIdeaToNovelGraphV1): boolean {
  return validateGraphDefinition(graph).length === 0;
}
